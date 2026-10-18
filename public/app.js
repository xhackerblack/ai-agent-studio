/* AI Agent Studio frontend — Android-app-like UX (bottom sheets, FAB, toasts). */
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  agents: [],
  currentAgent: null,
  currentConv: null,
  password: localStorage.getItem("aas_pw") || "",
  sheetOnClose: null,
};

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

/* ---------- Bottom sheet ---------- */
function openSheet(html, onClose = null) {
  $("sheet-content").innerHTML = html;
  $("sheet-backdrop").classList.remove("hidden");
  $("sheet").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  state.sheetOnClose = onClose;
}
function closeSheet() {
  $("sheet-backdrop").classList.add("hidden");
  $("sheet").classList.add("hidden");
  document.body.style.overflow = "";
  if (state.sheetOnClose) { const f = state.sheetOnClose; state.sheetOnClose = null; f(); }
}
$("sheet-backdrop").addEventListener("click", closeSheet);
// swipe-down on handle to dismiss
(function () {
  const handle = document.querySelector(".sheet-handle");
  let startY = 0;
  handle.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
  handle.addEventListener("touchmove", (e) => {
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) $("sheet").style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  handle.addEventListener("touchend", (e) => {
    const dy = e.changedTouches[0].clientY - startY;
    $("sheet").style.transform = "";
    if (dy > 90) closeSheet();
  });
})();

/** Confirm dialog as a bottom sheet. Resolves true/false. */
function confirmDialog(title, message, okLabel = "تأكيد") {
  return new Promise((resolve) => {
    openSheet(`
      <h2>${escapeHtml(title)}</h2>
      <p class="muted">${escapeHtml(message)}</p>
      <div class="row" style="margin-top:14px">
        <button class="btn primary block" id="cf-ok" style="flex:1">${escapeHtml(okLabel)}</button>
        <button class="btn block" id="cf-no" style="flex:1">إلغاء</button>
      </div>`, () => resolve(false));
    $("cf-ok").onclick = () => { state.sheetOnClose = null; closeSheet(); resolve(true); };
    $("cf-no").onclick = () => closeSheet();
  });
}

/* ---------- Tabs + appbar + FAB ---------- */
const VIEW_FAB = {
  agents: { icon: "＋", action: () => openAgentModal(null) },
  chat: { icon: "＋", action: () => newConversation() },
};
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const view = $("view-" + name);
  view.classList.add("active");
  $("appbar-title").textContent = view.dataset.title || "";
  document.querySelectorAll(".bottomnav button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  const fab = $("fab");
  if (VIEW_FAB[name]) {
    fab.textContent = VIEW_FAB[name].icon;
    fab.classList.remove("hidden");
    fab.onclick = VIEW_FAB[name].action;
  } else {
    fab.classList.add("hidden");
  }
  if (name === "dashboard") loadDashboard();
  if (name === "settings") loadSettings();
  if (name === "images") renderGallery();
  if (name === "chat") setTimeout(() => $("chat-log").scrollTop = $("chat-log").scrollHeight, 60);
  window.scrollTo(0, 0);
}
document.querySelectorAll(".bottomnav button").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.view)));
document.querySelectorAll("[data-go]").forEach((b) =>
  b.addEventListener("click", () => showView(b.dataset.go)));

