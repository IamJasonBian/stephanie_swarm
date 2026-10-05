// Generic adapter for any local runtime that speaks the OpenAI chat API —
// MLX (mlx_vlm.server), llama.cpp, vLLM, LocalAI. Unlike the hermes adapter
// this passes tool definitions and tool-call/tool-result messages through
// verbatim, which is what the harness needs.
//
// First instance: `qwen` → mlx_vlm.server on 127.0.0.1:8321 serving
// mlx-community/Qwen3.5-27B-6bit (see services/mlx/).

import { BackendUnavailable, type ChatRequest } from "./ollama.ts";

export interface OpenAICompatibleOptions {
  alias: string; // public model alias clients ask for
  baseUrl: string; // ".../v1"
  model: string; // model id the server expects
  apiKey?: string;
  timeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface ChatCompletion {
  id?: string;
  object?: string;
  model?: string;
  choices: {
    index?: number;
    message: { role: string; content: string | null; tool_calls?: ChatRequest["messages"][number]["tool_calls"] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class OpenAICompatibleBackend {
  private readonly opts: Required<Omit<OpenAICompatibleOptions, "apiKey">> & { apiKey?: string };

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = {
      timeoutMs: 300_000,
      healthTimeoutMs: 1_500,
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/$/, ""),
    };
  }

  get alias(): string {
    return this.opts.alias;
  }

  get modelName(): string {
    return this.opts.model;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest): Promise<ChatCompletion> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: req.messages,
      max_tokens: req.max_tokens,
      temperature: req.temperature,
      top_p: req.top_p,
      presence_penalty: req.presence_penalty,
      frequency_penalty: req.frequency_penalty,
      seed: req.seed,
      stream: false,
    };
    // Only send tool fields when present — some servers reject `tools: undefined`.
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
    }

    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      // Unreachable/timeout ⇒ 503-class so dispatch fails over to another node.
      throw new BackendUnavailable(this.opts.alias, e instanceof Error ? e.message : String(e));
    }
    if (res.status === 401 || res.status === 403) {
      throw new BackendUnavailable(this.opts.alias, "auth rejected — check the API key");
    }
    if (res.status === 404 || res.status === 503 || res.status >= 500) {
      const text = await res.text().catch(() => "");
      throw new BackendUnavailable(this.opts.alias, `HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json().catch(() => null)) as ChatCompletion | null;
    if (!res.ok || !json) {
      // 4xx with a body is a *request* problem (bad tool schema, too long) —
      // a plain Error so the route returns 502 and dispatch does NOT retry
      // the same payload elsewhere.
      const detail = json ? JSON.stringify(json).slice(0, 300) : "";
      throw new Error(`${this.opts.alias}: HTTP ${res.status} ${detail}`);
    }
    if (!Array.isArray(json.choices) || json.choices.length === 0 || !json.choices[0].message) {
      throw new Error(`${this.opts.alias}: malformed completion (no choices[0].message)`);
    }
    // Re-alias so clients see the option they asked for.
    json.model = this.opts.alias;
    return json;
  }

  // Ready ⇔ the server answers /models and lists our model (mlx_vlm.server
  // only lists models it has actually loaded).
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.opts.healthTimeoutMs),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? []).map((m) => m.id ?? "");
      return ids.some((id) => id === this.opts.model || id.endsWith(`/${this.opts.model}`) || this.opts.model.endsWith(`/${id}`));
    } catch {
      return false;
    }
  }

  status(): { alias: string; model: string; via: string } {
    return { alias: this.opts.alias, model: this.opts.model, via: this.opts.baseUrl };
  }
}

// --- qwen: local MLX server -------------------------------------------------
export const qwen = new OpenAICompatibleBackend({
  alias: "qwen",
  baseUrl: process.env.MLX_URL ?? "http://127.0.0.1:8321/v1",
  model: process.env.MLX_MODEL ?? "mlx-community/Qwen3.5-27B-6bit",
  apiKey: process.env.MLX_API_KEY,
});
