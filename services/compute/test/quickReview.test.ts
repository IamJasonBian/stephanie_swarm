import { test } from "node:test";
import assert from "node:assert/strict";
import { clipDiff, createQuickReviewHandler } from "../src/quickReviewMcp.ts";
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

test("review reads one clipped diff and does not call the model without one", async () => {
  const seen: ChatRequest[] = [];
  let loads = 0;
  const handler = createQuickReviewHandler(async (req) => {
    seen.push(req);
    return { choices: [{ message: { role: "assistant", content: "Explain: subtracts.\nAttack: - [high] add.ts: sign flipped" } }] };
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
  assert.match(called.result.content[0].text, /# quick-review \(\d+ms\)/);
  assert.match(called.result.content[0].text, /Explain: subtracts/);
  assert.equal(seen.length, 1);
  assert.match(String(seen[0].messages[0].content), /Explain:/);
  assert.match(String(seen[0].messages[0].content), /Attack:/);
  assert.equal(seen[0].max_tokens, 40);
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
    return { choices: [{ message: { role: "assistant", content: "nope" } }] };
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
