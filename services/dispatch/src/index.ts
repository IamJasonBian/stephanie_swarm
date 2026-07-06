// Job negotiation service — queue + dispatch broker in front of the compute
// service. Clients (UI, Telegram bots) submit jobs with optional model
// preferences; the broker picks a backend, bounds concurrency, and tracks
// results.
//   POST /jobs            — enqueue; ?wait=true long-polls for the result
//   GET  /jobs/:id        — job status/result
//   GET  /health          — own stats + proxied compute health
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import {
  BACKENDS,
  enqueue,
  getJob,
  waitForJob,
  queueStats,
  setExecutor,
  setNodeCount,
  type Backend,
  type Job,
  type JobPreferences,
  type JobType,
} from "./queue.ts";

const PORT = Number(process.env.PORT ?? 8877);
// Compute pool: static COMPUTE_URLS (comma-separated) plus nodes that
// self-register via POST /nodes/register (shared-secret protected, heartbeat
// every ~60s, expired after REGISTER_TTL_MS of silence). Jobs round-robin
// across the live pool and fail over to the next node automatically.
const COMPUTE_URLS = (process.env.COMPUTE_URLS ?? process.env.COMPUTE_URL ?? "http://localhost:8878")
  .split(",")
  .map((u) => u.trim().replace(/\/$/, ""))
  .filter(Boolean);
const SWARM_KEY = process.env.SWARM_KEY ?? "";
const REGISTER_TTL_MS = 150_000;
const WAIT_TIMEOUT_S = Number(process.env.WAIT_TIMEOUT_S ?? 60);

const registered = new Map<string, number>(); // node url -> lastSeen ms

function poolNodes(): string[] {
  const now = Date.now();
  const dynamic = [...registered.entries()]
    .filter(([, seen]) => now - seen < REGISTER_TTL_MS)
    .map(([url]) => url);
  return [...new Set([...COMPUTE_URLS, ...dynamic])];
}

// Sweep expired registrations so concurrency shrinks with the pool.
setInterval(() => {
  const now = Date.now();
  for (const [url, seen] of registered) {
    if (now - seen >= REGISTER_TTL_MS) {
      registered.delete(url);
      console.log(`node expired: ${url}`);
    }
  }
  setNodeCount(poolNodes().length);
}, 30_000).unref();

const COMPUTE_PATHS: Record<JobType, string> = {
  chat: "/v1/chat/completions",
  execute: "/v1/execute",
  convert: "/v1/convert",
};

let nodeRR = 0;

setExecutor(async (job: Job, backend: Backend) => {
  const path = COMPUTE_PATHS[job.type];
  const payload = job.type === "chat" ? { ...job.payload, model: backend } : job.payload;
  const nodes = poolNodes();
  const start = nodeRR++ % nodes.length;
  const nodeErrors: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[(start + i) % nodes.length];
    let res: Response;
    try {
      res = await fetch(`${node}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(310_000),
      });
    } catch (e) {
      // Node unreachable — try the next one.
      nodeErrors.push(`${node}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status === 503) {
      // Backend not configured/ready on this node — another node may have it.
      nodeErrors.push(`${node}: ${typeof body?.error === "string" ? body.error : "503"}`);
      continue;
    }
    if (!res.ok) {
      throw new Error(
        typeof body?.error === "string" ? body.error : `compute returned HTTP ${res.status}`
      );
    }
    return { result: body, model: backend };
  }
  throw new Error(`no compute node could serve this job — ${nodeErrors.join("; ")}`);
});

const app = new Hono();
app.use("*", cors());

app.get("/health", async (c) => {
  const nodes = await Promise.all(
    poolNodes().map(async (node) => {
      const source = COMPUTE_URLS.includes(node) ? "static" : "registered";
      try {
        const res = await fetch(`${node}/health`, { signal: AbortSignal.timeout(2_000) });
        return { node, source, ...(await res.json() as object) };
      } catch {
        return { node, source, ok: false, error: "unreachable" };
      }
    })
  );
  const healthy = nodes.filter((n) => (n as { ok?: boolean }).ok);
  return c.json({
    ok: healthy.length > 0,
    pool: { total: nodes.length, healthy: healthy.length },
    queue: queueStats(),
    // First healthy node doubles as the legacy `compute` field for old clients.
    compute: healthy[0] ?? nodes[0] ?? null,
    nodes,
  });
});

// Node discovery: compute nodes announce themselves (and heartbeat) here.
// Requires the shared SWARM_KEY; the hub verifies it can actually reach the
// node's /health before admitting it to the pool.
app.post("/nodes/register", async (c) => {
  if (!SWARM_KEY) {
    return c.json({ error: "registration disabled — set SWARM_KEY on the hub" }, 403);
  }
  if (c.req.header("x-swarm-key") !== SWARM_KEY) {
    return c.json({ error: "bad swarm key" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as { url?: string } | null;
  const url = body?.url?.trim().replace(/\/$/, "");
  if (!url || !/^https?:\/\//.test(url)) {
    return c.json({ error: "url (http[s]://host:port) is required" }, 400);
  }
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    return c.json(
      { error: `hub cannot reach ${url}/health — ${e instanceof Error ? e.message : e}` },
      400
    );
  }
  if (!registered.has(url) && !COMPUTE_URLS.includes(url)) {
    console.log(`node registered: ${url}`);
  }
  registered.set(url, Date.now());
  setNodeCount(poolNodes().length);
  return c.json({ ok: true, pool: poolNodes() });
});

function publicView(job: Job) {
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    model: job.model,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

app.post("/jobs", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { type?: JobType; payload?: Record<string, unknown>; preferences?: JobPreferences }
    | null;
  if (!body || !body.type || !(body.type in COMPUTE_PATHS)) {
    return c.json({ error: "type must be 'chat', 'execute', or 'convert'" }, 400);
  }
  if (!body.payload || typeof body.payload !== "object") {
    return c.json({ error: "payload object is required" }, 400);
  }
  const prefs = body.preferences ?? {};
  if (prefs.model && !BACKENDS.includes(prefs.model)) {
    return c.json({ error: `preferences.model must be one of: ${BACKENDS.join(", ")}` }, 400);
  }

  const job = enqueue(body.type, body.payload, prefs);

  if (c.req.query("wait") === "true") {
    const finished = await waitForJob(job.jobId, WAIT_TIMEOUT_S * 1000);
    return c.json(publicView(finished ?? job), finished?.status === "failed" ? 502 : 200);
  }
  return c.json({ jobId: job.jobId, status: job.status }, 202);
});

app.get("/jobs/:id", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.json({ error: "unknown jobId (results expire after 1h)" }, 404);
  return c.json(publicView(job));
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`dispatch service listening on :${info.port} → compute pool: ${COMPUTE_URLS.join(", ")}`);
});
