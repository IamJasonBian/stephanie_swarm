// telegram-penguin — a Telegram front door onto the swarm's local model,
// tuned as a universal get-money-back / reimbursement & dispute advocate.
//
// Long-polls the Bot API (no deps). Each message → dispatch as an `agent` job
// (qwen + the reimbursement-advocate harness ⇒ live web search) or a plain
// `chat` job when tools are off / unavailable. Photos go to the model as
// images (Qwen is a VLM — receipts, statements, screenshots); PDFs/DOCX go
// through compute's docling converter when that venv exists.
//
// Learning loop: every exchange is logged; `/outcome won|partial|lost <note>`
// records how a case ended, and those outcomes are injected into every
// prompt as "Lessons from past cases" (see memory.ts).
//
// Env (services/.env or services/telegram-penguin/.env):
//   TELEGRAM_BOT_TOKEN          from @BotFather — required
//   TELEGRAM_ALLOWED_CHAT_IDS   comma-separated chat ids. Empty ⇒ nobody
//                               (rejected ids are logged). Default-deny.
//   DISPATCH_URL                default http://localhost:8877
//   HARNESS_TOKEN               enables tool mode (must match the hub's)
//   PENGUIN_MODEL               default qwen
//   PENGUIN_PROFILE             default reimbursement-advocate
//   PENGUIN_HISTORY             turns of context kept per chat (default 12)
//   PENGUIN_DATA_DIR            default services/telegram-penguin/data
//
// Deliberately NOT a claude-code-telegram bot: no shell, no filesystem — the
// only capability beyond the model is whatever the harness profile allows.

import { cases, lastAssistant, lessonsBlock, logTurn, recordOutcome, stats, type Outcome } from "./memory.ts";

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const DISPATCH_URL = (process.env.DISPATCH_URL ?? "http://localhost:8877").replace(/\/$/, "");
const HARNESS_TOKEN = process.env.HARNESS_TOKEN ?? "";
const MODEL = process.env.PENGUIN_MODEL ?? "qwen";
const PROFILE = process.env.PENGUIN_PROFILE ?? "reimbursement-advocate";
const HISTORY = Number(process.env.PENGUIN_HISTORY ?? 12);
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const TG_LIMIT = 4000; // Telegram caps messages at 4096 chars
const MAX_FILE_BYTES = 15 * 1024 * 1024; // Bot API getFile cap is 20 MB
const JOB_TIMEOUT_MS = Number(process.env.PENGUIN_JOB_TIMEOUT_MS ?? 300_000);
const DOC_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
  "text/plain",
  "text/csv",
]);

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------
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

async function download(fileId: string): Promise<{ bytes: Buffer; path: string }> {
  const f = await tg<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
  if (!f.file_path) throw new Error("telegram did not return a file path");
  if ((f.file_size ?? 0) > MAX_FILE_BYTES) throw new Error(`file too large (${Math.round((f.file_size ?? 0) / 1e6)} MB > 15 MB)`);
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), path: f.file_path };
}

interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// ---------------------------------------------------------------------------
// Per-chat state
// ---------------------------------------------------------------------------
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type Msg = { role: "user" | "assistant"; content: string | ContentPart[] };
type DocInput = { filename: string; data: string };

const history = new Map<number, Msg[]>();
const toolsOff = new Set<number>(); // chats that ran /tools off

function remember(chat: number, m: Msg): void {
  const h = history.get(chat) ?? [];
  h.push(m);
  // Images are big — keep only the most recent one in context.
  let seenImage = false;
  for (let i = h.length - 1; i >= 0; i--) {
    const c = h[i].content;
    if (Array.isArray(c) && c.some((p) => p.type === "image_url")) {
      if (seenImage) h[i] = { role: h[i].role, content: textOf(c) + "\n[earlier image omitted from context]" };
      seenImage = true;
    }
  }
  while (h.length > HISTORY * 2) h.shift();
  history.set(chat, h);
}

function textOf(c: Msg["content"]): string {
  return typeof c === "string" ? c : c.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n");
}

