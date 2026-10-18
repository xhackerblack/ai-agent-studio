/* AI Agent Studio frontend — vanilla JS, Arabic RTL, mobile-first. */
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  agents: [],
  currentAgent: null,
  currentConv: null,
  password: localStorage.getItem("aas_pw") || "",
};

function headers(extra = {}) {
  const h = { ...extra };
  if (state.password) h["x-app-password"] = state.password;
  return h;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: headers(opts.headers || {}) });
  if (res.status === 401) throw Object.assign(new Error("unauthorized"), { code: "unauthorized" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.code || res.status);
    e.code = data.code; e.detail = data.detail || ""; e.message = data.message || "";
    throw e;
  }
  return data;
}

const ERR_AR = {
  quota: "نفدت الحصة اليومية المجانية (١٠٬٠٠٠ خلية). تُصفَّر عند ٠٠:٠٠ UTC.",
  upstream: "تعذّرت الخدمة. حاوِل مجدداً.",
  unauthorized: "كلمة المرور غير صحيحة — حدّثها في الإعدادات.",
  network: "تعذّر الاتصال بالخادم.",
};
function errText(e) {
  const base = ERR_AR[e.code] || e.message || ERR_AR.network;
  return e.detail ? `${base} (التفاصيل: ${e.detail})` : base;
}

/* ---------- tabs ---------- */
document.querySelectorAll(".bottomnav button").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});
document.querySelectorAll("[data-go]").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.go));
});
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + name).classList.add("active");
  document.querySelectorAll(".bottomnav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  if (name === "dashboard") loadDashboard();
  if (name === "settings") loadSettings();
  window.scrollTo(0, 0);
}

