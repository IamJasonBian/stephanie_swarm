// Streamable-HTTP MCP at POST /quick-review. The fast model returns a finished
// review. Pass model "--3.5" for local Qwen3.5, whose thinking block is printed
// and then capped so the answer still arrives.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ChatRequest } from "./backends/ollama.ts";
import { loadPullRequestDiff } from "./prDiff.ts";

export type QuickModel = "fast" | "3.5";

export interface QuickDraft {
  content: string;
  reasoning: string;
}

export type QuickChat = (req: ChatRequest, signal: AbortSignal, model: QuickModel) => Promise<QuickDraft>;
export type LoadDiff = (
  repo: string,
  pr: string | number,
  timeoutMs: number,
) => Promise<{ repo: string; pr: string; diff: string }>;

const GH_CAP_MS = 1_250;
const MODEL_FLOOR_MS = 200;
const SNIPPET_CAP = 1_000;
export const FAST_MAX_TOKENS = 160;
export const QWEN35_MAX_TOKENS = 140;
const THINK_BUDGET = 40;
const FAST_TIMEOUT_MS = 5_000;
const QWEN35_TIMEOUT_MS = 15_000;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const FAST_MODEL = process.env.QUICK_REVIEW_MODEL ?? "qwen2.5:1.5b";
const DEFAULT_MODEL = process.env.QUICK_REVIEW_DEFAULT ?? "--fast";
const QWEN35_URL = (process.env.MLX_URL ?? "http://127.0.0.1:8321/v1").replace(/\/$/, "");
const QWEN35_MODEL = process.env.MLX_MODEL ?? "mlx-community/Qwen3.5-27B-6bit";

const SYSTEM = [
  "Think briefly, then exactly two lines, and stop. Do not quote the diff.",
  "Explain: one sentence on what the diff does.",
  "Attack: - [high|med|low] where: one concrete break.",
  "If you cannot break it, write \"Attack: No break found.\"",
].join(" ");

export function parseQuickModel(value: string | undefined): QuickModel {
  const text = (value?.trim() || DEFAULT_MODEL).toLowerCase();
  if (text === "fast" || text === "--fast") return "fast";
  if (text === "3.5" || text === "--3.5" || text === "qwen3.5" || text === "latest" || text === "--latest") {
    return "3.5";
  }
  throw new Error("model must be --fast, --3.5, or --latest");
}

export function modelLabel(model: QuickModel): string {
  return model === "3.5" ? QWEN35_MODEL.split("/").pop()! : FAST_MODEL;
}

export function clipDiff(diff: string, cap = SNIPPET_CAP): string {
  const text = diff.trim();
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "\n…[truncated]";
}

// The review is complete once the Attack line has actually ended.
export function answerReady(text: string): boolean {
  const at = text.search(/Attack:/);
  if (at < 0) return false;
  const line = text.slice(at).split("\n")[0].trim();
  if (line.length < "Attack: x".length) return false;
  return text.slice(at).includes("\n") || /[.!?]$/.test(line) || /no break found[.!?]?$/i.test(line);
}

export function splitThink(content: string, reasoning: string): { think: string; answer: string } {
  let think = reasoning.trim();
  let answer = content;
  const tagged = answer.match(/<think>([\s\S]*?)<\/think>/i);
  if (tagged) {
    if (!think) think = tagged[1].trim();
    answer = answer.replace(tagged[0], "").trim();
  }
  return { think, answer: answer.trim() };
}

export function formatQuickReview(input: {
  model: QuickModel;
  ms: number;
  repo: string;
  pr: string;
  content: string;
  reasoning: string;
}): string {
  const { think, answer } = splitThink(input.content, input.reasoning);
  const body = think ? `<think>\n${think}\n</think>\n\n${answer}` : answer;
  return `# quick-review (${modelLabel(input.model)}, ${input.ms}ms)\nrepo: ${input.repo}\npr: #${input.pr}\n\n${body}\n`;
}

async function readChatStream(res: Response): Promise<QuickDraft> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("quick-review model returned no stream");
  const decoder = new TextDecoder();
  let pending = "";
  let content = "";
  let reasoning = "";
  const take = (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    const chunk = JSON.parse(payload) as {
      choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string }; message?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
    };
    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? choice?.message;
    if (!delta) return;
    content += delta.content ?? "";
    reasoning += delta.reasoning_content ?? delta.reasoning ?? "";
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        try {
          take(trimmed.slice(5).trim());
        } catch {
          // Ignore a partial or non-JSON keepalive line.
        }
        if (answerReady(content)) return { content, reasoning };
      }
    }
  } catch (e) {
    // A deadline still returns the thinking and answer gathered so far.
    if (content.trim() || reasoning.trim()) return { content, reasoning };
    throw e;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { content, reasoning };
}