async function send(chat: number, text: string, replyTo?: number): Promise<void> {
  const pieces = text.length <= TG_LIMIT ? [text] : text.match(new RegExp(`[\\s\\S]{1,${TG_LIMIT}}`, "g")) ?? [text];
  for (const [i, piece] of pieces.entries()) {
    await tg("sendMessage", {
      chat_id: chat,
      text: piece,
      reply_to_message_id: i === 0 ? replyTo : undefined,
      disable_web_page_preview: true,
    }).catch((e) => console.warn(`send failed: ${e instanceof Error ? e.message : e}`));
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
interface JobResult {
  jobId?: string;
  status?: string;
  model?: string;
  error?: string;
  result?: {
    choices?: { message?: { content?: string | null } }[];
    harness?: { tool_calls: number; tools_used: string[]; stopped_by: string; elapsed_ms: number };
    error?: string;
  };
}

async function askDispatch(
  messages: Msg[],
  useTools: boolean,
  documents: DocInput[]
): Promise<{ text: string; note: string; model: string; toolCalls: number }> {
  // Lessons ride along as a system message; the harness merges it into the
  // single leading system prompt.
  const lessons = lessonsBlock();
  const withLessons = lessons ? [{ role: "system", content: lessons }, ...messages] : messages;
  const body = useTools
    ? {
        type: "agent",
        payload: { profile: PROFILE, messages: withLessons, max_tokens: 1400, documents: documents.length ? documents : undefined },
        preferences: { model: MODEL },
      }
    : {
        type: "chat",
        payload: { messages: withLessons, max_tokens: 1400, temperature: 0.4, documents: documents.length ? documents : undefined },
        preferences: { model: MODEL, fallback: false },
      };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (useTools) headers["x-harness-token"] = HARNESS_TOKEN;

  const res = await fetch(`${DISPATCH_URL}/jobs?wait=true`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  let job = (await res.json().catch(() => null)) as JobResult | null;
  if (!res.ok) throw new Error(job?.error ?? `dispatch HTTP ${res.status}`);
  // dispatch's long-poll caps at ~60s; a 27B model with tool rounds often
  // takes longer, so keep polling the job until it settles.
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (job && (job.status === "queued" || job.status === "running") && job.jobId && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await fetch(`${DISPATCH_URL}/jobs/${job.jobId}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (poll?.ok) job = (await poll.json().catch(() => job)) as JobResult;
  }
  const reply = job?.result?.choices?.[0]?.message?.content;
  if (job?.status !== "done" || !reply) {
    const why = job?.error ?? job?.result?.error ?? (job?.status === "running" || job?.status === "queued" ? `timed out after ${JOB_TIMEOUT_MS / 1000}s` : `job ${job?.status ?? "failed"}`);
    throw new Error(why);
  }
  const h = job.result?.harness;
  const toolCalls = h?.tool_calls ?? 0;
  const note =
    toolCalls > 0
      ? `\n\n🔎 ${toolCalls} ${h!.tools_used.join("/")} call${toolCalls > 1 ? "s" : ""} · ${job.model} · ${(h!.elapsed_ms / 1000).toFixed(0)}s`
      : `\n\n🐧 ${job.model}`;
  return { text: reply, note, model: job.model ?? MODEL, toolCalls };
}

// ---------------------------------------------------------------------------
// Attachments → model input
// ---------------------------------------------------------------------------
async function attachments(m: TgMessage): Promise<{ parts: ContentPart[]; documents: DocInput[]; count: number; skipped: string[] }> {
  const parts: ContentPart[] = [];
  const documents: DocInput[] = [];
  const skipped: string[] = [];
  let count = 0;

  if (m.photo && m.photo.length > 0) {
    const best = m.photo[m.photo.length - 1]; // largest rendition
    const { bytes } = await download(best.file_id);
    parts.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${bytes.toString("base64")}` } });
    count++;
  }
  if (m.document) {
    const mime = m.document.mime_type ?? "";
    const name = m.document.file_name ?? "document";
    if (mime.startsWith("image/")) {
      const { bytes } = await download(m.document.file_id);
      parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${bytes.toString("base64")}` } });
      count++;
    } else if (DOC_MIME.has(mime) || /\.(pdf|docx|pptx|xlsx|html?|txt|csv)$/i.test(name)) {
      const { bytes } = await download(m.document.file_id);
      documents.push({ filename: name, data: bytes.toString("base64") });
      count++;
    } else {
      skipped.push(`${name} (${mime || "unknown type"})`);
    }
  }
  return { parts, documents, count, skipped };
}

const DEFAULT_ATTACHMENT_PROMPT =
  "Here is a receipt/statement/bill/EOB/screenshot. Extract merchant, date, total, currency, tax/tip/FX, payment method/last-4, key line items, and anything that looks off (duplicate, wrong amount, tip math, foreign fee, out-of-policy). Then rank my get-money-back options (merchant/platform → employer expense if corporate → card/bank dispute → regulator) with the deadlines that matter and one ready-to-send message for the best path.";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function handleCommand(chat: number, text: string): Promise<boolean> {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const on = Boolean(HARNESS_TOKEN) && !toolsOff.has(chat);

  switch (cmd.replace(/@\w+$/, "")) {
    case "/start":
    case "/help":
      await send(
        chat,
        [
          "🐧 penguin — get-money-back advocate (local model).",
          "",
          "I cover: employer expenses · card/bank chargebacks · Amazon/PayPal/app-store · travel · medical/EOB · subscriptions · BNPL · warranties/price protection · shipping claims · deposits/utilities.",
          "",
          "Tell me amount / who / when / how you paid, or send a receipt, statement, bill, EOB, or screenshot (PDF/DOCX too).",
          "",
          on
            ? `Web search ON (${PROFILE}) — policies, deadlines, escalation contacts, cited.`
            : "Web search is off on this hub.",
          "",
          "/new — fresh case",
          "/outcome won|partial|lost <what happened> — record how it ended",
          "/lessons — past-case tactics",
          "/tools on|off — toggle web search",
          "/status — hub health",
        ].join("\n")
      );
      return true;
    case "/new":
      history.delete(chat);
      await send(chat, "🧊 fresh ice. what are we getting back?");
      return true;
    case "/tools": {
      if (arg === "off") toolsOff.add(chat);
      else if (arg === "on") toolsOff.delete(chat);
      await send(chat, `web search ${Boolean(HARNESS_TOKEN) && !toolsOff.has(chat) ? "on" : "off"} for this chat`);
      return true;
    }
    case "/outcome": {
      const m = arg.match(/^(won|partial|lost|pending)\b\s*(.*)$/is);
      if (!m) {
        await send(chat, "usage: /outcome won|partial|lost <what worked or didn't>\ne.g. /outcome won cited Reg Z 60-day window, Chase reversed $212 in 4 days");
        return true;
      }
      const outcome = m[1].toLowerCase() as Outcome;
      const note = m[2].trim();
      const summary = (lastAssistant(chat) ?? textOf(history.get(chat)?.find((x) => x.role === "user")?.content ?? "") ?? "").slice(0, 400);
      recordOutcome({ chat, outcome, note, summary: summary || "(no case context in this chat)" });
      const s = stats();
      await send(chat, `📚 recorded: ${outcome}${note ? ` — "${note}"` : ""}\nhub now has ${s.cases} outcomes (${s.won} won · ${s.partial} partial · ${s.lost} lost). Future advice will weigh this.`);
      return true;
    }
    case "/lessons": {
      const block = lessonsBlock(8);
      await send(chat, block ?? "no outcomes recorded yet — after a case resolves, run /outcome won|partial|lost <note>");
      return true;
    }
    case "/status": {
      try {
        const h = (await (await fetch(`${DISPATCH_URL}/health`, { signal: AbortSignal.timeout(8000) })).json()) as {
          pool?: { healthy: number; total: number };
          nodes?: { backends?: Record<string, { ready?: boolean; reachable?: boolean }> }[];
          harness?: { enabled: boolean };
        };
        const ready = new Set<string>();
        for (const n of h.nodes ?? []) for (const [k, v] of Object.entries(n.backends ?? {})) if (v.ready || v.reachable) ready.add(k);
        const s = stats();
        await send(
          chat,
          `pool ${h.pool?.healthy ?? "?"}/${h.pool?.total ?? "?"} · ready: ${[...ready].join(", ") || "none"} · harness ${h.harness?.enabled ? "on" : "off"} · profile ${PROFILE}\nmemory: ${s.turns} turns, ${s.cases} outcomes`
        );
      } catch (e) {
        await send(chat, `hub unreachable: ${e instanceof Error ? e.message : e}`);
      }
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
async function handle(m: TgMessage): Promise<void> {
  const chat = m.chat.id;
  const text = (m.text ?? m.caption ?? "").trim();
  const hasAttachment = Boolean(m.photo?.length || m.document);
  if (!text && !hasAttachment) return;

  if (!ALLOWED.has(String(chat))) {
    console.log(`rejected chat ${chat} (${m.chat.type}${m.from?.username ? " @" + m.from.username : ""}) — add to TELEGRAM_ALLOWED_CHAT_IDS to allow`);
    if (m.chat.type === "private") await send(chat, `🧊 Not on the list. Your chat id is ${chat}.`);
    return;
  }

  if (text.startsWith("/") && !hasAttachment && (await handleCommand(chat, text))) return;

  await tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  const typing = setInterval(() => void tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {}), 4500);
  try {
    let documents: DocInput[] = [];
    let userContent: Msg["content"] = text;
    let attCount = 0;
    if (hasAttachment) {
      const a = await attachments(m);
      documents = a.documents;
      attCount = a.count;
      if (a.skipped.length) await send(chat, `skipping ${a.skipped.join(", ")} — send PDF/DOCX/images`);
      if (a.count === 0 && !text) return;
      const prompt = text || DEFAULT_ATTACHMENT_PROMPT;
      userContent = a.parts.length ? [{ type: "text", text: prompt }, ...a.parts] : prompt;
    }

    remember(chat, { role: "user", content: userContent });
    logTurn({ chat, role: "user", content: textOf(userContent), attachments: attCount });

    const useTools = Boolean(HARNESS_TOKEN) && !toolsOff.has(chat);
    let out: Awaited<ReturnType<typeof askDispatch>>;
    try {
      out = await askDispatch(history.get(chat) ?? [], useTools, documents);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/converter|docling/i.test(msg)) {
        await send(chat, "📄 this hub can't convert PDFs/DOCX yet (docling venv missing — see services/README.md). Send a photo or screenshot of the document instead.", m.message_id);
        return;
      }
      if (!useTools) throw e;
      // Harness unavailable (mlx cold, profile missing, ...) → plain chat.
      console.warn(`agent job failed for chat ${chat}: ${msg} — retrying as plain chat`);
      out = await askDispatch(history.get(chat) ?? [], false, documents);
      out.note += " (no web)";
    }
    remember(chat, { role: "assistant", content: out.text });
    logTurn({ chat, role: "assistant", content: out.text, model: out.model, tool_calls: out.toolCalls });
    await send(chat, out.text + out.note, m.message_id);
  } catch (e) {
    await send(chat, `🧊 the penguins slipped: ${e instanceof Error ? e.message : e}`, m.message_id);
  } finally {
    clearInterval(typing);
  }
}

async function main(): Promise<void> {
  const me = await tg<{ username: string }>("getMe", {});
  const s = stats();
  console.log(
    `telegram-penguin online as @${me.username} → ${DISPATCH_URL} model=${MODEL} tools=${HARNESS_TOKEN ? PROFILE : "off"} allowed=${ALLOWED.size} chat(s) memory=${s.turns} turns/${s.cases} outcomes`
  );
  await tg("setMyCommands", {
    commands: [
      { command: "new", description: "start a fresh case" },
      { command: "outcome", description: "won|partial|lost <note> — teach me how it ended" },
      { command: "lessons", description: "what past cases taught this hub" },
      { command: "tools", description: "on|off — toggle web search" },
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

if (!TOKEN) {
  // Under launchd KeepAlive an exit would crash-loop every 15s. Idle instead.
  console.log("TELEGRAM_BOT_TOKEN not set — telegram-penguin idle. Put the token in services/.env and kickstart this service.");
  setInterval(() => console.log("still waiting for TELEGRAM_BOT_TOKEN"), 10 * 60_000);
} else {
  void main();
}