/* ---------- agents ---------- */
async function loadAgents() {
  const { agents } = await api("/api/agents");
  state.agents = agents;
  const list = $("agents-list");
  list.innerHTML = agents.length ? "" : '<p class="muted">لا يوجد وكلاء بعد — أنشئ أول وكيل ✨</p>';
  for (const a of agents) {
    const d = document.createElement("div");
    d.className = "card agent-row";
    d.innerHTML = `
      <div class="av">${a.avatar}</div>
      <div><div class="nm">${escapeHtml(a.name)}</div>
      <div class="ds">${escapeHtml(a.description || a.tone || "")}</div></div>
      <div class="spacer"></div>
      <button class="btn small" data-act="chat">💬</button>
      <button class="btn small" data-act="edit">✏️</button>
      <button class="btn small" data-act="toggle">${a.isActive ? "⏸️" : "▶️"}</button>
      <button class="btn small" data-act="del">🗑️</button>`;
    d.querySelector('[data-act="chat"]').onclick = () => { setChatAgent(a.id); showView("chat"); };
    d.querySelector('[data-act="edit"]').onclick = () => openAgentModal(a);
    d.querySelector('[data-act="toggle"]').onclick = async () => {
      await api(`/api/agents/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: !a.isActive }) });
      loadAgents();
    };
    d.querySelector('[data-act="del"]').onclick = async () => {
      if (confirm("حذف الوكيل نهائياً؟")) { await api(`/api/agents/${a.id}`, { method: "DELETE" }); loadAgents(); }
    };
    list.appendChild(d);
  }
  fillAgentSelects();
}

function fillAgentSelects() {
  const opts = state.agents.map((a) => `<option value="${a.id}">${a.avatar} ${escapeHtml(a.name)}</option>`).join("");
  for (const id of ["chat-agent", "learn-agent", "know-agent", "rem-agent", "mem-agent"]) {
    const el = $(id);
    if (el) el.innerHTML = opts || '<option value="">— لا يوجد وكلاء —</option>';
  }
  if (state.agents.length && !$("chat-agent").value) setChatAgent(state.agents[0].id);
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* agent modal */
let editingId = null;
let modalTools = [];
function openAgentModal(a) {
  editingId = a ? a.id : null;
  $("am-title").textContent = a ? "تعديل الوكيل" : "وكيل جديد";
  $("am-name").value = a?.name || "";
  $("am-avatar").value = a?.avatar || "🤖";
  $("am-desc").value = a?.description || "";
  $("am-tone").value = a?.tone || "ودود ومختصر";
  $("am-prompt").value = a?.systemPrompt || "";
  $("am-model").innerHTML = (state.config?.models || []).map((m) =>
    `<option value="${m.id}" ${a?.model === m.id ? "selected" : ""}>${escapeHtml(m.label)}</option>`).join("");
  modalTools = a?.tools ? [...a.tools] : ["calculator", "datetime"];
  renderModalTools();
  $("agent-modal").classList.remove("hidden");
}
function renderModalTools() {
  const box = $("am-tools");
  box.innerHTML = "";
  for (const t of state.config?.builtinTools || []) {
    const c = document.createElement("button");
    c.className = "chip" + (modalTools.includes(t.name) ? " on" : "");
    c.textContent = `${t.icon} ${t.label}`;
    c.onclick = () => {
      modalTools = modalTools.includes(t.name)
        ? modalTools.filter((x) => x !== t.name)
        : [...modalTools, t.name];
      renderModalTools();
    };
    box.appendChild(c);
  }
}
$("am-cancel").onclick = () => $("agent-modal").classList.add("hidden");
$("am-save").onclick = async () => {
  const payload = {
    name: $("am-name").value, avatar: $("am-avatar").value, description: $("am-desc").value,
    tone: $("am-tone").value, model: $("am-model").value, systemPrompt: $("am-prompt").value,
    tools: modalTools,
  };
  try {
    if (editingId) await api(`/api/agents/${editingId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    else await api("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    $("agent-modal").classList.add("hidden");
    loadAgents();
  } catch (e) { alert(errText(e)); }
};
$("btn-new-agent").onclick = () => openAgentModal(null);
$("cta-create").onclick = () => { showView("agents"); openAgentModal(null); };

/* quick customize */
$("btn-quick").onclick = async () => {
  const desc = $("quick-desc").value.trim();
  if (!desc) return alert("صِف الوكيل بجملة واحدة أولاً");
  const box = $("quick-result");
  box.classList.remove("hidden");
  box.innerHTML = '<p class="muted">⏳ أولّد الوكيل…</p>';
  try {
    const { draft } = await api("/api/agents/quick", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: desc }),
    });
    box.innerHTML = `<div class="card"><b>${draft.avatar} ${escapeHtml(draft.name)}</b>
      <p class="muted">${escapeHtml(draft.description)}</p>
      <p class="muted">النبرة: ${escapeHtml(draft.tone)}</p></div>
      <div class="row"><button class="btn primary" id="q-save">💾 حفظ الوكيل</button>
      <button class="btn" id="q-edit">✏️ مراجعة وتعديل</button></div>`;
    $("q-save").onclick = async () => {
      await api("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      box.classList.add("hidden"); $("quick-desc").value = "";
      loadAgents();
    };
    $("q-edit").onclick = () => {
      box.classList.add("hidden");
      openAgentModal({ ...draft, tools: draft.tools });
    };
  } catch (e) { box.innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`; }
};

/* ---------- chat ---------- */
function setChatAgent(id) {
  state.currentAgent = id;
  $("chat-agent").value = id;
  loadConversations();
}
$("chat-agent").onchange = (e) => setChatAgent(e.target.value);

async function loadConversations() {
  if (!state.currentAgent) return;
  const { conversations } = await api(`/api/conversations?agentId=${state.currentAgent}`);
  const sel = $("chat-conv");
  sel.innerHTML = conversations.map((c) =>
    `<option value="${c.id}">${escapeHtml(c.title)} (${c.count})</option>`).join("");
  state.currentConv = sel.value || null;
  renderChat(conversations.find((c) => c.id === state.currentConv));
}
$("chat-conv").onchange = async (e) => {
  state.currentConv = e.target.value;
  // reload messages via a lightweight path: fetch conv list is enough for titles;
  // messages render on demand — we keep last rendered. Simpler: re-render from cached fetch:
  const { conversations } = await api(`/api/conversations?agentId=${state.currentAgent}`);
  renderChat(conversations.find((c) => c.id === state.currentConv));
};
// NOTE: conversation message bodies come through SSE render below; history bodies
// are re-fetched lazily by starting a fresh render from the conversation endpoint.
async function renderChat(meta) {
  const log = $("chat-log");
  log.innerHTML = "";
  if (!meta) { log.innerHTML = '<p class="muted">اختر وكيلاً وابدأ المحادثة 💬</p>'; return; }
  // Fetch full conversation via a dedicated lightweight call (reuse conv list? no bodies).
  // We fetch messages by re-requesting the conversation through chat history endpoint fallback:
  // Simplest reliable: keep messages client-side after SSE; for history, fetch conv detail:
  try {
    const res = await fetch(`/api/conversations/detail?id=${meta.id}`, { headers: headers() });
    if (res.ok) {
      const { conversation } = await res.json();
      for (const m of conversation.messages || []) addMsg(m.role, m.content, m.tools || []);
      return;
    }
  } catch { /* fall through */ }
  log.innerHTML = '<p class="muted">ابدأ الكتابة بالأسفل 💬</p>';
}

function addMsg(role, content, tools = []) {
  const log = $("chat-log");
  const d = document.createElement("div");
  d.className = "msg " + (role === "user" ? "user" : "bot");
  d.innerHTML = (tools.length
    ? tools.map((t) => `<span class="toolbadge">🔧 ${escapeHtml(t)}</span>`).join("") + "<br>"
    : "") + escapeHtml(content);
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

$("btn-new-conv").onclick = async () => {
  const { conversation } = await api("/api/conversations", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: state.currentAgent }),
  });
  state.currentConv = conversation.id;
  loadConversations();
};

async function sendMessage() {
  const input = $("chat-text");
  const text = input.value.trim();
  if (!text || !state.currentAgent) return;
  input.value = "";
  addMsg("user", text);
  const botEl = addMsg("bot", "⏳ …");
  $("chat-tools").textContent = "";
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ agentId: state.currentAgent, conversationId: state.currentConv, message: text }),
    });
    if (res.status === 401) throw Object.assign(new Error("unauthorized"), { code: "unauthorized" });
    if (!res.ok || !res.body) throw new Error("network");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", full = "";
    botEl.textContent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const p of parts) {
        const line = p.trim();
        if (!line.startsWith("data:")) continue;
        const obj = JSON.parse(line.slice(5));
        if (obj.type === "token") { full += obj.text; botEl.textContent = full; $("chat-log").scrollTop = $("chat-log").scrollHeight; }
        else if (obj.type === "tool") { $("chat-tools").textContent = `🔧 يستخدم: ${obj.icon} ${obj.label}…`; }
        else if (obj.type === "conversation") { state.currentConv = obj.id; }
        else if (obj.type === "error") throw Object.assign(new Error(obj.code || "upstream"), { code: obj.code, detail: obj.detail || "" });
      }
    }
    $("chat-tools").textContent = "";
    loadConversations(); // refresh titles
  } catch (e) {
    botEl.innerHTML = `<span style="color:#a32c2c">${escapeHtml(errText(e))}</span>`;
  }
}
$("btn-send").onclick = sendMessage;
$("chat-text").addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });

$("btn-learn-now").onclick = async () => {
  const st = $("learn-status");
  st.classList.remove("hidden");
  st.textContent = "⏳ يحلل المحادثة ويتعلم…";
  try {
    const r = await api("/api/learn", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: state.currentAgent, conversationId: state.currentConv }),
    });
    const n = (r.events || []).length;
    st.textContent = n ? `✅ تعلّم ${n} عناصر جديدة — شاهدها في لوحة التحكم ← سجل التعلّم` : "لا يوجد ما يستحق الحفظ هذه المرة.";
  } catch (e) { st.textContent = "❌ " + errText(e); }
};

/* training modal */
$("btn-train-open").onclick = () => { $("train-modal").classList.remove("hidden"); };
$("btn-train-cancel").onclick = () => $("train-modal").classList.add("hidden");
$("btn-train-start").onclick = async () => {
  const f = $("train-file").files[0];
  const st = $("train-status");
  st.classList.remove("hidden");
  if (!f) { st.textContent = "اختر ملفاً أولاً"; return; }
  st.textContent = "⏳ جارٍ استخراج النص وتوليد المعرفة… (قد يستغرق دقيقة)";
  try {
    const fd = new FormData();
    fd.append("agentId", state.currentAgent);
    fd.append("file", f);
    const res = await fetch("/api/train", { method: "POST", headers: headers(), body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.code || "bad"), { code: data.code, message: data.message, detail: data.detail || "" });
    st.textContent = `✅ ${data.message}` + (data.note ? ` — ملاحظة: ${data.note}` : "");
    $("train-file").value = "";
  } catch (e) { st.textContent = "❌ " + errText(e); }
};

/* ---------- dashboard ---------- */
async function loadDashboard() {
  try {
    const s = await api("/api/dashboard/stats");
    $("quota-chip").textContent = `⚡ ${s.today.quotaLeft.toLocaleString("ar")} متبقٍ`;
    $("dash-cards").innerHTML = `
      <div class="card"><h3>🤖 الوكلاء</h3><b style="font-size:24px">${s.agents}</b></div>
      <div class="card"><h3>💬 رسائل اليوم</h3><b style="font-size:24px">${s.today.messages}</b></div>
      <div class="card"><h3>🔧 استدعاءات الأدوات</h3><b style="font-size:24px">${s.today.toolCalls}</b></div>
      <div class="card"><h3>⚡ خلايا اليوم</h3><b style="font-size:24px">${s.today.neurons.toLocaleString("ar")}</b></div>`;
    drawChart(s.series);
  } catch (e) { $("dash-cards").innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`; }
  loadLearnLog(); loadKnowledge(); loadTools(); loadReminders();
}

function drawChart(series) {
  const c = $("dash-chart");
  const ctx = c.getContext("2d");
  const W = c.width = c.offsetWidth * 2, H = c.height = 280;
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(1, ...series.map((s) => s.messages));
  const bw = W / series.length;
  ctx.fillStyle = "#6c3df4";
  series.forEach((s, i) => {
    const h = (s.messages / max) * (H - 60);
    ctx.fillRect(i * bw + bw * 0.25, H - 30 - h, bw * 0.5, h);
    ctx.fillStyle = "#8a8496";
    ctx.font = "20px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(s.day, i * bw + bw / 2, H - 8);
    ctx.fillStyle = "#6c3df4";
  });
}

async function loadLearnLog() {
  const id = $("learn-agent").value || state.currentAgent;
  if (!id) return;
  const { events } = await api(`/api/learning-log/${id}`);
  const box = $("learn-log");
  box.innerHTML = events.length ? "" : '<p class="muted">لا أحداث تعلّم بعد — تحدث مع الوكيل ثم اضغط "اجعله يتعلم".</p>';
  const names = { memory: "🧠 ذاكرة", lesson: "💡 درس", gap: "❓ فجوة", training: "📄 تدريب" };
  for (const e of events.slice(0, 40)) {
    const d = document.createElement("div");
    d.className = "tl-item";
    d.innerHTML = `<span class="ev-${e.event}"><b>${names[e.event] || e.event}</b></span>
      <div>${escapeHtml(e.detail)}</div><div class="at">${new Date(e.at).toLocaleString("ar")}</div>`;
    box.appendChild(d);
  }
}
$("learn-agent").onchange = loadLearnLog;

async function loadKnowledge() {
  const id = $("know-agent").value || state.currentAgent;
  if (!id) return;
  const { files } = await api(`/api/knowledge/${id}`);
  const box = $("know-list");
  box.innerHTML = files.length ? "" : '<p class="muted">لا ملفات تدريب بعد.</p>';
  for (const f of files) {
    const d = document.createElement("div");
    d.className = "card agent-row";
    d.innerHTML = `<div class="av">📄</div><div><div class="nm">${escapeHtml(f.filename)}</div>
      <div class="ds">${f.chunks} مقطعاً — ${new Date(f.uploadedAt).toLocaleDateString("ar")}</div></div>
      <div class="spacer"></div><button class="btn small">🗑️</button>`;
    d.querySelector("button").onclick = async () => {
      if (confirm("حذف الملف ومعرفته؟")) { await api(`/api/knowledge/${id}/${f.id}`, { method: "DELETE" }); loadKnowledge(); }
    };
    box.appendChild(d);
  }
}
$("know-agent").onchange = loadKnowledge;

async function loadTools() {
  const { builtin, custom } = await api("/api/tools");
  const box = $("tools-list");
  box.innerHTML = "";
  for (const t of builtin) {
    const d = document.createElement("div");
    d.className = "card agent-row";
    d.innerHTML = `<div class="av">${t.icon}</div><div><div class="nm">${escapeHtml(t.label)}</div>
      <div class="ds">${escapeHtml(t.description.slice(0, 80))}…</div></div>`;
    box.appendChild(d);
  }
  for (const t of custom) {
    const d = document.createElement("div");
    d.className = "card agent-row";
    d.innerHTML = `<div class="av">${t.icon}</div><div><div class="nm">${escapeHtml(t.name)}</div>
      <div class="ds" dir="ltr">${escapeHtml(t.baseUrl)}</div></div>
      <div class="spacer"></div><button class="btn small">🗑️</button>`;
    d.querySelector("button").onclick = async () => {
      await api(`/api/tools/${t.id}`, { method: "DELETE" }); loadTools();
    };
    box.appendChild(d);
  }
}
$("btn-add-tool").onclick = async () => {
  try {
    await api("/api/tools", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $("ct-name").value, baseUrl: $("ct-base").value, description: $("ct-desc").value }),
    });
    $("ct-name").value = $("ct-base").value = $("ct-desc").value = "";
    loadTools();
  } catch (e) { alert(errText(e)); }
};

