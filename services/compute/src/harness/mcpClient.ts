// MCP client manager: spawns the stdio servers a profile declares, lists
// their tools as OpenAI function definitions, and executes calls. One
// connection per (profile, server), created lazily and dropped on any
// protocol error so the next run gets a fresh process.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { HarnessProfile, McpServerSpec } from "./profiles.ts";
import type { ToolDefinition } from "../backends/ollama.ts";

export class McpError extends Error {
  readonly server: string;
  constructor(server: string, message: string) {
    super(`mcp ${server}: ${message}`);
    this.server = server;
  }
}

interface Conn {
  client: Client;
  transport: StdioClientTransport;
  tools: Map<string, { description?: string; inputSchema: Record<string, unknown> }>;
}

const CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? 20_000);

function subprocessEnv(spec: McpServerSpec): Record<string, string> {
  // Minimal environment — the compute service's env carries API keys.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/",
    LANG: process.env.LANG ?? "en_US.UTF-8",
  };
  return { ...env, ...(spec.env ?? {}) };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export class McpManager {
  private conns = new Map<string, Promise<Conn>>();

  private key(profile: string, server: string): string {
    return `${profile}/${server}`;
  }

  private async connect(profile: HarnessProfile, server: string): Promise<Conn> {
    const spec = profile.servers[server];
    if (!spec) throw new McpError(server, "not declared in profile");
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: subprocessEnv(spec),
      cwd: spec.cwd,
      stderr: "pipe",
    });
    // Surface server stderr in our log (prefixed) — that's where FastMCP logs.
    transport.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log(`[mcp ${server}] ${line.slice(0, 500)}`);
    });
    const client = new Client({ name: "stephanie-compute-harness", version: "0.1.0" });
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `connect ${server}`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `listTools ${server}`);
      const tools = new Map<string, { description?: string; inputSchema: Record<string, unknown> }>();
      for (const t of listed.tools) {
        tools.set(t.name, { description: t.description, inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> });
      }
      transport.onclose = () => this.conns.delete(this.key(profile.name, server));
      transport.onerror = (e) => {
        console.warn(`[mcp ${server}] transport error: ${e.message}`);
        this.conns.delete(this.key(profile.name, server));
      };
      return { client, transport, tools };
    } catch (e) {
      await transport.close().catch(() => {});
      throw new McpError(server, e instanceof Error ? e.message : String(e));
    }
  }

  private conn(profile: HarnessProfile, server: string): Promise<Conn> {
    const k = this.key(profile.name, server);
    let p = this.conns.get(k);
    if (!p) {
      p = this.connect(profile, server);
      this.conns.set(k, p);
      p.catch(() => this.conns.delete(k));
    }
    return p;
  }

  // Tools the model may see = allowlist ∩ what the servers actually expose.
  // Returns OpenAI definitions plus a name→server routing map.
  async tools(profile: HarnessProfile): Promise<{ defs: ToolDefinition[]; route: Map<string, string> }> {
    const defs: ToolDefinition[] = [];
    const route = new Map<string, string>();
    const allowed = new Set(profile.tools.map((t) => t.name));
    for (const server of Object.keys(profile.servers)) {
      const c = await this.conn(profile, server);
      for (const [name, t] of c.tools) {
        if (!allowed.has(name)) continue;
        if (route.has(name)) {
          throw new McpError(server, `tool "${name}" is also exposed by ${route.get(name)} — ambiguous, refusing`);
        }
        route.set(name, server);
        defs.push({ type: "function", function: { name, description: t.description, parameters: t.inputSchema } });
      }
    }
    return { defs, route };
  }

  async call(
    profile: HarnessProfile,
    server: string,
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<string> {
    const c = await this.conn(profile, server);
    let result;
    try {
      // The SDK's own timeout is loose (it does a tool-list refresh first);
      // race it with a hard deadline so profile limits are exact.
      result = await withTimeout(
        c.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }),
        timeoutMs,
        `${name}`
      );
    } catch (e) {
      // Drop the connection; the next run spawns a fresh server. close() waits
      // for the child to exit (~2s grace) so don't block the caller on it.
      this.conns.delete(this.key(profile.name, server));
      void c.transport.close().catch(() => {});
      throw new McpError(server, `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text ?? "" : `[${b.type} block omitted]`))
      .join("\n");
    if (result.isError) return `TOOL ERROR: ${text || "(no detail)"}`;
    return text;
  }

  async closeAll(): Promise<void> {
    const all = [...this.conns.values()];
    this.conns.clear();
    await Promise.all(all.map((p) => p.then((c) => c.transport.close()).catch(() => {})));
  }
}

export const mcpManager = new McpManager();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void mcpManager.closeAll().finally(() => process.exit(0));
  });
}
