import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatibleBackend } from "../src/backends/openaiCompatible.ts";
import { BackendUnavailable } from "../src/backends/ollama.ts";
import { startFakeOpenAI } from "./fixtures/fakeOpenAI.ts";

test("passes tool definitions and tool messages through verbatim, re-aliases model", async () => {
  const fake = await startFakeOpenAI("mlx-community/Fake-1B", [{ text: "hi" }]);
  try {
    const b = new OpenAICompatibleBackend({ alias: "qwen", baseUrl: fake.url, model: "mlx-community/Fake-1B" });
    const tools = [{ type: "function" as const, function: { name: "web_search", parameters: { type: "object" } } }];
    const out = await b.chat({
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "result" },
      ],
      tools,
      tool_choice: "auto",
    });
    assert.equal(out.model, "qwen");
    assert.equal(out.choices[0].message.content, "hi");
    const sent = fake.requests[0] as { model: string; tools: unknown; tool_choice: unknown; messages: unknown[]; stream: boolean };
    assert.equal(sent.model, "mlx-community/Fake-1B");
    assert.deepEqual(sent.tools, tools);
    assert.equal(sent.tool_choice, "auto");
    assert.equal(sent.messages.length, 3);
    assert.equal(sent.stream, false);
  } finally {
    await fake.close();
  }
});

test("omits tool fields when no tools are given", async () => {
  const fake = await startFakeOpenAI("m", [{ text: "ok" }]);
  try {
    const b = new OpenAICompatibleBackend({ alias: "qwen", baseUrl: fake.url, model: "m" });
    await b.chat({ messages: [{ role: "user", content: "x" }], tool_choice: "auto" });
    assert.ok(!("tools" in fake.requests[0]));
    assert.ok(!("tool_choice" in fake.requests[0]));
  } finally {
    await fake.close();
  }
});

test("health: true only when the server lists the configured model", async () => {
  const fake = await startFakeOpenAI("served-model");
  try {
    assert.equal(await new OpenAICompatibleBackend({ alias: "a", baseUrl: fake.url, model: "served-model" }).healthy(), true);
    assert.equal(await new OpenAICompatibleBackend({ alias: "a", baseUrl: fake.url, model: "other-model" }).healthy(), false);
  } finally {
    await fake.close();
  }
  // dead server
  assert.equal(await new OpenAICompatibleBackend({ alias: "a", baseUrl: "http://127.0.0.1:1/v1", model: "x" }).healthy(), false);
});

test("unreachable ⇒ BackendUnavailable (503-class); 4xx ⇒ plain Error (no failover)", async () => {
  const dead = new OpenAICompatibleBackend({ alias: "qwen", baseUrl: "http://127.0.0.1:1/v1", model: "x", timeoutMs: 2000 });
  await assert.rejects(dead.chat({ messages: [{ role: "user", content: "x" }] }), BackendUnavailable);

  const fake = await startFakeOpenAI("m", [{ status: 400, body: { error: "bad schema" } }, { status: 503 }]);
  try {
    const b = new OpenAICompatibleBackend({ alias: "qwen", baseUrl: fake.url, model: "m" });
    await assert.rejects(b.chat({ messages: [{ role: "user", content: "x" }] }), (e: unknown) => e instanceof Error && !(e instanceof BackendUnavailable) && /400/.test(e.message));
    await assert.rejects(b.chat({ messages: [{ role: "user", content: "x" }] }), BackendUnavailable);
  } finally {
    await fake.close();
  }
});
