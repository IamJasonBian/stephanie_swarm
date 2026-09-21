// General-purpose compute service.
//   POST /v1/chat/completions   — OpenAI-compatible; model: "hermes" | "claude" | "kimi" | "qwen"
//   POST /v1/agent/completions  — bounded MCP tool loop over a named harness profile
//   GET  /v1/harness/profiles   — profiles this node can run
//   POST /v1/execute            — Judge0 code execution (503 until JUDGE0_URL set)
//   GET  /health                — backend readiness
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hermesChat, hermesHealthy, hermesModelName, BackendUnavailable, type ChatRequest, type ChatMessage } from "./backends/ollama.ts";
import { claudeChat, claudeStatus } from "./backends/claude.ts";
import { kimiChat, kimiStatus } from "./backends/kimi.ts";
import { qwen, type ChatCompletion } from "./backends/openaiCompatible.ts";
import { convertDocument, converterReady, type DocumentInput } from "./backends/converter.ts";
import { runPython, Judge0Unavailable, type Judge0SubmitOptions } from "./judge0Client.ts";
import { getProfile, loadProfiles } from "./harness/profiles.ts";
import { mcpManager } from "./harness/mcpClient.ts";
import { McpError } from "./harness/mcpClient.ts";
import { runAgent } from "./harness/agentLoop.ts";

const PORT = Number(process.env.PORT ?? 8878);
const MODELS = ["hermes", "claude", "kimi", "qwen"] as const;
type ModelAlias = (typeof MODELS)[number];

