// AI Agent Studio — Cloudflare Worker.
// Routes: /api/config, /api/agents*, /api/conversations*, /api/chat (SSE),
// /api/train, /api/knowledge*, /api/learn, /api/learning-log/*, /api/memories*,
// /api/tools*, /api/skills*, /api/brain/*, /api/reminders*, /api/dashboard/stats,
// /api/generate-image, /api/images/*.
// Static frontend served from ./public via the ASSETS binding.

import {
  CHAT_MODELS, CHAT_FALLBACK, DEFAULT_CHAT_MODEL, EMBEDDING_MODEL,
  FREE_NEURONS_PER_DAY, getChatModel, chatNeurons, embeddingNeurons,
  publicModels, IMAGE_MODELS, DEFAULT_IMAGE_MODEL, getImageModel,
  publicImageModels,
} from "./models.js";
import { chunkText, retrieve, relevantChunks, RELEVANCE_THRESHOLD } from "./rag.js";
import { BUILTIN_TOOLS, getBuiltinTool, builtinToolCards } from "./tools.js";
import { learnFromConversation, memoryValue } from "./learn.js";
import {
  newAgentId, defaultAgent, listAgents, getAgent, saveAgent,
  deleteAgent, quickCustomize, ensureOctopus, OCTOPUS_SYSTEM,
} from "./agents.js";

const textEncoder = new TextEncoder();

/* ---------------- helpers ---------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function kv(env) {
  const ns = env.STUDIO_KV;
  return {
    async get(k) {
      const v = await ns.get(k);
      return v ? JSON.parse(v) : null;
    },
    async set(k, v) {
      await ns.put(k, JSON.stringify(v));
    },
    async del(k) {
      await ns.delete(k);
    },
  };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

async function checkPassword(request, env) {
  const secret = env.APP_PASSWORD;
  if (!secret) return true;
  const given = request.headers.get("x-app-password") || "";
  return timingSafeEqual(textEncoder.encode(given), textEncoder.encode(secret));
}

function errDetail(err) {
  return String((err && (err.message || err.error)) || err || "unknown").slice(0, 300);
}

function isQuotaError(err) {
  const s = String((err && (err.message || err.error)) || err || "");
  return /quota|429|insufficient|exceeded|10,?000/i.test(s);
}

async function bumpStat(kvH, key, by = 1) {
  const day = new Date().toISOString().slice(0, 10);
  const k = `stats:${day}:${key}`;
  const v = (await kvH.get(k)) || 0;
  await kvH.set(k, v + by);
}

async function runChatLLM(env, modelId, messages, maxTokens, stream = false) {
  const ids = [modelId, ...CHAT_FALLBACK.filter((m) => m !== modelId)];
  let lastErr = null;
  for (const id of ids) {
    try {
      const r = await env.AI.run(id, { messages, max_tokens: maxTokens, stream });
      return { result: r, modelId: id };
    } catch (e) {
      if (isQuotaError(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("chat failed");
}

/* ---------------- config ---------------- */

async function handleConfig() {
  return json({
    models: publicModels(),
    defaultModel: DEFAULT_CHAT_MODEL,
    imageModels: publicImageModels(),
    defaultImageModel: DEFAULT_IMAGE_MODEL,
    freePerDay: FREE_NEURONS_PER_DAY,
    builtinTools: builtinToolCards(),
    app: "AI Agent Studio",
  });
}

/* ---------------- agents ---------------- */

async function handleAgents(req, kvH, url) {
  if (req.method === "GET") return json({ agents: await ensureOctopus(kvH) });
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const agent = defaultAgent({
      name: String(body.name || "وكيل جديد").slice(0, 60),
      avatar: String(body.avatar || "🤖").slice(0, 8),
      description: String(body.description || "").slice(0, 300),
      tone: String(body.tone || "ودود ومختصر").slice(0, 80),
      language: String(body.language || "العربية").slice(0, 20),
      model: String(body.model || DEFAULT_CHAT_MODEL),
      systemPrompt: String(body.systemPrompt || defaultAgent().systemPrompt).slice(0, 4000),
      tools: Array.isArray(body.tools) ? body.tools.filter((t) => getBuiltinTool(t)).slice(0, 8) : ["calculator", "datetime"],
      skillIds: Array.isArray(body.skillIds) ? body.skillIds.map(String).slice(0, 12) : [],
      autoLearn: !!body.autoLearn,
      autoResearch: !!body.autoResearch,
      researchTopics: Array.isArray(body.researchTopics)
        ? body.researchTopics.map((t) => String(t).slice(0, 200)).filter(Boolean).slice(0, 10)
        : [],
      deepThink: !!body.deepThink,
      effort: ["fast", "balanced", "deep"].includes(body.effort) ? body.effort : "balanced",
      expertise: String(body.expertise || "").slice(0, 1000),
      style: String(body.style || "").slice(0, 1000),
      avoidTopics: String(body.avoidTopics || "").slice(0, 1000),
      isOctopus: !!body.isOctopus,
    });
    await saveAgent(kvH, agent);
    await bumpStat(kvH, "agentsCreated");
    return json({ agent }, 201);
  }
  return json({ code: "method", message: "Method not allowed" }, 405);
}

async function handleAgentById(req, kvH, id) {
  const agent = await getAgent(kvH, id);
  if (!agent) return json({ code: "not-found", message: "الوكيل غير موجود" }, 404);
  if (req.method === "GET") return json({ agent });
  if (req.method === "PATCH") {
    const body = await req.json().catch(() => ({}));
    // Version history: snapshot the pre-change state (cap 20)
    try {
      const hist = (await kvH.get(`agenthist:${id}`)) || [];
      hist.unshift({ at: new Date().toISOString(), name: agent.name, snapshot: { ...agent } });
      await kvH.set(`agenthist:${id}`, hist.slice(0, 20));
    } catch { /* history must never break the update */ }
    for (const f of ["name", "avatar", "description", "tone", "language", "model", "systemPrompt"]) {
      if (typeof body[f] === "string") agent[f] = body[f].slice(0, 4000);
    }
    if (Array.isArray(body.tools)) {
      agent.tools = body.tools.filter((t) => getBuiltinTool(t)).slice(0, 8);
    }
    if (Array.isArray(body.skillIds)) {
      agent.skillIds = body.skillIds.map(String).slice(0, 12);
    }
    if (typeof body.autoLearn === "boolean") agent.autoLearn = body.autoLearn;
    if (typeof body.autoResearch === "boolean") agent.autoResearch = body.autoResearch;
    if (Array.isArray(body.researchTopics)) {
      agent.researchTopics = body.researchTopics.map((t) => String(t).slice(0, 200)).filter(Boolean).slice(0, 10);
    }
    if (typeof body.deepThink === "boolean") agent.deepThink = body.deepThink;
    if (["fast", "balanced", "deep"].includes(body.effort)) agent.effort = body.effort;
    for (const f of ["expertise", "style", "avoidTopics"]) {
      if (typeof body[f] === "string") agent[f] = body[f].slice(0, 1000);
    }
    if (typeof body.isActive === "boolean") agent.isActive = body.isActive;
    if (typeof body.isOctopus === "boolean") agent.isOctopus = body.isOctopus;
    await saveAgent(kvH, agent);
    return json({ agent });
  }
  if (req.method === "DELETE") {
    await deleteAgent(kvH, id);
    return json({ ok: true });
  }
  return json({ code: "method", message: "Method not allowed" }, 405);
}

/* ---------------- conversations ---------------- */

async function handleConversations(req, kvH, url) {
  const agentId = url.searchParams.get("agentId");
  if (req.method === "GET") {
    const ids = (await kvH.get(`convs:${agentId}`)) || [];
    const out = [];
    for (const id of ids.slice(0, 30)) {
      const c = await kvH.get(`conv:${id}`);
      if (c) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length });
    }
    return json({ conversations: out });
  }
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const agent = await getAgent(kvH, String(body.agentId || ""));
    if (!agent) return json({ code: "not-found", message: "الوكيل غير موجود" }, 404);
    const conv = {
      id: "cv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      agentId: agent.id,
      title: "محادثة جديدة",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await kvH.set(`conv:${conv.id}`, conv);
    const ids = (await kvH.get(`convs:${agent.id}`)) || [];
    ids.unshift(conv.id);
    await kvH.set(`convs:${agent.id}`, ids.slice(0, 50));
    return json({ conversation: conv }, 201);
  }
  return json({ code: "method", message: "Method not allowed" }, 405);
}

/* ---------------- image generation ---------------- */

/**
 * Generate an image with Workers AI, store the PNG bytes in KV,
 * return an unguessable URL. Images expire after 30 days.
 */
