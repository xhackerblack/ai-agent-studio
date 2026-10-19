// Tests for the image self-learning lab (src/imagelab.js). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import {
  VISION_MODEL, EVAL_CRITERIA, safeParseEval, analyzeImage,
  getImageLessons, buildLearnSuffix, evaluateAndLearn,
} from "../src/imagelab.js";

function mockKV() {
  const m = new Map();
  return {
    async get(k) { const v = m.get(k); return v === undefined ? null : JSON.parse(v); },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async del(k) { m.delete(k); },
    _raw: m,
  };
}

const VISION_OK = JSON.stringify({
  scores: { composition: 4, lines: 2, artifacts: 5, styleMatch: 4, finish: 3 },
  strengths: ["تكوين متوازن"],
  issues: ["خطوط مهتزة في الزاوية"],
  lesson: "اجعل الخطوط الخارجية عريضة وواثقة",
});

/* ---------- safeParseEval ---------- */

test("safeParseEval parses a valid vision reply and averages the overall", () => {
  const ev = safeParseEval(VISION_OK);
  assert.equal(ev.scores.composition, 4);
  assert.equal(ev.scores.lines, 2);
  assert.equal(ev.overall, 3.6); // (4+2+5+4+3)/5
  assert.deepEqual(ev.strengths, ["تكوين متوازن"]);
  assert.equal(ev.lesson, "اجعل الخطوط الخارجية عريضة وواثقة");
});

test("safeParseEval clamps out-of-range and non-numeric scores", () => {
  const ev = safeParseEval(JSON.stringify({
    scores: { composition: 9, lines: 0, artifacts: -3, styleMatch: "x", finish: 4.6 },
  }));
  assert.equal(ev.scores.composition, 5);
  assert.equal(ev.scores.lines, 1);
  assert.equal(ev.scores.artifacts, 1);
  assert.equal(ev.scores.styleMatch, 3);
  assert.equal(ev.scores.finish, 5);
});

test("safeParseEval never throws on garbage", () => {
  for (const bad of ["", "no json here", "{broken", null, 42]) {
    const ev = safeParseEval(bad);
    assert.equal(ev.overall, 3.0);
    assert.equal(ev.lesson, "");
  }
  assert.equal(EVAL_CRITERIA.length, 5);
});

/* ---------- prompt enrichment ---------- */

test("buildLearnSuffix is empty without lessons, formatted with them", () => {
  assert.equal(buildLearnSuffix([]), "");
  assert.equal(buildLearnSuffix(null), "");
  const s = buildLearnSuffix(["درس أول", "درس ثانٍ"]);
  assert.match(s, /درس أول/);
  assert.match(s, /درس ثانٍ/);
  // caps at 3
  const s4 = buildLearnSuffix(["a", "b", "c", "d"]);
  assert.doesNotMatch(s4, /- d\n?$/);
});

test("getImageLessons returns only image-eval lessons, most recent last", async () => {
  const kv = mockKV();
  await kv.set("learned:ag1", [
    { at: "t", text: "درس محادثة", source: "chat" },
    { at: "t", text: "درس صورة 1", source: "image-eval", imageId: "i1" },
    { at: "t", text: "درس صورة 2", source: "image-eval", imageId: "i2" },
    { at: "t", text: "درس بحث", source: "research" },
    { at: "t", text: "درس صورة 3", source: "image-eval", imageId: "i3" },
  ]);
  assert.deepEqual(await getImageLessons(kv, "ag1", 2), ["درس صورة 2", "درس صورة 3"]);
  assert.equal((await getImageLessons(kv, "ag1", 10)).length, 3);
  assert.deepEqual(await getImageLessons(kv, "nope"), []);
});

/* ---------- analyzeImage ---------- */

