const $ = (id) => document.getElementById(id);
const WINDOW_S = 120;
const IDS = ["qwen35", "qwen25", "jev"];
const INFO = {
  qwen35: { title: "MLX", mode: "continuous batching", note: "Qwen3.5-27B on mlx_vlm (:8321). Every request is visible via /metrics, including penguin and compute traffic." },
  qwen25: { title: "Ollama", mode: "ollama (llama.cpp)", note: "qwen2.5-coder:7b on Ollama (:11434). Ollama has no metrics API, so only probes run from this page appear as jobs." },
  jev: { title: "Jev", mode: "llm2jev --submission all", note: "Qwen3-14B scoring server (LLM2Jev, :30000). It scores inputs instead of generating text: a probe sends one /v1/systemone evaluation and is timed by prompt tokens per second. Outside requests are counted from /tmp/llm2jev.log (no timings)." },
};

let cur = IDS.includes(localStorage.getItem("backend")) ? localStorage.getItem("backend") : "qwen35";
const S = Object.fromEntries(IDS.map((b) => [b, { up: false, engine: {}, reqs: [], live: {}, load: {}, series: [], fresh: null }]));
const st = () => S[cur];
let backends = {}, sortKey = "id", sortDir = -1, filter = "all";
const srcBadge = (s) => `<span class="src ${s || "normal"}">${s || "normal"}</span>`;
const probes = {};

