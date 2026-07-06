// Kimi backend — Moonshot AI's Kimi K2.6 via OpenRouter (OpenAI-compatible).
// K2.6 is a 1T-param MoE (262K context, tool calling, vision) — far too large
// to host locally, so this is API-only. Default model is the OpenRouter free
// tier; set KIMI_MODEL=moonshotai/kimi-k2.6 for the paid variant, or point
// KIMI_URL at Moonshot's own platform (also OpenAI-compatible).

import { BackendUnavailable, type ChatRequest } from "./ollama.ts";

const KIMI_URL = process.env.KIMI_URL ?? "https://openrouter.ai/api/v1";
const KIMI_MODEL = process.env.KIMI_MODEL ?? "moonshotai/kimi-k2.6:free";
const API_KEY_ENV = process.env.KIMI_URL ? "KIMI_API_KEY" : "OPENROUTER_API_KEY";

function apiKey(): string | undefined {
  return process.env.KIMI_API_KEY ?? process.env.OPENROUTER_API_KEY;
}

export async function kimiChat(req: ChatRequest): Promise<unknown> {
  const key = apiKey();
  if (!key) {
    throw new BackendUnavailable("kimi", `${API_KEY_ENV} not set`);
  }
  let res: Response;
  try {
    res = await fetch(`${KIMI_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: req.messages,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
        top_p: req.top_p,
        presence_penalty: req.presence_penalty,
        frequency_penalty: req.frequency_penalty,
        stream: false,
      }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    throw new BackendUnavailable("kimi", e instanceof Error ? e.message : String(e));
  }
  if (res.status === 401 || res.status === 403) {
    throw new BackendUnavailable("kimi", "auth rejected — check the API key");
  }
  if (res.status === 429 || res.status >= 500) {
    throw new BackendUnavailable("kimi", `HTTP ${res.status} (rate limit / upstream)`);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json) {
    const detail = json ? JSON.stringify(json).slice(0, 200) : "";
    throw new BackendUnavailable("kimi", `HTTP ${res.status} ${detail}`);
  }
  json.model = "kimi";
  return json;
}

export function kimiStatus(): { ready: boolean; model: string; via: string } {
  return { ready: Boolean(apiKey()), model: KIMI_MODEL, via: KIMI_URL };
}
