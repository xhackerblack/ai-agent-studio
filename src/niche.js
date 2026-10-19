// Niche intelligence: understand WHAT the user wants BEFORE the image model draws.
// Pipeline: detect niche → refine keyword-stuffing into a real description →
// attach a tested style block → pre-flight validate. A raw keyword-stuffed
// prompt must never reach the image model.

import { CHAT_FALLBACK } from "./models.js";
import { buildLearnSuffix, VISION_MODEL } from "./imagelab.js";

export const NICHES = {
  "coloring-page": {
    label: "صفحة تلوين",
    icon: "📄",
    palette: "bw",
    styleBlock:
      "black and white coloring book page, clean bold outlines, pure line art, " +
      "absolutely no shading, no gray tones, no gradients, no color, white background, " +
      "every shape closed and colourable, large open areas",
    mustHave: ["black and white", "line art"],
    mustAvoid: ["full-color", "full color", "colored illustration", "colorful", "watercolor", "vibrant colors"],
  },
  "coloring-cover": {
    label: "غلاف كتاب تلوين",
    icon: "📕",
    palette: "color",
    styleBlock:
      "full-color charming book cover illustration, richly detailed scene filling the frame " +
      "edge to edge, warm inviting palette, decorative filler details in every corner, " +
      "no text, no letters, no words, no title",
    mustHave: ["full-color", "no text"],
    mustAvoid: ["black and white", "line art", "coloring book page"],
  },
  kawaii: {
    label: "كاواي",
    icon: "🌸",
    palette: "color",
    styleBlock:
      "kawaii style illustration, cute chibi character, big expressive eyes, soft pastel colors, " +
      "simple clean shapes, thick bold outlines, white background",
    mustHave: ["kawaii"],
    mustAvoid: ["photorealistic", "black and white", "line art"],
  },
  general: {
    label: "عام",
    icon: "🎨",
    palette: "color",
    styleBlock: "",
    mustHave: [],
    mustAvoid: [],
  },
};

export function getNiche(key) {
  return NICHES[key] || NICHES.general;
}

export function nicheKeyOf(key) {
  return NICHES[key] ? key : "general";
}

/** Fast heuristic niche detection (also the LLM fallback). Pure function. */
export function detectNicheHeuristic(text) {
  const t = String(text || "").toLowerCase();
  const has = (...ws) => ws.some((w) => t.includes(w));
  if (has("coloring book", "coloring page", "coloring pages", "صفحة تلوين", "صفحات تلوين", "كتاب تلوين", "كتب تلوين", "coloriage")) {
    if (has("cover", "غلاف")) return "coloring-cover";
    return "coloring-page";
  }
  if (has("book cover", "غلاف كتاب")) return "coloring-cover";
  if (has("kawaii", "chibi", "تشيبي", "كاواي")) return "kawaii";
  return "general";
}

async function runChatLLM(env, messages, maxTokens = 400) {
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
  throw lastErr || new Error("niche llm failed");
}

const NICHE_SYSTEM = `You are a niche classifier for an image-generation studio.
The user request may be Arabic, English, or keyword-stuffed.
Reply with JSON ONLY, no markdown, no extra text:
{"niche":"coloring-page|coloring-cover|kawaii|general","subject":"3-8 English words describing the scene","audience":"kids|adults|any"}
Rules:
- mentions coloring book/page (or صفحة تلوين / كتاب تلوين) → "coloring-page"
- mentions cover (or غلاف) of a coloring book → "coloring-cover"
- chibi/kawaii/cute character → "kawaii"
- otherwise → "general"
- subject: concise English scene description, no style words.`;

function safeParseNicheJson(text, fallbackText) {
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json");
    const o = JSON.parse(m[0]);
    const key = nicheKeyOf(o.niche);
    const subject = String(o.subject || "").slice(0, 120).trim();
    return { key, subject: subject || heuristicSubject(fallbackText), audience: String(o.audience || "any").slice(0, 10) };
  } catch {
    return { key: detectNicheHeuristic(fallbackText), subject: heuristicSubject(fallbackText), audience: "any" };
  }
}

/** LLM niche analysis with heuristic fallback. Never throws. */
export async function analyzeNiche(env, text) {
  const raw = String(text || "").trim();
  if (!raw) return { key: "general", subject: "a cozy scene", audience: "any" };
  try {
    const out = await runChatLLM(env, [
      { role: "system", content: NICHE_SYSTEM },
      { role: "user", content: raw.slice(0, 500) },
    ], 300);
    return safeParseNicheJson(out, raw);
  } catch {
    return { key: detectNicheHeuristic(raw), subject: heuristicSubject(raw), audience: "any" };
  }
}

const NICHE_WORDS = /coloring\sbook|coloring\sbooks|coloring\spages?|coloring|coloriage|صفحة تلوين|صفحات تلوين|كتاب تلوين|كتب تلوين|للكبار|للأطفال|للاطفال|cover|غلاف|كاواي|تشيبي|kawaii|chibi/gi;

/** Strip niche/format keywords → clean subject fallback. Pure function. */
export function heuristicSubject(text) {
  const s = String(text || "").replace(NICHE_WORDS, " ").replace(/\s+/g, " ").trim();
  return s || "a cozy scene";
}

const REFINE_SYSTEM = `Rewrite the user's image request as ONE vivid English image description, 12-28 words, scene only.
Remove style/format words like "coloring book", "4k", "trending", "wallpaper".
Keep the subject, mood and key objects. No quotes, no preamble — reply with the description only.`;