const f = (n, d = 1) => (n == null || Number.isNaN(+n)) ? "—" : (+n).toFixed(d);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dur = (s) => {
  if (s == null) return "—";
  if (s < 1) return `${(s * 1000) | 0} ms`;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
};
const when = (u) => {
  if (!u) return "—";
  const d = new Date(u * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const bar = (num, den, label, cls = "") => {
  const pct = den ? Math.min(100, (100 * num) / den) : 0;
  return `<div class="progress"><div class="bar ${cls}" style="width:${pct}%"></div><span>${label}</span></div>`;
};

// ---- tabs, toggle, collapsibles -------------------------------------------
const TABS = ["jobs", "stages", "executors", "environment"];
function showTab() {
  const hash = location.hash.slice(1) || "jobs";
  const tab = TABS.includes(hash) ? hash : "jobs";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("show", t.id === "tab-" + tab));
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  document.title = `${INFO[cur].title} Serve - ${tab[0].toUpperCase() + tab.slice(1)}`;
  if (tab === "environment") loadEnv();
  if (!TABS.includes(hash) && $(hash)) requestAnimationFrame(() => $(hash).scrollIntoView());
  requestAnimationFrame(() => { drawLive(); drawBars(); });
}
window.addEventListener("hashchange", showTab);

function select(b) {
  cur = b;
  localStorage.setItem("backend", b);
  document.querySelectorAll("#toggle button").forEach((x) => x.classList.toggle("active", x.dataset.b === b));
  const jev = b === "jev";
  $("title-backend").textContent = INFO[b].title;
  $("backend-note").textContent = INFO[b].note;
  $("k-mode").textContent = INFO[b].mode;
  $("probe-target").textContent = (backends[b] && backends[b].label) || b;
  $("lmax").parentElement.style.display = jev ? "none" : "";
  const quickOpt = $("chat-mode").querySelector('option[value="quick"]');
  quickOpt.textContent = `Quick (stream from ${b === "qwen25" ? "Qwen2.5" : "Qwen3.5"}, no tools)`;
  document.title = `${INFO[b].title} Serve`;
  renderEngine(); renderReqs(); renderLive(); drawLive();
}
document.querySelectorAll("#toggle button").forEach((x) => x.addEventListener("click", () => select(x.dataset.b)));
document.addEventListener("keydown", (e) => {
  if (e.target.matches("textarea, input, select")) return;
  const i = ["1", "2", "3"].indexOf(e.key);
  if (i >= 0) select(IDS[i]);
});

document.querySelectorAll(".collapse-toggle").forEach((el) => el.addEventListener("click", () => {
  el.classList.toggle("closed");
  $(el.dataset.target).classList.toggle("hidden");
  drawLive();
}));
document.querySelectorAll("#jobs-table th[data-k]").forEach((th) => th.addEventListener("click", () => {
  const k = th.dataset.k;
  sortDir = sortKey === k ? -sortDir : -1; sortKey = k;
  document.querySelectorAll("#jobs-table .sort").forEach((s) => s.remove());
  th.insertAdjacentHTML("beforeend", `<span class="sort">${sortDir < 0 ? "▾" : "▴"}</span>`);
  renderReqs();
}));

function pushPoint(b, t, v) {
  const s = S[b].series;
  s.push({ t, v });
  const cutoff = Date.now() / 1000 - WINDOW_S - 5;
  while (s.length && s[0].t < cutoff) s.shift();
}
function withIds(b, list) {
  const total = (S[b].engine.completed || 0) + (S[b].engine.failed || 0);
  const base = Math.max(0, (total || list.length) - list.length);
  return list.map((r, i) => ({ ...r, id: base + i }));
}

// ---- SSE: engine stream ----------------------------------------------------
function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => { $("sse").className = "badge ok"; $("sse").textContent = "SSE live"; };
  es.onerror = () => { $("sse").className = "badge bad"; $("sse").textContent = "SSE reconnecting"; };
  es.addEventListener("snapshot", (e) => {
    const d = JSON.parse(e.data);
    backends = d.backends || {};
    for (const b of IDS) {
      S[b].live = (d.live || {})[b] || {};
      S[b].load = (d.load || {})[b] || {};
      S[b].reqs = withIds(b, ((d.recent || {})[b] || []).slice(-200));
    }
    select(cur);
  });
  es.addEventListener("load", (e) => {
    const l = JSON.parse(e.data), b = l.backend;
    if (!S[b]) return;
    S[b].load = l;
    if (b === cur) { renderLive(); renderLoad(); }
  });
  es.addEventListener("load_output", (e) => {
    const o = JSON.parse(e.data);
    if (o.backend !== cur) return;
    const text = (o.text || "(empty response)").replace(/\n/g, "\n    ");
    $("out").textContent += `\n[#${o.id} · ${f(o.elapsed_s, 2)} s${o.ok ? "" : " · failed"}]\n    ${text}\n`;
    $("out").scrollTop = $("out").scrollHeight;
  });
  es.addEventListener("tick", (e) => {
    const d = JSON.parse(e.data);
    for (const b of IDS) {
      const eng = (d.engines || {})[b];
      if (eng) { S[b].up = eng.up; if (eng.engine) S[b].engine = eng.engine; }
      if (d.live && d.live[b]) S[b].live = d.live[b];
      if (d.load && d.load[b]) S[b].load = d.load[b];
      const l = S[b].live;
      pushPoint(b, d.t, l.active ? (l.inst_tok_s || 0) : 0);
      if (S[b].reqs.length && S[b].reqs[0].id == null) S[b].reqs = withIds(b, S[b].reqs);
    }
    renderToggle(); renderEngine(); renderLive();
  });
  es.addEventListener("live", (e) => {
    const l = JSON.parse(e.data), b = l.backend || "qwen35";
    if (!S[b]) return;
    S[b].live = l;
    pushPoint(b, Date.now() / 1000, l.active ? (l.inst_tok_s || 0) : 0);
    if (b === cur) renderLive();
  });
  es.addEventListener("request", (e) => {
    const r = JSON.parse(e.data), b = r.backend || "qwen35";
    if (!S[b]) return;
    const s = S[b];
    const lastId = s.reqs.length ? s.reqs.at(-1).id : ((s.engine.completed || 0) + (s.engine.failed || 0)) - 1;
    s.reqs.push({ ...r, id: lastId + 1 }); s.reqs = s.reqs.slice(-200);
    s.fresh = r.timestamp_unix;
    if (b === cur) renderReqs();
  });
}

// ---- support chat → reimbursement engine ------------------------------------
const PRESETS = [
  ["Flight cancelled, voucher only", "Delta cancelled my JFK to SFO flight on Sept 20 and only offered a $200 voucher. The ticket was $412 on my Chase Sapphire. They say vouchers are their policy. What do I do?"],
  ["\"All sales final\"", "A boutique refuses to refund a $180 jacket that fell apart after one week. They say all sales are final. What can I do?"],
  ["Past the return window", "I missed Best Buy's 15-day return window by 4 days on a $650 laptop with a defective screen. They say it's too late."],
  ["Bank: \"charge was authorized\"", "My bank closed my $299 chargeback saying the charge was authorized because I gave the merchant my card. But the service was never delivered."],
  ["Employer: \"not in policy\"", "My employer rejected an $86 client dinner saying alcohol isn't reimbursable, but my manager approved the dinner in advance."],
  ["No receipt", "I lost the receipt for a $140 work taxi ride last month. Finance says no receipt, no reimbursement."],
  ["Can't cancel subscription", "A gym keeps charging me $49/month three months after I cancelled in writing. They say I must cancel in person."],
  ["Package never arrived", "Amazon marked my $220 order delivered on Sept 12 but it never arrived, and the third-party seller won't respond."],
  ["Insurance denied ER", "My insurer denied a $1,200 ER bill as out-of-network even though I went to the nearest hospital in an emergency."],
  ["Only store credit", "The airline refunded my cancelled $380 hotel add-on as store credit only. I want cash back."],
];
const newSession = () => "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
let chat = JSON.parse(sessionStorage.getItem("chat") || "null") || { session: newSession(), messages: [] };
chat.busy = false;
const saveChat = () => sessionStorage.setItem("chat", JSON.stringify({ session: chat.session, messages: chat.messages.filter((m) => !m.pending) }));

