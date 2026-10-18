// Agent storage + quick customization (one-sentence → full agent config).
// KV layout: agents:index → [ids], agent:<id> → agent JSON.

import { CHAT_FALLBACK, DEFAULT_CHAT_MODEL } from "./models.js";
import { builtinToolCards } from "./tools.js";

export function newAgentId() {
  return "ag_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function defaultAgent(overrides = {}) {
  return {
    id: newAgentId(),
    name: "وكيل جديد",
    avatar: "🤖",
    description: "",
    tone: "ودود ومختصر",
    language: "العربية",
    model: DEFAULT_CHAT_MODEL,
    systemPrompt: "أنت وكيل ذكاء اصطناعي مساعد، ودود ومختصر. أجب بالعربية ما لم يُطلب غير ذلك.",
    tools: ["calculator", "datetime", "url_fetch"],
    isActive: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export async function listAgents(kv) {
  const ids = (await kv.get("agents:index")) || [];
  const agents = [];
  for (const id of ids) {
    const a = await kv.get(`agent:${id}`);
    if (a) agents.push(a);
  }
  return agents.sort((x, y) => (y.createdAt || "").localeCompare(x.createdAt || ""));
}

export async function getAgent(kv, id) {
  return kv.get(`agent:${id}`);
}

export async function saveAgent(kv, agent) {
  await kv.set(`agent:${agent.id}`, agent);
  const ids = (await kv.get("agents:index")) || [];
  if (!ids.includes(agent.id)) {
    ids.unshift(agent.id);
    await kv.set("agents:index", ids);
  }
  return agent;
}

export async function deleteAgent(kv, id) {
  await kv.del(`agent:${id}`);
  await kv.del(`mem:${id}`);
  await kv.del(`learn:${id}`);
  await kv.del(`learned:${id}`);
  await kv.del(`know:${id}:files`);
  const ids = ((await kv.get("agents:index")) || []).filter((x) => x !== id);
  await kv.set("agents:index", ids);
}

const QUICK_SYSTEM = `أنت مصمم وكلاء ذكاء اصطناعي. المستخدم يصف ما يريده بجملة واحدة.
ولّد إعدادات وكيل كاملة بصيغة JSON فقط:
{"name":"اسم جذاب بالعربية","avatar":"إيموجي واحد","description":"وصف قصير","tone":"نبرة الشخصية","systemPrompt":"تعليمات نظام مفصلة بالعربية تجعل الوكيل خبيراً في المطلوب","tools":["calculator","datetime","currency","url_fetch","webhook","reminder"]}
اختر من الأدوات فقط ما يناسب المهمة (3 كحد أقصى). لا تضف أي نص خارج JSON.`;

async function runLLM(env, messages, maxTokens) {
  let lastErr = null;
  for (const modelId of CHAT_FALLBACK) {
    try {
      const r = await env.AI.run(modelId, { messages, max_tokens: maxTokens });
      const text = typeof r?.response === "string" ? r.response : "";
      if (text.trim()) return text;
      lastErr = new Error("empty response");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("quick customize failed");
}

/** One sentence → full agent config (reviewed by the user before saving). */
export async function quickCustomize(env, description) {
  const raw = await runLLM(env, [
    { role: "system", content: QUICK_SYSTEM },
    { role: "user", content: String(description || "").slice(0, 500) },
  ], 1000);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("تعذّر توليد إعدادات الوكيل");
  const o = JSON.parse(m[0]);
  const validTools = builtinToolCards().map((t) => t.name);
  const tools = (Array.isArray(o.tools) ? o.tools : [])
    .filter((t) => validTools.includes(t))
    .slice(0, 3);
  return {
    name: String(o.name || "وكيل جديد").slice(0, 60),
    avatar: String(o.avatar || "🤖").slice(0, 8),
    description: String(o.description || "").slice(0, 300),
    tone: String(o.tone || "ودود ومختصر").slice(0, 80),
    language: "العربية",
    model: DEFAULT_CHAT_MODEL,
    systemPrompt: String(o.systemPrompt || "").slice(0, 3000),
    tools: tools.length ? tools : ["calculator", "datetime"],
  };
}
