// Image self-learning lab: after every generated image, a vision model LOOKS
// at the image, scores it on a 5-criterion rubric, extracts one concrete
// lesson, and stores everything in KV. Past lessons are injected into future
// image prompts, so quality improves with every generation. Evaluations and
// lessons appear as nodes in the Brain map.

/** Vision model used to "see" and critique generated images. */
export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
// NOTE: vision neuron cost varies with image size; it counts against the
// daily Workers AI quota. No hard-coded rate is claimed here.

export const EVAL_CRITERIA = [
  { key: "composition", label: "التكوين", hint: "hero subject fills the frame, no empty voids, balanced layout" },
  { key: "lines", label: "جودة الخطوط", hint: "clean confident outlines, no wobbly, broken or sketchy strokes" },
  { key: "artifacts", label: "خلو من العيوب", hint: "no deformed objects, no merged shapes, no extra limbs, no gibberish text" },
  { key: "styleMatch", label: "مطابقة الوصف", hint: "matches what the prompt asked for" },
  { key: "finish", label: "الإتقان العام", hint: "finished professional look, consistent detail, ready to use" },
];

const EVAL_SYSTEM_BASE = `You are a strict art director judging an AI-generated image.
The original text prompt was: "{PROMPT}"
{NICHE_RULE}
Score the image 1-5 (integers) on each criterion:
- composition: hero subject fills the frame, no empty voids, balanced layout
- lines: clean confident outlines, no wobbly/broken/sketchy strokes
- artifacts: no deformed objects, merged shapes, extra limbs, gibberish text
- styleMatch: matches what the prompt asked for
- finish: finished professional look, consistent detail, ready to use
If the prompt asks for a coloring page / coloring book, also judge that every
shape is closed and colourable; mention it in issues when it is not.

Reply with JSON ONLY, no markdown, no extra text:
{"scores":{"composition":4,"lines":3,"artifacts":5,"styleMatch":4,"finish":4},
"strengths":["..."],"issues":["..."],
"lesson":"one short imperative lesson for the NEXT generation, e.g. 'fill empty corners with small filler motifs'"}
Write strengths, issues and lesson in ARABIC. Be honest and specific — never
give 5/5 when real flaws exist.`;

/** Niche-aware strict gate appended to the eval prompt. */
function nicheRule(nicheKey) {
  if (nicheKey === "coloring-page") {
    return `STRICT GATE — the requested niche is a COLORING PAGE (pure black and white line art).
If the image contains ANY color, shading, gray tones or gradients, styleMatch MUST be 1
and the FIRST issue MUST state: "colored/shaded image delivered instead of a black-and-white coloring page".`;
  }
  if (nicheKey === "coloring-cover") {
    return `STRICT GATE — the requested niche is a COLORING BOOK COVER (full-color illustration).
If the image is black-and-white line art instead of a full-color illustration, styleMatch MUST be 1.`;
  }
  return "";
}

function buildEvalPrompt(prompt, nicheKey) {
  return EVAL_SYSTEM_BASE
    .replace("{PROMPT}", String(prompt || "").slice(0, 500))
    .replace("{NICHE_RULE}", nicheRule(nicheKey));
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** Robust parse of the vision model's JSON reply. Never throws. */
export function safeParseEval(text) {
  const fallback = {
    scores: { composition: 3, lines: 3, artifacts: 3, styleMatch: 3, finish: 3 },
    overall: 3.0, strengths: [], issues: [], lesson: "",
  };
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const o = JSON.parse(m[0]);
    const scores = {};
    for (const c of EVAL_CRITERIA) scores[c.key] = clampScore(o?.scores?.[c.key]);
    const vals = Object.values(scores);
    const overall = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    const str = (a) => (Array.isArray(a) ? a.map(String).map((s) => s.slice(0, 200)).slice(0, 5) : []);
    return {
      scores, overall,
      strengths: str(o.strengths),
      issues: str(o.issues),
      lesson: String(o.lesson || "").slice(0, 300),
    };
  } catch {
    return fallback;
  }
}