$("presets").innerHTML = PRESETS.map(([label], i) => `<a data-i="${i}" title="${esc(PRESETS[i][1])}">${esc(label)}</a>`).join("");
$("presets").querySelectorAll("a").forEach((a) => a.onclick = () => { $("chat-input").value = PRESETS[+a.dataset.i][1]; $("chat-input").focus(); });

function triageTags(t) {
  if (!t || t.error) return t && t.error ? `<span class="tag warn">triage failed</span>` : "";
  const tags = [];
  for (const [k, p] of (t.domain?.top3 || [])) if (p >= 0.15) tags.push(`<span class="tag dom">${esc(k.replace(/_/g, " "))}</span>`);
  for (const [k, p] of (t.objection?.top3 || [])) if (p >= 0.15 && k !== "none_yet") tags.push(`<span class="tag obj">${esc(k.replace(/_/g, " "))}</span>`);
  if (t.has_facts != null && t.has_facts < 0.5) tags.push(`<span class="tag warn">missing amount / company / date</span>`);
  return tags.length ? `<div class="tags">${tags.join("")}</div>` : "";
}

function renderChat() {
  const log = $("chat-log");
  log.innerHTML = chat.messages.map((m) => {
    const meta = m.meta ? `<div class="meta">${m.meta}</div>` : "";
    return `<div class="msg ${m.role}${m.pending ? " pending" : ""}">${esc(m.content || "")}${m.role === "user" ? triageTags(m.triage) : ""}${meta}</div>`;
  }).join("") || `<div class="muted">Ask a reimbursement question or pick a common objection below. Replies come from the reimbursement-advocate engine, with the lessons from past cases in the prompt.</div>`;
  log.scrollTop = log.scrollHeight;
  $("chat-send").disabled = chat.busy;
}

function renderTriage(t) {
  if (!t) return;
  if (t.error) { $("triage").innerHTML = `<span style="color:#b94a48">Jev triage failed: ${esc(t.error)}</span>`; return; }
  const rows = (list) => (list || []).map(([k, p]) =>
    `<tr><td>${esc(k.replace(/_/g, " "))}</td><td class="p">${f(p * 100, 0)}%</td></tr>`).join("");
  $("triage").innerHTML = `<table>
      <tr><td colspan="2"><b>Domain</b></td></tr>${rows(t.domain?.top3)}
      <tr><td colspan="2"><b>Objection</b></td></tr>${rows(t.objection?.top3)}
      <tr><td><b>Key facts present</b></td><td class="p">${t.has_facts == null ? "—" : f(t.has_facts * 100, 0) + "%"}</td></tr>
    </table><div class="muted" style="margin-top:4px">${t.prompt_tokens} prompt tokens scored in ${f(t.elapsed_s, 1)} s. Near-equal shares mean several routes apply.</div>`;
}

async function loadEngine() {
  try {
    const e = await (await fetch("/api/chat/engine")).json();
    const o = e.outcomes || {};
    $("engine-bar").innerHTML = `Engine: <b>${esc(e.profile)}</b> ${e.profile_loaded ? "" : "(profile missing!)"} · ` +
      `harness ${e.harness_token ? "<b>on</b> (web_search)" : "<b style='color:#b94a48'>off</b> (no HARNESS_TOKEN)"}` +
      (e.limits ? ` · ≤${e.limits.max_tool_rounds} tool rounds, ${f(e.limits.timeout_ms / 1000, 0)} s` : "") +
      ` · memory: <b>${e.turns}</b> turns (${e.support_turns} from this chat UI) · outcomes <b>${o.won || 0}</b> won / ${o.partial || 0} partial / ${o.lost || 0} lost`;
    $("lessons").textContent = e.lessons || "none yet. Record an outcome to start the loop.";
  } catch (err) {
    $("engine-bar").textContent = "engine info unavailable: " + err;
  }
}

async function streamPost(url, body, onEvent, signal) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(ev, JSON.parse(data));
    }
  }
}

