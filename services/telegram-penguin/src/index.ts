// telegram-penguin — a Telegram front door onto the swarm's local model.
//
// Long-polls the Bot API (no deps), forwards each message to dispatch as an
// `agent` job (qwen + web-readonly harness ⇒ live web search) or a plain
// `chat` job when tools are off / unavailable, and replies in the chat.
//
// Env (services/.env or services/telegram-penguin/.env):
//   TELEGRAM_BOT_TOKEN          from @BotFather — required
//   TELEGRAM_ALLOWED_CHAT_IDS   comma-separated chat ids allowed to talk to it.
//                               Empty ⇒ nobody (each rejected id is logged so
//                               you can copy it in). Deliberately default-deny.
//   DISPATCH_URL                default http://localhost:8877
//   HARNESS_TOKEN               enables tool mode (must match the hub's)
//   PENGUIN_MODEL               default qwen
//   PENGUIN_PROFILE             default web-readonly
//   PENGUIN_HISTORY             turns of context kept per chat (default 12)
//
// Deliberately NOT a claude-code-telegram bot: no shell, no filesystem — the
// only capability beyond the model is whatever the harness profile allows.

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const DISPATCH_URL = (process.env.DISPATCH_URL ?? "http://localhost:8877").replace(/\/$/, "");
const HARNESS_TOKEN = process.env.HARNESS_TOKEN ?? "";
const MODEL = process.env.PENGUIN_MODEL ?? "qwen";
const PROFILE = process.env.PENGUIN_PROFILE ?? "web-readonly";
const HISTORY = Number(process.env.PENGUIN_HISTORY ?? 12);
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const TG_LIMIT = 4000; // Telegram caps messages at 4096 chars

if (!TOKEN) {
  // Under launchd KeepAlive an exit would crash-loop every 15s. Idle instead.
  console.log("TELEGRAM_BOT_TOKEN not set — telegram-penguin idle. Put the token in services/.env and kickstart this service.");
  setInterval(() => console.log("still waiting for TELEGRAM_BOT_TOKEN"), 10 * 60_000);
} else {
  void main();
}

const api = (method: string) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function tg<T = unknown>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(api(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
  return json.result as T;
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

type Msg = { role: "user" | "assistant"; content: string };
const history = new Map<number, Msg[]>();
const toolsOff = new Set<number>(); // chats that ran /tools off

function remember(chat: number, m: Msg): void {
  const h = history.get(chat) ?? [];
  h.push(m);
  while (h.length > HISTORY * 2) h.shift();
  history.set(chat, h);
}

async function send(chat: number, text: string, replyTo?: number): Promise<void> {
  const pieces = text.length <= TG_LIMIT ? [text] : text.match(new RegExp(`[\\s\\S]{1,${TG_LIMIT}}`, "g")) ?? [text];
  for (const [i, piece] of pieces.entries()) {
    await tg("sendMessage", {
      chat_id: chat,
      text: piece,
      reply_to_message_id: i === 0 ? replyTo : undefined,
      disable_web_page_preview: true,
    }).catch(async (e) => {
      // Most likely Markdown-ish text Telegram rejected — we send plain text,
      // so this is usually a flood limit; log and move on.
      console.warn(`send failed: ${e instanceof Error ? e.message : e}`);
    });
  }
}

interface JobResult {
  status?: string;
  model?: string;
  error?: string;
  result?: {
    choices?: { message?: { content?: string | null } }[];
    harness?: { tool_calls: number; tools_used: string[]; stopped_by: string; elapsed_ms: number };
    error?: string;
  };
}

async function askDispatch(chat: number, messages: Msg[], useTools: boolean): Promise<{ text: string; note: string }> {
  const body = useTools
    ? {
        type: "agent",
        payload: { profile: PROFILE, messages, max_tokens: 1200 },
        preferences: { model: MODEL },
      }
    : {
        type: "chat",
        payload: { messages, max_tokens: 1200, temperature: 0.4 },
        preferences: { model: MODEL, fallback: true },
      };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useTools) headers["x-harness-token"] = HARNESS_TOKEN;

  const res = await fetch(`${DISPATCH_URL}/jobs?wait=true`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(170_000),
  });
  const job = (await res.json().catch(() => null)) as JobResult | null;
  const reply = job?.result?.choices?.[0]?.message?.content;
  if (!res.ok || job?.status !== "done" || !reply) {
    throw new Error(job?.error ?? job?.result?.error ?? `job ${job?.status ?? "failed"} (HTTP ${res.status})`);
  }
  const h = job.result?.harness;
  const note = h && h.tool_calls > 0 ? `\n\n🔎 ${h.tool_calls} ${h.tools_used.join("/")} call${h.tool_calls > 1 ? "s" : ""} · ${job.model} · ${(h.elapsed_ms / 1000).toFixed(0)}s` : `\n\n🐧 ${job.model}`;
  return { text: reply, note };
}