async function generateImage(env, prompt, modelId) {
  const model = getImageModel(modelId);
  const clean = String(prompt || "").trim().slice(0, 2000);
  if (!clean) throw new Error("الوصف فارغ");
  const out = await env.AI.run(model.id, { prompt: clean, steps: 4 });
  let bytes;
  if (model.returns === "base64") {
    const b64 = out?.image;
    if (typeof b64 !== "string" || !b64.length) throw new Error("no image in model response");
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new Uint8Array(await new Response(out).arrayBuffer());
  }
  if (!bytes.length) throw new Error("empty image");
  const id = crypto.randomUUID();
  await env.STUDIO_KV.put(`img:${id}`, bytes, {
    metadata: { prompt: clean.slice(0, 200), at: Date.now() },
    expirationTtl: 60 * 60 * 24 * 30,
  });
  return { id, url: `/api/images/${id}` };
}

async function handleGenerateImage(request, env, kvH) {
  const body = await request.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return json({ code: "bad", message: "الوصف (prompt) مطلوب" }, 400);
  try {
    const { id, url } = await generateImage(env, prompt, body.model);
    await bumpStat(kvH, "images");
    return json({ id, url, model: getImageModel(body.model).id }, 201);
  } catch (e) {
    if (isQuotaError(e)) return json({ code: "quota", message: "نفدت الحصة اليومية" }, 429);
    return json({ code: "upstream", message: "تعذّر توليد الصورة", detail: errDetail(e) }, 502);
  }
}

async function handleImage(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("not found", { status: 404 });
  const buf = await env.STUDIO_KV.get(`img:${id}`, "arrayBuffer");
  if (!buf) return new Response("not found", { status: 404 });
  return new Response(buf, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
      "content-length": String(buf.byteLength),
    },
  });
}

/* ---------------- chat (SSE) ---------------- */

const DECIDE_SYSTEM = `أنت مخطط أدوات لوكيل ذكاء اصطناعي. أمامك رسالة المستخدم وقائمة الأدوات المتاحة.
إن كانت الرسالة تحتاج أدوات فعلاً (حساب، وقت، عملات، بحث ويب، جلب رابط، تذكير، API خارجي، رسم/توليد صورة) أعد JSON فقط:
{"tool":"اسم_الأداة","args":{...}}
يمكنك طلب أداة واحدة في كل مرة — ستُسأل مجدداً إن كنت تحتاج أداة أخرى بعد رؤية النتيجة.
إن لم تعد تحتاج أي أداة أعد JSON فقط: {"answer":true}
لا تضف أي نص خارج JSON.`;

async function decideTool(env, agent, enabledTools, userText, priorResults = "") {
  if (!enabledTools.length) return null;
  const toolDesc = enabledTools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
  const raw = await runChatLLM(env, agent.model, [
    { role: "system", content: DECIDE_SYSTEM + "\n\nالأدوات:\n" + toolDesc },
    { role: "user", content: userText.slice(0, 1500) + (priorResults ? `\n\nنتائج الأدوات السابقة:\n${priorResults}` : "") },
  ], 300).then((r) => r.result?.response || "");
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    if (o.tool && enabledTools.some((t) => t.name === o.tool)) {
      return { name: o.tool, args: o.args && typeof o.args === "object" ? o.args : {} };
    }
  } catch { /* fall through */ }
  return null;
}

/* ---------------- deep thinking ---------------- */

const THINK_SYSTEM = `أنت المفكّر العميق لوكيل ذكاء اصطناعي. حلّل طلب المستخدم بعمق قبل أن يجيب الوكيل.
اكتب تحليلك بالعربية بهذا الهيكل المختصر:
1. فهم الطلب: ما الذي يريده المستخدم فعلاً (وليس حرفياً)؟
2. النقاط الأساسية: أهم 2-4 نقاط يجب تغطيتها في الإجابة.
3. الافتراضات: ما الذي تفترضه لعدم وضوحه؟ اذكرها صراحة.
4. خطة الإجابة: خطوات مرقمة إن كان الطلب معقداً، وإلا سطر واحد.
5. المخاطر: ما الذي قد يُساء فهمه في الإجابة؟
كن مركزاً وعملياً — لا حشو.`;

const CRITIQUE_SYSTEM = `أنت مراجع دقيق لوكيل ذكاء اصطناعي. أمامك سؤال المستخدم ومسودة إجابة الوكيل.
راجع المسودة: هل أجابت فعلاً عن السؤال؟ هل فيها أخطاء أو ثغرات أو حشو أو نبرة غير مناسبة؟
ثم أعد كتابة الإجابة النهائية محسّنة وكاملة. أعد الإجابة النهائية فقط — دون شرح مراجعتك.`;

async function runThinking(env, modelId, userText, toolResultText, effort) {
  const maxTokens = effort === "deep" ? 900 : 400;
  const { result } = await runChatLLM(env, modelId, [
    { role: "system", content: THINK_SYSTEM },
    { role: "user", content: `طلب المستخدم:\n${userText.slice(0, 2000)}${toolResultText ? `\n\nنتائج الأدوات:\n${toolResultText.slice(0, 1500)}` : ""}` },
  ], maxTokens);
  const text = typeof result?.response === "string" ? result.response.trim() : "";
  return { text, inChars: userText.length + toolResultText.length + 600, outChars: text.length };
}

async function runCritique(env, modelId, userText, draft) {
  const { result } = await runChatLLM(env, modelId, [
    { role: "system", content: CRITIQUE_SYSTEM },
    { role: "user", content: `سؤال المستخدم:\n${userText.slice(0, 1500)}\n\nمسودة الإجابة:\n${draft.slice(0, 4000)}` },
  ], 1500);
  const text = typeof result?.response === "string" ? result.response.trim() : "";
  return { text: text || draft, inChars: userText.length + draft.length + 400, outChars: text.length };
}