async function sendChat() {
  const text = $("chat-input").value.trim();
  if (!text || chat.busy) return;
  const mode = $("chat-mode").value;
  const backend = ["qwen35", "qwen25"].includes(cur) ? cur : "qwen35";
  const target = mode === "engine" ? "qwen35" : backend;
  $("chat-input").value = "";
  const user = { role: "user", content: text };
  const bot = { role: "assistant", content: mode === "engine" ? "Engine working…" : "", pending: true };
  chat.messages.push(user, bot);
  chat.busy = true;
  probes[target] = { prompt: text, submitted: Date.now() / 1000, mode };
  renderChat(); renderLive();
  const history = chat.messages.filter((m) => !m.pending).map(({ role, content }) => ({ role, content }));
  let streamed = "";
  try {
    await streamPost("/api/chat", { session: chat.session, mode, backend, messages: history }, (ev, d) => {
      if (ev === "triage") { user.triage = d; renderTriage(d); }
      else if (ev === "status") { if (!streamed) bot.content = d.elapsed_s ? `Engine working… ${f(d.elapsed_s, 0)} s (it may run web searches)` : d.phase; }
      else if (ev === "token") {
        if (d.text) { streamed += d.text; bot.content = streamed; }
        else if (!streamed && d.reasoning) bot.content = "Thinking…";
        S[target].live = { ...d, active: true };
        if (cur === target) renderLive();
      } else if (ev === "reply") {
        bot.content = d.text; bot.pending = false;
        const h = d.harness || {};
        bot.meta = [d.mode === "engine" ? `engine · ${esc(d.model)}` : `quick · ${esc(d.model)}`,
          h.tool_calls ? `${h.tool_calls} web search${h.tool_calls > 1 ? "es" : ""}` : d.mode === "engine" ? "no tool calls" : "",
          `${f(d.elapsed_s, 1)} s`, d.lessons ? "lessons in prompt" : ""].filter(Boolean).join(" · ");
      } else if (ev === "fail") { bot.content = `[error] ${d.error}`; bot.pending = false; }
      renderChat();
    });
  } catch (err) {
    bot.content = `[error] ${err}`; bot.pending = false;
  }
  if (bot.pending) { bot.pending = false; bot.content ||= "(no reply)"; }
  chat.busy = false;
  delete probes[target];
  saveChat(); renderChat(); renderLive(); loadEngine();
}

async function recordOutcome(outcome) {
  const firstUser = chat.messages.find((m) => m.role === "user");
  if (!firstUser) { $("outcome-status").textContent = "Start a conversation first."; return; }
  const lastTriage = [...chat.messages].reverse().find((m) => m.triage && !m.triage.error)?.triage;
  const domain = lastTriage?.domain?.choice ? `[${lastTriage.domain.choice.replace(/_/g, " ")}] ` : "";
  const r = await fetch("/api/chat/outcome", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: chat.session, outcome, note: $("outcome-note").value, summary: domain + firstUser.content.slice(0, 200) }) });
  const d = await r.json();
  $("outcome-status").textContent = r.ok ? `Recorded "${outcome}". Now ${d.cases} outcomes in the engine; future replies (here and on Telegram) will weigh it.` : d.error;
  if (r.ok) { $("outcome-note").value = ""; loadEngine(); }
}

$("chat-send").onclick = sendChat;
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
$("chat-new").onclick = () => { chat = { session: newSession(), messages: [], busy: false }; saveChat(); renderChat(); $("triage").textContent = "New conversation."; $("outcome-status").textContent = ""; };
document.querySelectorAll(".out-btn").forEach((b) => b.onclick = () => recordOutcome(b.dataset.o));
renderChat();
loadEngine();

async function fireLoad() {
  const q = new URLSearchParams({ backend: cur, rps: $("rps").value, seconds: $("secs").value,
    max_tokens: $("lmax").value, prompt: $("prompt").value });
  const r = await fetch("/api/load?" + q);
  const d = await r.json();
  if (!r.ok) { $("load-status").textContent = d.error || "failed"; return; }
  $("out").classList.remove("muted");
  $("out").textContent = `-- load: ${d.total} requests @ ${d.rps}/s on ${cur}\n`;
}
$("load-go").onclick = fireLoad;

function renderLoad() {
  const l = st().load || {};
  $("load-go").disabled = !!l.active;
  if (!l.total) { $("load-status").textContent = ""; return; }
  const end = l.finished || Date.now() / 1000;
  const elapsed = l.started ? end - l.started : 0;
  $("load-status").innerHTML = `${l.active ? "running" : "finished"}: sent ${l.sent}/${l.total} @ ${l.rps}/s · ` +
    `done ${l.done} · failed ${l.failed} · ${dur(elapsed)}` +
    (!l.active && elapsed ? ` · ${f(l.done / elapsed, 2)} completed/s` : "");
}