async function loadReminders() {
  const id = $("rem-agent").value || state.currentAgent;
  if (!id) return;
  const { reminders } = await api(`/api/reminders/${id}`);
  const box = $("rem-list");
  box.innerHTML = reminders.length ? "" : '<p class="muted">لا تذكيرات — اطلب من الوكيل: "ذكّرني بـ…"</p>';
  for (const r of reminders.slice(0, 20)) {
    const d = document.createElement("div");
    d.className = "card agent-row";
    d.innerHTML = `<div class="av">⏰</div><div><div class="nm">${escapeHtml(r.text)}</div>
      <div class="ds">${escapeHtml(r.when || "")} ${r.done ? "✅" : ""}</div></div>
      ${r.done ? "" : '<div class="spacer"></div><button class="btn small">تم ✅</button>'}`;
    const b = d.querySelector("button");
    if (b) b.onclick = async () => { await api(`/api/reminders/${id}/${r.id}`, { method: "PATCH" }); loadReminders(); };
    box.appendChild(d);
  }
}
$("rem-agent").onchange = loadReminders;

/* ---------- settings ---------- */
async function loadSettings() {
  const id = $("mem-agent").value || state.currentAgent;
  if (!id) return;
  const { memories } = await api(`/api/memories/${id}`);
  const box = $("mem-list");
  const keys = Object.keys(memories);
  box.innerHTML = keys.length ? "" : '<p class="muted">لا ذكريات محفوظة بعد.</p>';
  for (const k of keys) {
    const d = document.createElement("div");
    d.className = "card agent-row";
    d.innerHTML = `<div><div class="nm">${escapeHtml(k)}</div><div class="ds">${escapeHtml(memories[k])}</div></div>
      <div class="spacer"></div><button class="btn small">🗑️</button>`;
    d.querySelector("button").onclick = async () => {
      await api(`/api/memories/${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: k }) });
      loadSettings();
    };
    box.appendChild(d);
  }
}
$("mem-agent").onchange = loadSettings;
$("btn-save-pw").onclick = () => {
  state.password = $("set-password").value;
  localStorage.setItem("aas_pw", state.password);
  alert(state.password ? "حُفظت كلمة المرور على هذا الجهاز ✅" : "أُزيلت كلمة المرور");
};

/* ---------- init ---------- */
(async function init() {
  try {
    state.config = await api("/api/config");
    await loadAgents();
    if (state.agents.length) setChatAgent(state.agents[0].id);
    else {
      // Seed a demo agent so the app works immediately
      const { agent } = await api("/api/agents", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "مساعدي الذكي", avatar: "🤖", description: "وكيل تجريبي جاهز", tone: "ودود ومختصر" }),
      });
      await loadAgents();
      setChatAgent(agent.id);
    }
    loadDashboard();
  } catch (e) {
    document.querySelector("main").innerHTML = `<div class="note err">تعذّر الاتصال بالخادم: ${escapeHtml(errText(e))}</div>`;
  }
})();
