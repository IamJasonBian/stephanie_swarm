// hermes-chat — Cloudflare Worker front door for the swarm's LLM services.
//
// Durable memory:  one SQLite-backed Durable Object per conversation
//                  (strongly consistent, no expiry).
// Durable storage: D1 database indexing all conversations for listing.
//
// Routes:
//   POST   /api/chat                — send a message (creates conv on demand)
//   GET    /api/conversations       — list all conversations (D1 index)
//   GET    /api/conversations/:id   — full message history (Durable Object)
//   DELETE /api/conversations/:id   — delete a conversation everywhere
//   GET    /api/health              — proxied dispatch/compute health
//
// Inference happens on the Mac: chat requests proxy to the dispatch service
// over DISPATCH_URL (a cloudflared tunnel in production).

import { DurableObject } from "cloudflare:workers";

interface Env {
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  DB: D1Database;
  DISPATCH_URL: string;
  ASSETS: Fetcher;
}

interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  ts: number;
}

const MODELS = ["hermes", "claude", "kimi"];
const HISTORY_LIMIT = 40; // messages sent to the model per request

// ---------------------------------------------------------------------------
// Durable Object: one instance per conversation, addressed by name (the
// conversation id). Messages live in the DO's own SQLite storage.
// ---------------------------------------------------------------------------
export class Conversation extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        role    TEXT NOT NULL,
        content TEXT NOT NULL,
        model   TEXT,
        ts      INTEGER NOT NULL
      )
    `);
  }

  append(message: StoredMessage): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO messages (role, content, model, ts) VALUES (?, ?, ?, ?)",
      message.role,
      message.content,
      message.model ?? null,
      message.ts
    );
  }

  history(limit?: number): StoredMessage[] {
    const rows = this.ctx.storage.sql
      .exec<StoredMessage>(
        limit
          ? `SELECT role, content, model, ts FROM messages ORDER BY id DESC LIMIT ${Math.floor(limit)}`
          : "SELECT role, content, model, ts FROM messages ORDER BY id ASC"
      )
      .toArray();
    return limit ? rows.reverse() : rows;
  }

  count(): number {
    const row = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages")
      .one();
    return row.n;
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function ensureIndex(env: Env): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER, message_count INTEGER DEFAULT 0, last_model TEXT)"
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      try {
        const res = await fetch(`${env.DISPATCH_URL}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        return json(await res.json());
      } catch {
        return json({ ok: false, error: "dispatch unreachable — is the tunnel up?" }, 502);
      }
    }

    if (url.pathname === "/api/conversations" && request.method === "GET") {
      await ensureIndex(env);
      const { results } = await env.DB.prepare(
        "SELECT id, title, created_at, updated_at, message_count, last_model FROM conversations ORDER BY updated_at DESC LIMIT 100"
      ).all();
      return json({ conversations: results });
    }

    const convMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]+)$/);
    if (convMatch) {
      const id = convMatch[1];
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(id));
      if (request.method === "GET") {
        return json({ conversationId: id, messages: await stub.history() });
      }
      if (request.method === "DELETE") {
        await stub.destroy();
        await ensureIndex(env);
        await env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      // A model is online if ANY healthy compute node in the pool can serve
      // it. Dispatch unreachable ⇒ everything reports offline.
      const status: Record<string, boolean> = Object.fromEntries(MODELS.map((m) => [m, false]));
      try {
        const res = await fetch(`${env.DISPATCH_URL}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        const health = (await res.json()) as {
          nodes?: { ok?: boolean; backends?: Record<string, { reachable?: boolean; ready?: boolean }> }[];
        };
        for (const node of health.nodes ?? []) {
          if (!node.ok || !node.backends) continue;
          if (node.backends.hermes?.reachable) status.hermes = true;
          if (node.backends.claude?.ready) status.claude = true;
          if (node.backends.kimi?.ready) status.kimi = true;
        }
      } catch {
        // leave everything offline
      }
      const firstOnline = MODELS.find((m) => status[m]);
      return json({ models: MODELS, default: firstOnline ?? "hermes", status });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as {
        conversationId?: string;
        message?: string;
        model?: string;
        fallback?: boolean;
        // coach-style (Coach in a Cave UI): full OpenAI message array + SSE reply
        messages?: { role: string; content: string }[];
        temperature?: number;
      } | null;

      // Coach in a Cave sends the whole conversation each turn (stateless —
      // no Durable Object involved) and reads an SSE stream back.
      if (Array.isArray(body?.messages)) {
        const model = body.model && MODELS.includes(body.model) ? body.model : "hermes";
        let dispatchRes: Response;
        try {
          dispatchRes = await fetch(`${env.DISPATCH_URL}/jobs?wait=true`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "chat",
              payload: {
                messages: body.messages,
                temperature: body.temperature ?? 0.6,
                max_tokens: 2048,
              },
              preferences: { model, fallback: body.fallback ?? true },
            }),
            signal: AbortSignal.timeout(90_000),
          });
        } catch {
          return json({ error: "dispatch unreachable — is the tunnel up?" }, 502);
        }
        const job = (await dispatchRes.json().catch(() => null)) as {
          status?: string;
          model?: string;
          error?: string;
          result?: { choices?: { message?: { content?: string } }[] };
        } | null;
        const reply = job?.result?.choices?.[0]?.message?.content;
        if (!dispatchRes.ok || job?.status !== "done" || !reply) {
          return json(
            { error: job?.error ?? `job ${job?.status ?? "failed"} (HTTP ${dispatchRes.status})` },
            502
          );
        }
        // Dispatch is non-streaming: re-emit the reply as the SSE chunk
        // stream the coach UI's reader expects (chunked by line so it types).
        const pieces = reply.match(/[^\n]*\n|[^\n]+$/g) ?? [reply];
        const sse =
          pieces
            .map((p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
            .join("") + "data: [DONE]\n\n";
        return new Response(sse, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      }

      if (!body?.message?.trim()) {
        return json({ error: "message is required" }, 400);
      }
      const model = body.model ?? "hermes";
      if (!MODELS.includes(model)) {
        return json({ error: `model must be one of: ${MODELS.join(", ")}` }, 400);
      }

      const message = body.message.trim();
      // `||` (not `??`): an empty-string id must mint a fresh conversation.
      const conversationId = body.conversationId?.trim() || crypto.randomUUID();
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(conversationId));

      await stub.append({ role: "user", content: message, ts: Date.now() });
      const context = await stub.history(HISTORY_LIMIT);

      let dispatchRes: Response;
      try {
        dispatchRes = await fetch(`${env.DISPATCH_URL}/jobs?wait=true`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "chat",
            payload: {
              messages: context.map((m) => ({ role: m.role, content: m.content })),
              max_tokens: 1024,
            },
            preferences: { model, fallback: body.fallback ?? true },
          }),
          signal: AbortSignal.timeout(90_000),
        });
      } catch {
        return json({ error: "dispatch unreachable — is the tunnel up?" }, 502);
      }

      const job = (await dispatchRes.json().catch(() => null)) as {
        status?: string;
        model?: string;
        error?: string;
        result?: { choices?: { message?: { content?: string } }[] };
      } | null;

      const reply = job?.result?.choices?.[0]?.message?.content;
      if (!dispatchRes.ok || job?.status !== "done" || !reply) {
        return json(
          { error: job?.error ?? `job ${job?.status ?? "failed"} (HTTP ${dispatchRes.status})` },
          502
        );
      }

      await stub.append({ role: "assistant", content: reply, model: job.model, ts: Date.now() });

      // Keep the D1 index in sync (title = first message, truncated).
      await ensureIndex(env);
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, message_count, last_model)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           message_count = excluded.message_count,
           last_model = excluded.last_model`
      )
        .bind(conversationId, message.slice(0, 80), now, now, await stub.count(), job.model ?? model)
        .run();

      return json({ conversationId, reply, model: job.model });
    }

    // Everything else falls through to the static chat UI.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