async function handle(m: TgMessage): Promise<void> {
  const chat = m.chat.id;
  const text = (m.text ?? "").trim();
  if (!text) return;

  if (!ALLOWED.has(String(chat))) {
    console.log(`rejected chat ${chat} (${m.chat.type}${m.from?.username ? " @" + m.from.username : ""}) — add to TELEGRAM_ALLOWED_CHAT_IDS to allow`);
    if (m.chat.type === "private") await send(chat, `🧊 Not on the list. Your chat id is ${chat}.`);
    return;
  }

  if (text === "/start" || text === "/help") {
    await send(
      chat,
      [
        "🐧 penguin — local Qwen on the swarm.",
        HARNESS_TOKEN ? `Web search is ON (${PROFILE}); /tools off to disable.` : "Web search is off on this hub (no HARNESS_TOKEN).",
        "/new — forget this conversation",
        "/tools on|off — toggle web search for this chat",
        "/status — hub health",
      ].join("\n")
    );
    return;
  }
  if (text === "/new") {
    history.delete(chat);
    await send(chat, "🧊 fresh ice. what's up?");
    return;
  }
  if (text.startsWith("/tools")) {
    const arg = text.split(/\s+/)[1];
    if (arg === "off") toolsOff.add(chat);
    else if (arg === "on") toolsOff.delete(chat);
    const on = HARNESS_TOKEN && !toolsOff.has(chat);
    await send(chat, `web search ${on ? "on" : "off"} for this chat`);
    return;
  }
  if (text === "/status") {
    try {
      const h = (await (await fetch(`${DISPATCH_URL}/health`, { signal: AbortSignal.timeout(8000) })).json()) as {
        pool?: { healthy: number; total: number };
        nodes?: { backends?: Record<string, { ready?: boolean; reachable?: boolean }> }[];
        harness?: { enabled: boolean };
      };
      const ready = new Set<string>();
      for (const n of h.nodes ?? []) for (const [k, v] of Object.entries(n.backends ?? {})) if (v.ready || v.reachable) ready.add(k);
      await send(chat, `pool ${h.pool?.healthy ?? "?"}/${h.pool?.total ?? "?"} · ready: ${[...ready].join(", ") || "none"} · harness ${h.harness?.enabled ? "on" : "off"}`);
    } catch (e) {
      await send(chat, `hub unreachable: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }

  remember(chat, { role: "user", content: text });
  await tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  const typing = setInterval(() => void tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {}), 4500);
  try {
    const useTools = Boolean(HARNESS_TOKEN) && !toolsOff.has(chat);
    let out: { text: string; note: string };
    try {
      out = await askDispatch(chat, history.get(chat) ?? [], useTools);
    } catch (e) {
      if (!useTools) throw e;
      // Harness unavailable (mlx cold, profile missing, ...) → plain chat.
      console.warn(`agent job failed for chat ${chat}: ${e instanceof Error ? e.message : e} — retrying as plain chat`);
      out = await askDispatch(chat, history.get(chat) ?? [], false);
      out.note += " (no web)";
    }
    remember(chat, { role: "assistant", content: out.text });
    await send(chat, out.text + out.note, m.message_id);
  } catch (e) {
    await send(chat, `🧊 the penguins slipped: ${e instanceof Error ? e.message : e}`, m.message_id);
  } finally {
    clearInterval(typing);
  }
}

async function main(): Promise<void> {
  const me = await tg<{ username: string }>("getMe", {});
  console.log(`telegram-penguin online as @${me.username} → ${DISPATCH_URL} model=${MODEL} tools=${HARNESS_TOKEN ? PROFILE : "off"} allowed=${ALLOWED.size} chat(s)`);
  await tg("setMyCommands", {
    commands: [
      { command: "new", description: "forget this conversation" },
      { command: "tools", description: "tools on|off — toggle web search" },
      { command: "status", description: "hub health" },
      { command: "help", description: "what this bot does" },
    ],
  }).catch(() => {});

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg<TgUpdate[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, 45_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) void handle(u.message).catch((e) => console.error(`handle: ${e instanceof Error ? e.message : e}`));
      }
    } catch (e) {
      console.warn(`poll: ${e instanceof Error ? e.message : e}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