// ---- render ----------------------------------------------------------------
function statusBadge(s) {
  if (!s.up) return `<span class="badge bad">DOWN</span>`;
  return (s.engine.in_flight || 0) > 0 ? `<span class="badge run">RUNNING</span>` : `<span class="badge ok">ACTIVE</span>`;
}

function renderToggle() {
  document.querySelectorAll("#toggle button").forEach((x) => {
    const s = S[x.dataset.b];
    x.querySelector(".sdot").className = "sdot " + (!s.up ? "down" : (s.engine.in_flight || 0) > 0 ? "busy" : "up");
  });
}

function renderEngine() {
  const s = st(), engine = s.engine;
  $("model").textContent = (engine.model || "—").replace("mlx-community/", "");
  $("k-uptime").textContent = dur(engine.uptime_s) + (engine.metrics === "probe-only" ? " (monitor uptime)" : "");
  $("k-completed").textContent = engine.completed ?? "—";
  $("k-failed").textContent = engine.failed ?? "—";
  $("k-queue").textContent = cur === "qwen35"
    ? `${engine.queue_depth ?? "—"} (engine) · ${engine.dispatch_queued ?? "—"} (dispatch)`
    : "not reported";
  if (cur === "qwen35" && engine.slots) $("k-mode").textContent = `continuous batching · ${engine.slots} slots`;
  $("s-eng").textContent = engine.avg_decode_tok_s ? f(engine.avg_decode_tok_s) + " tok/s" : "—";
  $("n-completed").textContent = (engine.completed ?? 0) + (engine.failed ?? 0);

  $("exec-summary").innerHTML = IDS.map((b) => {
    const x = S[b], e = x.engine, cfg = backends[b] || {};
    return `<tr${b === cur ? ' style="font-weight:700"' : ""}>
      <td><a onclick="select('${b}')" style="cursor:pointer">${esc(cfg.label || b)}</a></td>
      <td>${esc((cfg.base || "").replace("http://", ""))}</td>
      <td>${esc((e.model || "—").replace("mlx-community/", ""))}</td>
      <td>${statusBadge(x)}</td><td>${e.in_flight ?? "—"}</td><td>${e.queue_depth ?? "—"}</td>
      <td>${e.completed ?? "—"}</td><td>${e.failed ?? "—"}</td>
      <td>${e.prompt_tokens_total ?? "—"}</td><td>${e.generated_tokens_total ?? "—"}</td>
      <td>${e.avg_decode_tok_s ? f(e.avg_decode_tok_s) + " tok/s" : "—"}</td><td>${dur(e.avg_request_time_s)}</td>
      <td>${e.memory_gb ? f(e.memory_gb) + " GB" : "—"}</td><td>${e.metrics || "—"}</td></tr>`;
  }).join("");

  const q = S.qwen35.engine;
  $("exec-rows").innerHTML = [
    ["dispatch", "127.0.0.1:8877", q.dispatch_queued != null ? `<span class="badge ok">ACTIVE</span>` : `<span class="badge">UNKNOWN</span>`, `queued ${q.dispatch_queued ?? "—"} · running qwen ${q.dispatch_running ?? "—"}`],
    ["monitor (this UI)", "127.0.0.1:8880", `<span class="badge ok">ACTIVE</span>`, "SSE /api/events · /api/generate?backend="],
  ].map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
}

