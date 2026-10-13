// Streamable-HTTP MCP at POST /cheap-review. Same local Qwen3.5 as /offload,
// but each call is a batch of code-review jobs run in sequence or in parallel.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { ChatRequest } from "./backends/ollama.ts";
import { qwen, type ChatCompletion } from "./backends/openaiCompatible.ts";
import { loadPullRequest, type LoadedPr } from "./prDiff.ts";

export type ReviewChat = (req: ChatRequest) => Promise<ChatCompletion>;

const MAX_JOBS = 8;
const MAX_TOKENS_CAP = 512;
const DEFAULT_MAX_TOKENS = 256;
const SNIPPET_CAP = 8_000;
const PARALLEL_LIMIT = Math.max(1, Number(process.env.CHEAP_REVIEW_PARALLEL ?? 4));

const SYSTEM = [
  "You are a fast adversarial code reader. Callers will run you often, so stay short.",
  "Read only the diff you are given.",
  "First explain what the change does, in at most three sentences, starting with \"Explain:\".",
  "Then attack it. Name one concrete way it is wrong, breaks, or can be abused, as \"Attack: - [high|med|low] where: issue\".",
  "If you cannot break it, write \"Attack: No break found.\"",
  "No praise, no style notes, no restating the diff.",
].join(" ");

export interface ReviewJobInput {
  id?: string;
  path?: string;
  diff?: string;
  code?: string;
  question?: string;
}

export interface ReviewResult {
  label: string;
  text: string;
  error?: boolean;
}

function clip(text: string | undefined): string {
  const value = (text ?? "").trim();
  if (value.length <= SNIPPET_CAP) return value;
  return value.slice(0, SNIPPET_CAP) + "\n…[truncated]";
}

function jobLabel(job: ReviewJobInput, index: number): string {
  return job.id?.trim() || job.path?.trim() || `job ${index + 1}`;
}

function jobBody(job: ReviewJobInput): string | null {
  const diff = clip(job.diff);
  const code = clip(job.code);
  if (!diff && !code) return null;
  const parts = [];
  if (job.path?.trim()) parts.push(`Path: ${job.path.trim()}`);
  if (job.question?.trim()) parts.push(`Question: ${job.question.trim()}`);
  if (diff) parts.push(`Diff:\n${diff}`);
  if (code) parts.push(`Code:\n${code}`);
  return parts.join("\n\n");
}

export function reviewPrompt(job: ReviewJobInput, focus: string | undefined, earlier: string[]): string {
  const body = jobBody(job);
  const parts = [body ?? ""];
  if (focus?.trim()) parts.unshift(`Focus: ${focus.trim()}`);
  if (earlier.length) parts.push(`Findings already reported in this batch:\n${earlier.join("\n\n")}`);
  return parts.filter(Boolean).join("\n\n");
}

async function reviewOne(
  chat: ReviewChat,
  job: ReviewJobInput,
  index: number,
  focus: string | undefined,
  earlier: string[],
  maxTokens: number,
): Promise<ReviewResult> {
  const label = jobLabel(job, index);
  const prompt = reviewPrompt(job, focus, earlier);
  if (!jobBody(job)) {
    return { label, text: "skipped: provide diff or code", error: true };
  }
  try {
    const result = await chat({
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    });
    const text = (result.choices[0]?.message?.content ?? "").trim() || "(empty review)";
    return { label, text };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { label, text: message, error: true };
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runReviews(
  chat: ReviewChat,
  jobs: ReviewJobInput[],
  mode: "sequence" | "parallel",
  focus: string | undefined,
  maxTokens: number,
): Promise<ReviewResult[]> {
  if (mode === "parallel") {
    return mapPool(jobs, PARALLEL_LIMIT, (job, index) => reviewOne(chat, job, index, focus, [], maxTokens));
  }
  const results: ReviewResult[] = [];
  const earlier: string[] = [];
  for (let index = 0; index < jobs.length; index++) {
    const result = await reviewOne(chat, jobs[index], index, focus, earlier, maxTokens);
    results.push(result);
    if (!result.error) earlier.push(`## ${result.label}\n${result.text.slice(0, 240)}`);
  }
  return results;
}

export function formatReviews(
  mode: "sequence" | "parallel",
  results: ReviewResult[],
  source?: { repo: string; pr: string; title?: string; url?: string; skipped?: number },
): string {
  const head = [`# cheap-review (${mode}, ${results.length} file${results.length === 1 ? "" : "s"})`];
  if (source) {
    head.push(`repo: ${source.repo}`);
    head.push(`pr: #${source.pr}${source.title ? ` ${source.title}` : ""}${source.url ? ` ${source.url}` : ""}`);
    if (source.skipped) head.push(`skipped: ${source.skipped} more files (cap ${MAX_JOBS})`);
  }
  const body = results.map((r) => `## ${r.label}\n${r.text}`).join("\n\n");
  return `${head.join("\n")}\n\n${body}\n`;
}

export type LoadPr = (repo: string, pr: string | number) => Promise<LoadedPr>;

export function createCheapReviewHandler(chat: ReviewChat = (req) => qwen.chat(req), loadPr: LoadPr = loadPullRequest) {
  return async function handleCheapReview(req: Request): Promise<Response> {
    const server = new McpServer({ name: "cheap-review", version: "1.0.0" });
    server.registerTool(
      "review",
      {
        title: "Cheap code review",
        description:
          "Fast adversarial read of a pull request on local Qwen3.5. Meant to be called often. Requires a git repo (local checkout or GitHub owner/name) and a PR number or URL. Each changed file is explained, then attacked. mode=parallel (default) runs up to 4 files at once. mode=sequence runs one file at a time and shows earlier attacks to the next file.",
        inputSchema: {
          repo: z.string().describe("Local git checkout path, or GitHub owner/name"),
          pr: z.union([z.number().int().positive(), z.string().min(1)]).describe("Pull request number or github.com pull URL"),
          mode: z.enum(["sequence", "parallel"]).optional().describe("Default parallel, so a batch returns quickly"),
          focus: z.string().optional().describe("Extra instruction applied to every file"),
          max_tokens: z
            .number()
            .int()
            .positive()
            .max(MAX_TOKENS_CAP)
            .optional()
            .describe("Per-file completion cap (default 256, max 512)"),
        },
      },
      async ({ repo, pr, mode, focus, max_tokens }) => {
        let loaded: LoadedPr;
        try {
          loaded = await loadPr(repo, pr);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
        if (loaded.jobs.length === 0) {
          return { content: [{ type: "text" as const, text: `PR #${loaded.pr} in ${loaded.repo} has no diff` }], isError: true };
        }
        const jobs = loaded.jobs.slice(0, MAX_JOBS);
        const how = mode ?? "parallel";
        const results = await runReviews(chat, jobs, how, focus, max_tokens ?? DEFAULT_MAX_TOKENS);
        const allFailed = results.every((r) => r.error);
        return {
          content: [{
            type: "text" as const,
            text: formatReviews(how, results, { ...loaded, skipped: loaded.jobs.length - jobs.length }),
          }],
          ...(allFailed ? { isError: true } : {}),
        };
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

export const handleCheapReview = createCheapReviewHandler();