export async function streamQuickChat(req: ChatRequest, signal: AbortSignal, model: QuickModel): Promise<QuickDraft> {
  const qwen35 = model === "3.5";
  const res = await fetch(qwen35 ? `${QWEN35_URL}/chat/completions` : `${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: qwen35 ? QWEN35_MODEL : FAST_MODEL,
      messages: req.messages,
      max_tokens: req.max_tokens,
      temperature: 0,
      stream: true,
      ...(qwen35 ? { enable_thinking: true, thinking_budget: THINK_BUDGET } : { keep_alive: "30m" }),
    }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`quick-review model HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  try {
    return await readChatStream(res);
  } catch (e) {
    if (signal.aborted) throw e;
    throw e;
  }
}

function missedBudget(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /timed out|missed its 2s budget/i.test(error.message);
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

export function createQuickReviewHandler(
  chat: QuickChat = streamQuickChat,
  loadDiff: LoadDiff = loadPullRequestDiff,
  budgetMs = 1_900,
) {
  return async function handleQuickReview(req: Request): Promise<Response> {
    const server = new McpServer({ name: "quick-review", version: "1.0.0" });
    server.registerTool(
      "review",
      {
        title: "Quick code review",
        description:
          "One-pass review of a pull request. Requires a git repo (local checkout or GitHub owner/name) and a PR number or URL. Returns the full Explain and Attack, and prints a <think> block when the model produced one. model accepts --fast, --3.5, or --latest; QUICK_REVIEW_DEFAULT changes the default.",
        inputSchema: {
          repo: z.string().describe("Local git checkout path, or GitHub owner/name"),
          pr: z.union([z.number().int().positive(), z.string().min(1)]).describe("Pull request number or github.com pull URL"),
          model: z.string().optional().describe("--fast, --3.5, or --latest; omit to use QUICK_REVIEW_DEFAULT"),
        },
      },
      async ({ repo, pr, model }) => {
        let which: QuickModel;
        try {
          which = parseQuickModel(model);
        } catch (e) {
          return toolError(e instanceof Error ? e.message : String(e));
        }
        const started = performance.now();
        const left = () => budgetMs - (performance.now() - started);
        const ghTimeout = Math.max(50, Math.min(GH_CAP_MS, Math.floor(left()) - MODEL_FLOOR_MS));
        let loaded: { repo: string; pr: string; diff: string };
        try {
          loaded = await loadDiff(repo, pr, ghTimeout);
        } catch (e) {
          const message = missedBudget(e) ? "quick-review missed its 2s fetch budget" : e instanceof Error ? e.message : String(e);
          return toolError(message);
        }
        const diff = clipDiff(loaded.diff);
        if (!diff) return toolError(`PR #${loaded.pr} in ${loaded.repo} has no diff`);
        if (left() < MODEL_FLOOR_MS) return toolError("quick-review missed its 2s budget");
        const timeout = which === "3.5" ? QWEN35_TIMEOUT_MS : FAST_TIMEOUT_MS;
        try {
          const draft = await chat(
            {
              messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: `Do not quote the diff.\n\n${diff}` },
              ],
              max_tokens: which === "3.5" ? QWEN35_MAX_TOKENS : FAST_MAX_TOKENS,
              temperature: 0,
            },
            AbortSignal.timeout(timeout),
            which,
          );
          const { answer } = splitThink(draft.content, draft.reasoning);
          if (!answer && !draft.reasoning.trim()) return toolError("quick-review returned an empty review");
          return {
            content: [{
              type: "text" as const,
              text: formatQuickReview({
                model: which,
                ms: Math.round(performance.now() - started),
                repo: loaded.repo,
                pr: loaded.pr,
                content: draft.content,
                reasoning: draft.reasoning,
              }),
            }],
          };
        } catch (e) {
          const message = missedBudget(e) ? `${modelLabel(which)} timed out` : e instanceof Error ? e.message : String(e);
          return toolError(message);
        }
      },
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(req);
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  };
}

export const handleQuickReview = createQuickReviewHandler();