async function runQualityRating(env, modelId, userText, answer) {
  try {
    const { result } = await runChatLLM(env, modelId, [
      { role: "system", content: `قيّم جودة هذه الإجابة من 1 إلى 5 (5 = ممتازة) مع ملاحظة قصيرة جداً. أعد JSON فقط: {"score":4,"note":"..."}` },
      { role: "user", content: `السؤال: ${userText.slice(0, 800)}\n\nالإجابة: ${answer.slice(0, 2000)}` },
    ], 150);
    const m = String(result?.response || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    const score = Math.min(5, Math.max(1, Number(o.score) || 3));
    return { score, note: String(o.note || "").slice(0, 200) };
  } catch {
    return null;
  }
}

function buildSystemPrompt(agent, memories, learned, ragContext, skills) {
  const parts = [];
  // 🐙 Octopus operator persona always leads for the octopus agent
  if (agent.isOctopus) parts.push(OCTOPUS_SYSTEM);
  parts.push(agent.systemPrompt);
  const memEntries = Object.entries(memories || {});
  if (memEntries.length) {
    // Expert-level organization: group memories by category
    const groups = {};
    for (const [k, v] of memEntries) {
      const { value, category } = memoryValue(v);
      (groups[category] = groups[category] || []).push(`- ${k}: ${value}`);
    }
    const order = ["شخصي", "عمل", "تفضيلات", "مشاريع", "أخرى"];
    const blocks = order.filter((c) => groups[c]).map((c) => `[${c}]\n${groups[c].join("\n")}`);
    for (const c of Object.keys(groups)) if (!order.includes(c)) blocks.push(`[${c}]\n${groups[c].join("\n")}`);
    parts.push("ما تعرفه عن المستخدم (ذاكرة دائمة مصنّفة):\n" + blocks.join("\n"));
  }
  if (learned && learned.length) {
    parts.push("دروس تعلمتها بنفسك من محادثات سابقة (اتبعها):\n" +
      learned.slice(-8).map((l) => `- ${l.text}`).join("\n"));
  }
  if (ragContext) {
    parts.push("معلومات من ملفات التدريب الخاصة بك (اعتمد عليها وأشر للمصدر):\n" + ragContext);
  }
  if (skills && skills.length) {
    parts.push("مهارات مدمجة — طبّقها باحتراف كلما كان ذلك مفيداً:\n" +
      skills.map((s) => `### ${s.icon || "🧩"} ${s.name}\n${s.instructions}`).join("\n"));
  }
  const profile = [];
  if (agent.expertise) profile.push(`مجال الخبرة: ${agent.expertise}`);
  if (agent.style) profile.push(`أسلوب الرد: ${agent.style}`);
  if (agent.avoidTopics) profile.push(`تجنّب: ${agent.avoidTopics}`);
  if (profile.length) parts.push("ملف شخصية الوكيل:\n" + profile.map((p) => `- ${p}`).join("\n"));
  parts.push("لغة الرد: " + (agent.language || "العربية") + ". النبرة: " + (agent.tone || "ودود ومختصر") + ".");
  return parts.join("\n\n");
}

async function getRagHits(env, kvH, agent, userText, k = 5) {
  const files = (await kvH.get(`know:${agent.id}:files`)) || [];
  if (!files.length) return [];
  const emb = await env.AI.run(EMBEDDING_MODEL, { text: [userText.slice(0, 1000)] });
  const q = emb?.data?.[0];
  if (!q) return [];
  const allChunks = [];
  for (const f of files) {
    const rec = await kvH.get(`know:${agent.id}:${f.id}`);
    if (rec && Array.isArray(rec.chunks)) {
      for (const c of rec.chunks) allChunks.push({ ...c, file: f.filename });
    }
  }
  return relevantChunks(allChunks, q, k);
}

async function getRagContext(env, kvH, agent, userText) {
  const hits = await getRagHits(env, kvH, agent, userText, 5);
  if (!hits.length) return "";
  return hits.map((h, i) => `[${i + 1}] (من ${h.file || "ملف التدريب"}): ${h.text}`).join("\n");
}

/* ---------------- deep research ---------------- */

const RESEARCH_SYSTEM = `أنت باحث محلل محترف. أمامك موضوع بحث ومواد من مصادر متعددة.
اكتب تقريراً بحثياً كاملاً بالعربية بهذا الهيكل:
## ملخص تنفيذي
(3-5 أسطر: أهم ما يجب معرفته)
## النقاط الرئيسية
(5-8 نقاط مرقمة، كل نقطة جملة واحدة دقيقة)
## تحليل
(فقرتان: ماذا تعني هذه المعلومات؟ وما الثغرات أو الأسئلة المفتوحة؟)
## المصادر
(اذكر: قاعدة المعرفة الداخلية / الويب — بعناوينها)
كن دقيقاً وموضوعياً. إن تعارضت المصادر اذكر التعارض. لا تخترع معلومات.`;

async function runDeepResearch(env, kvH, agent, query, send, depth = "deep") {
  const startedAt = new Date().toISOString();
  const kbHits = [];
  const webSources = [];
  const seenUrls = new Set();
  let neurons = 0;
  const comprehensive = depth === "comprehensive";
  const maxSources = comprehensive ? 6 : 4;
  const fetchChars = comprehensive ? 4000 : 3000;

  send({ type: "research", stage: "start", query, depth });

  // Stage 1: internal knowledge base first
  send({ type: "research", stage: "kb", state: "start" });
  try {
    const hits = await getRagHits(env, kvH, agent, query, 6);
    for (const h of hits) kbHits.push({ file: h.file || "ملف التدريب", text: h.text });
    neurons += embeddingNeurons(query.length);
  } catch { /* no kb */ }
  send({
    type: "research", stage: "kb", state: "done", hits: kbHits.length,
    files: [...new Set(kbHits.map((h) => h.file))].slice(0, 5),
  });

  // Stage 2: web when the KB is not enough
  const needWeb = kbHits.length < 2;
  if (needWeb) {
    send({ type: "research", stage: "web", state: "start" });
    try {
      // Query fan-out: 3 search phrasings for broader coverage
      let queries = [query];
      try {
        const { result: qr } = await runChatLLM(env, agent.model, [
          { role: "system", content: `ولّد 3 صيغ بحث مختلفة لنفس الموضوع (عربية أولاً). أعد JSON فقط: {"queries":["...","...","..."]}` },
          { role: "user", content: `الموضوع: ${query}` },
        ], 200);
        const m = String(qr?.response || "").match(/\{[\s\S]*\}/);
        if (m) {
          const arr = JSON.parse(m[0]).queries || [];
          const qs = arr.map(String).map((s) => s.trim()).filter((s) => s.length > 2).slice(0, 3);
          if (qs.length) queries = [...new Set([query, ...qs])].slice(0, 3);
        }
        neurons += chatNeurons(agent.model, 100, 150);
      } catch { /* fan-out is best-effort */ }
      const wsTool = getBuiltinTool("web_search");
      const fetchTool = getBuiltinTool("url_fetch");
      for (const q of queries) {
        if (webSources.length >= maxSources) break;
        const out = await wsTool.run({ query: q }, { fetch, agent, env });
        for (const r of (out.results || [])) {
          if (webSources.length >= maxSources) break;
          const urlKey = String(r.url || "").split("?")[0].toLowerCase();
          if (!r.url || seenUrls.has(urlKey)) continue; // dedupe by URL
          seenUrls.add(urlKey);
          send({ type: "research", stage: "fetch", state: "progress", title: r.title });
          try {
            const page = await fetchTool.run({ url: r.url, maxChars: fetchChars }, { fetch, agent, env });
            const text = String(page.text || page.content || "").slice(0, fetchChars);
            if (text.length > 200) webSources.push({ title: r.title, url: r.url, text });
          } catch { /* skip failed source */ }
        }
      }
    } catch { /* web failed — continue with KB only */ }
    send({
      type: "research", stage: "web", state: "done",
      sources: webSources.map((s) => ({ title: s.title, url: s.url })),
    });
  } else {
    send({ type: "research", stage: "web", state: "skipped", reason: "kb-sufficient" });
  }

  // Stage 3: analyze & synthesize
  send({ type: "research", stage: "analyze", state: "start" });
  const kbText = kbHits.map((h, i) => `[معرفة ${i + 1} — ${h.file}]: ${h.text}`).join("\n");
  const webText = webSources.map((s, i) => `[مصدر ${i + 1} — ${s.title}]: ${s.text}`).join("\n");
  const material = `${kbText ? "من قاعدة المعرفة:\n" + kbText + "\n\n" : ""}${webText ? "من الويب:\n" + webText : ""}`;
  const { result } = await runChatLLM(env, agent.model, [
    { role: "system", content: RESEARCH_SYSTEM },
    { role: "user", content: `موضوع البحث: ${query}\n\n${material || "(لا مواد متاحة — اكتب من معرفتك العامة مع التنبيه لذلك)"}\n\nاكتب التقرير الكامل.` },
  ], 1500);
  const report = typeof result?.response === "string" ? result.response.trim() : "";
  neurons += chatNeurons(agent.model, material.length + 500, report.length);
  send({ type: "research", stage: "analyze", state: "done" });

  // Stage 4: learn — distill lessons into the agent's mind
  send({ type: "research", stage: "learn", state: "start" });
  const lessons = [];
  try {
    const { result: lr } = await runChatLLM(env, agent.model, [
      { role: "system", content: `استخرج أهم 3-5 حقائق أو دروس من هذا التقرير البحثي. أعد JSON فقط: {"lessons":["..."]}` },
      { role: "user", content: `الموضوع: ${query}\n\nالتقرير:\n${report.slice(0, 4000)}` },
    ], 500);
    const m = String(lr?.response || "").match(/\{[\s\S]*\}/);
    if (m) {
      const arr = JSON.parse(m[0]).lessons || [];
      const learned = (await kvH.get(`learned:${agent.id}`)) || [];
      for (const t of arr.slice(0, 5)) {
        const txt = String(t).slice(0, 300);
        if (txt.length > 10) {
          lessons.push(txt);
          learned.push({ text: txt, at: startedAt, source: "research" });
        }
      }
      await kvH.set(`learned:${agent.id}`, learned.slice(-50));
      const log = (await kvH.get(`learn:${agent.id}`)) || [];
      log.push({
        at: startedAt, event: "research",
        detail: `بحث معمق: "${query}" — ${webSources.length} مصادر ويب، ${kbHits.length} من المعرفة، ${lessons.length} دروس محفوظة.`,
      });
      await kvH.set(`learn:${agent.id}`, log.slice(-200));
    }
    neurons += chatNeurons(agent.model, 1500, 500);
  } catch { /* learning must never break research */ }
  send({ type: "research", stage: "learn", state: "done", lessons: lessons.length });

  // Save the research record
  const rec = {
    id: "rs_" + Date.now().toString(36), query, at: startedAt,
    kbHits: kbHits.length, webSources: webSources.length,
    lessons: lessons.length, summary: report.slice(0, 600),
  };
  const list = (await kvH.get(`research:${agent.id}`)) || [];
  list.unshift(rec);
  await kvH.set(`research:${agent.id}`, list.slice(0, 20));
  await bumpStat(kvH, "neurons", neurons);

  send({ type: "research", stage: "done", id: rec.id });
  return { report, rec };
}

/* ---------------- autonomous research (cron) ---------------- */

async function pickResearchTopic(kvH, agent) {
  // 1. Rotate through the user's topic list
  const topics = agent.researchTopics || [];
  if (topics.length) {
    const k = `research:${agent.id}:idx`;
    const idx = Number((await kvH.get(k)) || 0);
    await kvH.set(k, (idx + 1) % topics.length);
    return topics[idx % topics.length];
  }
  // 2. Fall back to the most recent knowledge gap
  const log = (await kvH.get(`learn:${agent.id}`)) || [];
  const gaps = log.filter((e) => e.event === "gap").slice(-5);
  if (gaps.length) {
    const t = String(gaps[gaps.length - 1].detail || "").replace(/^فجوة معرفية:\s*/, "").slice(0, 200);
    if (t.length > 3) return t;
  }
  return "";
}

async function autoResearchOne(env, kvH, agent) {
  const topic = await pickResearchTopic(kvH, agent);
  if (!topic) return { skipped: true };
  const at = new Date().toISOString();
  // Autonomous mode: search the web directly (the KB is covered in chat)
  const wsTool = getBuiltinTool("web_search");
  const out = await wsTool.run({ query: topic }, { fetch, agent, env });
  const results = (out.results || []).slice(0, 3);
  const fetchTool = getBuiltinTool("url_fetch");
  const sources = [];
  for (const r of results) {
    try {
      const page = await fetchTool.run({ url: r.url, maxChars: 2500 }, { fetch, agent, env });
      const text = String(page.text || "").slice(0, 2500);
      if (text.length > 200) sources.push({ title: r.title, text });
    } catch { /* skip failed source */ }
  }
  if (!sources.length) return { skipped: true };
  // Extract memorable facts
  const material = sources.map((s, i) => `[مصدر ${i + 1} — ${s.title}]: ${s.text}`).join("\n");
  const { result } = await runChatLLM(env, agent.model, [
    { role: "system", content: `أنت باحث مستقل. استخرج من هذه المصادر أهم 3-5 حقائق جديدة ومفيدة تستحق الحفظ في الذاكرة الدائمة لوكيل ذكاء اصطناعي. أعد JSON فقط: {"facts":["..."]}` },
    { role: "user", content: `الموضوع: ${topic}\n\n${material.slice(0, 6000)}` },
  ], 600);
  const facts = [];
  try {
    const m = String(result?.response || "").match(/\{[\s\S]*\}/);
    if (m) facts.push(...(JSON.parse(m[0]).facts || []));
  } catch { /* no facts */ }
  const learned = (await kvH.get(`learned:${agent.id}`)) || [];
  let added = 0;
  for (const f of facts.slice(0, 5)) {
    const txt = String(f).slice(0, 300);
    if (txt.length > 15 && !learned.some((l) => l.text === txt)) {
      learned.push({ text: txt, at, source: "auto-research" });
      added++;
    }
  }
  if (added) {
    await kvH.set(`learned:${agent.id}`, learned.slice(-60));
    const log = (await kvH.get(`learn:${agent.id}`)) || [];
    log.push({
      at, event: "auto-research",
      detail: `بحث تلقائي: "${topic}" — ${sources.length} مصادر، ${added} حقائق جديدة في الذاكرة.`,
    });
    await kvH.set(`learn:${agent.id}`, log.slice(-200));
    await bumpStat(kvH, "neurons", chatNeurons(agent.model, material.length, 600));
  }
  return { skipped: false, topic, sources: sources.length, added };
}

export async function autoResearchCycle(env) {
  const kvH = kv(env);
  const agents = await listAgents(kvH);
  const researchers = agents.filter((a) => a.autoResearch && a.isActive).slice(0, 3);
  const out = [];
  for (const agent of researchers) {
    try {
      out.push({ agent: agent.id, ...(await autoResearchOne(env, kvH, agent)) });
    } catch {
      out.push({ agent: agent.id, error: true });
    }
  }
  return out;
}

async function handleChat(req, env, kvH, waitCtx) {
  const body = await req.json().catch(() => ({}));
  const agent = await getAgent(kvH, String(body.agentId || ""));
  if (!agent || !agent.isActive) {
    return json({ code: "not-found", message: "الوكيل غير موجود أو معطّل" }, 404);
  }
  const userText = String(body.message || "").trim().slice(0, 4000);
  if (!userText) return json({ code: "bad", message: "الرسالة فارغة" }, 400);
  // Deep-research trigger: "ابحث بعمق عن ..." / "بحث معمق: ..." / "بحث شامل عن ..."
  let researchQuery = "";
  let researchDepth = "deep";
  const rm = userText.match(/^(ابحث بعمق عن|بحث معمق عن|بحث معمق:|بحث شامل عن|بحث شامل:|deep research:?|comprehensive research:?)\s*([\s\S]+)/i);
  if (rm && rm[2].trim()) {
    researchQuery = rm[2].trim().slice(0, 500);
    if (/شامل|comprehensive/i.test(rm[1])) researchDepth = "comprehensive";
  } else if (/ابحث بعمق/i.test(userText)) {
    const q = userText.replace(/ابحث بعمق( عن)?/gi, "").replace(/[:،,]/g, " ").trim();
    if (q.length > 2) researchQuery = q.slice(0, 500);
  }
  let conv = null;
  if (body.conversationId) conv = await kvH.get(`conv:${body.conversationId}`);
  if (!conv) {
    conv = {
      id: "cv_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      agentId: agent.id, title: userText.slice(0, 40) || "محادثة جديدة",
      messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const toolsUsed = [];
      try {
        send({ type: "conversation", id: conv.id, title: conv.title });

        const [memories, learned, skills] = await Promise.all([
          kvH.get(`mem:${agent.id}`),
          kvH.get(`learned:${agent.id}`),
          getSkillsForAgent(kvH, agent),
        ]);
        let ragContext = "";
        try {
          ragContext = await getRagContext(env, kvH, agent, userText);
        } catch (e) {
          ragContext = "";
        }

        // Shared answer state
        let full = "";
        let modelId = agent.model;
        let system = "";
        const imageIds = [];
        let skipFinalNeurons = false;

        if (researchQuery) {
          // Deep-research mode: KB -> web -> analyze -> learn, with live map
          const { report } = await runDeepResearch(env, kvH, agent, researchQuery, send, researchDepth);
          full = report;
          for (let i = 0; i < full.length; i += 48) {
            send({ type: "token", text: full.slice(i, i + 48) });
          }
          toolsUsed.push("🔬 بحث معمق");
          skipFinalNeurons = true; // already accounted inside runDeepResearch
        } else {

        // Phase 1: decide tools (chains: up to 3 rounds)
        const enabledTools = (agent.tools || []).map(getBuiltinTool).filter(Boolean);
        let toolResultText = "";
        const MAX_TOOL_ROUNDS = 3;
        try {
          const toolCtx = {
            fetch, agent, env,
            getCustomTool: async (id) => kvH.get(`tool:${id}`),
            generateImage: (prompt, model) => generateImage(env, prompt, model),
            addReminder: async (agentId, item) => {
              const k = `reminders:${agentId}`;
              const list = (await kvH.get(k)) || [];
              list.unshift(item);
              await kvH.set(k, list.slice(0, 100));
            },
          };
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            const decision = await decideTool(env, agent, enabledTools, userText, toolResultText);
            if (!decision) break;
            const tool = getBuiltinTool(decision.name);
            send({ type: "tool", icon: tool.icon, label: tool.label });
            toolsUsed.push(tool.label);
            const out = await tool.run(decision.args, toolCtx);
            if (decision.name === "image_generate" && out && out.id) imageIds.push(out.id);
            toolResultText += `\nنتيجة الأداة (${tool.label}): ${JSON.stringify(out).slice(0, 2000)}`;
            await bumpStat(kvH, "toolCalls");
            if (decision.name === "image_generate") await bumpStat(kvH, "images");
          }
          toolResultText = toolResultText.trim();
        } catch (e) {
          toolResultText = `تعذّر استخدام الأداة: ${errDetail(e)} — أجب بدونها.`;
        }

        // Phase 1.5: deep thinking (optional per agent)
        const deepOn = !!agent.deepThink && agent.effort !== "fast";
        const effort = agent.effort === "deep" ? "deep" : "balanced";
        let thinkingText = "";
        if (deepOn) {
          send({ type: "thinking", state: "start", effort });
          try {
            const th = await runThinking(env, agent.model, userText, toolResultText, effort);
            thinkingText = th.text;
            if (thinkingText) send({ type: "thinking", state: "done", text: thinkingText });
            await bumpStat(kvH, "neurons", chatNeurons(agent.model, th.inChars, th.outChars));
          } catch (e) {
            send({ type: "thinking", state: "error" });
          }
        }

        // Phase 2: build the final answer
        system = buildSystemPrompt(agent, memories, learned, ragContext, skills);
        const history = (conv.messages || []).slice(-30).map((m) => ({
          role: m.role === "user" ? "user" : "assistant", content: m.content,
        }));
        const finalMessages = [
          { role: "system", content: system },
          ...history,
          { role: "user", content: userText + (toolResultText ? `\n\n${toolResultText}` : "") + (thinkingText ? `\n\nتحليلك العميق (اعتمد عليه):\n${thinkingText}` : "") },
        ];
        full = "";
        modelId = agent.model;
        if (deepOn && effort === "deep") {
          // Deep mode: draft (non-stream) -> self-critique -> stream the refined answer
          send({ type: "thinking", state: "critique" });
          const draftRes = await runChatLLM(env, agent.model, finalMessages, 1500, false);
          modelId = draftRes.modelId || agent.model;
          const draft = typeof draftRes.result?.response === "string" ? draftRes.result.response : "";
          await bumpStat(kvH, "neurons", chatNeurons(modelId, JSON.stringify(finalMessages).length, draft.length));
          const crit = await runCritique(env, agent.model, userText, draft || "تعذّرت الصياغة.");
          full = crit.text;
          await bumpStat(kvH, "neurons", chatNeurons(modelId, crit.inChars, crit.outChars));
          // Stream the refined answer so the UX stays live
          for (let i = 0; i < full.length; i += 48) {
            send({ type: "token", text: full.slice(i, i + 48) });
          }
        } else {
          const r = await runChatLLM(env, agent.model, finalMessages, 1500, true);
          modelId = r.modelId || agent.model;
          const result = r.result;
          if (result && typeof result.getReader === "function") {
            const reader = result.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value, { stream: true });
              for (const line of text.split("\n")) {
                const t = line.trim();
                if (!t.startsWith("data:")) continue;
                const payload = t.slice(5).trim();
                if (payload === "[DONE]") continue;
                try {
                  const o = JSON.parse(payload);
                  const delta = o?.response || o?.choices?.[0]?.delta?.content || "";
                  if (delta) {
                    full += delta;
                    send({ type: "token", text: delta });
                  }
                } catch { /* keep-alive */ }
              }
            }
          } else if (typeof result?.response === "string") {
            full = result.response;
            send({ type: "token", text: full });
          }
        }

        } // end normal chat flow (non-research)

        // Persist
        conv.messages.push({ role: "user", content: userText });
        conv.messages.push({ role: "assistant", content: full, tools: toolsUsed, images: imageIds });
        conv.messages = conv.messages.slice(-60);
        conv.updatedAt = new Date().toISOString();
        if (conv.title === "محادثة جديدة") conv.title = userText.slice(0, 40);
        await kvH.set(`conv:${conv.id}`, conv);
        const ids = (await kvH.get(`convs:${agent.id}`)) || [];
        if (!ids.includes(conv.id)) {
          ids.unshift(conv.id);
          await kvH.set(`convs:${agent.id}`, ids.slice(0, 50));
        }
        await bumpStat(kvH, "messages", 2);
        await bumpStat(kvH, `agent:${agent.id}:messages`, 2);
        if (!skipFinalNeurons) {
          await bumpStat(kvH, "neurons", chatNeurons(modelId, system.length + userText.length, full.length));
        }

        send({ type: "done", tools: toolsUsed, images: imageIds });
        controller.close();

        // Background: self-learning autopilot + quality self-rating (never block the reply)
        if (waitCtx && typeof waitCtx.waitUntil === "function") {
          waitCtx.waitUntil((async () => {
            try {
              if (agent.autoLearn) {
                const r = await learnFromConversation(env, kvH, agent, conv.messages);
                if (!r.skipped) {
                  await bumpStat(kvH, "neurons", chatNeurons(agent.model, 4000, 1200));
                }
              }
              if (agent.deepThink && full.trim().length > 20) {
                const q = await runQualityRating(env, agent.model, userText, full);
                if (q) {
                  const log = (await kvH.get(`learn:${agent.id}`)) || [];
                  log.push({
                    at: new Date().toISOString(), event: "quality",
                    score: q.score,
                    detail: `تقييم ذاتي للجودة: ${q.score}/5 — ${q.note}`,
                  });
                  await kvH.set(`learn:${agent.id}`, log.slice(-200));
                  await bumpStat(kvH, "neurons", chatNeurons(agent.model, 1200, 150));
                }
              }
            } catch { /* silent: background work must never break chat */ }
          })());
        }
      } catch (e) {
        if (isQuotaError(e)) send({ type: "error", code: "quota" });
        else send({ type: "error", code: "upstream", detail: errDetail(e) });
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}

/* ---------------- training (one-file) ---------------- */

function extractText(filename, bytes) {
  const lower = filename.toLowerCase();
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  if (/\.(txt|md|markdown|csv|json|html?)$/.test(lower)) {
    let text = new TextDecoder().decode(buf);
    if (/\.html?$/.test(lower)) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    }
    return { text, note: "" };
  }
  if (/\.pdf$/.test(lower)) {
    // Best-effort: PDFs often store text in (parentheses) — very naive.
    const raw = new TextDecoder("latin1").decode(buf);
    const parts = [...raw.matchAll(/\((?:\\.|[^()\\])*\)/g)].map((m) =>
      m[0].slice(1, -1).replace(/\\([()\\])/g, "$1"));
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    return {
      text: text.slice(0, 200000),
      note: text.length > 200
        ? "استخراج تجريبي من PDF — للحصول على أفضل نتيجة ارفع نسخة TXT."
        : "تعذّر استخراج نص كافٍ من هذا الـ PDF — جرّب نسخة TXT.",
    };
  }
  return { text: "", note: "صيغة غير مدعومة — الصيغ المدعومة: TXT, MD, CSV, JSON, HTML (وPDF تجريبياً)." };
}