/* ---------- Agents ---------- */
async function loadAgents() {
  const box = $("agents-list");
  box.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  try {
    const { agents } = await api("/api/agents");
    state.agents = agents;
  } catch (e) { box.innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`; return; }
  box.innerHTML = state.agents.length ? "" : '<p class="muted">لا يوجد وكلاء بعد — اضغط ＋ لإنشاء أول وكيل ✨</p>';
  for (const a of state.agents) {
    const d = document.createElement("div");
    d.className = "card agent-row";
    d.innerHTML = `
      <div class="av">${a.avatar}</div>
      <div><div class="nm">${escapeHtml(a.name)}</div>
      <div class="ds">${escapeHtml(a.description || a.tone || "")}</div></div>
      <div class="spacer"></div>
      <div class="ops">
        <button class="btn icon-btn small-btn" data-act="chat" title="محادثة">💬</button>
        <button class="btn icon-btn" data-act="edit" title="تعديل">✏️</button>
        <button class="btn icon-btn" data-act="del" title="حذف">🗑️</button>
      </div>`;
    const btns = d.querySelectorAll("button");
    btns[0].onclick = () => { setChatAgent(a.id); showView("chat"); };
    btns[1].onclick = () => openAgentModal(a);
    btns[2].onclick = async () => {
      if (await confirmDialog("حذف الوكيل", `حذف "${a.name}" نهائياً مع كل بياناته؟`, "حذف")) {
        try { await api(`/api/agents/${a.id}`, { method: "DELETE" }); toast("تم حذف الوكيل"); loadAgents(); }
        catch (e) { toast(errText(e), true); }
      }
    };
    // long-press toggles active state
    let pressT = null;
    d.addEventListener("touchstart", () => {
      pressT = setTimeout(async () => {
        try {
          await api(`/api/agents/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ isActive: !a.isActive }) });
          toast(a.isActive ? "تم إيقاف الوكيل مؤقتاً" : "تم تفعيل الوكيل");
          loadAgents();
        } catch (e) { toast(errText(e), true); }
      }, 600);
    }, { passive: true });
    d.addEventListener("touchend", () => clearTimeout(pressT));
    box.appendChild(d);
  }
  fillAgentSelects();
}

function fillAgentSelects() {
  const opts = state.agents.map((a) => `<option value="${a.id}">${a.avatar} ${escapeHtml(a.name)}</option>`).join("");
  for (const id of ["chat-agent", "learn-agent", "know-agent", "rem-agent", "mem-agent"]) {
    const el = $(id);
    if (el) {
      const cur = el.value;
      el.innerHTML = opts || '<option value="">— لا يوجد وكلاء —</option>';
      if (cur && state.agents.some((a) => a.id === cur)) el.value = cur;
    }
  }
  if (state.agents.length && !$("chat-agent").value) setChatAgent(state.agents[0].id);
}

