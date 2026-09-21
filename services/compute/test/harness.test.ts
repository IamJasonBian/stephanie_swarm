import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleBackend } from "../src/backends/openaiCompatible.ts";
import { parseProfile, loadProfiles, ProfileError, type HarnessProfile } from "../src/harness/profiles.ts";
import { McpManager } from "../src/harness/mcpClient.ts";
import { runAgent } from "../src/harness/agentLoop.ts";
import { startFakeOpenAI, type Scripted } from "./fixtures/fakeOpenAI.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ECHO_SERVER = join(here, "fixtures", "echo-mcp.ts");

// Profile pointing at the fixture MCP server. `wipe` is mutating; `slow`,
// `injection`, `env` are allowed read-only tools for the specific tests.
function profile(over: Partial<HarnessProfile> = {}): HarnessProfile {
  return parseProfile({
    name: "test-echo",
    exposure: "trusted",
    backends: ["qwen"],
    servers: { echo: { command: process.execPath, args: [ECHO_SERVER], env: { DECLARED: "yes" } } },
    tools: [
      { name: "echo", timeout_ms: 5000, max_output_bytes: 64 },
      { name: "wipe", mutating: true },
      { name: "slow", timeout_ms: 300 },
      { name: "injection" },
      { name: "env" },
    ],
    limits: { max_tool_rounds: 3, timeout_ms: 20000, max_tool_output_bytes: 200 },
    system_prompt: "test system prompt",
    ...over,
  });
}

const mcp = new McpManager();
after(() => mcp.closeAll());

async function run(script: Scripted[], prof = profile(), user = "hello") {
  const fake = await startFakeOpenAI("m", script);
  const backend = new OpenAICompatibleBackend({ alias: "qwen", baseUrl: fake.url, model: "m" });
  try {
    const res = await runAgent({ profile: prof, backend: "qwen", chat: (r) => backend.chat(r), mcp, messages: [{ role: "user", content: user }] });
    return { res, fake };
  } finally {
    await fake.close();
  }
}

test("profile validation is default-deny", () => {
  assert.throws(() => parseProfile({ name: "x", exposure: "public", backends: ["qwen"], servers: { a: { command: "x" } }, tools: [{ name: "t" }] }), ProfileError);
  assert.throws(() => parseProfile({ name: "Bad Name", exposure: "local", backends: ["qwen"], servers: { a: { command: "x" } }, tools: [{ name: "t" }] }), ProfileError);
  assert.throws(() => parseProfile({ name: "x", exposure: "local", backends: [], servers: { a: { command: "x" } }, tools: [{ name: "t" }] }), ProfileError);
  assert.throws(() => parseProfile({ name: "x", exposure: "local", backends: ["qwen"], servers: {}, tools: [{ name: "t" }] }), ProfileError);
  assert.throws(() => parseProfile({ name: "x", exposure: "local", backends: ["qwen"], servers: { a: { command: "x" } }, tools: [] }), ProfileError);
  // limits are clamped to hard caps
  const p = parseProfile({ name: "x", exposure: "local", backends: ["qwen"], servers: { a: { command: "x" } }, tools: [{ name: "t" }], limits: { max_tool_rounds: 999, timeout_ms: 1e9 } });
  assert.equal(p.limits.max_tool_rounds, 8);
  assert.equal(p.limits.timeout_ms, 600_000);
});

test("loadProfiles skips broken files and name/filename mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  writeFileSync(join(dir, "good.json"), JSON.stringify({ name: "good", exposure: "local", backends: ["qwen"], servers: { a: { command: "${HOME}/x" } }, tools: [{ name: "t" }] }));
  writeFileSync(join(dir, "broken.json"), "{ nope");
  writeFileSync(join(dir, "mismatch.json"), JSON.stringify({ name: "other", exposure: "local", backends: ["qwen"], servers: { a: { command: "x" } }, tools: [{ name: "t" }] }));
  const loaded = loadProfiles(dir);
  assert.deepEqual([...loaded.keys()], ["good"]);
  assert.ok(!loaded.get("good")!.servers.a.command.includes("${HOME}"));
});