function renderLive() {
  const s = st(), live = s.live, active = !!live.active, jev = cur === "jev";
  $("big").innerHTML = jev
    ? `${f(active ? 0 : live.tok_s, 0)}<small>prompt tok/s (last eval)</small>`
    : `${f(active ? live.inst_tok_s : 0)}<small>tok/s</small>`;
  $("s-avg").textContent = f(live.tok_s);
  $("s-tok").textContent = live.tokens ?? "—";
  $("s-ttft").textContent = live.ttft_s == null ? "—" : f(live.ttft_s, 2) + " s";

  const rows = [], p = probes[cur];
  const nextId = s.reqs.length ? s.reqs.at(-1).id + 1 : "—";
  if (active || p) {
    const engine = p && p.mode === "engine" && !active;
    const progress = jev
      ? bar(1, 1, "evaluating…", "running")
      : engine ? bar(1, 1, "harness running", "running")
      : bar(live.tokens || 0, 900, `${live.tokens || 0} tokens`, "running");
    rows.push(`<tr><td>${nextId}</td><td>${srcBadge(p ? "chat" : "probe")}</td>
      <td class="desc">${p ? `${p.mode} chat: ` : ""}${esc(p ? p.prompt : "(another tab)")}</td>
      <td>${when(p && p.submitted)}</td><td>${dur(engine ? Date.now() / 1000 - p.submitted : live.elapsed_s || (p ? Date.now() / 1000 - p.submitted : null))}</td>
      <td>${!engine && live.ttft_s != null ? dur(live.ttft_s) : "—"}</td><td>${jev || engine ? "—" : f(live.inst_tok_s)}</td><td>${progress}</td></tr>`);
  }
  const l = s.load || {};
  const loadOpen = l.active ? Math.max(0, (l.sent || 0) - (l.done || 0) - (l.failed || 0)) : 0;
  if (l.active) {
    const fin = (l.done || 0) + (l.failed || 0);
    rows.push(`<tr><td>—</td><td>${srcBadge("load")}</td>
      <td class="desc">${l.total} requests @ ${l.rps}/s · ${loadOpen} open${l.failed ? ` · <span style="color:#b94a48">${l.failed} failed</span>` : ""}</td>
      <td>${when(l.started)}</td><td>${dur(Date.now() / 1000 - l.started)}</td><td>—</td><td>—</td>
      <td>${bar(fin, l.total, `${fin}/${l.total} done`, "running")}</td></tr>`);
  }
  // One row per in-flight load request (the only per-request view for Jev/Ollama).
  const jobs = l.jobs || [];
  const nowS = Date.now() / 1000;
  for (const j of jobs) {
    rows.push(`<tr><td>load #${j.id + 1}</td><td>${srcBadge("load")}</td>
      <td class="desc">${esc(j.prompt)} (request #${j.id})</td>
      <td>${when(j.started)}</td><td>${dur(nowS - j.started)}</td><td>—</td><td>—</td>
      <td>${bar(1, 1, jev ? "evaluating…" : "running", "running")}</td></tr>`);
  }
  const inFlight = s.engine.in_flight || 0;
  const slots = s.engine.slots || inFlight;
  const queued = Math.max(0, inFlight - slots);
  const running = Math.max(0, Math.min(inFlight, slots) - (active ? 1 : 0) - jobs.length);
  for (let i = 0; i < running; i++) {
    const src = loadOpen > i ? "load" : "normal";
    rows.push(`<tr><td>—</td><td>${srcBadge(src)}</td><td class="desc">${src === "load" ? "load request" : "penguin / compute / other client"} on engine slot ${i + 1 + (active ? 1 : 0)}</td>
      <td>—</td><td>—</td><td>—</td><td>—</td><td>${bar(1, 1, "running", "running")}</td></tr>`);
  }
  if (queued) {
    rows.push(`<tr><td>—</td><td>${srcBadge(loadOpen ? "load" : "normal")}</td><td class="desc">${queued} waiting in engine queue</td>
      <td>—</td><td>—</td><td>—</td><td>—</td><td>${bar(0, 1, `${queued} queued`)}</td></tr>`);
  }
  $("active-rows").innerHTML = rows.join("") || `<tr><td colspan="8" class="muted">No active jobs</td></tr>`;
  const count = Math.max(inFlight, (active ? 1 : 0) + loadOpen);
  $("n-active").textContent = count;
  $("k-active").textContent = count;
  renderLoad();
}