async function handleTrain(req, env, kvH) {
  const form = await req.formData().catch(() => null);
  if (!form) return json({ code: "bad", message: "لا يوجد ملف" }, 400);
  const agentId = String(form.get("agentId") || "");
  const file = form.get("file");
  const agent = await getAgent(kvH, agentId);
  if (!agent) return json({ code: "not-found", message: "الوكيل غير موجود" }, 404);
  if (!file || typeof file.arrayBuffer !== "function") {
    return json({ code: "bad", message: "ملف غير صالح" }, 400);
  }
  const filename = String(file.name || "file").slice(0, 120);
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > 25 * 1024 * 1024) {
    return json({ code: "bad", message: "الملف أكبر من 25MB" }, 400);
  }
  const { text, note } = extractText(filename, bytes);
  if (text.trim().length < 50) {
    return json({ code: "bad", message: note || "تعذّر استخراج نص من الملف" }, 400);
  }
  const chunks = chunkText(text).slice(0, 400);
  // Embed in batches of 10
  const embedded = [];
  for (let i = 0; i < chunks.length; i += 10) {
    const batch = chunks.slice(i, i + 10);
    const r = await env.AI.run(EMBEDDING_MODEL, { text: batch });
    const vecs = r?.data || [];
    batch.forEach((c, j) => {
      if (vecs[j]) embedded.push({ text: c, embedding: vecs[j] });
    });
  }
  const fileId = "kf_" + Date.now().toString(36);
  await kvH.set(`know:${agentId}:${fileId}`, { chunks: embedded });
  const files = (await kvH.get(`know:${agentId}:files`)) || [];
  files.unshift({
    id: fileId, filename, chunks: embedded.length,
    uploadedAt: new Date().toISOString(), note,
  });
  await kvH.set(`know:${agentId}:files`, files.slice(0, 20));
  await bumpStat(kvH, "neurons", embeddingNeurons(text.length));

  // Visible learning event: the agent trained itself from the file
  const log = (await kvH.get(`learn:${agentId}`)) || [];
  log.push({
    at: new Date().toISOString(), event: "training",
    detail: `تعلّم من الملف "${filename}" — ${embedded.length} مقطعاً معرفياً أُضيف لقاعدة المعرفة.`,
  });
  await kvH.set(`learn:${agentId}`, log.slice(-200));

  return json({
    ok: true, fileId, filename,
    chunks: embedded.length, note,
    message: `تعلّم الوكيل من الملف ✅ (${embedded.length} مقطعاً)`,
  });
}