test("greeting: no tool call, one model call, tools offered", async () => {
  const { res, fake } = await run([{ text: "hi there" }]);
  assert.equal(res.completion.choices[0].message.content, "hi there");
  assert.equal(res.completion.harness.tool_calls, 0);
  assert.equal(res.completion.harness.stopped_by, "answer");
  assert.equal(fake.requests.length, 1);
  const sent = fake.requests[0] as { tools: { function: { name: string } }[]; messages: { role: string; content: string }[] };
  // only allowlisted tools are shown; system prompt is first
  assert.deepEqual(sent.tools.map((t) => t.function.name).sort(), ["echo", "env", "injection", "slow", "wipe"]);
  assert.equal(sent.messages[0].role, "system");
  assert.equal(sent.messages[0].content, "test system prompt");
});

test("exactly one system message, at index 0, on every model call — including wrap-up", async () => {
  const fake = await startFakeOpenAI("m", [
    { tool_calls: [{ name: "echo", arguments: { text: "a" } }] },
    { tool_calls: [{ name: "echo", arguments: { text: "a" } }] }, // repeat → wrapUp
    { text: "done" },
  ]);
  const backend = new OpenAICompatibleBackend({ alias: "qwen", baseUrl: fake.url, model: "m" });
  try {
    await runAgent({
      profile: profile(),
      backend: "qwen",
      chat: (r) => backend.chat(r),
      mcp,
      messages: [{ role: "system", content: "base playbook" }, { role: "user", content: "hi" }],
    });
    assert.equal(fake.requests.length, 3);
    for (const req of fake.requests) {
      const msgs = (req as { messages: { role: string; content: string }[] }).messages;
      assert.equal(msgs[0].role, "system");
      assert.equal(msgs.filter((m) => m.role === "system").length, 1);
      assert.match(msgs[0].content, /test system prompt/);
      assert.match(msgs[0].content, /base playbook/);
    }
    assert.match((fake.requests[2] as { messages: { content: string }[] }).messages[0].content, /Tool use is now closed/);
  } finally {
    await fake.close();
  }
});

test("tool round trip: call → MCP → result fed back → final answer", async () => {
  const { res, fake } = await run([{ tool_calls: [{ name: "echo", arguments: { text: "ping" } }] }, { text: "done" }]);
  assert.equal(res.completion.choices[0].message.content, "done");
  assert.equal(res.completion.harness.tool_calls, 1);
  assert.deepEqual(res.completion.harness.tools_used, ["echo"]);
  const second = fake.requests[1] as { messages: { role: string; content: string; tool_call_id?: string }[] };
  const toolMsg = second.messages.find((m) => m.role === "tool")!;
  assert.equal(toolMsg.content, "echo:ping");
  assert.equal(toolMsg.tool_call_id, "call_0_0");
});

test("mutating tool is denied, never executed; unknown tool is denied", async () => {
  const { res, fake } = await run([{ tool_calls: [{ name: "wipe", arguments: { target: "/" } }, { name: "rm_rf", arguments: {} }] }, { text: "ok" }]);
  assert.equal(res.completion.harness.tool_calls, 0);
  const second = fake.requests[1] as { messages: { role: string; content: string }[] };
  const denials = second.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.equal(denials.length, 2);
  assert.match(denials[0], /TOOL DENIED: .*mutating/);
  assert.match(denials[1], /TOOL DENIED: .*not in the profile allowlist/);
});

test("repeated identical call stops the loop and wraps up with tools disabled", async () => {
  const { res, fake } = await run([
    { tool_calls: [{ name: "echo", arguments: { text: "same" } }] },
    { tool_calls: [{ name: "echo", arguments: { text: "same" } }] },
    { text: "wrapped" },
  ]);
  assert.equal(res.completion.harness.stopped_by, "repeat");
  assert.equal(res.completion.harness.tool_calls, 1);
  assert.equal(res.completion.choices[0].message.content, "wrapped");
  assert.equal((fake.requests[2] as { tool_choice: string }).tool_choice, "none");
});

test("max_tool_rounds cap forces a final tools-off answer", async () => {
  const { res, fake } = await run([
    { tool_calls: [{ name: "echo", arguments: { text: "1" } }] },
    { tool_calls: [{ name: "echo", arguments: { text: "2" } }] },
    { tool_calls: [{ name: "echo", arguments: { text: "3" } }] },
    { text: "final" },
  ]);
  assert.equal(res.completion.harness.stopped_by, "max_rounds");
  assert.equal(res.completion.harness.rounds, 3);
  assert.equal(fake.requests.length, 4);
  assert.equal((fake.requests[3] as { tool_choice: string }).tool_choice, "none");
});