test("analyzeImage calls the vision model and parses the critique", async () => {
  let seen;
  const env = { AI: { run: async (model, input) => { seen = { model, input }; return { response: VISION_OK }; } } };
  const ev = await analyzeImage(env, "ZmFrZXIzMjQ=", "a cozy bakery");
  assert.equal(seen.model, VISION_MODEL);
  assert.equal(seen.input.image, "ZmFrZXIzMjQ=");
  assert.match(seen.input.prompt, /a cozy bakery/);
  assert.equal(ev.overall, 3.6);
});

test("analyzeImage throws on empty vision response", async () => {
  const env = { AI: { run: async () => ({ response: "" }) } };
  await assert.rejects(() => analyzeImage(env, "eA==", "x"), /empty vision response/);
  await assert.rejects(() => analyzeImage(env, "", "x"), /no image bytes/);
});

test("analyzeImage adds the strict gate for coloring-page niche", async () => {
  let seen;
  const env = { AI: { run: async (model, input) => { seen = input; return { response: VISION_OK }; } } };
  await analyzeImage(env, "eA==", "a pumpkin", "coloring-page");
  assert.match(seen.prompt, /STRICT GATE/);
  assert.match(seen.prompt, /styleMatch MUST be 1/);
  await analyzeImage(env, "eA==", "a pumpkin", "general");
  assert.doesNotMatch(seen.prompt, /STRICT GATE/);
});

/* ---------- evaluateAndLearn (full pipeline) ---------- */

function visionEnv(reply = VISION_OK) {
  return { AI: { run: async () => ({ response: reply }) } };
}

test("evaluateAndLearn stores eval, history, lesson and timeline event", async () => {
  const kv = mockKV();
  const agent = { id: "ag1", name: "مختبِر" };
  const rec = await evaluateAndLearn(visionEnv(), kv, agent, "img-1", "a cozy bakery", "eA==");
  assert.equal(rec.evaluated, true);
  assert.equal(rec.overall, 3.6);

  const stored = await kv.get("imgeval:img-1");
  assert.equal(stored.overall, 3.6);
  assert.equal(stored.prompt, "a cozy bakery");

  const log = await kv.get("imglog:ag1");
  assert.equal(log.length, 1);
  assert.equal(log[0].id, "img-1");
  assert.equal(log[0].overall, 3.6);

  const learned = await kv.get("learned:ag1");
  assert.equal(learned.length, 1);
  assert.equal(learned[0].source, "image-eval");
  assert.equal(learned[0].imageId, "img-1");
  assert.match(learned[0].text, /الخطوط الخارجية/);

  const timeline = await kv.get("learn:ag1");
  assert.ok(timeline.some((e) => e.event === "image-eval" && e.detail.includes("3.6/5")));
  assert.ok(timeline.some((e) => e.event === "lesson"));
});

test("evaluateAndLearn degrades gracefully when vision fails", async () => {
  const kv = mockKV();
  const env = { AI: { run: async () => { throw new Error("model overloaded"); } } };
  const rec = await evaluateAndLearn(env, kv, { id: "ag1" }, "img-2", "x", "eA==");
  assert.equal(rec.evaluated, false);
  const stored = await kv.get("imgeval:img-2");
  assert.equal(stored.evaluated, false);
  // no lesson, no crash
  assert.equal(await kv.get("learned:ag1"), null);
});

test("evaluateAndLearn respects the imageLearn opt-out", async () => {
  const kv = mockKV();
  const rec = await evaluateAndLearn(visionEnv(), kv, { id: "ag1", imageLearn: false }, "img-3", "x", "eA==");
  assert.equal(rec.evaluated, false);
  assert.equal(rec.reason, "disabled");
  assert.equal(await kv.get("imgeval:img-3"), null);
});

test("imglog caps at 30 entries", async () => {
  const kv = mockKV();
  await kv.set("imglog:ag1", Array.from({ length: 30 }, (_, i) => ({ id: `old-${i}`, at: "t", prompt: "p", overall: 4 })));
  await evaluateAndLearn(visionEnv(), kv, { id: "ag1" }, "new-1", "x", "eA==");
  const log = await kv.get("imglog:ag1");
  assert.equal(log.length, 30);
  assert.equal(log[log.length - 1].id, "new-1");
});