function renderReqs() {
  const s = st();
  const counts = { all: s.reqs.length, normal: 0, probe: 0, load: 0 };
  s.reqs.forEach((r) => { counts[r.source || "normal"] = (counts[r.source || "normal"] || 0) + 1; });
  $("filters").innerHTML = ["all", "normal", "chat", "probe", "load"].map((k) =>
    `<a class="${filter === k ? "on" : ""}" data-f="${k}">${k} (${counts[k] || 0})</a>`).join("");
  $("filters").querySelectorAll("a").forEach((a) => a.onclick = () => { filter = a.dataset.f; renderReqs(); });
  const list = s.reqs.filter((r) => filter === "all" || (r.source || "normal") === filter).sort((a, b) => {
    const x = a[sortKey] ?? -Infinity, y = b[sortKey] ?? -Infinity;
    return (x > y ? 1 : x < y ? -1 : 0) * sortDir;
  });
  $("rows").innerHTML = list.map((r) => {
    const failed = r.finish_reason === "error" || +r.finish_reason >= 400;
    const tags = [r.stream ? "stream" : "sync", r.tool_calls ? "tools" : "", r.finish_reason].filter(Boolean).join(", ");
    const pt = r.prompt_tokens, ct = r.completion_tokens;
    return `<tr class="${r.timestamp_unix === s.fresh ? "fresh" : ""}">
      <td>${r.id}</td><td>${srcBadge(r.source)}</td>
      <td class="desc"><a>${esc(r.endpoint || "/chat/completions")}</a> <span class="muted">(${esc(tags)})</span></td>
      <td>${when(r.timestamp_unix)}</td>
      <td>${dur(r.request_elapsed_s)}</td>
      <td>${dur(r.ttft_s)}</td>
      <td>${f(r.prefill_tok_s, 0)}</td>
      <td>${f(r.decode_tok_s)}</td>
      <td>${r.peak_memory_gb ? f(r.peak_memory_gb) + " GB" : "—"}</td>
      <td>${pt == null && ct == null ? `<span class="muted">not reported</span>` : bar(ct || 0, (pt || 0) + (ct || 0), `${pt ?? "?"} → ${ct ?? "?"}`, failed ? "failed" : "")}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" class="muted">No ${filter === "all" ? "" : filter + " "}jobs yet</td></tr>`;
  renderQuantiles();
  drawBars();
}

function renderQuantiles() {
  const reqs = st().reqs;
  const q = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i);
    return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
  };
  const metrics = [
    ["Duration", "request_elapsed_s", dur],
    ["Time to first token", "ttft_s", dur],
    ["Decode tok/s", "decode_tok_s", (v) => f(v)],
    ["Prefill tok/s", "prefill_tok_s", (v) => f(v, 0)],
    ["Prompt tokens", "prompt_tokens", (v) => f(v, 0)],
    ["Output tokens", "completion_tokens", (v) => f(v, 0)],
    ["Peak memory", "peak_memory_gb", (v) => f(v, 2) + " GB"],
  ];
  $("quantiles").innerHTML = metrics.map(([label, k, fmt]) => {
    const vals = reqs.map((r) => r[k]).filter((v) => v != null);
    return `<tr><td>${label}</td>${[0, .25, .5, .75, 1].map((p) => `<td>${vals.length ? fmt(q(vals, p)) : "—"}</td>`).join("")}</tr>`;
  }).join("");
}

