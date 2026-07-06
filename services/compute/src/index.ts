// General-purpose compute service.
//   POST /v1/chat/completions  — OpenAI-compatible; model: "hermes" | "claude"
//   POST /v1/execute           — Judge0 code execution (503 until JUDGE0_URL set)
//   GET  /health               — backend readiness
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hermesChat, hermesHealthy, hermesModelName, BackendUnavailable, type ChatRequest } from "./backends/ollama.ts";
import { claudeChat, claudeStatus } from "./backends/claude.ts";
import { kimiChat, kimiStatus } from "./backends/kimi.ts";
import { convertDocument, converterReady, type DocumentInput } from "./backends/converter.ts";
import { runPython, Judge0Unavailable, type Judge0SubmitOptions } from "./judge0Client.ts";

const PORT = Number(process.env.PORT ?? 8878);
const MODELS = ["hermes", "claude", "kimi"] as const;
type ModelAlias = (typeof MODELS)[number];

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
  const [hermes, converter, claude] = await Promise.all([
    hermesHealthy(),
    converterReady(),
    claudeStatus(),
  ]);
  const kimi = kimiStatus();
  const judge0 = Boolean(process.env.JUDGE0_URL);
  return c.json({
    ok: hermes || claude.ready || kimi.ready,
    backends: {
      hermes: { reachable: hermes, model: hermesModelName() },
      claude,
      kimi,
      judge0: { configured: judge0 },
      converter: { ready: converter, engine: "docling" },
    },
    basePrompt: basePrompt ? basename(BASE_PROMPT_FILE) : null,
  });
});

app.get("/v1/models", async (c) => {
  const [hermes, claude] = await Promise.all([hermesHealthy(), claudeStatus()]);
  const online: Record<ModelAlias, boolean> = {
    hermes,
    claude: claude.ready,
    kimi: kimiStatus().ready,
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
