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
  if (brainTimer) { clearInterval(brainTimer); brainTimer = null; }
  if (name === "brain") {
    ensureBrainCanvas();
    loadBrain();
    brainTimer = setInterval(() => { if (!document.hidden) loadBrain(true); }, 25000);
  }
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
  // Reconcile: if the current agent was deleted or never loaded, pick the first available
  if (!state.agents.some((a) => a.id === state.currentAgent)) {
    state.currentAgent = state.agents.length ? state.agents[0].id : null;
    const sel = $("chat-agent");
    if (sel) sel.value = state.currentAgent || "";
  }
}

function fillAgentSelects() {
  const opts = state.agents.map((a) => `<option value="${a.id}">${a.avatar} ${escapeHtml(a.name)}</option>`).join("");
  for (const id of ["chat-agent", "learn-agent", "know-agent", "rem-agent", "mem-agent", "brain-agent", "research-agent"]) {
    const el = $(id);
    if (el) {
      const cur = el.value;
      el.innerHTML = opts || '<option value="">— لا يوجد وكلاء —</option>';
      if (cur && state.agents.some((a) => a.id === cur)) el.value = cur;
    }
  }
  if (state.agents.length && !$("chat-agent").value) setChatAgent(state.agents[0].id);
}
$("brain-agent").addEventListener("change", () => loadBrain());
$("btn-brain-refresh").addEventListener("click", () => { toast("🔄 تحديث العقل…"); loadBrain(); });
$("autolearn-toggle").addEventListener("click", async (e) => {
  e.stopPropagation();
  const id = $("brain-agent").value;
  const agent = state.agents.find((a) => a.id === id);
  if (!agent) return toast("اختر وكيلاً أولاً", true);
  const v = !agent.autoLearn;
  try {
    await api(`/api/agents/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoLearn: v }),
    });
    agent.autoLearn = v;
    $("autolearn-toggle").classList.toggle("on", v);
    $("autolearn-toggle").setAttribute("aria-checked", String(v));
    toast(v
      ? "🧠 التعلّم الذاتي مفعّل — سيلاحظ أخطاءه ويتعلم بعد كل محادثة تلقائياً"
      : "تم إيقاف التعلّم الذاتي التلقائي");
  } catch (err) { toast(errText(err), true); }
});

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
    <h3>👤 ملف الشخصية</h3>
    <input id="am-expertise" placeholder="مجال الخبرة (مثال: تسويق رقمي، طبخ)" value="${escapeHtml(a?.expertise || "")}">
    <input id="am-style" placeholder="أسلوب الرد (مثال: مباشر، قصصي، أكاديمي)" value="${escapeHtml(a?.style || "")}">
    <input id="am-avoid" placeholder="مواضيع يتجنبها (مثال: سياسة، نصائح طبية)" value="${escapeHtml(a?.avoidTopics || "")}">
    <h3>🧰 الأدوات المفعّلة</h3>
    <div id="am-tools" class="chips"></div>
    <h3>🧩 المهارات المدمجة</h3>
    <div id="am-skills" class="chips"><span class="muted">جارٍ التحميل…</span></div>
    <p class="muted" style="font-size:13px;margin:0 0 6px">أضف مهارات جديدة من لوحة التحكم ← مكتبة المهارات</p>
    <label class="switch-row"><span>🧠 تعلّم ذاتي تلقائي <small class="muted">— بعد كل محادثة</small></span><button type="button" class="switch" id="am-autolearn" role="switch" aria-label="التعلم الذاتي"></button></label>
    <label class="switch-row"><span>🔬 تفكير عميق <small class="muted">— تحليل + نقد ذاتي (يستهلك خلايا أكثر)</small></span><button type="button" class="switch" id="am-deepthink" role="switch" aria-label="التفكير العميق"></button></label>
    <div id="am-effort-row" class="hidden" style="margin-bottom:10px">
      <label class="muted" style="font-size:13px">مستوى الجهد:</label>
      <select id="am-effort">
        <option value="fast">⚡ سريع — بدون تفكير مرئي</option>
        <option value="balanced">⚖️ متوازن — تفكير مختصر</option>
        <option value="deep">🔬 عميق — تفكير + نقد ذاتي</option>
      </select>
    </div>
    ${a ? '<button class="btn ghost big" id="am-history" style="margin-bottom:8px">🕘 سجل الإصدارات والتراجع</button>' : ""}
    <button class="btn primary big" id="am-save">💾 حفظ الوكيل</button>`);
  renderModalTools();
  modalSkillIds = [...(a?.skillIds || [])];
  modalAutoLearn = !!a?.autoLearn;
  renderSkillChips();
  const autoSw = $("am-autolearn");
  autoSw.classList.toggle("on", modalAutoLearn);
  autoSw.onclick = () => { modalAutoLearn = !modalAutoLearn; autoSw.classList.toggle("on", modalAutoLearn); };
  // Deep think
  modalDeepThink = !!a?.deepThink;
  modalEffort = a?.effort || "balanced";
  const dtSw = $("am-deepthink");
  const effRow = $("am-effort-row");
  const effSel = $("am-effort");
  dtSw.classList.toggle("on", modalDeepThink);
  effRow.classList.toggle("hidden", !modalDeepThink);
  effSel.value = modalEffort;
  dtSw.onclick = () => {
    modalDeepThink = !modalDeepThink;
    dtSw.classList.toggle("on", modalDeepThink);
    effRow.classList.toggle("hidden", !modalDeepThink);
  };
  effSel.onchange = () => { modalEffort = effSel.value; };
  const histBtn = $("am-history");
  if (histBtn) histBtn.onclick = () => openHistorySheet(editingId);
  $("am-save").onclick = saveAgentModal;
}
let modalSkillIds = [], modalAutoLearn = false, modalDeepThink = false, modalEffort = "balanced", skillsCache = null;
async function getSkillsCache() {
  if (!skillsCache) skillsCache = (await api("/api/skills")).skills;
  return skillsCache;
}
async function renderSkillChips() {
  const box = $("am-skills");
  if (!box) return;
  try {
    const skills = await getSkillsCache();
    box.innerHTML = "";
    if (!skills.length) box.innerHTML = '<span class="muted">لا مهارات بعد — أنشئ من لوحة التحكم</span>';
    for (const s of skills) {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "chip" + (modalSkillIds.includes(s.id) ? " on" : "");
      c.textContent = `${s.icon} ${s.name}`;
      c.onclick = () => {
        modalSkillIds = modalSkillIds.includes(s.id)
          ? modalSkillIds.filter((x) => x !== s.id)
          : [...modalSkillIds, s.id];
        renderSkillChips();
      };
      box.appendChild(c);
    }
  } catch { box.innerHTML = '<span class="muted">تعذّر تحميل المهارات</span>'; }
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
    tools: modalTools, skillIds: modalSkillIds, autoLearn: modalAutoLearn,
    deepThink: modalDeepThink, effort: modalEffort,
    expertise: $("am-expertise").value, style: $("am-style").value, avoidTopics: $("am-avoid").value,
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
  attachLinkPreviews(d, content);
  return d;
}

/* Link previews: fetch the page title for the first URL in a message */
const previewCache = new Map();
function attachLinkPreviews(el, text) {
  const m = String(text || "").match(/https?:\/\/[^\s<>"')\]]+/);
  if (!m) return;
  const url = m[0].replace(/[.,;:!?]+$/, "");
  const render = (title) => {
    if (!title || el.querySelector(".link-preview")) return;
    const a = document.createElement("a");
    a.className = "link-preview";
    a.href = url; a.target = "_blank"; a.rel = "noopener";
    const host = url.replace(/^https?:\/\//, "").split("/")[0];
    a.innerHTML = '<span class="lp-icon">🔗</span><span class="lp-text"><span class="lp-title"></span><span class="lp-url"></span></span>';
    a.querySelector(".lp-title").textContent = title;
    a.querySelector(".lp-url").textContent = host;
    el.appendChild(a);
  };
  if (previewCache.has(url)) { render(previewCache.get(url)); return; }
  api(`/api/preview?url=${encodeURIComponent(url)}`)
    .then((r) => {
      const t = (r && r.title) || "";
      previewCache.set(url, t);
      if (previewCache.size > 60) previewCache.delete(previewCache.keys().next().value);
      render(t);
    })
    .catch(() => { /* no preview */ });
}

/* Deep-thinking box: collapsible, survives the streamed answer */
function handleThinkingEvent(botEl, obj) {
  let box = botEl._thinkEl || null;
  if (obj.state === "start") {
    if (!box) {
      box = document.createElement("details");
      box.className = "thinking";
      box.open = true;
      box.innerHTML = '<summary>🧠 <span class="think-label">يفكر بعمق…</span></summary><div class="think-body"><span class="typing"><span></span><span></span><span></span></span></div>';
      botEl.prepend(box);
      botEl._thinkEl = box;
    } else {
      box.open = true;
    }
    const lbl = box.querySelector(".think-label");
    if (lbl) lbl.textContent = obj.effort === "deep" ? "يفكر بعمق — ثم يراجع نفسه…" : "يفكر بعمق…";
  } else if (obj.state === "critique") {
    const lbl = box && box.querySelector(".think-label");
    if (lbl) lbl.textContent = "🔬 يراجع إجابته ويحسّنها…";
  } else if (obj.state === "done") {
    if (box) {
      const lbl = box.querySelector(".think-label");
      if (lbl) lbl.textContent = "🧠 التفكير العميق";
      const body = box.querySelector(".think-body");
      if (body) body.textContent = obj.text || "";
      box.open = false;
    }
  } else if (obj.state === "error") {
    if (box) box.remove();
    botEl._thinkEl = null;
  }
  const log = $("chat-log");
  if (log) log.scrollTop = log.scrollHeight;
}

/* Agent version history */
async function openHistorySheet(agentId) {
  openSheet('<h2>🕘 سجل إصدارات الوكيل</h2><div id="hist-list"><div class="skel"></div><div class="skel"></div></div>');
  try {
    const { history } = await api(`/api/agents/${agentId}/history`);
    const box = $("hist-list");
    if (!history.length) {
      box.innerHTML = '<p class="muted">لا إصدارات محفوظة بعد — تُحفظ نسخة تلقائياً عند كل تعديل.</p>';
      return;
    }
    box.innerHTML = "";
    for (const h of history) {
      const row = document.createElement("div");
      row.className = "hist-row";
      const info = document.createElement("div");
      info.innerHTML = `<b></b><br><small class="muted"></small>`;
      info.querySelector("b").textContent = h.name || "نسخة";
      info.querySelector("small").textContent = new Date(h.at).toLocaleString("ar");
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = "↩️ استعادة";
      btn.onclick = async () => {
        if (await confirmDialog("استعادة هذه النسخة؟", "سيتم إرجاع إعدادات الوكيل إلى هذه النسخة.")) {
          try {
            await api(`/api/agents/${agentId}/rollback`, {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ index: h.index }),
            });
            toast("تمت الاستعادة ✅");
            closeSheet(); loadAgents();
          } catch (e) { toast(errText(e), true); }
        }
      };
      row.appendChild(info); row.appendChild(btn);
      box.appendChild(row);
    }
  } catch (e) {
    $("hist-list").innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`;
  }
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

/* Share current conversation as formatted text */
$("btn-share-conv").onclick = async () => {
  const id = state.currentConv;
  if (!id) return toast("لا توجد محادثة لمشاركتها", true);
  try {
    const { conversation } = await api(`/api/conversations/detail?id=${encodeURIComponent(id)}`);
    const agent = state.agents.find((a) => a.id === state.currentAgent);
    let txt = `💬 محادثة مع ${agent ? agent.avatar + " " + agent.name : "الوكيل"}\n========================\n\n`;
    for (const m of conversation.messages || []) {
      txt += (m.role === "user" ? "🧑 أنت:\n" : "🤖 الوكيل:\n") + m.content + "\n\n";
    }
    txt += "— عبر AI Agent Studio";
    if (navigator.share) {
      await navigator.share({ title: "محادثة", text: txt });
    } else {
      await navigator.clipboard.writeText(txt);
      toast("نُسخت المحادثة — الصقها أينما شئت 📋");
    }
  } catch (e) { toast(errText(e), true); }
};

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
          if (first) {
            first = false;
            // Clear the typing indicator but keep the thinking box and research map
            const th = botEl._thinkEl || null;
            const rm = botEl._researchEl || null;
            botEl.textContent = "";
            if (th) botEl.appendChild(th);
            if (rm) botEl.appendChild(rm);
            botEl._thinkEl = th;
            botEl._researchEl = rm;
            const s = document.createElement("span");
            botEl.appendChild(s);
            botEl._textEl = s;
          }
          full += obj.text;
          (botEl._textEl || botEl).textContent = full;
          $("chat-log").scrollTop = $("chat-log").scrollHeight;
        }
        else if (obj.type === "tool") { $("chat-tools").textContent = `🔧 يستخدم: ${obj.icon} ${obj.label}…`; }
        else if (obj.type === "thinking") { handleThinkingEvent(botEl, obj); }
        else if (obj.type === "research") { handleResearchEvent(botEl, obj); }
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
    if (!full && !botEl._thinkEl && !botEl._researchEl) botEl.innerHTML = '<span class="muted">رد فارغ — حاول مجدداً</span>';
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
/* Deep research: topic sheet */
$("btn-research-open").onclick = () => {
  const agent = state.agents.find((a) => a.id === state.currentAgent);
  if (!agent) {
    toast("أنشئ وكيلاً أولاً من تبويب الوكلاء 🤖", true);
    showView("agents");
    return;
  }
  openSheet(`
    <h2>🔬 بحث معمق</h2>
    <p class="muted">سيبحث الوكيل <b>${agent.avatar} ${escapeHtml(agent.name)}</b> في قاعدة معرفته أولاً،
    ثم في الويب إن لزم، ويلخّص ويحلّل — ويحفظ الدروس في عقله.</p>
    <input id="research-topic" placeholder="موضوع البحث… (مثال: أسعار الذهب اليوم)">
    <button class="btn primary big" id="btn-research-start">🔬 ابدأ البحث</button>`);
  const start = () => {
    const t = $("research-topic").value.trim();
    if (!t) return toast("اكتب موضوع البحث أولاً", true);
    closeSheet();
    $("chat-text").value = `ابحث بعمق عن: ${t}`;
    sendMessage();
  };
  $("btn-research-start").onclick = start;
  $("research-topic").onkeydown = (e) => { if (e.key === "Enter") start(); };
  setTimeout(() => $("research-topic").focus(), 300);
};

/* Deep research: live map card */
const RESEARCH_STAGES = {
  kb: { icon: "📚", label: "قاعدة المعرفة" },
  web: { icon: "🌐", label: "الويب" },
  analyze: { icon: "📊", label: "التلخيص والتحليل" },
  learn: { icon: "🧠", label: "التعلّم والحفظ" },
};

function researchMap(botEl) {
  let map = botEl._researchEl;
  if (!map) {
    map = document.createElement("div");
    map.className = "research-map";
    map.innerHTML = '<div class="rm-head">🔬 <span class="rm-query"></span></div><div class="rm-stages"></div>';
    map._rows = {};
    botEl.prepend(map);
    botEl._researchEl = map;
  }
  return map;
}

function researchRow(map, stage) {
  if (!map._rows[stage]) {
    const meta = RESEARCH_STAGES[stage] || { icon: "•", label: stage };
    const row = document.createElement("div");
    row.className = "rm-row";
    row.innerHTML = '<span class="rm-status">⏳</span><span class="rm-icon"></span><span class="rm-label"></span><span class="rm-detail"></span>';
    row.querySelector(".rm-icon").textContent = meta.icon;
    row.querySelector(".rm-label").textContent = meta.label;
    map.querySelector(".rm-stages").appendChild(row);
    map._rows[stage] = row;
  }
  return map._rows[stage];
}

function handleResearchEvent(botEl, obj) {
  const map = researchMap(botEl);
  const scroll = () => { const l = $("chat-log"); if (l) l.scrollTop = l.scrollHeight; };
  if (obj.stage === "start") {
    map.querySelector(".rm-query").textContent = `بحث معمق: ${obj.query || ""}`;
    scroll();
    return;
  }
  if (obj.stage === "fetch") {
    const row = researchRow(map, "web");
    row.querySelector(".rm-status").textContent = "⏳";
    row.querySelector(".rm-detail").textContent = `يقرأ: ${(obj.title || "").slice(0, 40)}…`;
    scroll();
    return;
  }
  if (obj.stage === "done") {
    map.classList.add("done");
    map.querySelector(".rm-head").insertAdjacentHTML("beforeend", ' <span class="rm-badge">✅ اكتمل</span>');
    scroll();
    return;
  }
  const row = researchRow(map, obj.stage);
  const st = row.querySelector(".rm-status");
  const dt = row.querySelector(".rm-detail");
  if (obj.state === "start") {
    st.textContent = "⏳";
    dt.textContent = "جارٍ…";
  } else if (obj.state === "done") {
    st.textContent = "✅";
    if (obj.stage === "kb") {
      const files = (obj.files || []).join("، ");
      dt.textContent = obj.hits ? `${obj.hits} نتائج${files ? ` — ${files}` : ""}` : "لا نتائج";
    } else if (obj.stage === "web") {
      const n = (obj.sources || []).length;
      dt.textContent = n ? `${n} مصادر` : "لا مصادر جديدة";
      if (n && !row.querySelector(".rm-chips")) {
        const chips = document.createElement("div");
        chips.className = "rm-chips";
        for (const s of obj.sources.slice(0, 4)) {
          const a = document.createElement("a");
          a.href = s.url; a.target = "_blank"; a.rel = "noopener";
          a.className = "rm-chip";
          a.textContent = `🔗 ${(s.title || s.url).slice(0, 32)}`;
          chips.appendChild(a);
        }
        row.appendChild(chips);
      }
    } else if (obj.stage === "learn") {
      dt.textContent = obj.lessons ? `حُفظت ${obj.lessons} دروس في العقل 🧠` : "اكتمل";
    } else {
      dt.textContent = "اكتمل";
    }
  } else if (obj.state === "skipped") {
    st.textContent = "⏭️";
    dt.textContent = "المعرفة الداخلية كافية";
  }
  scroll();
}
$("btn-train-open").onclick = () => {
  const agent = state.agents.find((a) => a.id === state.currentAgent);
  if (!agent) {
    toast("أنشئ وكيلاً أولاً من تبويب الوكلاء 🤖", true);
    showView("agents");
    return;
  }
  openSheet(`
    <h2>📄 تدريب بملف واحد</h2>
    <p class="muted">سيتدرب الوكيل: <b>${agent.avatar} ${escapeHtml(agent.name)}</b></p>
    <p class="muted">ارفع ملفاً (TXT / MD / CSV / JSON / HTML — وPDF تجريبياً) وسيتعلم منه الوكيل تلقائياً.</p>
    <input type="file" id="train-file" accept=".txt,.md,.csv,.json,.html,.pdf">
    <div id="train-status" class="note hidden"></div>
    <button class="btn primary big" id="btn-train-start">🚀 ابدأ التدريب</button>`);
  $("btn-train-start").onclick = async () => {
    const f = $("train-file").files[0];
    const st = $("train-status");
    st.classList.remove("hidden");
    if (!f) { st.textContent = "اختر ملفاً أولاً"; return; }
    const ag = state.agents.find((a) => a.id === state.currentAgent);
    if (!ag) { st.textContent = "الوكيل غير موجود — أعد اختيار الوكيل"; st.className = "note err"; return; }
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

/* ---------- Brain: live knowledge graph ---------- */

const KIND_COLORS = {
  agent: "#a78bfa", memory: "#8b5cf6", lesson: "#34d399", file: "#60a5fa",
  chunk: "#38bdf8", tool: "#fbbf24", skill: "#f472b6", event: "#f87171",
};
const KIND_AR = {
  agent: "الوكيل", memory: "ذاكرة دائمة", lesson: "درس مستخلص", file: "ملف تدريب",
  chunk: "مقطع معرفي", tool: "أداة", skill: "مهارة مدمجة", event: "حدث تعلّم",
};

const Brain = {
  nodes: [], edgeIdx: [],
  canvas: null, ctx: null, ready: false,
  scale: 1, ox: 0, oy: 0, cx: 0, cy: 0,
  running: false, still: 0,
  dragNode: null, pointers: new Map(),
  panStart: null, downAt: 0, downXY: null, movedFar: false,
  pinchD: 0,
  posMemory: new Map(),
  stars: [],
};
let brainTimer = null;

function ensureBrainCanvas() {
  if (Brain.ready) { brainResize(); return; }
  Brain.canvas = $("brain-canvas");
  Brain.ctx = Brain.canvas.getContext("2d");
  Brain.ready = true;
  // static starfield
  for (let i = 0; i < 90; i++) {
    Brain.stars.push({ x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + 0.3, a: Math.random() * 0.5 + 0.15 });
  }
  brainResize();
  window.addEventListener("resize", brainResize);

  const cv = Brain.canvas;
  cv.addEventListener("pointerdown", (e) => {
    cv.setPointerCapture(e.pointerId);
    Brain.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    Brain.downAt = Date.now();
    Brain.downXY = { x: e.clientX, y: e.clientY };
    Brain.movedFar = false;
    if (Brain.pointers.size === 1) {
      const n = brainHit(e.clientX, e.clientY);
      if (n) { Brain.dragNode = n; }
      else { Brain.panStart = { x: e.clientX - Brain.ox, y: e.clientY - Brain.oy }; }
    } else if (Brain.pointers.size === 2) {
      Brain.dragNode = null; Brain.panStart = null;
      const p = [...Brain.pointers.values()];
      Brain.pinchD = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    }
    wakeBrain();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!Brain.pointers.has(e.pointerId)) return;
    const prev = Brain.pointers.get(e.pointerId);
    Brain.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Brain.downXY && Math.hypot(e.clientX - Brain.downXY.x, e.clientY - Brain.downXY.y) > 8) Brain.movedFar = true;
    if (Brain.pointers.size === 2) {
      const p = [...Brain.pointers.values()];
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (Brain.pinchD > 0) {
        const mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
        brainZoomAt(mx, my, d / Brain.pinchD);
      }
      Brain.pinchD = d;
      return;
    }
    if (Brain.dragNode) {
      const w = brainToWorld(e.clientX, e.clientY);
      Brain.dragNode.x = w.x; Brain.dragNode.y = w.y;
      Brain.dragNode.vx = Brain.dragNode.vy = 0;
    } else if (Brain.panStart) {
      Brain.ox = e.clientX - Brain.panStart.x;
      Brain.oy = e.clientY - Brain.panStart.y;
    }
    wakeBrain();
  });
  const endPointer = (e) => {
    const wasTap = Brain.pointers.size === 1 && !Brain.movedFar && (Date.now() - Brain.downAt) < 500;
    const n = wasTap ? brainHit(e.clientX, e.clientY) : null;
    Brain.pointers.delete(e.pointerId);
    if (Brain.pointers.size < 2) Brain.pinchD = 0;
    if (Brain.pointers.size === 0) {
      if (Brain.dragNode) {
        Brain.posMemory.set(Brain.dragNode.id, { x: Brain.dragNode.x, y: Brain.dragNode.y });
        Brain.dragNode = null;
      }
      Brain.panStart = null;
      if (n) openNodeSheet(n);
    }
  };
  cv.addEventListener("pointerup", endPointer);
  cv.addEventListener("pointercancel", endPointer);
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    brainZoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 0.89);
    wakeBrain();
  }, { passive: false });
}

function brainResize() {
  if (!Brain.ready) return;
  const wrap = Brain.canvas.parentElement;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  Brain.canvas.width = w * dpr;
  Brain.canvas.height = h * dpr;
  Brain._dpr = dpr;
  Brain.cx = w / 2; Brain.cy = h / 2;
}

function brainToWorld(sx, sy) {
  const r = Brain.canvas.getBoundingClientRect();
  const x = sx - r.left, y = sy - r.top;
  return {
    x: (x - r.width / 2 - Brain.ox) / Brain.scale + Brain.cx,
    y: (y - r.height / 2 - Brain.oy) / Brain.scale + Brain.cy,
  };
}

function brainHit(cx, cy) {
  const w = brainToWorld(cx, cy);
  for (let i = Brain.nodes.length - 1; i >= 0; i--) {
    const n = Brain.nodes[i];
    if (Math.hypot(n.x - w.x, n.y - w.y) <= n.r + 10) return n;
  }
  return null;
}

function brainZoomAt(vx, vy, factor) {
  // vx, vy = viewport (client) coordinates
  const before = brainToWorld(vx, vy);
  Brain.scale = Math.min(3.2, Math.max(0.35, Brain.scale * factor));
  const r = Brain.canvas.getBoundingClientRect();
  const x = vx - r.left, y = vy - r.top;
  Brain.ox = x - r.width / 2 - (before.x - Brain.cx) * Brain.scale;
  Brain.oy = y - r.height / 2 - (before.y - Brain.cy) * Brain.scale;
}

function initBrainGraph(data) {
  for (const n of Brain.nodes) {
    if (Brain.posMemory.size > 600) Brain.posMemory.clear();
    Brain.posMemory.set(n.id, { x: n.x, y: n.y });
  }
  const w = Brain.canvas.clientWidth || 360, h = Brain.canvas.clientHeight || 480;
  Brain.cx = w / 2; Brain.cy = h / 2;
  const R = Math.min(w, h) * 0.36;
  Brain.nodes = data.nodes.map((n, i) => {
    const saved = Brain.posMemory.get(n.id);
    const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
    return {
      ...n,
      x: saved ? saved.x : Brain.cx + Math.cos(a) * R * (0.35 + Math.random() * 0.65),
      y: saved ? saved.y : Brain.cy + Math.sin(a) * R * (0.35 + Math.random() * 0.65),
      vx: 0, vy: 0,
      r: n.kind === "agent" ? 26 : n.kind === "file" ? 15 : n.kind === "chunk" ? 8 : 11,
    };
  });
  const idx = new Map(Brain.nodes.map((n, i) => [n.id, i]));
  Brain.edgeIdx = data.edges
    .map(([a, b]) => [idx.get(a), idx.get(b)])
    .filter(([a, b]) => a !== undefined && b !== undefined);
  Brain.still = 0;
  $("brain-empty").classList.toggle("hidden", data.nodes.length > 1);
  startBrainLoop();
}

function brainTick() {
  const nodes = Brain.nodes;
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 4) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d2 = 4; }
      const d = Math.sqrt(d2);
      const f = Math.min(11000 / d2, 60);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
  }
  for (const [ai, bi] of Brain.edgeIdx) {
    const a = nodes[ai], b = nodes[bi];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = ((d - 95) * 0.018);
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }
  for (const nd of nodes) {
    if (nd === Brain.dragNode) continue;
    nd.vx += (Brain.cx - nd.x) * 0.0035;
    nd.vy += (Brain.cy - nd.y) * 0.0035;
    nd.vx *= 0.86; nd.vy *= 0.86;
    nd.x += nd.vx; nd.y += nd.vy;
  }
}

function brainDraw(t) {
  const { ctx, canvas } = Brain;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const dpr = Brain._dpr || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const g = ctx.createRadialGradient(w / 2, h / 2, 30, w / 2, h / 2, Math.max(w, h) * 0.8);
  g.addColorStop(0, "#10163a");
  g.addColorStop(1, "#070a18");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  for (const s of Brain.stars) {
    ctx.globalAlpha = s.a;
    ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
  }
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(w / 2 + Brain.ox, h / 2 + Brain.oy);
  ctx.scale(Brain.scale, Brain.scale);
  ctx.translate(-Brain.cx, -Brain.cy);
  // edges
  ctx.lineWidth = 1 / Brain.scale;
  for (const [ai, bi] of Brain.edgeIdx) {
    const a = Brain.nodes[ai], b = Brain.nodes[bi];
    const col = KIND_COLORS[b.kind] || "#8892b8";
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.34;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // nodes
  const pulse = (Math.sin((t || 0) / 450) + 1) / 2;
  for (const nd of Brain.nodes) {
    const col = KIND_COLORS[nd.kind] || "#cbd5e1";
    ctx.shadowColor = col;
    ctx.shadowBlur = nd.kind === "agent" ? 26 + pulse * 14 : 12;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#0b0e1f";
    ctx.beginPath();
    ctx.arc(nd.x, nd.y, nd.r * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${Math.round(nd.r * 0.95)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(nd.icon, nd.x, nd.y + 1);
    if (Brain.scale > 0.5 || nd.kind === "agent") {
      ctx.font = `600 ${nd.kind === "agent" ? 15 : 11}px Tahoma, sans-serif`;
      ctx.fillStyle = "rgba(255,255,255,.92)";
      ctx.shadowColor = "rgba(0,0,0,.8)";
      ctx.shadowBlur = 4;
      ctx.fillText(nd.label, nd.x, nd.y + nd.r + 11);
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
}

function startBrainLoop() {
  if (Brain.running || !Brain.nodes.length) return;
  Brain.running = true;
  const step = (t) => {
    if (!Brain.running) return;
    brainTick();
    brainDraw(t || 0);
    let maxV = 0;
    for (const nd of Brain.nodes) maxV = Math.max(maxV, Math.abs(nd.vx) + Math.abs(nd.vy));
    if (maxV < 0.03 && !Brain.dragNode) {
      if (++Brain.still > 80) { Brain.running = false; return; }
    } else Brain.still = 0;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function wakeBrain() { Brain.still = 0; startBrainLoop(); }

function openNodeSheet(n) {
  openSheet(`
    <h2>${escapeHtml(n.icon)} ${escapeHtml(n.label)}</h2>
    <p><span class="bstat"><b>◉</b> ${KIND_AR[n.kind] || n.kind}</span></p>
    <p style="font-size:15px;line-height:1.9;white-space:pre-wrap">${escapeHtml(n.detail || "لا تفاصيل إضافية.")}</p>`);
}

async function loadBrain(soft = false) {
  const id = $("brain-agent") && $("brain-agent").value;
  if (!id) return;
  try {
    const data = await api(`/api/brain/${id}`);
    initBrainGraph(data);
    updateBrainStats(data);
    const agent = state.agents.find((a) => a.id === id);
    const sw = $("autolearn-toggle");
    sw.classList.toggle("on", !!agent?.autoLearn);
    sw.setAttribute("aria-checked", !!agent?.autoLearn);
  } catch (e) {
    if (!soft) toast(errText(e), true);
  }
}

function updateBrainStats(data) {
  const s = data.stats;
  const names = { memory: "🧠 ذاكرة", lesson: "💡 دروس", file: "📄 ملفات", tool: "🔧 أدوات", skill: "🧩 مهارات", event: "✨ أحداث" };
  let html = `<span class="bstat live"><span class="dot"></span>مباشر</span><span class="bstat"><b>${s.total}</b> عقدة</span>`;
  for (const [k, label] of Object.entries(names)) {
    if (s.counts[k]) html += `<span class="bstat"><b>${s.counts[k]}</b> ${label}</span>`;
  }
  if (s.lastEvent) {
    const d = new Date(s.lastEvent);
    html += `<span class="bstat">⏱️ آخر تعلّم: ${d.toLocaleDateString("ar")} ${d.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" })}</span>`;
  }
  $("brain-stats").innerHTML = html;
}

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

/* ---------- Skills library ---------- */

const SKILL_PRESETS = [
  { name: "خبير تسويق رقمي", icon: "📣", instructions: "أنت خبير تسويق رقمي محترف. عند أي سؤال تسويقي: ابدأ بفهم الجمهور المستهدف، اقترح 3 أفكار عملية قابلة للتنفيذ خلال أسبوع، اذكر مقياس نجاح واضحاً لكل فكرة، وتجنب النصائح العامة الفارغة." },
  { name: "مبرمج أول", icon: "💻", instructions: "أنت مبرمج أول خبير. اكتب كوداً نظيفاً يعمل من أول مرة، اشرح الفكرة باختصار قبل الكود، علّق على الأجزاء المعقدة فقط، واذكر الحالات الحدّية والأخطاء المحتملة وكيفية اختبارها." },
  { name: "كاتب محتوى عربي", icon: "✍️", instructions: "أنت كاتب محتوى عربي محترف. اكتب بلغة حية ومباشرة، ابدأ بخطاف قوي يجذب القارئ، استخدم فقرات قصيرة وعناوين فرعية، واختم بدعوة لاتخاذ إجراء. تجنب الحشو والكليشيهات والمقدمات الطويلة." },
  { name: "مترجم محترف", icon: "🌐", instructions: "أنت مترجم محترف. ترجم المعنى والروح لا الكلمات حرفياً، حافظ على نبرة النص الأصلي، وكيّف الأمثلة والتعابير الاصطلاحية لتناسب الثقافة العربية. عند الغموض اذكر البديلين باختصار." },
  { name: "محلل بيانات", icon: "📊", instructions: "أنت محلل بيانات. عند عرض أرقام: لخّص الاتجاه الرئيسي في سطر واحد أولاً، اذكر أهم 3 ملاحظات، اقترح قراراً عملياً واحداً مبنياً عليها، ونبّه لأي رقم يحتاج تحققاً قبل الاعتماد عليه." },
];

async function loadSkills() {
  const box = $("skills-list");
  box.innerHTML = '<div class="skel"></div>';
  try {
    const { skills } = await api("/api/skills");
    skillsCache = skills;
    box.innerHTML = skills.length ? "" : '<p class="muted">لا مهارات بعد — أنشئ واحدة أو أضف الجاهزة ✨</p>';
    for (const s of skills) {
      const d = document.createElement("div");
      d.className = "card agent-row";
      d.innerHTML = `<div class="av">${escapeHtml(s.icon)}</div>
        <div><div class="nm">${escapeHtml(s.name)}</div>
        <div class="ds">${escapeHtml((s.instructions || "").slice(0, 90))}…</div></div>
        <div class="spacer"></div>
        <button class="btn icon-btn" data-act="view" title="عرض">👁️</button>
        <button class="btn icon-btn" data-act="del" title="حذف">🗑️</button>`;
      const [viewB, delB] = d.querySelectorAll("button");
      viewB.onclick = () => openSheet(`
        <h2>${escapeHtml(s.icon)} ${escapeHtml(s.name)}</h2>
        <p style="font-size:15px;line-height:1.9;white-space:pre-wrap">${escapeHtml(s.instructions)}</p>`);
      delB.onclick = async () => {
        if (await confirmDialog("حذف المهارة", `حذف "${s.name}" نهائياً؟`, "حذف")) {
          try {
            await api(`/api/skills/${s.id}`, { method: "DELETE" });
            skillsCache = null;
            toast("تم حذف المهارة");
            loadSkills();
          } catch (e) { toast(errText(e), true); }
        }
      };
      box.appendChild(d);
    }
  } catch (e) { box.innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`; }
}

function initSkillsUI() {
  $("btn-skill-open").onclick = () => {
    openSheet(`
      <h2>🧩 مهارة جديدة</h2>
      <p class="muted">المهارة حزمة تعليمات تُدمج في عقل الوكيل عندما تفعّلها له.</p>
      <input id="sk-name" placeholder="اسم المهارة (مثال: خبير SEO)">
      <div class="row"><input id="sk-icon" placeholder="🧩" value="🧩" style="flex:0 0 80px;text-align:center;font-size:22px"></div>
      <textarea id="sk-ins" rows="5" placeholder="تعليمات المهارة — كيف يتصرف الوكيل عندما تُفعّل؟ اكتب بتفصيل عملي وواضح"></textarea>
      <button class="btn primary big" id="sk-save">💾 حفظ المهارة</button>`);
    $("sk-save").onclick = async () => {
      const name = $("sk-name").value.trim();
      const ins = $("sk-ins").value.trim();
      if (!name || !ins) return toast("الاسم والتعليمات مطلوبان", true);
      try {
        await api("/api/skills", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, icon: $("sk-icon").value.trim() || "🧩", instructions: ins }),
        });
        skillsCache = null;
        closeSheet();
        toast("تمت إضافة المهارة ✅");
        loadSkills();
      } catch (e) { toast(errText(e), true); }
    };
  };
  $("btn-skill-presets").onclick = async () => {
    const btn = $("btn-skill-presets");
    btn.disabled = true;
    try {
      for (const p of SKILL_PRESETS) {
        await api("/api/skills", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(p),
        });
      }
      skillsCache = null;
      toast(`تمت إضافة ${SKILL_PRESETS.length} مهارات جاهزة ✨`);
      loadSkills();
    } catch (e) { toast(errText(e), true); }
    btn.disabled = false;
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
    renderPerAgent(s.perAgent);
  } catch (e) { cards.innerHTML = `<div class="note err">${escapeHtml(errText(e))}</div>`; }
  loadLearnLog(); loadKnowledge(); loadTools(); loadReminders(); loadSkills();
  loadGaps(); initBackup(); loadResearchHistory();
}

function renderPerAgent(perAgent) {
  const box = $("dash-peragent");
  if (!box) return;
  const active = (perAgent || []).filter((r) => r.messages > 0);
  if (!active.length) {
    box.innerHTML = '<p class="muted">لا نشاط اليوم بعد — تحدث مع وكلائك وستظهر هنا.</p>';
    return;
  }
  box.innerHTML = "";
  for (const r of active.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "pa-row";
    row.innerHTML = `<span></span><b></b>`;
    row.children[0].innerHTML = `${escapeHtml(r.avatar)} ${escapeHtml(r.name)}${r.quality != null ? ` <small class="muted">⭐ ${r.quality}/5</small>` : ""}`;
    row.children[1].textContent = `${r.messages} رسالة`;
    box.appendChild(row);
  }
}

/* Research history */
async function loadResearchHistory() {
  const sel = $("research-agent");
  const id = (sel && sel.value) || state.currentAgent;
  if (!id) return;
  const box = $("research-list");
  try {
    const { research } = await api(`/api/research/${id}`);
    if (!research.length) {
      box.innerHTML = '<p class="muted">لا بحوث بعد — ابدأ واحداً من زر «🔬 بحث معمق» في المحادثة.</p>';
      return;
    }
    box.innerHTML = "";
    for (const r of research.slice(0, 10)) {
      const d = document.createElement("button");
      d.className = "rs-row";
      d.innerHTML = `<div class="rs-q"></div><small class="muted"></small>`;
      d.querySelector(".rs-q").textContent = `🔬 ${r.query}`;
      d.querySelector("small").textContent =
        `${new Date(r.at).toLocaleString("ar")} — 📚 ${r.kbHits} معرفة، 🌐 ${r.webSources} ويب، 🧠 ${r.lessons} دروس`;
      d.onclick = () => openSheet(`
        <h2>🔬 ${escapeHtml(r.query)}</h2>
        <p class="muted">${new Date(r.at).toLocaleString("ar")}</p>
        <p style="white-space:pre-wrap">${escapeHtml(r.summary || "")}</p>`);
      box.appendChild(d);
    }
  } catch { box.innerHTML = '<p class="muted">تعذّر التحميل</p>'; }
}

/* Smart training suggestions from knowledge gaps */
async function loadGaps() {
  const box = $("dash-gaps");
  if (!box) return;
  try {
    const { gaps } = await api("/api/gaps");
    if (!gaps.length) {
      box.innerHTML = '<p class="muted">لا فجوات مرصودة — الوكلاء يتعلمون تلقائياً من المحادثات.</p>';
      return;
    }
    box.innerHTML = "";
    for (const g of gaps.slice(0, 5)) {
      const row = document.createElement("div");
      row.className = "gap-row";
      const info = document.createElement("div");
      info.innerHTML = `<b></b><br><small class="muted"></small>`;
      info.querySelector("b").textContent = `${g.avatar || "🤖"} ${g.agentName}`;
      info.querySelector("small").textContent = g.detail;
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = "📄 درّبه";
      btn.onclick = () => {
        setChatAgent(g.agentId);
        showView("chat");
        setTimeout(() => $("btn-train-open").click(), 400);
      };
      row.appendChild(info); row.appendChild(btn);
      box.appendChild(row);
    }
  } catch { box.innerHTML = '<p class="muted">تعذّر التحميل</p>'; }
}

/* Full backup: download + restore */
function initBackup() {
  const dl = $("btn-backup-dl"), up = $("btn-backup-up"), fi = $("backup-file"), st = $("backup-status");
  if (!dl || dl.dataset.init) return;
  dl.dataset.init = "1";
  dl.onclick = async () => {
    try {
      const b = await api("/api/backup");
      const blob = new Blob([JSON.stringify(b)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ai-agent-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("تم تنزيل النسخة الاحتياطية 💾");
    } catch (e) { toast(errText(e), true); }
  };
  up.onclick = () => fi.click();
  fi.onchange = async () => {
    const f = fi.files[0];
    if (!f) return;
    st.classList.remove("hidden");
    st.textContent = "جارٍ الاستعادة…";
    try {
      const backup = JSON.parse(await f.text());
      const r = await api("/api/backup/import", {
        method: "POST", headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ backup }),
      });
      st.textContent = `تمت استعادة ${r.agents} وكيل ✅`;
      st.className = "note ok";
      loadAgents();
    } catch (e) {
      st.textContent = errText(e);
      st.className = "note err";
    }
    fi.value = "";
  };
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
    const names = { memory: "🧠 ذاكرة", lesson: "💡 درس", gap: "❓ فجوة", training: "📄 تدريب", quality: "⭐ جودة", research: "🔬 بحث" };
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
$("research-agent").onchange = loadResearchHistory;

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

/* Reminder notifications: poll due reminders while the app is open */
function initNotifications() {
  const btn = $("btn-notif");
  if (!btn || btn.dataset.init) return;
  btn.dataset.init = "1";
  const refreshLabel = () => {
    btn.textContent = ("Notification" in window && Notification.permission === "granted")
      ? "🔔 التنبيهات مفعّلة" : "🔔 تفعيل التنبيهات";
  };
  refreshLabel();
  btn.onclick = async () => {
    if (!("Notification" in window)) return toast("المتصفح لا يدعم التنبيهات", true);
    const p = await Notification.requestPermission();
    refreshLabel();
    toast(p === "granted" ? "تم تفعيل التنبيهات 🔔" : "لم تُمنح صلاحية التنبيهات", p !== "granted");
  };
  const check = async () => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      for (const a of state.agents.slice(0, 10)) {
        const { reminders } = await api(`/api/reminders/${a.id}`);
        const now = Date.now();
        for (const r of reminders || []) {
          if (r.done || !r.dueAt) continue;
          const t = new Date(r.dueAt).getTime();
          if (isNaN(t) || t > now) continue;
          const key = `aas_notified_${r.id}`;
          if (localStorage.getItem(key)) continue;
          localStorage.setItem(key, "1");
          new Notification("⏰ تذكير", { body: `${a.avatar} ${a.name}: ${r.text}`, tag: r.id });
        }
      }
    } catch { /* silent */ }
  };
  setInterval(check, 60000);
  setTimeout(check, 15000);
}

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
  initSkillsUI();
  // PWA: check for app updates and auto-apply them
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        reg.update().catch(() => {});
        setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      }
      let refreshing = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (refreshing) return;
        refreshing = true;
        toast("✨ وصل تحديث جديد — جارٍ تحميل آخر نسخة…");
        setTimeout(() => location.reload(), 1500);
      });
    } catch { /* ignore */ }
  }
  try {
    state.config = await api("/api/config");
    initImageStudio();
    initNotifications();
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