test("per-tool output truncation and total output budget", async () => {
  const big = "x".repeat(500);
  const { res, fake } = await run([{ tool_calls: [{ name: "echo", arguments: { text: big } }] }, { text: "ok" }]);
  const second = fake.requests[1] as { messages: { role: string; content: string }[] };
  const toolMsg = second.messages.find((m) => m.role === "tool")!;
  assert.ok(Buffer.byteLength(toolMsg.content) <= 64 + 80, "truncated to per-tool cap");
  assert.match(toolMsg.content, /truncated/);
  assert.equal(res.completion.harness.stopped_by, "answer");

  // budget: 150 bytes total; two ~200-byte results (per-tool cap raised) → over budget
  const prof = profile({
    tools: [{ name: "echo", timeout_ms: 5000, max_output_bytes: 4096 }],
    limits: { max_tool_rounds: 5, timeout_ms: 20000, max_tool_output_bytes: 150 },
  });
  const r2 = await run([
    { tool_calls: [{ name: "echo", arguments: { text: "a".repeat(200) } }, { name: "echo", arguments: { text: "b".repeat(200) } }] },
    { text: "budget" },
  ], prof);
  assert.equal(r2.res.completion.harness.stopped_by, "output_budget");
});

test("slow tool times out; loop continues with an error result", async () => {
  const { res, fake } = await run([{ tool_calls: [{ name: "slow", arguments: { ms: 3000 } }] }, { text: "ok" }]);
  const second = fake.requests[1] as { messages: { role: string; content: string }[] };
  assert.match(second.messages.find((m) => m.role === "tool")!.content, /TOOL ERROR/);
  assert.equal(res.completion.choices[0].message.content, "ok");
});

test("injection in tool output stays a quoted tool result; model-requested wipe is still denied", async () => {
  const { res, fake } = await run([
    { tool_calls: [{ name: "injection", arguments: {} }] },
    { tool_calls: [{ name: "wipe", arguments: { target: "/" } }] }, // model 'obeys' the injection
    { text: "refused" },
  ]);
  const second = fake.requests[1] as { messages: { role: string; content: string }[] };
  assert.equal(second.messages.at(-1)!.role, "tool");
  assert.match(second.messages.at(-1)!.content, /IGNORE ALL PREVIOUS/);
  const third = fake.requests[2] as { messages: { role: string; content: string }[] };
  assert.match(third.messages.at(-1)!.content, /TOOL DENIED/);
  assert.equal(res.completion.harness.tool_calls, 1);
});

test("MCP subprocess gets only declared env, not the service's", async () => {
  process.env.SUPER_SECRET = "leak-me";
  try {
    const fresh = new McpManager();
    try {
      const { res } = await (async () => {
        const fake = await startFakeOpenAI("m", [{ tool_calls: [{ name: "env", arguments: {} }] }, { text: "ok" }]);
        const backend = new OpenAICompatibleBackend({ alias: "qwen", baseUrl: fake.url, model: "m" });
        try {
          const r = await runAgent({ profile: profile(), backend: "qwen", chat: (x) => backend.chat(x), mcp: fresh, messages: [{ role: "user", content: "env" }] });
          const second = fake.requests[1] as { messages: { role: string; content: string }[] };
          return { res: JSON.parse(second.messages.find((m) => m.role === "tool")!.content) as { LEAKED: unknown; DECLARED: unknown } };
        } finally {
          await fake.close();
        }
      })();
      assert.equal(res.LEAKED, null);
      assert.equal(res.DECLARED, "yes");
    } finally {
      await fresh.closeAll();
    }
  } finally {
    delete process.env.SUPER_SECRET;
  }
});

test("MCP server that fails to start surfaces as an error, not a hang", async () => {
  const bad = profile({ servers: { echo: { command: "/nonexistent/binary", args: [] } } });
  const fresh = new McpManager();
  try {
    await assert.rejects(fresh.tools(bad), /mcp echo/);
  } finally {
    await fresh.closeAll();
  }
});