/** Turn keyword-stuffing into a real English description. Never throws. */
export async function refinePrompt(env, text, nicheKey) {
  const raw = String(text || "").trim();
  if (!raw) return "a cozy scene";
  try {
    const out = await runChatLLM(env, [
      { role: "system", content: REFINE_SYSTEM },
      { role: "user", content: `niche: ${nicheKey}\nrequest: ${raw.slice(0, 500)}` },
    ], 200);
    const d = String(out || "").replace(/^["']|["']$/g, "").trim().split("\n")[0].slice(0, 300);
    return d || heuristicSubject(raw);
  } catch {
    return heuristicSubject(raw);
  }
}

/** Assemble the final model-ready prompt: description + style block + lessons + template. */
export function buildFinalPrompt({ refined, nicheKey, lessons = [], template = null } = {}) {
  const n = getNiche(nicheKey);
  let p = String(refined || "a cozy scene").trim();
  if (n.styleBlock) p += "\n" + n.styleBlock;
  if (template) p += `\n[Proven style reference for this niche: ${String(template).slice(0, 200)}]`;
  const suffix = buildLearnSuffix(lessons);
  if (suffix) p += "\n" + suffix;
  return p;
}

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pre-flight check: does the final prompt carry the niche's mandatory style
 * constraints and none of its forbidden style phrases?
 * (mustAvoid uses a "no "-lookbehind so "no color" does not false-positive.)
 */
export function preflightCheck(finalPrompt, nicheKey) {
  const n = getNiche(nicheKey);
  const low = String(finalPrompt || "");
  const missing = n.mustHave.filter((ph) => !low.toLowerCase().includes(ph.toLowerCase()));
  const avoidedHit = n.mustAvoid.filter((ph) => new RegExp(`(?<!no\\s)${escRe(ph)}`, "i").test(low));
  return { ok: missing.length === 0 && avoidedHit.length === 0, missing, avoidedHit };
}

/** Auto-fix a failing pre-flight: re-assert the style block, hard. */
export function fixPrompt(finalPrompt, nicheKey, check) {
  const n = getNiche(nicheKey);
  let fix = String(finalPrompt || "");
  if (n.styleBlock && (check.missing.length || !fix.includes(n.styleBlock.split(",")[0]))) {
    fix += "\n" + n.styleBlock;
  }
  if (n.palette === "bw" && check.avoidedHit.length) {
    fix += "\n[CRITICAL STYLE RULE: scene words above may mention color — IGNORE them for rendering. " +
      "The output MUST be pure black and white line art: no color, no shading, no gray tones, no gradients.]";
  }
  return fix;
}

/* ---------------- web / reference learning ---------------- */

const DNA_SYSTEM = `You are an art director studying successful coloring books in a niche.
Given web research snippets below, extract the niche's STYLE DNA.
Reply with JSON ONLY, no markdown:
{"elements":["recurring objects/motifs"],"lineNotes":"how lines look","compositionNotes":"how scenes are composed","avoid":["common failures to avoid"],"lesson":"one Arabic imperative lesson for an image model generating this niche"}`;

function safeParseDna(text) {
  const fb = { elements: [], lineNotes: "", compositionNotes: "", avoid: [], lesson: "" };
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) return fb;
    const o = JSON.parse(m[0]);
    const arr = (a) => (Array.isArray(a) ? a.map(String).map((s) => s.slice(0, 160)).slice(0, 8) : []);
    return {
      elements: arr(o.elements),
      lineNotes: String(o.lineNotes || "").slice(0, 300),
      compositionNotes: String(o.compositionNotes || "").slice(0, 300),
      avoid: arr(o.avoid),
      lesson: String(o.lesson || "").slice(0, 300),
    };
  } catch {
    return fb;
  }
}

/** Extract style DNA from web research snippets. Never throws. */
export async function extractStyleDNA(env, nicheKey, subject, snippets) {
  const n = getNiche(nicheKey);
  const text = (snippets || []).join("\n").slice(0, 4000);
  if (!text.trim()) return { elements: [], lineNotes: "", compositionNotes: "", avoid: [], lesson: "" };
  try {
    const out = await runChatLLM(env, [
      { role: "system", content: DNA_SYSTEM },
      { role: "user", content: `niche: ${n.label} (${nicheKey})\nsubject: ${subject}\n\nresearch:\n${text}` },
    ], 600);
    return safeParseDna(out);
  } catch {
    return { elements: [], lineNotes: "", compositionNotes: "", avoid: [], lesson: "" };
  }
}

const STYLE_VISION_SYSTEM = `You are an art director. Analyze ONLY the ART STYLE of this reference image (not its content).
Reply with JSON ONLY, no markdown:
{"styleName":"short name","palette":"bw|color|pastel","instructions":"3-6 Arabic imperative sentences an image model must follow to reproduce this style","motifs":["recurring visual motifs"],"lineWeight":"how outlines look"}`;

function safeParseStyleVision(text) {
  const fb = { styleName: "أسلوب مرجعي", palette: "color", instructions: "", motifs: [], lineWeight: "" };
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) return fb;
    const o = JSON.parse(m[0]);
    return {
      styleName: String(o.styleName || fb.styleName).slice(0, 60),
      palette: /bw|black/i.test(String(o.palette)) ? "bw" : "color",
      instructions: String(o.instructions || "").slice(0, 1200),
      motifs: Array.isArray(o.motifs) ? o.motifs.map(String).slice(0, 8) : [],
      lineWeight: String(o.lineWeight || "").slice(0, 200),
    };
  } catch {
    return fb;
  }
}

/** Vision-extract style DNA from a user-uploaded reference image. Throws on vision failure. */
export async function styleFromImage(env, imageB64) {
  const out = await env.AI.run(VISION_MODEL, {
    image: imageB64,
    prompt: STYLE_VISION_SYSTEM,
    max_tokens: 800,
  });
  const text = typeof out?.response === "string" ? out.response : "";
  if (!text.trim()) throw new Error("empty vision response");
  return safeParseStyleVision(text);
}
