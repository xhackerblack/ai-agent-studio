// Tests for niche intelligence (src/niche.js). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import {
  NICHES, getNiche, nicheKeyOf, detectNicheHeuristic, heuristicSubject,
  analyzeNiche, refinePrompt, buildFinalPrompt, preflightCheck, fixPrompt,
  extractStyleDNA,
} from "../src/niche.js";

/* ---------- heuristic detection ---------- */

test("detectNicheHeuristic classifies the main niches", () => {
  assert.equal(detectNicheHeuristic("Fall coloring autumn coloring book cozy home"), "coloring-page");
  assert.equal(detectNicheHeuristic("صفحة تلوين خريفية"), "coloring-page");
  assert.equal(detectNicheHeuristic("coloring book cover, cute animals"), "coloring-cover");
  assert.equal(detectNicheHeuristic("غلاف كتاب تلوين"), "coloring-cover");
  assert.equal(detectNicheHeuristic("kawaii chibi girl"), "kawaii");
  assert.equal(detectNicheHeuristic("تشيبي لطيفة"), "kawaii");
  assert.equal(detectNicheHeuristic("a sunset over mountains"), "general");
  assert.equal(detectNicheHeuristic(""), "general");
});

test("heuristicSubject strips niche/format keywords", () => {
  assert.equal(heuristicSubject("Fall coloring autumn coloring book cozy home"), "Fall autumn cozy home");
  assert.equal(heuristicSubject("صفحة تلوين خريفية دافئة"), "خريفية دافئة");
  assert.equal(heuristicSubject("coloring book"), "a cozy scene");
});

test("getNiche falls back to general for unknown keys", () => {
  assert.equal(getNiche("nope").label, "عام");
  assert.equal(nicheKeyOf("nope"), "general");
  assert.equal(nicheKeyOf("coloring-page"), "coloring-page");
  assert.ok(NICHES["coloring-page"].styleBlock.includes("black and white"));
});

/* ---------- prompt building ---------- */

test("buildFinalPrompt attaches the niche style block", () => {
  const p = buildFinalPrompt({ refined: "a cozy autumn room", nicheKey: "coloring-page" });
  assert.match(p, /a cozy autumn room/);
  assert.match(p, /black and white coloring book page/);
  assert.match(p, /pure line art/);
});

test("buildFinalPrompt injects lessons and template", () => {
  const p = buildFinalPrompt({
    refined: "x", nicheKey: "general", lessons: ["درس1"], template: "قالب ناجح",
  });
  assert.match(p, /درس1/);
  assert.match(p, /قالب ناجح/);
});

/* ---------- pre-flight ---------- */

test("preflightCheck passes a compliant coloring-page prompt", () => {
  const p = buildFinalPrompt({ refined: "a pumpkin", nicheKey: "coloring-page" });
  const c = preflightCheck(p, "coloring-page");
  assert.equal(c.ok, true);
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.avoidedHit, []);
});

test("preflightCheck flags forbidden color phrases but not 'no color'", () => {
  const bad = "black and white coloring book page, line art, a full-color illustration of leaves";
  const c = preflightCheck(bad, "coloring-page");
  assert.equal(c.ok, false);
  assert.ok(c.avoidedHit.includes("full-color"));
  // "no color" must NOT false-positive
  const ok2 = preflightCheck("black and white, line art, absolutely no color, no shading", "coloring-page");
  assert.equal(ok2.ok, true);
});

test("fixPrompt repairs a failing pre-flight (neutralizes color phrases)", () => {
  const p = "a cozy autumn room, full-color illustration";
  const check = preflightCheck(p, "coloring-page");
  assert.equal(check.ok, false);
  assert.ok(check.avoidedHit.includes("full-color"));
  const fixed = fixPrompt(p, "coloring-page", check);
  const check2 = preflightCheck(fixed, "coloring-page");
  assert.deepEqual(check2.missing, []); // style constraints now enforced
  assert.match(fixed, /CRITICAL STYLE RULE/); // violating phrase explicitly neutralized
});

/* ---------- LLM-backed (mocked) ---------- */

function llmEnv(reply) {
  return { AI: { run: async () => ({ response: reply }) } };
}

test("analyzeNiche parses LLM JSON, falls back to heuristic", async () => {
  const a = await analyzeNiche(llmEnv(JSON.stringify({ niche: "kawaii", subject: "a cute cat", audience: "kids" })), "قطة");
  assert.equal(a.key, "kawaii");
  assert.equal(a.subject, "a cute cat");
  const b = await analyzeNiche(llmEnv("garbage {{{"), "صفحة تلوين ورود");
  assert.equal(b.key, "coloring-page");
  const c = await analyzeNiche({ AI: { run: async () => { throw new Error("down"); } } }, "coloring page flowers");
  assert.equal(c.key, "coloring-page");
});

test("refinePrompt returns the LLM description, heuristic on failure", async () => {
  const r = await refinePrompt(llmEnv("a cozy autumn living room with pumpkins"), "x", "coloring-page");
  assert.equal(r, "a cozy autumn living room with pumpkins");
  const h = await refinePrompt({ AI: { run: async () => { throw new Error("x"); } } }, "Fall coloring book cozy", "coloring-page");
  assert.equal(h, "Fall cozy");
});

test("extractStyleDNA parses research into lessons", async () => {
  const dna = await extractStyleDNA(
    llmEnv(JSON.stringify({ elements: ["pumpkins"], lineNotes: "bold", compositionNotes: "full", avoid: ["gray"], lesson: "املأ الفراغات" })),
    "coloring-page", "autumn", ["snippet one", "snippet two"]
  );
  assert.deepEqual(dna.elements, ["pumpkins"]);
  assert.equal(dna.lesson, "املأ الفراغات");
  const empty = await extractStyleDNA(llmEnv("{}"), "general", "x", []);
  assert.equal(empty.lesson, "");
});
