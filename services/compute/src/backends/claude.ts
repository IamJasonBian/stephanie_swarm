// Claude backend — two modes, switched by CLAUDE_BACKEND:
//   api (default): @anthropic-ai/sdk messages.create with ANTHROPIC_API_KEY
//   cli:           spawns `claude -p --output-format json`, reusing the swarm's
//                  subscription auth (CLAUDE_CONFIG_DIR) with no API key.
// Both return an OpenAI chat-completion-shaped object so UI/Telegram clients
// can treat this service as a standard /v1/chat/completions source.

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BackendUnavailable, type ChatRequest, type ChatMessage } from "./ollama.ts";

const CLAUDE_BACKEND = process.env.CLAUDE_BACKEND ?? "api";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5";
// Same pattern as claude-code-telegram: point CLAUDE_CONFIG_DIR at a specific
// Claude account (e.g. /Users/<you>/.claude-stephanie2 for the shared bot
// account); unset ⇒ the machine's default login.
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const DEFAULT_MAX_TOKENS = 1024;

function cliEnv(): NodeJS.ProcessEnv {
  return CLAUDE_CONFIG_DIR ? { ...process.env, CLAUDE_CONFIG_DIR } : process.env;
}

// Online-check for cli mode: `claude --version` proves the binary is present
// and runnable without spending any model quota. Cached for a minute.
let cliProbe: { ok: boolean; at: number } | null = null;
function cliAvailable(): Promise<boolean> {
  if (cliProbe && Date.now() - cliProbe.at < 60_000) return Promise.resolve(cliProbe.ok);
  return new Promise((resolve) => {
    execFile("claude", ["--version"], { timeout: 10_000, env: cliEnv() }, (err) => {
      cliProbe = { ok: !err, at: Date.now() };
      resolve(!err);
    });
  });
}

// Constructed lazily so a missing key only fails claude requests, not boot.
let anthropic: Anthropic | null = null;

function openAiShape(text: string, finishReason: string, usage: { prompt_tokens: number; completion_tokens: number }) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "claude",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

// OpenAI message array → Anthropic params: system messages are lifted into
// the top-level system param; the rest must be user/assistant turns.
function splitMessages(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return { system: system || undefined, turns };
}

async function claudeViaApi(req: ChatRequest): Promise<unknown> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new BackendUnavailable("claude", "ANTHROPIC_API_KEY not set (or use CLAUDE_BACKEND=cli)");
  }
  anthropic ??= new Anthropic();
  const { system, turns } = splitMessages(req.messages);
  if (turns.length === 0) {
    throw new BackendUnavailable("claude", "no user/assistant messages in request");
  }

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
      system,
      messages: turns,
    });
  } catch (e) {
    if (e instanceof Anthropic.APIConnectionError) {
      throw new BackendUnavailable("claude", e.message);
    }
    throw e; // typed API errors (429, 400, ...) surface as-is to the route handler
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const finish =
    response.stop_reason === "max_tokens" ? "length"
    : response.stop_reason === "refusal" ? "content_filter"
    : "stop";
  return openAiShape(text, finish, {
    prompt_tokens: response.usage.input_tokens,
    completion_tokens: response.usage.output_tokens,
  });
}

async function claudeViaCli(req: ChatRequest): Promise<unknown> {
  const { system, turns } = splitMessages(req.messages);
  const transcript = turns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  // Pin the model — otherwise the CLI uses the account's default (which may
  // be a far more expensive tier than intended).
  const args = ["-p", "--output-format", "json", "--model", CLAUDE_MODEL];
  if (system) args.push("--append-system-prompt", system);
  args.push(transcript);

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "claude",
      args,
      { timeout: 300_000, maxBuffer: 10 * 1024 * 1024, env: cliEnv() },
      (err, out, stderr) => {
        if (err) reject(new BackendUnavailable("claude", `claude CLI: ${stderr || err.message}`.slice(0, 500)));
        else resolve(out);
      }
    );
  });

  let result: string;
  try {
    const parsed = JSON.parse(stdout) as { result?: string };
    result = parsed.result ?? "";
  } catch {
    throw new BackendUnavailable("claude", "claude CLI returned non-JSON output");
  }
  return openAiShape(result, "stop", { prompt_tokens: 0, completion_tokens: 0 });
}

export async function claudeChat(req: ChatRequest): Promise<unknown> {
  return CLAUDE_BACKEND === "cli" ? claudeViaCli(req) : claudeViaApi(req);
}

export async function claudeStatus(): Promise<{ backend: string; ready: boolean; model: string }> {
  const ready =
    CLAUDE_BACKEND === "cli" ? await cliAvailable() : Boolean(process.env.ANTHROPIC_API_KEY);
  return { backend: CLAUDE_BACKEND, ready, model: CLAUDE_MODEL };
}