async function handleKnowledge(req, kvH, agentId, fileId) {
  if (req.method === "GET") {
    const files = (await kvH.get(`know:${agentId}:files`)) || [];
    return json({ files });
  }
  if (req.method === "DELETE" && fileId) {
    await kvH.del(`know:${agentId}:${fileId}`);
    const files = ((await kvH.get(`know:${agentId}:files`)) || []).filter((f) => f.id !== fileId);
    await kvH.set(`know:${agentId}:files`, files);
    return json({ ok: true });
  }
  return json({ code: "method", message: "Method not allowed" }, 405);
}

/* ---------------- learning loop ---------------- */

async function handleLearn(req, env, kvH) {
  const body = await req.json().catch(() => ({}));
  const agent = await getAgent(kvH, String(body.agentId || ""));
  if (!agent) return json({ code: "not-found", message: "الوكيل غير موجود" }, 404);
  let messages = [];
  if (body.conversationId) {
    const conv = await kvH.get(`conv:${body.conversationId}`);
    messages = (conv && conv.agentId === agent.id ? conv.messages : []).filter((m) => m.role !== "system");
  } else {
    // Latest conversation
    const ids = (await kvH.get(`convs:${agent.id}`)) || [];
    if (ids.length) {
      const conv = await kvH.get(`conv:${ids[0]}`);
      messages = ((conv && conv.messages) || []).filter((m) => m.role !== "system");
    }
  }
  try {
    const result = await learnFromConversation(env, kvH, agent, messages);
    await bumpStat(kvH, "neurons", chatNeurons(agent.model, 4000, 1200));
    return json({ ok: true, ...result });
  } catch (e) {
    if (isQuotaError(e)) return json({ code: "quota", message: "نفدت الحصة اليومية" }, 429);
    return json({ code: "upstream", message: "تعذّر التعلم الذاتي", detail: errDetail(e) }, 502);
  }
}

/* ---------------- skills ---------------- */

async function listSkills(kvH) {
  const ids = (await kvH.get("skills:index")) || [];
  const out = [];
  for (const id of ids) {
    const s = await kvH.get(`skill:${id}`);
    if (s) out.push(s);
  }
  return out;
}

