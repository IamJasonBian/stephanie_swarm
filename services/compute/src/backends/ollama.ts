// Hermes backend — proxies to Ollama's OpenAI-compatible endpoint.
// The local model is free to run, so no rate limiting here; concurrency is
// the dispatch service's job (HERMES_CONCURRENCY=1 by default).

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const HERMES_MODEL = process.env.HERMES_MODEL ?? "hermes3:8b";

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
}

export class BackendUnavailable extends Error {
  readonly backend: string;
  constructor(backend: string, cause: string) {
    super(`${backend} unavailable: ${cause}`);
    this.backend = backend;
  }
}

export async function hermesChat(req: ChatRequest): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: HERMES_MODEL,
        messages: req.messages,
        max_tokens: req.max_tokens,
        // Small local models repeat themselves at low temperature; default to
        // livelier sampling + a repetition penalty. All overridable per request
        // (or via HERMES_TEMPERATURE / HERMES_FREQUENCY_PENALTY).
        temperature: req.temperature ?? Number(process.env.HERMES_TEMPERATURE ?? 0.9),
        frequency_penalty: req.frequency_penalty ?? Number(process.env.HERMES_FREQUENCY_PENALTY ?? 0.5),
        top_p: req.top_p,
        presence_penalty: req.presence_penalty,
        seed: req.seed,
        stream: false,
      }),
      // Local 8B models can take a while on long prompts.
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new BackendUnavailable("hermes", e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BackendUnavailable("hermes", `HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  // Re-alias the model so clients see the option they asked for.
  json.model = "hermes";
  return json;
}

export async function hermesHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).some((m) => m.name === HERMES_MODEL || m.name.startsWith(HERMES_MODEL));
  } catch {
    return false;
  }
}

export function hermesModelName(): string {
  return HERMES_MODEL;
}