/* Agent editor (bottom sheet) */
let editingId = null, modalTools = [];
function openAgentModal(a) {
  editingId = a ? a.id : null;
  modalTools = a?.tools ? [...a.tools] : ["calculator", "datetime"];
  openSheet(`
    <h2>${a ? "✏️ تعديل الوكيل" : "✨ وكيل جديد"}</h2>
    <input id="am-name" placeholder="الاسم" value="${escapeHtml(a?.name || "")}">
    <div class="row">
      <input id="am-avatar" placeholder="الأيقونة" value="${escapeHtml(a?.avatar || "🤖")}" style="flex:0 0 90px;text-align:center;font-size:22px">
      <input id="am-tone" placeholder="النبرة (مثال: ودود ومختصر)" value="${escapeHtml(a?.tone || "ودود ومختصر")}" style="flex:1">
    </div>
    <input id="am-desc" placeholder="وصف قصير" value="${escapeHtml(a?.description || "")}">
    <select id="am-model">${(state.config?.models || []).map((m) =>
      `<option value="${m.id}" ${a?.model === m.id ? "selected" : ""}>${escapeHtml(m.label)}</option>`).join("")}</select>
    <textarea id="am-prompt" rows="4" placeholder="تعليمات النظام — شخصية الوكيل وخبرته">${escapeHtml(a?.systemPrompt || "")}</textarea>
    <h3>🧰 الأدوات المفعّلة</h3>
    <div id="am-tools" class="chips"></div>
    <button class="btn primary big" id="am-save">💾 حفظ الوكيل</button>`);
  renderModalTools();
  $("am-save").onclick = saveAgentModal;
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
async function saveAgentModal() {
  const payload = {
    name: $("am-name").value.trim() || "وكيل جديد",
    avatar: $("am-avatar").value || "🤖",
    description: $("am-desc").value, tone: $("am-tone").value,
    model: $("am-model").value, systemPrompt: $("am-prompt").value,
    tools: modalTools,
  };
  try {
    if (editingId) await api(`/api/agents/${editingId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    else await api("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    closeSheet(); toast("تم حفظ الوكيل ✅"); loadAgents();
  } catch (e) { toast(errText(e), true); }
}
$("cta-create").onclick = () => { showView("agents"); openAgentModal(null); };

/* Quick customize */
$("btn-quick").onclick = async () => {
  const desc = $("quick-desc").value.trim();
  if (!desc) return toast("صِف الوكيل بجملة واحدة أولاً", true);
  const box = $("quick-result");
  box.classList.remove("hidden");
  box.innerHTML = '<div class="skel"></div>';
  try {
    const { draft } = await api("/api/agents/quick", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: desc }),
    });
    box.innerHTML = `<div class="card"><b>${draft.avatar} ${escapeHtml(draft.name)}</b>
      <p class="muted">${escapeHtml(draft.description)}</p>
      <p class="muted">النبرة: ${escapeHtml(draft.tone)}</p></div>
      <div class="row"><button class="btn primary" id="q-save" style="flex:1">💾 حفظ</button>
      <button class="btn" id="q-edit" style="flex:1">✏️ مراجعة</button></div>`;
    $("q-save").onclick = async () => {
      try {
        await api("/api/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
        box.classList.add("hidden"); $("quick-desc").value = "";
        toast("تم إنشاء الوكيل ✅"); loadAgents();
      } catch (e) { toast(errText(e), true); }
    };
    $("q-edit").onclick = () => { box.classList.add("hidden"); openAgentModal({ ...draft, tools: draft.tools }); };
  } catch (e) { box.innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`; }
};

/* ---------- Chat ---------- */
const SUGGESTIONS = ["اشرح لي ببساطة", "أعطني مثالاً عملياً", "لخّص النقاط المهمة", "ما الخطوة التالية؟"];
function renderSuggestions() {
  const box = $("chat-suggest");
  box.innerHTML = "";
  for (const s of SUGGESTIONS) {
    const b = document.createElement("button");
    b.className = "suggest-chip";
    b.textContent = s;
    b.onclick = () => { $("chat-text").value = s; autoGrow(); sendMessage(); };
    box.appendChild(b);
  }
}

function setChatAgent(id) {
  state.currentAgent = id;
  $("chat-agent").value = id;
  loadConversations();
}
$("chat-agent").onchange = (e) => setChatAgent(e.target.value);

async function loadConversations() {
  if (!state.currentAgent) return;
  try {
    const { conversations } = await api(`/api/conversations?agentId=${state.currentAgent}`);
    const sel = $("chat-conv");
    sel.innerHTML = conversations.map((c) =>
      `<option value="${c.id}">${escapeHtml(c.title)} (${c.count})</option>`).join("");
    state.currentConv = sel.value || null;
    await renderChatHistory();
  } catch (e) { toast(errText(e), true); }
}
$("chat-conv").onchange = async (e) => { state.currentConv = e.target.value; await renderChatHistory(); };

async function renderChatHistory() {
  const log = $("chat-log");
  log.innerHTML = "";
  if (!state.currentConv) { log.innerHTML = '<p class="muted" style="text-align:center;margin-top:40px">اختر وكيلاً وابدأ المحادثة 💬</p>'; return; }
  try {
    const res = await fetch(`/api/conversations/detail?id=${state.currentConv}`, { headers: headers() });
    if (!res.ok) throw new Error("network");
    const { conversation } = await res.json();
    for (const m of conversation.messages || []) addMsg(m.role, m.content, m.tools || [], m.images || [], true);
    log.scrollTop = log.scrollHeight;
  } catch { log.innerHTML = '<p class="muted" style="text-align:center">ابدأ الكتابة بالأسفل 💬</p>'; }
}

function addMsg(role, content, tools = [], images = [], instant = false) {
  const log = $("chat-log");
  const d = document.createElement("div");
  d.className = "msg " + (role === "user" ? "user" : "bot");
  d.innerHTML = (tools.length
    ? tools.map((t) => `<span class="toolbadge">🔧 ${escapeHtml(t)}</span>`).join("") + "<br>"
    : "") + escapeHtml(content);
  for (const id of images || []) {
    const img = document.createElement("img");
    img.className = "gen-img";
    img.src = "/api/images/" + id;
    img.loading = "lazy";
    img.alt = "صورة مولدة بالذكاء الاصطناعي";
    img.onclick = () => openViewer(img.src);
    d.appendChild(img);
  }
  log.appendChild(d);
  if (!instant) log.scrollTop = log.scrollHeight;
  return d;
}

/** Fullscreen image viewer */
function openViewer(src) {
  const v = document.createElement("div");
  v.className = "img-viewer";
  const safe = String(src).replace(/"/g, "");
  v.innerHTML = `<button class="close" aria-label="إغلاق">✕</button><img src="${safe}" alt="صورة">`;
  v.querySelector(".close").onclick = () => v.remove();
  v.addEventListener("click", (e) => { if (e.target === v) v.remove(); });
  document.body.appendChild(v);
}

function autoGrow() {
  const ta = $("chat-text");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
}
$("chat-text").addEventListener("input", autoGrow);
$("chat-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

async function newConversation() {
  if (!state.currentAgent) return toast("أنشئ وكيلاً أولاً", true);
  try {
    const { conversation } = await api("/api/conversations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: state.currentAgent }),
    });
    state.currentConv = conversation.id;
    await loadConversations();
    toast("محادثة جديدة ✅");
  } catch (e) { toast(errText(e), true); }
}
$("btn-new-conv").onclick = newConversation;

async function sendMessage() {
  const input = $("chat-text");
  const text = input.value.trim();
  if (!text || !state.currentAgent) return;
  if (!state.currentConv) await newConversation();
  input.value = ""; autoGrow();
  addMsg("user", text);
  renderSuggestions();
  const botEl = addMsg("bot", "");
  botEl.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  $("chat-tools").textContent = "";
  $("btn-send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST", headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({ agentId: state.currentAgent, conversationId: state.currentConv, message: text }),
    });
    if (res.status === 401) throw Object.assign(new Error("unauthorized"), { code: "unauthorized" });
    if (!res.ok || !res.body) throw new Error("network");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", full = "", first = true;
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
        if (obj.type === "token") {
          if (first) { botEl.textContent = ""; first = false; }
          full += obj.text; botEl.textContent = full;
          $("chat-log").scrollTop = $("chat-log").scrollHeight;
        }
        else if (obj.type === "tool") { $("chat-tools").textContent = `🔧 يستخدم: ${obj.icon} ${obj.label}…`; }
        else if (obj.type === "conversation") { state.currentConv = obj.id; }
        else if (obj.type === "done") {
          for (const id of obj.images || []) {
            const img = document.createElement("img");
            img.className = "gen-img";
            img.src = "/api/images/" + id;
            img.loading = "lazy";
            img.alt = "صورة مولدة بالذكاء الاصطناعي";
            img.onclick = () => openViewer(img.src);
            botEl.appendChild(img);
          }
          if (obj.images && obj.images.length) {
            $("chat-log").scrollTop = $("chat-log").scrollHeight;
            toast("🎨 تم توليد الصورة!");
          }
        }
        else if (obj.type === "error") throw Object.assign(new Error(obj.code || "upstream"), { code: obj.code, detail: obj.detail || "" });
      }
    }
    if (!full) botEl.innerHTML = '<span class="muted">رد فارغ — حاول مجدداً</span>';
    $("chat-tools").textContent = "";
    loadConversations();
  } catch (e) {
    botEl.innerHTML = `<span style="color:#a32c2c">${escapeHtml(errText(e))}</span>`;
  } finally {
    $("btn-send").disabled = false;
  }
}
$("btn-send").onclick = sendMessage;

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
    toast(n ? `تعلّم ${n} عناصر جديدة 🧠` : "لا جديد للحفظ");
  } catch (e) { st.textContent = "❌ " + errText(e); toast(errText(e), true); }
};

