import { test } from "node:test";
import assert from "node:assert/strict";
import { createCheapReviewHandler, runReviews, type ReviewJobInput } from "../src/cheapReviewMcp.ts";
import type { ChatRequest } from "../src/backends/ollama.ts";

const ACCEPT = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function rpc(method: string, params: unknown, id = 1): Request {
  return new Request("http://localhost/cheap-review", {
    method: "POST",
    headers: ACCEPT,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const jobs: ReviewJobInput[] = [
  { path: "a.ts", diff: "--- a\n+++ b\n+return a - b" },
  { path: "b.ts", code: "function add(a, b) { return a - b }" },
];

test("sequence feeds earlier findings into the next job", async () => {
  const seen: ChatRequest[] = [];
  const results = await runReviews(async (req) => {
    seen.push(req);
    return { choices: [{ message: { role: "assistant", content: `note ${seen.length}` } }] };
  }, jobs, "sequence", "watch the arithmetic", 64);
  assert.equal(seen.length, 2);
  assert.match(String(seen[0].messages[1].content), /return a - b/);
  assert.match(String(seen[0].messages[1].content), /watch the arithmetic/);
  assert.doesNotMatch(String(seen[0].messages[1].content), /Findings already reported/);
  assert.match(String(seen[1].messages[1].content), /note 1/);
  assert.match(String(seen[0].messages[0].content), /Explain:/);
  assert.match(String(seen[0].messages[0].content), /Attack:/);
  assert.equal(seen[0].temperature, 0);
  assert.equal(results.map((r) => r.text).join(","), "note 1,note 2");
});

test("parallel runs jobs at the same time and does not share findings", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const seen: string[] = [];
  await runReviews(async (req) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    seen.push(String(req.messages[1].content));
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    return { choices: [{ message: { role: "assistant", content: "No findings." } }] };
  }, jobs, "parallel", undefined, 64);
  assert.equal(maxInFlight, 2);
  assert.equal(seen.some((p) => p.includes("Findings already reported")), false);
});

test("review tool requires a repo and a pr, then reviews each file", async () => {
  const handler = createCheapReviewHandler(async () => ({
    choices: [{ message: { role: "assistant", content: "No findings." } }],
  }), async () => ({
    repo: "acme/widget",
    pr: "14",
    title: "Fix add",
    url: "https://github.com/acme/widget/pull/14",
    jobs,
  }));
  const init = (await (await handler(rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  }))).json()) as { result: { serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, "cheap-review");

  const listed = (await (await handler(rpc("tools/list", {}))).json()) as {
    result: { tools: { name: string; inputSchema: { required?: string[] } }[] };
  };
  assert.deepEqual(listed.result.tools.map((t) => t.name), ["review"]);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ["repo", "pr"]);

  const called = (await (await handler(rpc("tools/call", {
    name: "review",
    arguments: { repo: "acme/widget", pr: 14, mode: "parallel" },
  }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(called.result.isError, undefined);
  assert.match(called.result.content[0].text, /# cheap-review \(parallel, 2 files\)/);
  assert.match(called.result.content[0].text, /repo: acme\/widget/);
  assert.match(called.result.content[0].text, /pr: #14 Fix add/);
  assert.match(called.result.content[0].text, /## a\.ts/);
});

test("a repo that is not git is a tool error and does not call the model", async () => {
  const handler = createCheapReviewHandler(async () => {
    throw new Error("should not call the model");
  }, async () => {
    throw new Error("/tmp/nope is not a git repo");
  });
  const called = (await (await handler(rpc("tools/call", {
    name: "review",
    arguments: { repo: "/tmp/nope", pr: "1" },
  }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /not a git repo/);
});

test("a pull request with no diff is a tool error", async () => {
  const handler = createCheapReviewHandler(async () => {
    throw new Error("should not call the model");
  }, async () => ({ repo: "acme/widget", pr: "3", title: "", url: "", jobs: [] }));
  const called = (await (await handler(rpc("tools/call", {
    name: "review",
    arguments: { repo: "acme/widget", pr: 3 },
  }))).json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(called.result.isError, true);
  assert.match(called.result.content[0].text, /no diff/);
});