// ---- environment -----------------------------------------------------------
async function loadEnv() {
  try {
    const s = await (await fetch("/api/status")).json();
    const flat = (o, pre = "", out = []) => {
      for (const [k, v] of Object.entries(o || {})) {
        if (v && typeof v === "object" && !Array.isArray(v)) flat(v, pre + k + ".", out);
        else out.push([pre + k, Array.isArray(v) ? JSON.stringify(v) : v]);
      }
      return out;
    };
    const row = ([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`;
    const srv = (s.metrics?.data?.server) || {};
    const up = (x) => (x?.http ? "up" : "down");
    $("env-runtime").innerHTML = [
      ["Qwen3.5 · MLX (:8321)", `${up(s.health)} · ${srv.loaded_model || "—"}`],
      ["Qwen2.5 · Ollama (:11434)", `${up(s.ollama_version)} · v${s.ollama_version?.data?.version || "?"} · loaded: ${(s.ollama_ps?.data?.models || []).map((m) => m.name).join(", ") || "none"}`],
      ["Jev · LLM2Jev (:30000)", `${up(s.jev_health)} · ${(s.jev_models?.data?.data || []).map((m) => m.id).join(", ")}`],
      ["Compute (:8878)", up(s.compute)],
      ["Dispatch (:8877)", up(s.dispatch)],
    ].map(row).join("");
    $("env-props").innerHTML = flat({ server: srv, cache: s.cache?.data }).map(row).join("");
  } catch (e) {
    $("env-runtime").innerHTML = `<tr><td colspan="2">${esc(e)}</td></tr>`;
  }
}

// ---- charts ----------------------------------------------------------------
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return null;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawLive() {
  const c = setup($("chart-live")); if (!c) return;
  const s = st(), engine = s.engine, reqs = s.reqs, series = s.series;
  const rate = (r) => r.decode_tok_s || r.prefill_tok_s || 0;
  const { ctx, w, h } = c, pad = { l: 40, r: 10, t: 8, b: 22 };
  const now = Date.now() / 1000, t0 = now - WINDOW_S;
  const inWin = reqs.filter((r) => r.timestamp_unix >= t0);
  const max = Math.ceil(Math.max(12, engine.avg_decode_tok_s || 0, ...series.map((p) => p.v), ...inWin.map(rate)) * 1.2);
  const X = (t) => pad.l + (w - pad.l - pad.r) * ((t - t0) / WINDOW_S);
  const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);

  ctx.font = "11px 'Helvetica Neue', Helvetica, Arial, sans-serif";
  ctx.lineWidth = 1;
  for (let sec = 0; sec <= WINDOW_S; sec += 10) {
    const x = X(now - sec);
    ctx.strokeStyle = sec % 30 ? "#f0f0f0" : "#e0e0e0";
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    if (sec % 30 === 0) {
      ctx.fillStyle = "#666";
      ctx.fillText(new Date((now - sec) * 1000).toLocaleTimeString([], { hour12: false }), x - 24, h - 6);
    }
  }
  ctx.fillStyle = "#666"; ctx.strokeStyle = "#e0e0e0";
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(v.toFixed(0), 8, y + 4);
  }
  ctx.strokeStyle = "#bbb"; ctx.strokeRect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);

  if (engine.avg_decode_tok_s) {
    ctx.setLineDash([5, 4]); ctx.strokeStyle = "#888";
    ctx.beginPath(); ctx.moveTo(pad.l, Y(engine.avg_decode_tok_s)); ctx.lineTo(w - pad.r, Y(engine.avg_decode_tok_s)); ctx.stroke();
    ctx.setLineDash([]);
  }

  const pts = series.filter((p) => p.t >= t0 - 2);
  if (pts.length > 1) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
    ctx.lineTo(X(pts.at(-1).t), Y(0)); ctx.lineTo(X(pts[0].t), Y(0)); ctx.closePath();
    ctx.fillStyle = "rgba(160,223,255,.55)"; ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v))));
    ctx.strokeStyle = "#3a87ad"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
  }

  inWin.forEach((r) => {
    const x1 = X(r.timestamp_unix), x0 = Math.max(pad.l, X(r.timestamp_unix - (r.request_elapsed_s || 0)));
    const y = Y(rate(r));
    ctx.fillStyle = !rate(r) ? "#ddd" : r.source === "load" ? "#fbb450" : r.source === "probe" ? "#3ec0ff" : r.source === "chat" ? "#7bc47f" : "#b8c7d3";
    ctx.strokeStyle = r.source === "load" ? "#c67605" : "#1c8ecb";
    ctx.fillRect(x0, y - 7, Math.max(4, x1 - x0), 14); ctx.strokeRect(x0, y - 7, Math.max(4, x1 - x0), 14);
    ctx.fillStyle = "#333";
    if (inWin.length <= 12) {
      const label = r.decode_tok_s ? `${f(r.decode_tok_s)} tok/s` : r.prefill_tok_s ? `${f(r.prefill_tok_s, 0)} prompt tok/s` : r.source;
      ctx.fillText(`Job ${r.id} · ${label}`, Math.min(x0 + 4, w - 150), y - 11);
    }
  });
}

function drawBars() {
  const c = setup($("chart-reqs")); if (!c) return;
  const s = st(), rate = (r) => r.decode_tok_s || r.prefill_tok_s || 0;
  const data = s.reqs.filter(rate).slice(-40);
  const { ctx, w, h } = c, pad = { l: 40, r: 6, t: 8, b: 20 };
  if (!data.length) return;
  const max = Math.ceil(Math.max(12, ...data.map(rate)) * 1.15);
  const bw = (w - pad.l - pad.r) / data.length;
  ctx.font = "11px 'Helvetica Neue', Helvetica, Arial, sans-serif"; ctx.fillStyle = "#666"; ctx.strokeStyle = "#e0e0e0";
  for (let i = 0; i <= 3; i++) {
    const v = (max * i) / 3, y = pad.t + (h - pad.t - pad.b) * (1 - v / max);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(v.toFixed(0), 6, y + 4);
  }
  data.forEach((r, i) => {
    const bh = (h - pad.t - pad.b) * (rate(r) / max), x = pad.l + i * bw + 1;
    ctx.fillStyle = r.timestamp_unix === s.fresh ? "#ffd24d" : r.tool_calls ? "#c9a3ff" : "#3ec0ff";
    ctx.fillRect(x, h - pad.b - bh, Math.max(2, bw - 2), bh);
    ctx.strokeStyle = "#1c8ecb"; ctx.strokeRect(x, h - pad.b - bh, Math.max(2, bw - 2), bh);
    if (bw > 22) { ctx.fillStyle = "#666"; ctx.fillText(r.id, x + 2, h - 6); }
  });
}

setInterval(drawLive, 250);
window.addEventListener("resize", () => { drawLive(); drawBars(); });
select(cur);
showTab();
connect();