/* Training sheet */
$("btn-train-open").onclick = () => {
  openSheet(`
    <h2>📄 تدريب بملف واحد</h2>
    <p class="muted">ارفع ملفاً (TXT / MD / CSV / JSON / HTML — وPDF تجريبياً) وسيتعلم منه الوكيل تلقائياً.</p>
    <input type="file" id="train-file" accept=".txt,.md,.csv,.json,.html,.pdf">
    <div id="train-status" class="note hidden"></div>
    <button class="btn primary big" id="btn-train-start">🚀 ابدأ التدريب</button>`);
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
      toast("تم التدريب ✅");
    } catch (e) { st.textContent = "❌ " + errText(e); }
  };
};

/* ---------- Image studio ---------- */

const IMG_STYLES = [
  { label: "🌅 واقعي", suffix: ", photorealistic, ultra detailed, 8k, professional photography" },
  { label: "🎠 كرتوني", suffix: ", cartoon style, vibrant colors, clean bold lines" },
  { label: "⛩️ أنمي", suffix: ", anime style, detailed, beautiful lighting" },
  { label: "🖼️ زيتي", suffix: ", classical oil painting, rich textures, museum quality" },
  { label: "🌃 سايبربانك", suffix: ", cyberpunk, neon lights, futuristic, dramatic atmosphere" },
  { label: "🏔️ طبيعة", suffix: ", breathtaking landscape, golden hour, national geographic" },
];
let activeStyle = -1;

