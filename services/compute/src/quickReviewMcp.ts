// Streamable-HTTP MCP at POST /quick-review. One short pass over a clipped PR
// diff on the warm 1.5B model, budgeted so the tool returns in under 2 seconds.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ChatRequest } from "./backends/ollama.ts";
import type { ChatCompletion } from "./backends/openaiCompatible.ts";
import { loadPullRequestDiff } from "./prDiff.ts";

export type QuickChat = (req: ChatRequest, signal: AbortSignal) => Promise<ChatCompletion>;
export type LoadDiff = (
  repo: string,
  pr: string | number,
  timeoutMs: number,
) => Promise<{ repo: string; pr: string; diff: string }>;

const BUDGET_MS = 1_900;
const GH_CAP_MS = 900;
const MODEL_FLOOR_MS = 200;
const SNIPPET_CAP = 1_000;
const MAX_TOKENS = 40;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.QUICK_REVIEW_MODEL ?? "qwen2.5:1.5b";

const SYSTEM = [
  "You have one second. Two lines only.",
  "Explain: one sentence on what the diff does.",
  "Attack: - [high|med|low] where: one concrete break.",
  "If you cannot break it, write \"Attack: No break found.\"",
].join(" ");

export function clipDiff(diff: string, cap = SNIPPET_CAP): string {
  const text = diff.trim();
  if (text.length <= cap) return text;
  return text.slice(0, cap) + "\n…[truncated]";
}

export async function ollamaQuickChat(req: ChatRequest, signal: AbortSignal): Promise<ChatCompletion> {
  const res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: req.messages,
      max_tokens: req.max_tokens,
      temperature: 0,
      stream: false,
      keep_alive: "30m",
    }),
    signal,
  });
  const json = (await res.json().catch(() => null)) as ChatCompletion | null;
  if (!res.ok || !json?.choices?.[0]?.message) {
    const detail = json ? JSON.stringify(json).slice(0, 200) : "";
    throw new Error(`quick-review model HTTP ${res.status} ${detail}`);
  }
  return json;
}

function missedBudget(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /timed out|missed its 2s budget/i.test(error.message);
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

export function createQuickReviewHandler(
  chat: QuickChat = ollamaQuickChat,
  loadDiff: LoadDiff = loadPullRequestDiff,
  budgetMs = BUDGET_MS,
) {
  return async function handleQuickReview(req: Request): Promise<Response> {
    const server = new McpServer({ name: "quick-review", version: "1.0.0" });
    server.registerTool(
      "review",
      {
        title: "Quick code review",
        description:
          "One-pass review of a pull request that returns in under 2 seconds. Requires a git repo (local checkout or GitHub owner/name) and a PR number or URL. Reads a short clip of the diff on a small local model and answers with Explain: then Attack:.",
        inputSchema: {
          repo: z.string().describe("Local git checkout path, or GitHub owner/name"),
          pr: z.union([z.number().int().positive(), z.string().min(1)]).describe("Pull request number or github.com pull URL"),
        },
      },
      async ({ repo, pr }) => {
        const started = performance.now();
        const left = () => budgetMs - (performance.now() - started);
        const ghTimeout = Math.max(50, Math.min(GH_CAP_MS, Math.floor(left()) - MODEL_FLOOR_MS));
        let loaded: { repo: string; pr: string; diff: string };
        try {
          loaded = await loadDiff(repo, pr, ghTimeout);
        } catch (e) {
          const message = missedBudget(e) ? "quick-review missed its 2s budget" : e instanceof Error ? e.message : String(e);
          return toolError(message);
        }
        const diff = clipDiff(loaded.diff);
        if (!diff) return toolError(`PR #${loaded.pr} in ${loaded.repo} has no diff`);
        if (left() < MODEL_FLOOR_MS) return toolError("quick-review missed its 2s budget");
        try {
          const result = await chat(
            {
              messages: [
                { role: "system", content: SYSTEM },
                { role: "user", content: diff },
              ],
              max_tokens: MAX_TOKENS,
              temperature: 0,
            },
            AbortSignal.timeout(Math.max(1, Math.floor(left()))),
          );
          const text = (result.choices[0]?.message?.content ?? "").trim();
          if (!text) return toolError("quick-review returned an empty review");
          const ms = Math.round(performance.now() - started);
          return {
            content: [{
              type: "text" as const,
              text: `# quick-review (${ms}ms)\nrepo: ${loaded.repo}\npr: #${loaded.pr}\n\n${text}\n`,
            }],
          };
        } catch (e) {
          const message = missedBudget(e) ? "quick-review missed its 2s budget" : e instanceof Error ? e.message : String(e);
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
