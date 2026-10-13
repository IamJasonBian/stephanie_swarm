import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerReady,
  clipDiff,
  createQuickReviewHandler,
  FAST_MAX_TOKENS,
  parseQuickModel,
  QWEN35_MAX_TOKENS,
} from "../src/quickReviewMcp.ts";
import type { ChatRequest } from "../src/backends/ollama.ts";

const ACCEPT = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function rpc(method: string, params: unknown, id = 1): Request {
  return new Request("http://localhost/quick-review", {
    method: "POST",
    headers: ACCEPT,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const diff = "diff --git a/add.ts b/add.ts\n- return a + b\n+ return a - b\n";

test("clipDiff keeps a short diff and marks a long one", () => {
  assert.equal(clipDiff("abc", 10), "abc");
  const clipped = clipDiff("x".repeat(50), 10);
  assert.equal(clipped.startsWith("x".repeat(10)), true);
  assert.match(clipped, /truncated/);
});

test("an Attack line is ready once it ends", () => {
  assert.equal(answerReady("Explain: subtracts."), false);
  assert.equal(answerReady("Attack: -"), false);
  assert.equal(answerReady("Attack: - [high] add.ts"), false);
  assert.equal(answerReady("Explain: subtracts.\nAttack: - [high] add.ts: sign flipped."), true);
});

test("model flags resolve fast and newest-model aliases", () => {
  assert.equal(parseQuickModel("--fast"), "fast");
  assert.equal(parseQuickModel("--3.5"), "3.5");
  assert.equal(parseQuickModel("--latest"), "3.5");
  assert.throws(() => parseQuickModel("--unknown"), /--fast, --3.5, or --latest/);
});

test("review reads one clipped diff and does not call the model without one", async () => {
  const seen: ChatRequest[] = [];
  let loads = 0;
  const handler = createQuickReviewHandler(async (req) => {
    seen.push(req);
    return { content: "Explain: subtracts.\nAttack: - [high] add.ts: sign flipped.", reasoning: "" };
  }, async () => {
    loads++;
    return { repo: "acme/widget", pr: "14", diff: `${diff}${"y".repeat(5_000)}` };
  });

  const init = (await (await handler(rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  }))).json()) as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, "quick-review");

  const listed = (await (await handler(rpc("tools/list", {}))).json()) as {
    result: { tools: { name: string; inputSchema: { required?: string[] } }[] };
  };
  assert.deepEqual(listed.result.tools.map((t) => t.name), ["review"]);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ["repo", "pr"]);

  const called = (await (await handler(rpc("tools/call", {
    name: "review",
    arguments: { repo: "acme/widget", pr: 14 },
  }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(called.result.isError, undefined);
  assert.match(called.result.content[0].text, /# quick-review \(qwen2\.5:1\.5b, \d+ms\)/);
  assert.match(called.result.content[0].text, /Explain: subtracts/);
  assert.doesNotMatch(called.result.content[0].text, /<think>/);
  assert.equal(seen.length, 1);
  assert.match(String(seen[0].messages[0].content), /Explain:/);
  assert.match(String(seen[0].messages[0].content), /Attack:/);
  assert.equal(seen[0].max_tokens, FAST_MAX_TOKENS);
  assert.equal(seen[0].temperature, 0);
  const prompt = String(seen[0].messages[1].content);
  assert.match(prompt, /return a - b/);
  assert.ok(prompt.length < 1_200);
  assert.match(prompt, /truncated/);

  const empty = createQuickReviewHandler(async () => {
    throw new Error("model should not run");
  }, async () => ({ repo: "acme/widget", pr: "14", diff: "  \n" }));
  const noDiff = (await (await empty(rpc("tools/call", {
    name: "review",
    arguments: { repo: "acme/widget", pr: 14 },
  }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(noDiff.result.isError, true);
  assert.match(noDiff.result.content[0].text, /no diff/);
  assert.equal(loads, 1);
});

test("a slow diff load returns a budget error and skips the model", async () => {
  let chats = 0;
  const handler = createQuickReviewHandler(async () => {
    chats++;
    return { content: "nope", reasoning: "" };
  }, async () => {
    await new Promise((r) => setTimeout(r, 80));
    return { repo: "acme/widget", pr: "1", diff };
  }, 30);
  const result = (await (await handler(rpc("tools/call", {
    name: "review",
    arguments: { repo: "acme/widget", pr: 1 },
  }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /2s budget/);
  assert.equal(chats, 0);
});

test("--3.5 uses Qwen3.5 and prints the thinking block", async () => {
  const seen: string[] = [];
  const handler = createQuickReviewHandler(async (req, _signal, model) => {
    seen.push(`${model}:${req.max_tokens}`);
    return {
      reasoning: "The sign flipped from add to subtract.",
      content: "Explain: add() now subtracts.\nAttack: - [high] add.ts: the sign flipped.",
    };
  }, async () => ({ repo: "acme/widget", pr: "14", diff }));
  const called = (await (await handler(rpc("tools/call", {
    name: "review",
    arguments: { repo: "acme/widget", pr: 14, model: "--3.5" },
  }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(called.result.isError, undefined);
  assert.deepEqual(seen, [`3.5:${QWEN35_MAX_TOKENS}`]);
  const text = called.result.content[0].text;
  assert.match(text, /Qwen3\.5/);
  assert.match(text, /<think>\nThe sign flipped from add to subtract\.\n<\/think>/);
  assert.match(text, /Attack: - \[high\] add\.ts: the sign flipped\./);
});