async function getSkillsForAgent(kvH, agent) {
  const ids = agent.skillIds || [];
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    const s = await kvH.get(`skill:${id}`);
    if (s) out.push(s);
  }
  return out;
}

async function handleSkills(req, kvH) {
  if (req.method === "GET") return json({ skills: await listSkills(kvH) });
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim().slice(0, 60);
    const instructions = String(body.instructions || "").trim().slice(0, 4000);
    if (!name || !instructions) {
      return json({ code: "bad", message: "الاسم والتعليمات مطلوبان" }, 400);
    }
    const skill = {
      id: "sk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name,
      icon: String(body.icon || "🧩").slice(0, 8),
      instructions,
      createdAt: new Date().toISOString(),
    };
    await kvH.set(`skill:${skill.id}`, skill);
    const ids = (await kvH.get("skills:index")) || [];
    ids.unshift(skill.id);
    await kvH.set("skills:index", ids.slice(0, 100));
    return json({ skill }, 201);
  }
  return json({ code: "method", message: "Method not allowed" }, 405);
}

/* ---------------- mind summary (expert organizer) ---------------- */

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * GET /api/mind/:agentId — "who am I according to what you know about me":
 * an auto-generated profile summary from categorized memories + lessons,
 * cached and regenerated only when the underlying data changes.
 */
async function handleMindSummary(env, kvH, agentId) {
  const agent = await getAgent(kvH, String(agentId || ""));
  if (!agent) return json({ code: "not-found", message: "الوكيل غير موجود" }, 404);
  const memories = (await kvH.get(`mem:${agent.id}`)) || {};
  const learned = (await kvH.get(`learned:${agent.id}`)) || [];
  const memLines = Object.entries(memories).map(([k, v]) => {
    const mv = memoryValue(v);
    return `${k} [${mv.category}]: ${mv.value}`;
  });
  const lessonLines = learned.slice(-15).map((l) => l.text);
  const fingerprint = `${memLines.length}:${learned.length}:${hashStr(memLines.join("|") + lessonLines.join("|"))}`;
  const cacheKey = `mindsum:${agent.id}`;
  const cached = await kvH.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) return json({ ...cached, cached: true });

  const counts = {};
  for (const [, v] of Object.entries(memories)) {
    const c = memoryValue(v).category;
    counts[c] = (counts[c] || 0) + 1;
  }

  let summary;
  if (!memLines.length && !lessonLines.length) {
    summary = "لا توجد ذكريات محفوظة بعد — تحدث معي وسأبني خريطة معرفية منظمة عنك: شخصي، عمل، تفضيلات، مشاريع.";
  } else {
    try {
      const { result } = await runChatLLM(env, agent.model, [
        {
          role: "system",
          content: "أنت خبير تنظيم معلومات. أمامك ذكريات مصنّفة ودروس مستخلصة عن مستخدم. اكتب ملخصاً شخصياً منظماً بعنوان «من أنت حسب ما أعرفه عنك»: فقرات قصيرة حسب الفئات (شخصي/عمل/تفضيلات/مشاريع) ثم سطر عن أسلوب التعلم المفضل. بالعربية، مباشر، بلا حشو.",
        },
        {
          role: "user",
          content: `الذكريات:\n${memLines.join("\n") || "(لا شيء)"}\n\nالدروس:\n${lessonLines.join("\n") || "(لا شيء)"}`,
        },
      ], 600);
      summary = String(result?.response || "").trim() || "تعذّر توليد الملخص.";
    } catch {
      summary = "تعذّر توليد الملخص حالياً — حاول لاحقاً.";
    }
  }
  const out = {
    summary,
    generatedAt: new Date().toISOString(),
    counts,
    memories: memLines.length,
    lessons: learned.length,
    fingerprint,
  };
  await kvH.set(cacheKey, out);
  return json({ ...out, cached: false });
}

/* ---------------- brain (live knowledge graph) ---------------- */

async function handleBrain(kvH, agentId) {
  const agent = await getAgent(kvH, String(agentId || ""));
  if (!agent) return json({ code: "not-found", message: "الوكيل غير موجود" }, 404);
  const nodes = [];
  const edges = [];
  const add = (id, label, kind, icon, detail, cat) => nodes.push({
    id, label: String(label || "").slice(0, 60), kind,
    icon: String(icon || "•").slice(0, 8), detail: String(detail || "").slice(0, 400),
    ...(cat ? { cat: String(cat).slice(0, 20) } : {}),
  });
  const link = (a, b) => edges.push([a, b]);
  const A = "agent";
  add(A, agent.name, "agent", agent.avatar || "🤖", agent.description || agent.tone || "");
  let i = 0;
  const memories = (await kvH.get(`mem:${agent.id}`)) || {};
  for (const [k, v] of Object.entries(memories).slice(0, 30)) {
    const id = `mem${i++}`;
    const mv = memoryValue(v);
    add(id, k, "memory", "🧠", `${k}: ${mv.value}`, mv.category);
    link(A, id);
  }
  const learned = (await kvH.get(`learned:${agent.id}`)) || [];
  for (const l of learned.slice(-20)) {
    const id = `les${i++}`;
    add(id, (l.text || "").slice(0, 42), "lesson", "💡", l.text);
    link(A, id);
  }
  const files = (await kvH.get(`know:${agent.id}:files`)) || [];
  for (const f of files.slice(0, 10)) {
    const fid = `file${i++}`;
    add(fid, f.filename, "file", "📄", `${f.chunks || 0} مقطعاً معرفياً`);
    link(A, fid);
    const rec = await kvH.get(`know:${agent.id}:${f.id}`);
    for (const c of ((rec && rec.chunks) || []).slice(0, 5)) {
      const cid = `chk${i++}`;
      add(cid, (c.text || "").slice(0, 38), "chunk", "📝", c.text);
      link(fid, cid);
    }
  }
  for (const tname of (agent.tools || [])) {
    const t = getBuiltinTool(tname);
    if (!t) continue;
    const id = `tool${i++}`;
    add(id, t.label, "tool", t.icon, t.description);
    link(A, id);
  }
  for (const s of await getSkillsForAgent(kvH, agent)) {
    const id = `sk${i++}`;
    add(id, s.name, "skill", s.icon, (s.instructions || "").slice(0, 200));
    link(A, id);
  }
  const log = (await kvH.get(`learn:${agent.id}`)) || [];
  const evIcon = { memory: "🧠", lesson: "💡", gap: "❓", training: "📄", quality: "⭐", research: "🔬", "auto-research": "🛰️" };
  for (const e of log.slice(-12)) {
    const id = `ev${i++}`;
    add(id, (e.detail || "").slice(0, 42), "event", evIcon[e.event] || "✨", e.detail);
    link(A, id);
  }
  const counts = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  return json({
    nodes, edges,
    stats: {
      total: nodes.length, edges: edges.length, counts,
      autoLearn: !!agent.autoLearn,
      lastEvent: log.length ? log[log.length - 1].at : null,
    },
  });
}

/* ---------------- tools ---------------- */

async function handleTools(req, kvH) {
  if (req.method === "GET") {
    const ids = (await kvH.get("tools:index")) || [];
    const custom = [];
    for (const id of ids) {
      const t = await kvH.get(`tool:${id}`);
      if (t) custom.push(t);
    }
    return json({ builtin: builtinToolCards(), custom });
  }
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const baseUrl = String(body.baseUrl || "").trim();
    if (!/^https?:\/\//i.test(baseUrl)) {
      return json({ code: "bad", message: "baseUrl يجب أن يبدأ بـ http" }, 400);
    }
    const tool = {
      id: "ct_" + Date.now().toString(36),
      name: String(body.name || "أداة مخصصة").slice(0, 60),
      description: String(body.description || "").slice(0, 300),
      icon: String(body.icon || "🧩").slice(0, 8),
      baseUrl: baseUrl.replace(/\/$/, ""),
      method: String(body.method || "GET").toUpperCase(),
      headers: body.headers && typeof body.headers === "object" ? body.headers : {},
      createdAt: new Date().toISOString(),
    };
    await kvH.set(`tool:${tool.id}`, tool);
    const ids = (await kvH.get("tools:index")) || [];
    ids.unshift(tool.id);
    await kvH.set("tools:index", ids);
    return json({ tool }, 201);
  }
  return json({ code: "method", message: "Method not allowed" }, 405);
}

/* ---------------- dashboard ---------------- */