// Shared secret gating the harness route. Unset ⇒ tool execution is off on
// this node (503), because the tunnel makes public traffic look like
// localhost to dispatch, so "loopback" is not a trust signal here.
const HARNESS_TOKEN = process.env.HARNESS_TOKEN ?? "";
function harnessAuthorized(header: string | undefined): boolean {
  if (!HARNESS_TOKEN || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(HARNESS_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Backends that can take OpenAI tool definitions and emit tool_calls.
const TOOL_CAPABLE: Record<ModelAlias, boolean> = { hermes: false, claude: false, kimi: true, qwen: true };

// Base system prompt injected ahead of every chat request, whichever model
// serves it. Defaults to the negotiation-tactics playbook; point
// BASE_PROMPT_FILE elsewhere to swap it, or set BASE_PROMPT_FILE="" to disable.
const here = dirname(fileURLToPath(import.meta.url));
const BASE_PROMPT_FILE =
  process.env.BASE_PROMPT_FILE ?? join(here, "..", "prompts", "negotiation.md");
let basePrompt = "";
if (BASE_PROMPT_FILE) {
  try {
    basePrompt = readFileSync(BASE_PROMPT_FILE, "utf8").trim();
  } catch {
    console.warn(`base prompt file not readable, continuing without it: ${BASE_PROMPT_FILE}`);
  }
}

const app = new Hono();
app.use("*", cors());

app.get("/health", async (c) => {
  const [hermes, converter, claude, qwenReady] = await Promise.all([
    hermesHealthy(),
    converterReady(),
    claudeStatus(),
    qwen.healthy(),
  ]);
  const kimi = kimiStatus();
  const judge0 = Boolean(process.env.JUDGE0_URL);
  const profiles = [...loadProfiles().values()];
  return c.json({
    ok: hermes || claude.ready || kimi.ready || qwenReady,
    backends: {
      hermes: { reachable: hermes, model: hermesModelName() },
      claude,
      kimi,
      qwen: { ready: qwenReady, ...qwen.status() },
      judge0: { configured: judge0 },
      converter: { ready: converter, engine: "docling" },
    },
    harness: {
      enabled: Boolean(HARNESS_TOKEN),
      profiles: profiles.map((p) => p.name),
    },
    basePrompt: basePrompt ? basename(BASE_PROMPT_FILE) : null,
  });
});

app.get("/v1/models", async (c) => {
  const [hermes, claude, qwenReady] = await Promise.all([hermesHealthy(), claudeStatus(), qwen.healthy()]);
  const online: Record<ModelAlias, boolean> = {
    hermes,
    claude: claude.ready,
    kimi: kimiStatus().ready,
    qwen: qwenReady,
  };
  return c.json({
    object: "list",
    data: MODELS.map((id) => ({ id, object: "model", owned_by: "hermes_swarm", online: online[id] })),
  });
});

app.post("/v1/chat/completions", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | ({ model?: string; stream?: boolean; documents?: DocumentInput[] } & ChatRequest)
    | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }
  if (body.stream) {
    return c.json({ error: "streaming not supported in v1 — omit stream" }, 400);
  }
  const model = (body.model ?? "hermes") as ModelAlias;
  if (!MODELS.includes(model)) {
    return c.json({ error: `model must be one of: ${MODELS.join(", ")}` }, 400);
  }

  try {
    // Optional document attachments: converted to markdown (docling) and
    // prepended as context ahead of the conversation.
    if (Array.isArray(body.documents) && body.documents.length > 0) {
      const converted = await Promise.all(body.documents.map(convertDocument));
      const context = converted
        .map((d) => `Reference document "${d.name}":\n\n${d.markdown}`)
        .join("\n\n---\n\n");
      body.messages = [{ role: "user", content: context }, ...body.messages];
    }
    // Base system prompt (negotiation playbook) goes first so client-supplied
    // system messages and document context sit on top of it.
    if (basePrompt) {
      body.messages = [{ role: "system", content: basePrompt }, ...body.messages];
    }
    const result =
      model === "hermes" ? await hermesChat(body)
      : model === "kimi" ? await kimiChat(body)
      : model === "qwen" ? await qwen.chat(body)
      : await claudeChat(body);
    return c.json(result as object);
  } catch (e) {
    if (e instanceof BackendUnavailable) {
      return c.json({ error: e.message }, 503);
    }
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// Harness: server-side MCP tool loop. Explicit opt-in route — plain chat
// never executes tools. Requires x-harness-token; profile must allow the
// backend; the backend must be tool-capable.
// ---------------------------------------------------------------------------
app.get("/v1/harness/profiles", (c) => {
  const profiles = [...loadProfiles().values()].map((p) => ({
    name: p.name,
    description: p.description ?? null,
    exposure: p.exposure,
    backends: p.backends,
    tools: p.tools.map((t) => ({ name: t.name, mutating: Boolean(t.mutating) })),
    limits: p.limits,
  }));
  return c.json({ enabled: Boolean(HARNESS_TOKEN), profiles });
});

app.post("/v1/agent/completions", async (c) => {
  if (!HARNESS_TOKEN) {
    return c.json({ error: "harness disabled on this node — set HARNESS_TOKEN in services/.env" }, 503);
  }
  if (!harnessAuthorized(c.req.header("x-harness-token"))) {
    return c.json({ error: "harness token missing or invalid" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as
    | {
        model?: string;
        profile?: string;
        messages?: ChatMessage[];
        limits?: { max_tool_rounds?: number; timeout_ms?: number; max_tool_output_bytes?: number };
        temperature?: number;
        max_tokens?: number;
        top_p?: number;
        include_transcript?: boolean;
        documents?: DocumentInput[];
      }
    | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "messages array is required" }, 400);
  }
  if (typeof body.profile !== "string") return c.json({ error: "profile is required" }, 400);
  // Same document-attachment contract as /v1/chat/completions: converted to
  // markdown (docling) and prepended as reference context.
  if (Array.isArray(body.documents) && body.documents.length > 0) {
    try {
      const converted = await Promise.all(body.documents.map(convertDocument));
      const context = converted.map((d) => `Reference document "${d.name}":\n\n${d.markdown}`).join("\n\n---\n\n");
      body.messages = [{ role: "user", content: context }, ...body.messages];
    } catch (e) {
      if (e instanceof BackendUnavailable) return c.json({ error: e.message }, 503);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  }
  const profile = getProfile(body.profile);
  if (!profile) return c.json({ error: `unknown harness profile: ${body.profile}` }, 404);

  const model = (body.model ?? profile.backends[0]) as ModelAlias;
  if (!MODELS.includes(model)) return c.json({ error: `model must be one of: ${MODELS.join(", ")}` }, 400);
  if (!profile.backends.includes(model)) {
    return c.json({ error: `profile "${profile.name}" does not allow backend "${model}"` }, 400);
  }
  if (!TOOL_CAPABLE[model]) {
    return c.json({ error: `backend "${model}" cannot take tool definitions — use one of: ${MODELS.filter((m) => TOOL_CAPABLE[m]).join(", ")}` }, 400);
  }
  // Base prompt (negotiation playbook) applies here too, under the profile's
  // own system prompt.
  const messages: ChatMessage[] = basePrompt
    ? [{ role: "system", content: basePrompt }, ...body.messages]
    : body.messages;
  const chat = model === "qwen"
    ? (req: ChatRequest) => qwen.chat(req)
    : (req: ChatRequest) => kimiChat(req) as Promise<ChatCompletion>;

  try {
    const { completion, transcript } = await runAgent({
      profile,
      backend: model,
      chat,
      mcp: mcpManager,
      messages,
      limits: body.limits,
      sampling: { temperature: body.temperature ?? 0.2, max_tokens: body.max_tokens ?? 1536, top_p: body.top_p },
    });
    return c.json(body.include_transcript ? { ...completion, transcript } : completion);
  } catch (e) {
    if (e instanceof BackendUnavailable) return c.json({ error: e.message }, 503);
    if (e instanceof McpError) return c.json({ error: e.message }, 502);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// Convert a document (PDF, DOCX, PPTX, XLSX, HTML, image, ...) to markdown.
// Body: { source: "<url-or-path>" } or { filename: "x.pdf", data: "<base64>" }.
app.post("/v1/convert", async (c) => {
  const body = (await c.req.json().catch(() => null)) as DocumentInput | null;
  if (!body || (!body.source && !(body.filename && body.data))) {
    return c.json({ error: "provide 'source' (URL/path) or 'filename' + 'data' (base64)" }, 400);
  }
  try {
    const { name, markdown } = await convertDocument(body);
    return c.json({ name, markdown, engine: "docling" });
  } catch (e) {
    if (e instanceof BackendUnavailable) return c.json({ error: e.message }, 503);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.post("/v1/execute", async (c) => {
  if (!process.env.JUDGE0_URL) {
    return c.json(
      { error: "judge0 not configured — set JUDGE0_URL and run Judge0 CE via Docker" },
      503
    );
  }
  const body = (await c.req.json().catch(() => null)) as Judge0SubmitOptions | null;
  if (!body || typeof body.sourceCode !== "string") {
    return c.json({ error: "sourceCode is required" }, 400);
  }
  try {
    return c.json(await runPython(body));
  } catch (e) {
    if (e instanceof Judge0Unavailable) {
      return c.json({ error: e.message }, 503);
    }
    throw e;
  }
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`compute service listening on :${info.port}`);
});

// ---------------------------------------------------------------------------
// Node discovery: announce this compute node to the hub so it joins the pool
// without editing COMPUTE_URLS. Needs DISPATCH_URL + SWARM_KEY in the env
// (services/.env); silently disabled otherwise. Heartbeats every 60s — the
// hub expires us ~150s after the last one, so a dead laptop leaves the pool
// on its own.
const HUB_URL = (process.env.DISPATCH_URL ?? "").trim().replace(/\/$/, "");
const SWARM_KEY = process.env.SWARM_KEY ?? "";

function detectAdvertiseUrl(): string {
  if (process.env.ADVERTISE_URL) return process.env.ADVERTISE_URL.replace(/\/$/, "");
  // Prefer the tailscale address (100.64.0.0/10) — reachable from every swarm
  // machine regardless of LAN; fall back to the first non-internal IPv4.
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal) as { address: string }[];
  const ts = addrs.find((a) => a.address.startsWith("100."));
  const ip = (ts ?? addrs[0])?.address ?? "localhost";
  return `http://${ip}:${PORT}`;
}

if (HUB_URL && SWARM_KEY) {
  const advertise = detectAdvertiseUrl();
  let lastOk: boolean | null = null;
  const register = async () => {
    try {
      const res = await fetch(`${HUB_URL}/nodes/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-swarm-key": SWARM_KEY },
        body: JSON.stringify({ url: advertise }),
        signal: AbortSignal.timeout(10_000),
      });
      const ok = res.ok;
      if (ok !== lastOk) {
        console.log(
          ok
            ? `registered with hub ${HUB_URL} as ${advertise}`
            : `hub rejected registration (HTTP ${res.status}): ${await res.text().catch(() => "")}`
        );
        lastOk = ok;
      }
    } catch (e) {
      if (lastOk !== false) {
        console.log(`hub unreachable for registration: ${e instanceof Error ? e.message : e}`);
        lastOk = false;
      }
    }
  };
  void register();
  setInterval(register, 60_000).unref();
} else {
  console.log("node discovery off (set DISPATCH_URL + SWARM_KEY in services/.env to join a hub)");
}