function renderImgStyles() {
  const box = $("img-styles");
  box.innerHTML = "";
  IMG_STYLES.forEach((s, i) => {
    const c = document.createElement("button");
    c.className = "chip" + (activeStyle === i ? " on" : "");
    c.textContent = s.label;
    c.onclick = () => { activeStyle = activeStyle === i ? -1 : i; renderImgStyles(); };
    box.appendChild(c);
  });
}

function fillImageModels() {
  const sel = $("img-model");
  sel.innerHTML = (state.config?.imageModels || [])
    .map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`).join("");
}

function recentImages() {
  try { return JSON.parse(localStorage.getItem("aas_imgs") || "[]"); } catch { return []; }
}
function saveRecentImage(id, prompt) {
  const list = [{ id, prompt, at: Date.now() }, ...recentImages()].slice(0, 24);
  try { localStorage.setItem("aas_imgs", JSON.stringify(list)); } catch { /* storage full */ }
}
function renderGallery() {
  const g = $("img-gallery");
  if (!g) return;
  const list = recentImages();
  g.innerHTML = list.length ? "" : '<p class="muted">لا صور بعد — ولّد أول صورة! ✨</p>';
  for (const it of list) {
    const img = document.createElement("img");
    img.src = "/api/images/" + it.id;
    img.loading = "lazy";
    img.alt = it.prompt || "صورة مولدة";
    img.title = it.prompt || "";
    img.onclick = () => openViewer(img.src);
    g.appendChild(img);
  }
}

function initImageStudio() {
  renderImgStyles();
  fillImageModels();
  renderGallery();
  $("btn-generate").onclick = async () => {
    const ta = $("img-prompt");
    let prompt = ta.value.trim();
    if (!prompt) return toast("اكتب وصف الصورة أولاً", true);
    if (activeStyle >= 0) prompt += IMG_STYLES[activeStyle].suffix;
    const st = $("img-status");
    const resBox = $("img-result");
    st.classList.remove("hidden");
    st.className = "note";
    st.textContent = "⏳ جارٍ الرسم… (قد يستغرق ١٠–٣٠ ثانية)";
    $("btn-generate").disabled = true;
    try {
      const r = await api("/api/generate-image", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, model: $("img-model").value }),
      });
      st.classList.add("hidden");
      saveRecentImage(r.id, prompt);
      resBox.classList.remove("hidden");
      resBox.innerHTML = `<div class="card img-result-card">
        <img class="gen-img" id="img-latest" src="${r.url}" alt="صورة مولدة">
        <div class="row" style="margin-top:10px">
          <button class="btn primary" id="img-dl" style="flex:1">⬇️ تحميل</button>
          <button class="btn" id="img-view" style="flex:1">🔍 عرض مكبّر</button>
        </div></div>`;
      $("img-view").onclick = () => openViewer(r.url);
      $("img-latest").onclick = () => openViewer(r.url);
      $("img-dl").onclick = async () => {
        try {
          const resp = await fetch(r.url);
          const blob = await resp.blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "ai-image-" + r.id.slice(0, 8) + ".png";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
          toast("تم تحميل الصورة ⬇️");
        } catch { window.open(r.url, "_blank"); }
      };
      renderGallery();
      toast("تم توليد الصورة! 🎨");
    } catch (e) {
      st.className = "note err";
      st.textContent = "❌ " + errText(e);
    } finally {
      $("btn-generate").disabled = false;
    }
  };
}

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  const cards = $("dash-cards");
  cards.innerHTML = '<div class="skel"></div><div class="skel"></div>';
  try {
    const s = await api("/api/dashboard/stats");
    document.querySelector(".quota-chip")?.remove();
    const chip = document.createElement("div");
    chip.className = "quota-chip";
    chip.textContent = `⚡ ${s.today.quotaLeft.toLocaleString("ar")} متبقٍ`;
    $("appbar-actions").appendChild(chip);
    cards.innerHTML = `
      <div class="card"><h3>🤖 الوكلاء</h3><b style="font-size:26px">${s.agents}</b></div>
      <div class="card"><h3>💬 رسائل اليوم</h3><b style="font-size:26px">${s.today.messages}</b></div>
      <div class="card"><h3>🎨 صور اليوم</h3><b style="font-size:26px">${s.today.images || 0}</b></div>
      <div class="card"><h3>🔧 الأدوات اليوم</h3><b style="font-size:26px">${s.today.toolCalls}</b></div>
      <div class="card"><h3>⚡ خلايا اليوم</h3><b style="font-size:26px">${s.today.neurons.toLocaleString("ar")}</b></div>`;
    drawChart(s.series);
  } catch (e) { cards.innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`; }
  loadLearnLog(); loadKnowledge(); loadTools(); loadReminders();
}