async function handleDashboard(kvH) {
  const agents = await listAgents(kvH);
  const day = new Date().toISOString().slice(0, 10);
  const [messages, toolCalls, neurons, agentsCreated, images] = await Promise.all([
    kvH.get(`stats:${day}:messages`),
    kvH.get(`stats:${day}:toolCalls`),
    kvH.get(`stats:${day}:neurons`),
    kvH.get(`stats:${day}:agentsCreated`),
    kvH.get(`stats:${day}:images`),
  ]);
  // Per-agent activity today + quality averages
  const perAgent = [];
  for (const a of agents.slice(0, 20)) {
    const [am, log] = await Promise.all([
      kvH.get(`stats:${day}:agent:${a.id}:messages`),
      kvH.get(`learn:${a.id}`),
    ]);
    let qSum = 0, qN = 0;
    for (const e of (log || [])) {
      if (e.event === "quality" && typeof e.score === "number") { qSum += e.score; qN++; }
    }
    perAgent.push({
      id: a.id, name: a.name, avatar: a.avatar,
      messages: am || 0,
      quality: qN ? Math.round((qSum / qN) * 10) / 10 : null,
    });
  }
  perAgent.sort((x, y) => y.messages - x.messages);
  // Last 7 days activity
  const series = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const m = (await kvH.get(`stats:${d}:messages`)) || 0;
    series.push({ day: d.slice(5), messages: m });
  }
  return json({
    agents: agents.length,
    activeAgents: agents.filter((a) => a.isActive).length,
    today: {
      messages: messages || 0, toolCalls: toolCalls || 0,
      neurons: neurons || 0, agentsCreated: agentsCreated || 0,
      images: images || 0,
      quotaLeft: Math.max(0, FREE_NEURONS_PER_DAY - (neurons || 0)),
    },
    perAgent,
    series,
  });
}

/* ---------------- backup / export / import ---------------- */

async function exportAgent(kvH, agentId) {
  const agent = await getAgent(kvH, String(agentId || ""));
  if (!agent) return null;
  const [memories, learned, files, log, reminders] = await Promise.all([
    kvH.get(`mem:${agent.id}`),
    kvH.get(`learned:${agent.id}`),
    kvH.get(`know:${agent.id}:files`),
    kvH.get(`learn:${agent.id}`),
    kvH.get(`reminders:${agent.id}`),
  ]);
  // Knowledge as plain texts (re-embedded on import)
  const knowTexts = [];
  for (const f of (files || [])) {
    const rec = await kvH.get(`know:${agent.id}:${f.id}`);
    if (rec && Array.isArray(rec.chunks)) {
      knowTexts.push({ filename: f.filename, texts: rec.chunks.map((c) => c.text).filter(Boolean) });
    }
  }
  const skillObjs = await getSkillsForAgent(kvH, agent);
  return {
    app: "ai-agent-studio-agent",
    version: 1,
    at: new Date().toISOString(),
    agent, memories: memories || {}, learned: learned || [],
    knowTexts, log: (log || []).slice(-100), reminders: reminders || [],
    skills: skillObjs,
  };
}

async function reembedTexts(env, texts) {
  const embedded = [];
  for (let i = 0; i < texts.length; i += 10) {
    const batch = texts.slice(i, i + 10);
    const r = await env.AI.run(EMBEDDING_MODEL, { text: batch });
    const vecs = r?.data || [];
    batch.forEach((t, j) => { if (vecs[j]) embedded.push({ text: t, embedding: vecs[j] }); });
  }
  return embedded;
}

async function importAgent(env, kvH, bundle) {
  if (!bundle || bundle.app !== "ai-agent-studio-agent" || !bundle.agent) {
    throw new Error("not an agent bundle");
  }
  const src = bundle.agent;
  const agent = defaultAgent({
    name: String(src.name || "وكيل مستورد").slice(0, 60) + " (مستورد)",
    avatar: src.avatar || "🤖",
    description: src.description || "",
    tone: src.tone || "ودود ومختصر",
    language: src.language || "العربية",
    model: src.model || DEFAULT_CHAT_MODEL,
    systemPrompt: src.systemPrompt || "",
    tools: Array.isArray(src.tools) ? src.tools.filter((t) => getBuiltinTool(t)) : ["calculator", "datetime"],
    deepThink: !!src.deepThink,
    effort: ["fast", "balanced", "deep"].includes(src.effort) ? src.effort : "balanced",
    expertise: src.expertise || "", style: src.style || "", avoidTopics: src.avoidTopics || "",
    autoLearn: !!src.autoLearn,
  });
  await saveAgent(kvH, agent);
  if (bundle.memories) await kvH.set(`mem:${agent.id}`, bundle.memories);
  if (Array.isArray(bundle.learned)) await kvH.set(`learned:${agent.id}`, bundle.learned.slice(-50));
  if (Array.isArray(bundle.log)) await kvH.set(`learn:${agent.id}`, bundle.log.slice(-200));
  if (Array.isArray(bundle.reminders)) await kvH.set(`reminders:${agent.id}`, bundle.reminders.slice(0, 100));
  // Restore skills into the library and enable them
  if (Array.isArray(bundle.skills)) {
    for (const s of bundle.skills) {
      const skill = {
        id: "sk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: String(s.name || "مهارة").slice(0, 60),
        icon: s.icon || "🧩",
        instructions: String(s.instructions || "").slice(0, 4000),
        createdAt: new Date().toISOString(),
      };
      await kvH.set(`skill:${skill.id}`, skill);
      const ids = (await kvH.get("skills:index")) || [];
      ids.unshift(skill.id);
      await kvH.set("skills:index", ids.slice(0, 100));
      agent.skillIds.push(skill.id);
    }
    await saveAgent(kvH, agent);
  }
  // Re-embed knowledge texts
  if (Array.isArray(bundle.knowTexts)) {
    const files = [];
    for (const kf of bundle.knowTexts.slice(0, 20)) {
      const texts = (kf.texts || []).slice(0, 400);
      if (!texts.length) continue;
      const embedded = await reembedTexts(env, texts);
      const fileId = "kf_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      await kvH.set(`know:${agent.id}:${fileId}`, { chunks: embedded });
      files.push({
        id: fileId, filename: String(kf.filename || "مستورد").slice(0, 120),
        chunks: embedded.length, uploadedAt: new Date().toISOString(),
        note: "مستورد من نسخة احتياطية (أُعيد تضمينه)",
      });
    }
    if (files.length) await kvH.set(`know:${agent.id}:files`, files);
  }
  return agent;
}

async function handleBackup(kvH) {
  const agents = await listAgents(kvH);
  const out = {
    app: "ai-agent-studio-backup", version: 1,
    at: new Date().toISOString(), agents: [],
  };
  for (const a of agents) {
    out.agents.push(await exportAgent(kvH, a.id));
  }
  out.skills = await listSkills(kvH);
  const ids = (await kvH.get("tools:index")) || [];
  out.customTools = [];
  for (const id of ids) {
    const t = await kvH.get(`tool:${id}`);
    if (t) out.customTools.push(t);
  }
  return json(out);
}

async function importBackup(env, kvH, backup) {
  if (!backup || backup.app !== "ai-agent-studio-backup" || !Array.isArray(backup.agents)) {
    throw new Error("not a backup file");
  }
  let count = 0;
  for (const bundle of backup.agents.slice(0, 50)) {
    await importAgent(env, kvH, bundle);
    count++;
  }
  return count;
}

