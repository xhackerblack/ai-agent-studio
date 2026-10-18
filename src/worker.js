// AI Agent Studio — Cloudflare Worker.
// Routes: /api/config, /api/agents*, /api/conversations*, /api/chat (SSE),
// /api/train, /api/knowledge*, /api/learn, /api/learning-log/*, /api/memories*,
// /api/tools*, /api/reminders*, /api/dashboard/stats.
// Static frontend served from ./public via the ASSETS binding.

import {
  CHAT_MODELS, CHAT_FALLBACK, DEFAULT_CHAT_MODEL, EMBEDDING_MODEL,
  FREE_NEURONS_PER_DAY, getChatModel, chatNeurons, embeddingNeurons,
  publicModels,
} from "./models.js";
import { chunkText, retrieve, relevantChunks, RELEVANCE_THRESHOLD } from "./rag.js";
import { BUILTIN_TOOLS, getBuiltinTool, builtinToolCards } from "./tools.js";
import { learnFromConversation } from "./learn.js";
import {
  newAgentId, defaultAgent, listAgents, getAgent, saveAgent,
  deleteAgent, quickCustomize,
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
    freePerDay: FREE_NEURONS_PER_DAY,
    builtinTools: builtinToolCards(),
    app: "AI Agent Studio",
  });
}

/* ---------------- agents ---------------- */

