// Self-learning loop: after a conversation (or on demand) the agent reviews
// the dialogue with an LLM and extracts (1) durable memories, (2) lessons that
// improve its behaviour, (3) open questions it answered poorly. Everything is
// written to KV and shown in the visible learning timeline.

import { CHAT_FALLBACK } from "./models.js";

const LEARN_SYSTEM = `أنت محلل تعلّم ذاتي لوكيل ذكاء اصطناعي. اقرأ المحادثة التالية واستخلص:
1. ذكريات دائمة: حقائق عن المستخدم وتفضيلاته (قصيرة، محددة).
2. دروس سلوكية: ما الذي حسّن الإجابة أو أفسدها؟ صِغها كقواعد للوكيل.
3. فجوات معرفية: أسئلة لم يُجب عنها الوكيل جيداً — اقترح موضوعاً لتدريبه عليه.

أعد JSON فقط بهذا الشكل:
{"memories":[{"key":"...","value":"..."}],"lessons":["..."],"gaps":["..."]}
إن لم تجد شيئاً يستحق الحفظ فأعد {"memories":[],"lessons":[],"gaps":[]}.
اكتب القيم بالعربية. لا تضف أي نص خارج JSON.`;

function safeParseLearn(text) {
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) return { memories: [], lessons: [], gaps: [] };
    const o = JSON.parse(m[0]);
    return {
      memories: Array.isArray(o.memories) ? o.memories.filter((x) => x && x.key && x.value).slice(0, 10) : [],
      lessons: Array.isArray(o.lessons) ? o.lessons.map(String).slice(0, 10) : [],
      gaps: Array.isArray(o.gaps) ? o.gaps.map(String).slice(0, 10) : [],
    };
  } catch {
    return { memories: [], lessons: [], gaps: [] };
  }
}

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
  throw lastErr || new Error("learn failed");
}

export function transcriptFor(messages, maxChars = 6000) {
  return (messages || [])
    .map((m) => `${m.role === "user" ? "المستخدم" : "الوكيل"}: ${m.content}`)
    .join("\n")
    .slice(-maxChars);
}

/**
 * Run the self-learning pass over a conversation transcript.
 * kv: {get,set} helpers. Returns {memories, lessons, gaps, events}.
 */
export async function learnFromConversation(env, kv, agent, messages) {
  const transcript = transcriptFor(messages);
  if (transcript.trim().length < 40) {
    return { memories: [], lessons: [], gaps: [], events: [], skipped: true };
  }
  const raw = await runLLM(env, [
    { role: "system", content: LEARN_SYSTEM },
    { role: "user", content: `وكيل: ${agent.name}\n\nالمحادثة:\n${transcript}` },
  ], 1200);
  const parsed = safeParseLearn(raw);

  const events = [];
  const now = new Date().toISOString();

  // 1) Durable memories
  const memKey = `mem:${agent.id}`;
  const memories = (await kv.get(memKey)) || {};
  for (const mem of parsed.memories) {
    memories[String(mem.key).slice(0, 80)] = String(mem.value).slice(0, 500);
    events.push({ at: now, event: "memory", detail: `حفظ في الذاكرة: ${mem.key} = ${mem.value}` });
  }
  await kv.set(memKey, memories);

  // 2) Behaviour lessons → appended to the agent's learned instructions
  if (parsed.lessons.length) {
    const insKey = `learned:${agent.id}`;
    const existing = (await kv.get(insKey)) || [];
    for (const lesson of parsed.lessons) {
      existing.push({ at: now, text: String(lesson).slice(0, 500) });
      events.push({ at: now, event: "lesson", detail: `درس مستخلص: ${lesson}` });
    }
    await kv.set(insKey, existing.slice(-50));
  }

  // 3) Knowledge gaps → suggestions
  for (const gap of parsed.gaps) {
    events.push({ at: now, event: "gap", detail: `فجوة معرفية مقترحة للتدريب: ${gap}` });
  }

  // Append to the visible learning timeline
  if (events.length) {
    const logKey = `learn:${agent.id}`;
    const log = (await kv.get(logKey)) || [];
    log.push(...events);
    await kv.set(logKey, log.slice(-200));
  }

  return { ...parsed, events, skipped: false };
}