/* ---------------- router ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Static frontend
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // Password gate (optional).
    // /api/images/* uses unguessable UUID URLs and must load inside <img>
    // tags (which can't send the x-app-password header), so it is exempt.
    const isPublicImage = path.startsWith("/api/images/");
    if (path !== "/api/config" && !isPublicImage && !(await checkPassword(request, env))) {
      return json({ code: "unauthorized", message: "كلمة المرور غير صحيحة" }, 401);
    }

    const kvH = kv(env);
    try {
      if (path === "/api/config" && request.method === "GET") return handleConfig();

      let mImg = path.match(/^\/api\/images\/([A-Za-z0-9-]+)$/);
      if (mImg && request.method === "GET") return handleImage(env, mImg[1]);

      if (path === "/api/generate-image" && request.method === "POST") {
        return handleGenerateImage(request, env, kvH);
      }

      if (path === "/api/agents") return handleAgents(request, kvH, url);
      if (path === "/api/agents/quick" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        try {
          const draft = await quickCustomize(env, body.description);
          return json({ draft });
        } catch (e) {
          if (isQuotaError(e)) return json({ code: "quota", message: "نفدت الحصة اليومية" }, 429);
          return json({ code: "upstream", message: "تعذّر التخصيص السريع", detail: errDetail(e) }, 502);
        }
      }
      let m = path.match(/^\/api\/agents\/([^/]+)$/);
      if (m && m[1] !== "import") return handleAgentById(request, kvH, m[1]);

      if (path === "/api/conversations") return handleConversations(request, kvH, url);
      if (path === "/api/conversations/detail" && request.method === "GET") {
        const conv = await kvH.get(`conv:${url.searchParams.get("id")}`);
        if (!conv) return json({ code: "not-found", message: "المحادثة غير موجودة" }, 404);
        return json({ conversation: conv });
      }
      m = path.match(/^\/api\/conversations\/([^/]+)$/);
      if (m && request.method === "DELETE") {
        const conv = await kvH.get(`conv:${m[1]}`);
        if (conv) {
          await kvH.del(`conv:${m[1]}`);
          const ids = ((await kvH.get(`convs:${conv.agentId}`)) || []).filter((x) => x !== m[1]);
          await kvH.set(`convs:${conv.agentId}`, ids);
        }
        return json({ ok: true });
      }

      // Agent version history + rollback
      m = path.match(/^\/api\/agents\/([^/]+)\/history$/);
      if (m && request.method === "GET") {
        const hist = (await kvH.get(`agenthist:${m[1]}`)) || [];
        return json({ history: hist.map((h, i) => ({ index: i, at: h.at, name: h.name })) });
      }
      m = path.match(/^\/api\/agents\/([^/]+)\/rollback$/);
      if (m && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const hist = (await kvH.get(`agenthist:${m[1]}`)) || [];
        const entry = hist[Number(body.index)];
        if (!entry || !entry.snapshot) {
          return json({ code: "bad", message: "نسخة غير موجودة" }, 400);
        }
        const restored = { ...entry.snapshot, id: m[1], updatedAt: new Date().toISOString() };
        await saveAgent(kvH, restored);
        return json({ agent: restored });
      }

      // Per-agent export / import (brain package)
      m = path.match(/^\/api\/agents\/([^/]+)\/export$/);
      if (m && request.method === "GET") {
        const bundle = await exportAgent(kvH, m[1]);
        if (!bundle) return json({ code: "not-found", message: "الوكيل غير موجود" }, 404);
        return json(bundle);
      }
      if (path === "/api/agents/import" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        try {
          const agent = await importAgent(env, kvH, body.bundle);
          return json({ agent }, 201);
        } catch (e) {
          return json({ code: "bad", message: "ملف غير صالح", detail: errDetail(e) }, 400);
        }
      }

      // Full backup: everything
      if (path === "/api/backup" && request.method === "GET") return handleBackup(kvH);
      if (path === "/api/backup/import" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        try {
          const count = await importBackup(env, kvH, body.backup);
          return json({ ok: true, agents: count }, 201);
        } catch (e) {
          return json({ code: "bad", message: "ملف النسخة غير صالح", detail: errDetail(e) }, 400);
        }
      }

      // Live activity ticker: recent events across all agents + today's stats
      if (path === "/api/activity" && request.method === "GET") {
        const agents = await listAgents(kvH);
        const icons = { memory: "🧠", lesson: "💡", gap: "❓", training: "📄", quality: "⭐", research: "🔬", "auto-research": "🛰️" };
        const items = [];
        for (const a of agents.slice(0, 15)) {
          const log = (await kvH.get(`learn:${a.id}`)) || [];
          for (const e of log.slice(-6)) {
            items.push({
              at: e.at, icon: icons[e.event] || "•",
              agentId: a.id,
              agent: `${a.avatar || "🤖"} ${a.name}`,
              text: String(e.detail || "").slice(0, 140),
            });
          }
        }
        const day = new Date().toISOString().slice(0, 10);
        const msgs = (await kvH.get(`stats:${day}:messages`)) || 0;
        const neurons = (await kvH.get(`stats:${day}:neurons`)) || 0;
        items.push({
          at: new Date().toISOString(), icon: "📊", agent: "النظام",
          text: `نشاط اليوم: ${msgs} رسالة — ${Number(neurons).toLocaleString("ar")} خلية مستهلكة`,
        });
        items.sort((x, y) => new Date(y.at) - new Date(x.at));
        return json({ items: items.slice(0, 25) });
      }

      // Research history per agent
      if (path.match(/^\/api\/research\/[^/]+$/) && request.method === "GET") {
        const agentId = path.split("/")[3];
        const list = (await kvH.get(`research:${agentId}`)) || [];
        return json({ research: list });
      }

      // Training suggestions: knowledge gaps aggregated & prioritized by frequency
      if (path === "/api/gaps" && request.method === "GET") {
        const agents = await listAgents(kvH);
        const map = new Map();
        for (const a of agents.slice(0, 20)) {
          const log = (await kvH.get(`learn:${a.id}`)) || [];
          for (const e of log) {
            if (e.event === "gap") {
              const key = String(e.detail || "").slice(0, 200);
              if (!key) continue;
              let rec = map.get(key);
              if (!rec) {
                rec = { detail: key, count: 0, agents: [], lastAt: null };
                map.set(key, rec);
              }
              rec.count++;
              if (!rec.agents.some((x) => x.id === a.id)) {
                rec.agents.push({ id: a.id, name: a.name, avatar: a.avatar });
              }
              if (!rec.lastAt || String(e.at) > String(rec.lastAt)) rec.lastAt = e.at;
            }
          }
        }
        const gaps = [...map.values()].sort(
          (x, y) => y.count - x.count || String(y.lastAt).localeCompare(String(x.lastAt))
        );
        return json({ gaps: gaps.slice(0, 10) });
      }

      // Link preview (title only)
      if (path === "/api/preview" && request.method === "GET") {
        const u = String(url.searchParams.get("url") || "").trim();
        if (!/^https?:\/\//i.test(u) || u.length > 2000) {
          return json({ code: "bad", message: "رابط غير صالح" }, 400);
        }
        try {
          const res = await fetch(u, {
            headers: { "user-agent": "AI-Agent-Studio/1.0" },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) throw new Error("fetch failed");
          const html = await res.text();
          const tm = html.match(/<title[^>]*>([\s\S]{1,300})<\/title>/i);
          const title = tm ? tm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 160) : "";
          return json({ url: u, title });
        } catch {
          return json({ url: u, title: "" });
        }
      }

      if (path === "/api/chat" && request.method === "POST") return handleChat(request, env, kvH, ctx);

      if (path === "/api/train" && request.method === "POST") {
        try {
          return await handleTrain(request, env, kvH);
        } catch (e) {
          if (isQuotaError(e)) return json({ code: "quota", message: "نفدت الحصة اليومية" }, 429);
          return json({ code: "upstream", message: "تعذّر التدريب", detail: errDetail(e) }, 502);
        }
      }
      m = path.match(/^\/api\/knowledge\/([^/]+)(?:\/([^/]+))?$/);
      if (m) return handleKnowledge(request, kvH, m[1], m[2]);

      if (path === "/api/learn" && request.method === "POST") return handleLearn(request, env, kvH);
      m = path.match(/^\/api\/learning-log\/([^/]+)$/);
      if (m && request.method === "GET") {
        const log = (await kvH.get(`learn:${m[1]}`)) || [];
        return json({ events: log.slice().reverse().slice(0, 100) });
      }
      m = path.match(/^\/api\/memories\/([^/]+)$/);
      if (m && request.method === "GET") {
        const memories = (await kvH.get(`mem:${m[1]}`)) || {};
        return json({ memories });
      }
      if (m && request.method === "DELETE") {
        const body = await request.json().catch(() => ({}));
        const memories = (await kvH.get(`mem:${m[1]}`)) || {};
        delete memories[String(body.key || "")];
        await kvH.set(`mem:${m[1]}`, memories);
        return json({ ok: true });
      }

      if (path === "/api/tools") return handleTools(request, kvH);
      if (path === "/api/skills") return handleSkills(request, kvH);
      m = path.match(/^\/api\/skills\/([^/]+)$/);
      if (m && request.method === "DELETE") {
        await kvH.del(`skill:${m[1]}`);
        const ids = ((await kvH.get("skills:index")) || []).filter((x) => x !== m[1]);
        await kvH.set("skills:index", ids);
        return json({ ok: true });
      }
      m = path.match(/^\/api\/brain\/([^/]+)$/);
      if (m && request.method === "GET") return handleBrain(kvH, m[1]);

      // Mind summary: auto-generated "who am I" profile
      m = path.match(/^\/api\/mind\/([^/]+)$/);
      if (m && request.method === "GET") return handleMindSummary(env, kvH, m[1]);
      m = path.match(/^\/api\/tools\/([^/]+)$/);
      if (m && request.method === "DELETE") {
        await kvH.del(`tool:${m[1]}`);
        const ids = ((await kvH.get("tools:index")) || []).filter((x) => x !== m[1]);
        await kvH.set("tools:index", ids);
        return json({ ok: true });
      }

      m = path.match(/^\/api\/reminders\/([^/]+)(?:\/([^/]+))?$/);
      if (m && request.method === "GET") {
        return json({ reminders: (await kvH.get(`reminders:${m[1]}`)) || [] });
      }
      if (m && request.method === "PATCH" && m[2]) {
        const list = (await kvH.get(`reminders:${m[1]}`)) || [];
        const item = list.find((r) => r.id === m[2]);
        if (item) item.done = true;
        await kvH.set(`reminders:${m[1]}`, list);
        return json({ ok: true });
      }

      if (path === "/api/dashboard/stats" && request.method === "GET") return handleDashboard(kvH);

      return json({ code: "not-found", message: "مسار غير موجود" }, 404);
    } catch (e) {
      return json({ code: "upstream", message: "خطأ في الخادم", detail: errDetail(e) }, 502);
    }
  },

  // Cron trigger: autonomous research every 30 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(autoResearchCycle(env));
  },
};