async function handleAgents(req, kvH, url) {
  if (req.method === "GET") return json({ agents: await listAgents(kvH) });
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
    for (const f of ["name", "avatar", "description", "tone", "language", "model", "systemPrompt"]) {
      if (typeof body[f] === "string") agent[f] = body[f].slice(0, 4000);
    }
    if (Array.isArray(body.tools)) {
      agent.tools = body.tools.filter((t) => getBuiltinTool(t)).slice(0, 8);
    }
    if (typeof body.isActive === "boolean") agent.isActive = body.isActive;
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

/* ---------------- chat (SSE) ---------------- */

const DECIDE_SYSTEM = `أنت مخطط أدوات لوكيل ذكاء اصطناعي. أمامك رسالة المستخدم وقائمة الأدوات المتاحة.
إن كانت الرسالة تحتاج أداة فعلاً (حساب، وقت، عملات، جلب رابط، تذكير، API خارجي) أعد JSON فقط:
{"tool":"اسم_الأداة","args":{...}}
وإلا أعد JSON فقط: {"answer":true}
لا تضف أي نص خارج JSON.`;

async function decideTool(env, agent, enabledTools, userText) {
  if (!enabledTools.length) return null;
  const toolDesc = enabledTools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
  const raw = await runChatLLM(env, agent.model, [
    { role: "system", content: DECIDE_SYSTEM + "\n\nالأدوات:\n" + toolDesc },
    { role: "user", content: userText.slice(0, 1500) },
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

function buildSystemPrompt(agent, memories, learned, ragContext) {
  const parts = [agent.systemPrompt];
  const memEntries = Object.entries(memories || {});
  if (memEntries.length) {
    parts.push("ما تعرفه عن المستخدم (ذاكرة دائمة):\n" +
      memEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n"));
  }
  if (learned && learned.length) {
    parts.push("دروس تعلمتها بنفسك من محادثات سابقة (اتبعها):\n" +
      learned.slice(-8).map((l) => `- ${l.text}`).join("\n"));
  }
  if (ragContext) {
    parts.push("معلومات من ملفات التدريب الخاصة بك (اعتمد عليها وأشر للمصدر):\n" + ragContext);
  }
  parts.push("لغة الرد: " + (agent.language || "العربية") + ". النبرة: " + (agent.tone || "ودود ومختصر") + ".");
  return parts.join("\n\n");
}

async function getRagContext(env, kvH, agent, userText) {
  const files = (await kvH.get(`know:${agent.id}:files`)) || [];
  if (!files.length) return "";
  const emb = await env.AI.run(EMBEDDING_MODEL, { text: [userText.slice(0, 1000)] });
  const q = emb?.data?.[0];
  if (!q) return "";
  const allChunks = [];
  for (const f of files) {
    const rec = await kvH.get(`know:${agent.id}:${f.id}`);
    if (rec && Array.isArray(rec.chunks)) {
      for (const c of rec.chunks) allChunks.push({ ...c, file: f.filename });
    }
  }
  const hits = relevantChunks(allChunks, q, 5);
  if (!hits.length) return "";
  return hits.map((h, i) => `[${i + 1}] (من ${h.file || "ملف التدريب"}): ${h.text}`).join("\n");
}

async function handleChat(req, env, kvH) {
  const body = await req.json().catch(() => ({}));
  const agent = await getAgent(kvH, String(body.agentId || ""));
  if (!agent || !agent.isActive) {
    return json({ code: "not-found", message: "الوكيل غير موجود أو معطّل" }, 404);
  }
  const userText = String(body.message || "").trim().slice(0, 4000);
  if (!userText) return json({ code: "bad", message: "الرسالة فارغة" }, 400);
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

        const [memories, learned] = await Promise.all([
          kvH.get(`mem:${agent.id}`),
          kvH.get(`learned:${agent.id}`),
        ]);
        let ragContext = "";
        try {
          ragContext = await getRagContext(env, kvH, agent, userText);
        } catch (e) {
          ragContext = "";
        }

        // Phase 1: decide tool
        const enabledTools = (agent.tools || []).map(getBuiltinTool).filter(Boolean);
        let toolResultText = "";
        try {
          const decision = await decideTool(env, agent, enabledTools, userText);
          if (decision) {
            const tool = getBuiltinTool(decision.name);
            send({ type: "tool", icon: tool.icon, label: tool.label });
            toolsUsed.push(tool.label);
            const ctx = {
              fetch, agent, env,
              getCustomTool: async (id) => kvH.get(`tool:${id}`),
              addReminder: async (agentId, item) => {
                const k = `reminders:${agentId}`;
                const list = (await kvH.get(k)) || [];
                list.unshift(item);
                await kvH.set(k, list.slice(0, 100));
              },
            };
            const out = await tool.run(decision.args, ctx);
            toolResultText = `نتيجة الأداة (${tool.label}): ${JSON.stringify(out).slice(0, 2000)}`;
            await bumpStat(kvH, "toolCalls");
          }
        } catch (e) {
          toolResultText = `تعذّر استخدام الأداة: ${errDetail(e)} — أجب بدونها.`;
        }

        // Phase 2: stream the final answer
        const system = buildSystemPrompt(agent, memories, learned, ragContext);
        const history = (conv.messages || []).slice(-12).map((m) => ({
          role: m.role === "user" ? "user" : "assistant", content: m.content,
        }));
        const finalMessages = [
          { role: "system", content: system },
          ...history,
          { role: "user", content: userText + (toolResultText ? `\n\n${toolResultText}` : "") },
        ];
        const { result, modelId } = await runChatLLM(env, agent.model, finalMessages, 1500, true);
        let full = "";
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

        // Persist
        conv.messages.push({ role: "user", content: userText });
        conv.messages.push({ role: "assistant", content: full, tools: toolsUsed });
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
        await bumpStat(kvH, "neurons", chatNeurons(modelId, system.length + userText.length, full.length));

        send({ type: "done", tools: toolsUsed });
        controller.close();
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
  const [messages, toolCalls, neurons, agentsCreated] = await Promise.all([
    kvH.get(`stats:${day}:messages`),
    kvH.get(`stats:${day}:toolCalls`),
    kvH.get(`stats:${day}:neurons`),
    kvH.get(`stats:${day}:agentsCreated`),
  ]);
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
      quotaLeft: Math.max(0, FREE_NEURONS_PER_DAY - (neurons || 0)),
    },
    series,
  });
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

    // Password gate (optional)
    if (path !== "/api/config" && !(await checkPassword(request, env))) {
      return json({ code: "unauthorized", message: "كلمة المرور غير صحيحة" }, 401);
    }

    const kvH = kv(env);
    try {
      if (path === "/api/config" && request.method === "GET") return handleConfig();

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
      if (m) return handleAgentById(request, kvH, m[1]);

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

      if (path === "/api/chat" && request.method === "POST") return handleChat(request, env, kvH);

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
};