function drawChart(series) {
  const c = $("dash-chart");
  const dpr = window.devicePixelRatio || 1;
  const W = c.width = c.offsetWidth * dpr, H = c.height = 150 * dpr;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(1, ...series.map((s) => s.messages));
  const bw = W / series.length;
  series.forEach((s, i) => {
    const h = (s.messages / max) * (H - 50 * dpr);
    ctx.fillStyle = "#6c3df4";
    const x = i * bw + bw * 0.28, w = bw * 0.44, y = H - 30 * dpr - h;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, Math.max(h, 4), 6);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, Math.max(h, 4));
    }
    ctx.fillStyle = "#857e93";
    ctx.font = `${11 * dpr}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(s.day, i * bw + bw / 2, H - 10 * dpr);
  });
}

async function loadLearnLog() {
  const id = $("learn-agent").value || state.currentAgent;
  if (!id) return;
  try {
    const { events } = await api(`/api/learning-log/${id}`);
    const box = $("learn-log");
    box.innerHTML = events.length ? "" : '<p class="muted">لا أحداث بعد — تحدث مع الوكيل ثم اضغط "🧠 اجعله يتعلم".</p>';
    const names = { memory: "🧠 ذاكرة", lesson: "💡 درس", gap: "❓ فجوة", training: "📄 تدريب" };
    for (const e of events.slice(0, 40)) {
      const d = document.createElement("div");
      d.className = "tl-item";
      d.innerHTML = `<span class="ev-${e.event}"><b>${names[e.event] || e.event}</b></span>
        <div>${escapeHtml(e.detail)}</div><div class="at">${new Date(e.at).toLocaleString("ar")}</div>`;
      box.appendChild(d);
    }
  } catch (e) { toast(errText(e), true); }
}
$("learn-agent").onchange = loadLearnLog;

async function loadKnowledge() {
  const id = $("know-agent").value || state.currentAgent;
  if (!id) return;
  try {
    const { files } = await api(`/api/knowledge/${id}`);
    const box = $("know-list");
    box.innerHTML = files.length ? "" : '<p class="muted">لا ملفات تدريب بعد.</p>';
    for (const f of files) {
      const d = document.createElement("div");
      d.className = "card agent-row";
      d.innerHTML = `<div class="av">📄</div><div><div class="nm">${escapeHtml(f.filename)}</div>
        <div class="ds">${f.chunks} مقطعاً — ${new Date(f.uploadedAt).toLocaleDateString("ar")}</div></div>
        <div class="spacer"></div><button class="btn icon-btn" title="حذف">🗑️</button>`;
      d.querySelector("button").onclick = async () => {
        if (await confirmDialog("حذف الملف", "حذف الملف ومعرفته من الوكيل؟", "حذف")) {
          await api(`/api/knowledge/${id}/${f.id}`, { method: "DELETE" });
          toast("تم حذف الملف"); loadKnowledge();
        }
      };
      box.appendChild(d);
    }
  } catch (e) { toast(errText(e), true); }
}
$("know-agent").onchange = loadKnowledge;

async function loadTools() {
  try {
    const { builtin, custom } = await api("/api/tools");
    const box = $("tools-list");
    box.innerHTML = "";
    for (const t of builtin) {
      const d = document.createElement("div");
      d.className = "card agent-row";
      d.innerHTML = `<div class="av">${t.icon}</div><div><div class="nm">${escapeHtml(t.label)}</div>
        <div class="ds">${escapeHtml(t.description.slice(0, 90))}…</div></div>`;
      box.appendChild(d);
    }
    for (const t of custom) {
      const d = document.createElement("div");
      d.className = "card agent-row";
      d.innerHTML = `<div class="av">${t.icon}</div><div><div class="nm">${escapeHtml(t.name)}</div>
        <div class="ds" dir="ltr">${escapeHtml(t.baseUrl)}</div></div>
        <div class="spacer"></div><button class="btn icon-btn" title="حذف">🗑️</button>`;
      d.querySelector("button").onclick = async () => {
        if (await confirmDialog("حذف الأداة", `حذف "${t.name}"؟`, "حذف")) {
          await api(`/api/tools/${t.id}`, { method: "DELETE" });
          toast("تم حذف الأداة"); loadTools();
        }
      };
      box.appendChild(d);
    }
  } catch (e) { toast(errText(e), true); }
}

$("btn-custom-tool-open").onclick = () => {
  openSheet(`
    <h2>🧩 أداة مخصصة (API خارجي)</h2>
    <input id="ct-name" placeholder="اسم الأداة (مثال: مخزون متجري)">
    <input id="ct-base" placeholder="https://api.example.com" dir="ltr">
    <input id="ct-desc" placeholder="وصف قصير لاستخدامها">
    <button class="btn primary big" id="btn-add-tool">💾 حفظ الأداة</button>`);
  $("btn-add-tool").onclick = async () => {
    try {
      await api("/api/tools", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: $("ct-name").value, baseUrl: $("ct-base").value, description: $("ct-desc").value }),
      });
      closeSheet(); toast("تمت إضافة الأداة ✅"); loadTools();
    } catch (e) { toast(errText(e), true); }
  };
};

async function loadReminders() {
  const id = $("rem-agent").value || state.currentAgent;
  if (!id) return;
  try {
    const { reminders } = await api(`/api/reminders/${id}`);
    const box = $("rem-list");
    box.innerHTML = reminders.length ? "" : '<p class="muted">لا تذكيرات — اطلب من الوكيل: "ذكّرني بـ…"</p>';
    for (const r of reminders.slice(0, 20)) {
      const d = document.createElement("div");
      d.className = "card agent-row";
      d.innerHTML = `<div class="av">⏰</div><div><div class="nm">${escapeHtml(r.text)}</div>
        <div class="ds">${escapeHtml(r.when || "")} ${r.done ? "✅ تم" : ""}</div></div>
        ${r.done ? "" : '<div class="spacer"></div><button class="btn small">تم ✅</button>'}`;
      const b = d.querySelector("button");
      if (b) b.onclick = async () => {
        await api(`/api/reminders/${id}/${r.id}`, { method: "PATCH" });
        toast("تم ✅"); loadReminders();
      };
      box.appendChild(d);
    }
  } catch (e) { toast(errText(e), true); }
}
$("rem-agent").onchange = loadReminders;

/* ---------- Settings ---------- */
async function loadSettings() {
  const id = $("mem-agent").value || state.currentAgent;
  if (!id) return;
  try {
    const { memories } = await api(`/api/memories/${id}`);
    const box = $("mem-list");
    const keys = Object.keys(memories);
    box.innerHTML = keys.length ? "" : '<p class="muted">لا ذكريات محفوظة بعد — ستظهر هنا ما يتعلمه الوكيل عنك.</p>';
    for (const k of keys) {
      const d = document.createElement("div");
      d.className = "card agent-row";
      d.innerHTML = `<div><div class="nm">${escapeHtml(k)}</div><div class="ds">${escapeHtml(memories[k])}</div></div>
        <div class="spacer"></div><button class="btn icon-btn" title="حذف">🗑️</button>`;
      d.querySelector("button").onclick = async () => {
        await api(`/api/memories/${id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: k }) });
        toast("تم حذف الذكرى"); loadSettings();
      };
      box.appendChild(d);
    }
  } catch (e) { toast(errText(e), true); }
}
$("mem-agent").onchange = loadSettings;
$("btn-save-pw").onclick = () => {
  state.password = $("set-password").value;
  if (state.password) localStorage.setItem("aas_pw", state.password);
  else localStorage.removeItem("aas_pw");
  toast(state.password ? "حُفظت كلمة المرور على هذا الجهاز ✅" : "أُزيلت كلمة المرور");
};

/* ---------- Init ---------- */
(async function init() {
  renderSuggestions();
  try {
    state.config = await api("/api/config");
    initImageStudio();
    await loadAgents();
    if (!state.agents.length) {
      try {
        const { agent } = await api("/api/agents", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "مساعدي الذكي", avatar: "🤖", description: "وكيل تجريبي جاهز", tone: "ودود ومختصر" }),
        });
        await loadAgents();
        setChatAgent(agent.id);
        setTimeout(() => toast("تم إنشاء وكيل تجريبي — جرّب محادثته! 🤖"), 800);
      } catch { /* already have agents or failed silently */ }
    } else if (state.currentAgent) {
      setChatAgent(state.currentAgent);
    }
    showView("home");
  } catch (e) {
    document.querySelector("main").innerHTML =
      `<div class="note err">تعذّر الاتصال بالخادم: ${escapeHtml(errText(e))}<br><span class="muted">تأكد من إتمام النشر على Cloudflare.</span></div>`;
  }
})();