/**
 * Ask the vision model to critique a generated image.
 * imageB64: base64 PNG/JPEG bytes. nicheKey enables the strict style gate.
 * Returns the parsed evaluation. Throws when the vision call fails.
 */
export async function analyzeImage(env, imageB64, prompt, nicheKey) {
  if (!imageB64) throw new Error("no image bytes");
  const out = await env.AI.run(VISION_MODEL, {
    image: imageB64,
    prompt: buildEvalPrompt(prompt, nicheKey),
    max_tokens: 900,
  });
  const text = typeof out?.response === "string" ? out.response : "";
  if (!text.trim()) throw new Error("empty vision response");
  return safeParseEval(text);
}

/** Last N image/niche lessons for prompt enrichment. */
export async function getImageLessons(kv, agentId, n = 3, sources = ["image-eval", "niche-research"]) {
  const learned = (await kv.get(`learned:${agentId}`)) || [];
  return learned
    .filter((l) => l && sources.includes(l.source) && l.text)
    .slice(-n)
    .map((l) => String(l.text));
}

/** Suffix appended to the image prompt so past lessons steer the next generation. */
export function buildLearnSuffix(lessons) {
  const list = (lessons || []).map(String).filter(Boolean).slice(0, 3);
  if (!list.length) return "";
  return "\n\n[Lessons learned from my own past generations — apply them]:\n" +
    list.map((l) => `- ${l}`).join("\n");
}

const IMGLOG_CAP = 30;
const LEARNED_CAP = 60;

/**
 * Full per-image learning pipeline: analyze → store evaluation →
 * append lesson to memory → learning-log event (shows in Brain map).
 * Never throws: on vision failure stores {evaluated:false} so the UI can retry.
 */
export async function evaluateAndLearn(env, kv, agent, imageId, prompt, imageB64, nicheKey) {
  const now = new Date().toISOString();
  const agentId = agent?.id || "global";
  if (agent && agent.imageLearn === false) {
    return { evaluated: false, reason: "disabled" };
  }
  let ev;
  try {
    ev = await analyzeImage(env, imageB64, prompt, nicheKey);
  } catch (e) {
    ev = null;
  }
  if (!ev) {
    const failed = { evaluated: false, reason: "vision-failed", at: now, prompt: String(prompt || "").slice(0, 200), niche: nicheKey || null };
    await kv.set(`imgeval:${imageId}`, failed);
    return failed;
  }
  const record = { evaluated: true, at: now, prompt: String(prompt || "").slice(0, 200), niche: nicheKey || null, ...ev };

  // 1) Per-image evaluation record (the "memory" of this image)
  await kv.set(`imgeval:${imageId}`, record);

  // 2) Per-agent image history (for gallery badges + Brain nodes)
  const logKey = `imglog:${agentId}`;
  const log = (await kv.get(logKey)) || [];
  log.push({ id: imageId, at: now, prompt: String(prompt || "").slice(0, 200), overall: ev.overall, niche: nicheKey || null });
  await kv.set(logKey, log.slice(-IMGLOG_CAP));

  // 3) Lesson → agent's learned instructions (steers future generations)
  const events = [];
  if (ev.lesson) {
    const insKey = `learned:${agentId}`;
    const learned = (await kv.get(insKey)) || [];
    learned.push({ at: now, text: ev.lesson, source: "image-eval", imageId });
    await kv.set(insKey, learned.slice(-LEARNED_CAP));
    events.push({ at: now, event: "lesson", detail: `🖼️ درس من تقييم صورة: ${ev.lesson}` });
  }

  // 4) Visible learning event → appears in Brain map + learning timeline
  const topNote = ev.issues[0] ? `ملاحظة: ${ev.issues[0]}` : ev.strengths[0] ? `ممتاز: ${ev.strengths[0]}` : "";
  events.push({ at: now, event: "image-eval", detail: `🖼️ قيّم صورة مولدة: ${ev.overall}/5${topNote ? ` — ${topNote}` : ""}` });
  const logKey2 = `learn:${agentId}`;
  const learnLog = (await kv.get(logKey2)) || [];
  learnLog.push(...events);
  await kv.set(logKey2, learnLog.slice(-200));

  return record;
}
