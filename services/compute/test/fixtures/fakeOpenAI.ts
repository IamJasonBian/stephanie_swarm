// Scriptable OpenAI-compatible server: each request pops the next scripted
// reply. Records every request body so tests can assert on what the model
// was shown (tools, tool results, etc).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Scripted =
  | { text: string }
  | { tool_calls: { name: string; arguments: Record<string, unknown>; id?: string }[] }
  | { status: number; body?: unknown };

export interface FakeOpenAI {
  url: string; // ".../v1"
  requests: Record<string, unknown>[];
  script: Scripted[];
  close(): Promise<void>;
}

export async function startFakeOpenAI(model = "fake-model", script: Scripted[] = []): Promise<FakeOpenAI> {
  const requests: Record<string, unknown>[] = [];
  let n = 0;
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/v1/models") {
      return send(200, { object: "list", data: [{ id: model, object: "model" }] });
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const step = script.shift();
      if (!step) return send(500, { error: "fake server: script exhausted" });
      if ("status" in step) return send(step.status, step.body ?? { error: "scripted failure" });
      const message =
        "text" in step
          ? { role: "assistant", content: step.text }
          : {
              role: "assistant",
              content: null,
              tool_calls: step.tool_calls.map((t, i) => ({
                id: t.id ?? `call_${n}_${i}`,
                type: "function",
                function: { name: t.name, arguments: JSON.stringify(t.arguments) },
              })),
            };
      n++;
      return send(200, {
        id: `chatcmpl-${n}`,
        object: "chat.completion",
        model,
        choices: [{ index: 0, message, finish_reason: "text" in step ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    script,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
