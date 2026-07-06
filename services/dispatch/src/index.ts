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
  type Backend,
  type Job,
  type JobPreferences,
  type JobType,
} from "./queue.ts";

const PORT = Number(process.env.PORT ?? 8877);
// Compute pool: every node in COMPUTE_URLS (comma-separated — localhost,
// LAN IPs, tailscale hostnames) contributes to total capacity. Jobs
// round-robin across nodes and fail over to the next node automatically.
const COMPUTE_URLS = (process.env.COMPUTE_URLS ?? process.env.COMPUTE_URL ?? "http://localhost:8878")
  .split(",")
  .map((u) => u.trim().replace(/\/$/, ""))
  .filter(Boolean);
const WAIT_TIMEOUT_S = Number(process.env.WAIT_TIMEOUT_S ?? 60);

const COMPUTE_PATHS: Record<JobType, string> = {
  chat: "/v1/chat/completions",
  execute: "/v1/execute",
  convert: "/v1/convert",
};

let nodeRR = 0;

setExecutor(async (job: Job, backend: Backend) => {
  const path = COMPUTE_PATHS[job.type];
  const payload = job.type === "chat" ? { ...job.payload, model: backend } : job.payload;
  const start = nodeRR++ % COMPUTE_URLS.length;
  const nodeErrors: string[] = [];

  for (let i = 0; i < COMPUTE_URLS.length; i++) {
    const node = COMPUTE_URLS[(start + i) % COMPUTE_URLS.length];
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
    COMPUTE_URLS.map(async (node) => {
      try {
        const res = await fetch(`${node}/health`, { signal: AbortSignal.timeout(2_000) });
        return { node, ...(await res.json() as object) };
      } catch {
        return { node, ok: false, error: "unreachable" };
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
