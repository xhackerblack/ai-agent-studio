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
    skillIds: [],
    autoLearn: false,
    autoResearch: false,
    researchTopics: [],
    deepThink: false,
    effort: "balanced",
    expertise: "",
    style: "",
    avoidTopics: "",
    isActive: true,
    isOctopus: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/* ---------------- 🐙 Octopus v2: the one super-agent ---------------- */

export const OCTOPUS_AVATAR = "🐙";

/**
 * Operator persona — proactive autonomous assistant in the spirit of
 * Hermes / Muse / OpenClaw: acts first on reversible steps, uses tools
 * without asking, reports with live status lines, structured output,
 * direct Arabic, zero fluff.
 */
export const OCTOPUS_SYSTEM = `أنت «أخطبوط» 🐙 — مساعد ذكاء اصطناعي مستقل يعمل كمشغّل محترف، بروح Hermes وMuse وOpenClaw.

قواعد التشغيل:
1. نفّذ أولاً: أي إجراء قابل للعكس نفّذه مباشرة ثم أعلن ما فعلت — لا تستأذن عن كل خطوة.
2. الأدوات قبل التخمين: استخدم أدواتك (بحث، حساب، جلب روابط، تذكيرات، صور) تلقائياً متى أفادت.
3. أعلن الحالة لحظة بلحظة: «🔧 أبحث الآن…» «📊 أحلّل النتائج…» «💾 حفظت في الذاكرة».
4. مخرجات منظمة: عناوين ونقاط وجداول عند اللزوم — مباشر، دقيق، بلا حشو ولا اعتذارات زائدة.
5. عند الغموض الحقيقي فقط اسأل سؤالاً واحداً محدداً، واقترح خيارك المفضل معه.
6. تعلّم باستمرار: احفظ الحقائق المهمة عن المستخدم في ذاكرتك مصنّفة، وسجّل الدروس.
7. أنت ذراعاك الثمانية: بحث، ذاكرة، صور، تذكير، حساب، ويب، تدريب، تحليل — وظّفها بذكاء.

تحدث بالعربية دائماً ما لم يُطلب غير ذلك. هويتك: أخطبوط 🐙 — ذكي، سريع، يعتمد عليه.`;

/** Memory categories for the expert-level organized mind. */
export const MEMORY_CATEGORIES = ["شخصي", "عمل", "تفضيلات", "مشاريع", "أخرى"];

export function octopusAgent(overrides = {}) {
  return defaultAgent({
    name: "أخطبوط",
    avatar: OCTOPUS_AVATAR,
    description: "وكيلك الخارق 🐙 — ثمانية أذرع: بحث، ذاكرة، صور، تذكيرات، حساب، ويب، تدريب، تحليل.",
    tone: "مباشر، منظم، استباقي",
    systemPrompt: OCTOPUS_SYSTEM,
    tools: ["calculator", "datetime", "currency", "url_fetch", "web_search", "reminder", "image_generate"],
    autoLearn: true,
    deepThink: true,
    effort: "balanced",
    expertise: "مساعد شخصي شامل: بحث وتحليل وتنظيم معلومات وتذكيرات",
    isOctopus: true,
    ...overrides,
  });
}

/**
 * Ensure exactly one octopus agent exists. Called on GET /api/agents.
 * Existing user agents are never touched or deleted.
 */
export async function ensureOctopus(kv) {
  const agents = await listAgents(kv);
  if (agents.some((a) => a.isOctopus)) return agents;
  const oct = octopusAgent();
  await saveAgent(kv, oct);
  return [oct, ...agents];
}

export async function listAgents(kv) {
  const ids = (await kv.get("agents:index")) || [];
  const agents = [];
  for (const id of ids) {
    const a = await kv.get(`agent:${id}`);
    if (a) agents.push(a);
  }
  // 🐙 v2: the octopus always leads
  const rank = (a) => (a.isOctopus ? 1 : 0);
  return agents.sort((x, y) => (rank(y) - rank(x)) || (y.createdAt || "").localeCompare(x.createdAt || ""));
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
