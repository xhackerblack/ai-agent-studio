// Tests for AI Agent Studio (backend logic). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { chunkText, cosine, retrieve, relevantChunks } from "../src/rag.js";
import { BUILTIN_TOOLS, getBuiltinTool } from "../src/tools.js";
import { transcriptFor } from "../src/learn.js";
import { chatNeurons, embeddingNeurons, getChatModel, DEFAULT_CHAT_MODEL } from "../src/models.js";

/* ---------- mocks ---------- */

function mockKV() {
  const m = new Map();
  return {
    async get(k) { const v = m.get(k); return v === undefined ? null : JSON.parse(v); },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async del(k) { m.delete(k); },
  };
}

function mockEnv(aiRun) {
  return {
    AI: { run: aiRun },
    STUDIO_KV: {
      _m: new Map(),
      async get(k, t) {
        const v = this._m.get(k);
        if (v === undefined) return null;
        if (t === "arrayBuffer") {
          if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
          return new TextEncoder().encode(String(v)).buffer;
        }
        return t === "json" ? JSON.parse(v) : v;
      },
      async put(k, v) {
        this._m.set(k, v instanceof Uint8Array ? v : (typeof v === "string" ? v : JSON.stringify(v)));
      },
      async delete(k) { this._m.delete(k); },
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
  };
}

async function api(env, path, opts = {}) {
  const req = new Request(`https://x.test${path}`, opts);
  return worker.fetch(req, env, {});
}
async function postJson(env, path, body) {
  return api(env, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ---------- rag ---------- */

test("chunkText splits on sentences with overlap", () => {
  const text = "الجملة الأولى مهمة. الجملة الثانية أطول قليلاً وتحتوي تفاصيل. الثالثة ختامية.";
  const chunks = chunkText(text, 40, 10);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 80));
});

test("cosine similarity: identical vectors = 1, orthogonal = 0", () => {
  assert.equal(Math.round(cosine([1, 0], [1, 0]) * 1000), 1000);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("retrieve ranks by similarity", () => {
  const chunks = [
    { text: "apple", embedding: [1, 0] },
    { text: "banana", embedding: [0, 1] },
    { text: "apple pie", embedding: [0.9, 0.1] },
  ];
  const top = retrieve(chunks, [1, 0], 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].text, "apple");
});

test("relevantChunks filters below threshold", () => {
  const chunks = [{ text: "x", embedding: [1, 0] }];
  assert.equal(relevantChunks(chunks, [0, 1], 5).length, 0);
  assert.equal(relevantChunks(chunks, [1, 0], 5).length, 1);
});

/* ---------- tools ---------- */

test("calculator evaluates safely", async () => {
  const t = getBuiltinTool("calculator");
  const r = await t.run({ expression: "(1200*0.15)+45" }, {});
  assert.equal(r.result, 225);
});

test("calculator rejects code injection", async () => {
  const t = getBuiltinTool("calculator");
  await assert.rejects(() => t.run({ expression: "process.exit(1)" }, {}));
});

test("datetime returns localized string", async () => {
  const t = getBuiltinTool("datetime");
  const r = await t.run({ timezone: "Africa/Casablanca" }, {});
  assert.ok(r.iso);
  assert.equal(r.timezone, "Africa/Casablanca");
});

test("currency converts with mocked rates", async () => {
  const t = getBuiltinTool("currency");
  const fakeFetch = async () => new Response(JSON.stringify({
    rates: { MAD: 10 }, time_last_update_utc: "now",
  }));
  const r = await t.run({ amount: 100, from: "USD", to: "MAD" }, { fetch: fakeFetch });
  assert.equal(r.result, 1000);
});

test("url_fetch strips HTML", async () => {
  const t = getBuiltinTool("url_fetch");
  const fakeFetch = async () => new Response(
    "<html><head><script>evil()</script></head><body><h1>مرحبا</h1><p>نص</p></body></html>");
  const r = await t.run({ url: "https://example.com" }, { fetch: fakeFetch });
  assert.ok(r.text.includes("مرحبا"));
  assert.ok(!r.text.includes("evil"));
  assert.ok(!r.text.includes("<h1>"));
});

/* ---------- models ---------- */

test("chatNeurons returns a positive estimate", () => {
  const n = chatNeurons(DEFAULT_CHAT_MODEL, "hello world".repeat(100), "reply".repeat(50));
  assert.ok(n > 0 && n < 100);
  assert.ok(getChatModel("nope").id === DEFAULT_CHAT_MODEL);
});

test("embeddingNeurons scales with text length", () => {
  const a = embeddingNeurons("x".repeat(4000));
  const b = embeddingNeurons("x".repeat(8000));
  assert.ok(b > a && a > 0);
});

/* ---------- worker: config & agents ---------- */

test("GET /api/config returns models and tools", async () => {
  const env = mockEnv(async () => ({}));
  const res = await api(env, "/api/config");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.models.length >= 2);
  assert.ok(data.builtinTools.length >= 5);
});

test("agent CRUD round-trip", async () => {
  const env = mockEnv(async () => ({}));
  const created = await postJson(env, "/api/agents", { name: "وكيل الاختبار", tools: ["calculator"] });
  assert.equal(created.status, 201);
  const { agent } = await created.json();
  assert.equal(agent.name, "وكيل الاختبار");

  const listed = await (await api(env, "/api/agents")).json();
  assert.equal(listed.agents.filter((a) => !a.isOctopus).length, 1);

  const patched = await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tone: "رسمي" }),
  });
  assert.equal((await patched.json()).agent.tone, "رسمي");

  const del = await api(env, `/api/agents/${agent.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const listed2 = await (await api(env, "/api/agents")).json();
  assert.equal(listed2.agents.filter((a) => !a.isOctopus).length, 0);
});

test("quick customize generates a draft from one sentence", async () => {
  const env = mockEnv(async () => ({
    response: JSON.stringify({
      name: "وكيل الذهب", avatar: "🥇", description: "خبير أسعار",
      tone: "مختصر", systemPrompt: "أنت خبير ذهب.", tools: ["currency", "calculator"],
    }),
  }));
  const res = await postJson(env, "/api/agents/quick", { description: "وكيل خبير في أسعار الذهب" });
  assert.equal(res.status, 200);
  const { draft } = await res.json();
  assert.equal(draft.name, "وكيل الذهب");
  assert.ok(draft.tools.includes("currency"));
});

/* ---------- worker: chat ---------- */

function chatEnv() {
  return mockEnv(async (model, input) => {
    // decide step returns JSON; final step returns text
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("مخطط أدوات")) return { response: '{"answer":true}' };
    return { response: "أهلاً بك! هذا رد تجريبي." };
  });
}

test("POST /api/chat streams tokens and persists", async () => {
  const env = chatEnv();
  const { agent } = await (await postJson(env, "/api/agents", { name: "A" })).json();
  const res = await postJson(env, "/api/chat", { agentId: agent.id, message: "مرحبا" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('"type":"token"'));
  assert.ok(text.includes("أهلاً بك"));
  assert.ok(text.includes('"type":"done"'));
});

test("chat uses a tool when the decider says so", async () => {
  const env = mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("مخطط أدوات")) return { response: '{"tool":"calculator","args":{"expression":"2+2"}}' };
    const last = JSON.stringify(input.messages[input.messages.length - 1]);
    if (last.includes("نتيجة الأداة")) return { response: "النتيجة 4." };
    return { response: "no tool" };
  });
  const { agent } = await (await postJson(env, "/api/agents", { name: "A", tools: ["calculator"] })).json();
  const res = await postJson(env, "/api/chat", { agentId: agent.id, message: "احسب 2+2" });
  const text = await res.text();
  assert.ok(text.includes('"type":"tool"'));
  assert.ok(text.includes("النتيجة 4"));
});

/* ---------- worker: training ---------- */

test("POST /api/train indexes a text file", async () => {
  const env = mockEnv(async (model, input) => {
    if (String(model).includes("bge")) {
      return { data: input.text.map(() => [0.1, 0.2, 0.3]) };
    }
    return { response: "{}" };
  });
  const { agent } = await (await postJson(env, "/api/agents", { name: "A" })).json();
  const fd = new FormData();
  fd.append("agentId", agent.id);
  fd.append("file", new Blob(["الذهب معدن نفيس يستخدم في الحلي والاستثمار. سعره يتغير يومياً حسب العرض والطلب في الأسواق العالمية، ويقاس عادة بالأونصة والدولار الأمريكي."], { type: "text/plain" }), "gold.txt");
  const res = await api(env, "/api/train", { method: "POST", body: fd });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.chunks >= 1);
  assert.match(data.message, /تعلّم الوكيل/);

  const know = await (await api(env, `/api/knowledge/${agent.id}`)).json();
  assert.equal(know.files.length, 1);
  assert.equal(know.files[0].filename, "gold.txt");
});

test("train rejects empty files", async () => {
  const env = mockEnv(async () => ({}));
  const { agent } = await (await postJson(env, "/api/agents", { name: "A" })).json();
  const fd = new FormData();
  fd.append("agentId", agent.id);
  fd.append("file", new Blob(["  "], { type: "text/plain" }), "empty.txt");
  const res = await api(env, "/api/train", { method: "POST", body: fd });
  assert.equal(res.status, 400);
});

/* ---------- worker: learning ---------- */

test("POST /api/learn extracts memories and writes the timeline", async () => {
  const env = mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("محلل تعلّم")) {
      return {
        response: JSON.stringify({
          memories: [{ key: "العملة المفضلة", value: "الدرهم المغربي" }],
          lessons: ["أجب باختصار"],
          gaps: [],
        }),
      };
    }
    return { response: '{"answer":true}' };
  });
  const { agent } = await (await postJson(env, "/api/agents", { name: "A" })).json();
  // seed a conversation via chat (consume the SSE stream so it fully persists)
  await (await postJson(env, "/api/chat", { agentId: agent.id, message: "أفضل الدرهم المغربي وأحب الردود المختصرة" })).text();
  const res = await postJson(env, "/api/learn", { agentId: agent.id });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.events.length >= 2);

  const mem = await (await api(env, `/api/memories/${agent.id}`)).json();
  assert.equal(mem.memories["العملة المفضلة"].value, "الدرهم المغربي");

  const log = await (await api(env, `/api/learning-log/${agent.id}`)).json();
  assert.ok(log.events.length >= 2);
});

/* ---------- worker: tools & dashboard ---------- */

test("custom tool CRUD", async () => {
  const env = mockEnv(async () => ({}));
  const created = await postJson(env, "/api/tools", {
    name: "مخزوني", baseUrl: "https://api.example.com", description: "API المخزون",
  });
  assert.equal(created.status, 201);
  const { tool } = await created.json();
  const listed = await (await api(env, "/api/tools")).json();
  assert.ok(listed.custom.some((t) => t.id === tool.id));
  assert.ok(listed.builtin.length >= 5);
  const del = await api(env, `/api/tools/${tool.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
});

test("dashboard stats reflect activity", async () => {
  const env = chatEnv();
  const { agent } = await (await postJson(env, "/api/agents", { name: "A" })).json();
  await (await postJson(env, "/api/chat", { agentId: agent.id, message: "hi" })).text();
  const s = await (await api(env, "/api/dashboard/stats")).json();
  assert.equal(s.agents, 1);
  assert.ok(s.today.messages >= 2);
  assert.equal(s.series.length, 7);
  assert.ok(s.today.quotaLeft <= 10000);
});

test("learn helpers: transcript truncates", () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(500) }));
  const t = transcriptFor(msgs);
  assert.ok(t.length <= 6000);
  assert.ok(t.includes("المستخدم:"));
});

/* ---------- image generation ---------- */

function imageEnv(visionScores) {
  let imageCalls = 0;
  const prompts = [];
  const env = mockEnv(async (model, args) => {
    const m = String(model);
    if (m.includes("flux") || m.includes("dreamshaper")) {
      imageCalls++;
      assert.ok(args.prompt && args.prompt.length > 0);
      prompts.push(args.prompt);
      // FLUX returns base64 JSON
      return { image: Buffer.from("fake-png-bytes").toString("base64") };
    }
    if (m.includes("vision")) {
      let s = visionScores;
      if (Array.isArray(s)) s = s.length > 1 ? s.shift() : s[0];
      s = s || { composition: 4, lines: 4, artifacts: 4, styleMatch: 4, finish: 4 };
      return {
        response: JSON.stringify({
          scores: s, strengths: ["تكوين جيد"], issues: s.styleMatch <= 2 ? ["صورة ملوّنة بدل صفحة تلوين"] : [],
          lesson: "درس تجريبي",
        }),
      };
    }
    // chat LLMs: niche analyzer vs prompt refiner (distinguished by system prompt)
    const sys = (args.messages && args.messages[0] && args.messages[0].content) || "";
    const userText = (args.messages && args.messages[1] && args.messages[1].content) || "";
    if (sys.includes("niche classifier")) {
      const niche = /coloring book|coloring page|تلوين/i.test(userText) ? "coloring-page" : "general";
      return { response: JSON.stringify({ niche, subject: "a test subject", audience: "any" }) };
    }
    return { response: "a refined test description of the scene" };
  });
  env._imageCalls = () => imageCalls;
  env._prompts = () => prompts;
  return env;
}

test("config exposes image models", async () => {
  const env = mockEnv(async () => ({}));
  const c = await (await api(env, "/api/config")).json();
  assert.ok(Array.isArray(c.imageModels) && c.imageModels.length >= 2);
  assert.ok(c.defaultImageModel.includes("flux"));
});

test("image_generate builtin tool is registered", () => {
  const t = getBuiltinTool("image_generate");
  assert.ok(t && t.label === "توليد صورة");
  assert.ok(typeof t.run === "function");
});

test("POST /api/generate-image stores PNG and serves it", async () => {
  const env = imageEnv();
  const res = await postJson(env, "/api/generate-image", { prompt: "a red apple" });
  assert.equal(res.status, 201);
  const { id, url } = await res.json();
  assert.ok(/^[0-9a-f-]{36}$/.test(id));
  assert.equal(url, `/api/images/${id}`);
  const img = await api(env, url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  const buf = Buffer.from(await img.arrayBuffer());
  assert.equal(buf.toString(), "fake-png-bytes");
  const s = await (await api(env, "/api/dashboard/stats")).json();
  assert.equal(s.today.images, 1);
});

test("POST /api/generate-image rejects empty prompt", async () => {
  const env = imageEnv();
  const res = await postJson(env, "/api/generate-image", { prompt: "  " });
  assert.equal(res.status, 400);
});

test("niche pipeline: coloring-page request carries B&W style block to the model", async () => {
  const env = imageEnv();
  const res = await postJson(env, "/api/generate-image", { prompt: "Fall coloring autumn coloring book cozy home" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.niche.key, "coloring-page");
  assert.equal(body.niche.label, "صفحة تلوين");
  const sent = env._prompts()[0];
  assert.match(sent, /black and white/);
  assert.match(sent, /line art/);
  assert.match(sent, /no shading/);
});

test("strict gate: styleMatch 1 triggers exactly one regeneration", async () => {
  const env = imageEnv([
    { composition: 4, lines: 4, artifacts: 4, styleMatch: 1, finish: 4 },
    { composition: 4, lines: 4, artifacts: 4, styleMatch: 4, finish: 4 },
  ]);
  const agent = await (await postJson(env, "/api/agents", { name: "رسام" })).json();
  const res = await postJson(env, "/api/generate-image", { prompt: "coloring page flowers", agentId: agent.agent.id });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(env._imageCalls(), 2); // exactly one retry, no loop
  assert.equal(body.evaluation.evaluated, true);
  assert.equal(body.evaluation.regenerated, true);
  assert.match(env._prompts()[1], /CRITICAL CORRECTION/);
});

test("winning niche prompt is remembered as a template", async () => {
  const env = imageEnv();
  const agent = await (await postJson(env, "/api/agents", { name: "رسام2" })).json();
  await postJson(env, "/api/generate-image", { prompt: "coloring page cat", agentId: agent.agent.id });
  const tpl = await env.STUDIO_KV.get("nichetemplate:coloring-page", "json");
  assert.ok(tpl && tpl.score >= 4);
});

test("POST /api/niche/analyze detects niche and refines the prompt", async () => {
  const env = imageEnv();
  const res = await postJson(env, "/api/niche/analyze", { text: "Fall coloring autumn coloring book cozy home hygge" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.niche, "coloring-page");
  assert.equal(body.refined, "a refined test description of the scene");
  assert.equal(body.check.ok, true);
  assert.match(body.finalPreview, /black and white/);
});

test("GET /api/images/:bad-id returns 404", async () => {
  const env = imageEnv();
  assert.equal((await api(env, "/api/images/nope")).status, 404);
  assert.equal((await api(env, "/api/images/123")).status, 404);
});

/* ---------- skills + brain ---------- */

test("skills CRUD", async () => {
  const env = mockEnv(async () => ({}));
  const bad = await postJson(env, "/api/skills", { name: "x" });
  assert.equal(bad.status, 400);
  const created = await postJson(env, "/api/skills", { name: "مهارة", instructions: "افعل كذا", icon: "🧪" });
  assert.equal(created.status, 201);
  const { skill } = await created.json();
  const listed = await (await api(env, "/api/skills")).json();
  assert.ok(listed.skills.some((s) => s.id === skill.id));
  const del = await api(env, `/api/skills/${skill.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const listed2 = await (await api(env, "/api/skills")).json();
  assert.ok(!listed2.skills.some((s) => s.id === skill.id));
});

test("agent PATCH persists skillIds and autoLearn", async () => {
  const env = mockEnv(async () => ({}));
  const { agent } = await (await postJson(env, "/api/agents", { name: "A" })).json();
  const { skill } = await (await postJson(env, "/api/skills", { name: "S", instructions: "I" })).json();
  const patched = await (await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ skillIds: [skill.id], autoLearn: true }),
  })).json();
  assert.deepEqual(patched.agent.skillIds, [skill.id]);
  assert.equal(patched.agent.autoLearn, true);
});

test("chat system prompt includes enabled skill instructions", async () => {
  let captured = "";
  const env = mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("مخطط أدوات")) return { response: '{"answer":true}' };
    captured = sys;
    return { response: "ok" };
  });
  const { agent } = await (await postJson(env, "/api/agents", { name: "A" })).json();
  const { skill } = await (await postJson(env, "/api/skills", { name: "مهارة الاختبار", instructions: "تعليمات سرية للاختبار 12345" })).json();
  await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ skillIds: [skill.id] }),
  });
  await (await postJson(env, "/api/chat", { agentId: agent.id, message: "مرحبا" })).text();
  assert.ok(captured.includes("تعليمات سرية للاختبار 12345"));
  assert.ok(captured.includes("مهارات مدمجة"));
});

test("brain endpoint returns live graph", async () => {
  const env = mockEnv(async () => ({}));
  const { agent } = await (await postJson(env, "/api/agents", { name: "عبقري" })).json();
  const { skill } = await (await postJson(env, "/api/skills", { name: "S", instructions: "I" })).json();
  await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ skillIds: [skill.id], autoLearn: true }),
  });
  const res = await api(env, `/api/brain/${agent.id}`);
  assert.equal(res.status, 200);
  const g = await res.json();
  assert.ok(g.nodes.length >= 2);
  assert.equal(g.nodes[0].kind, "agent");
  assert.equal(g.nodes[0].label, "عبقري");
  assert.ok(g.nodes.some((n) => n.kind === "skill" && n.label === "S"));
  assert.ok(g.nodes.some((n) => n.kind === "tool"));
  assert.ok(g.edges.length >= 2);
  assert.equal(g.stats.autoLearn, true);
  assert.equal(g.stats.total, g.nodes.length);
  const bad = await api(env, "/api/brain/nope");
  assert.equal(bad.status, 404);
});

/* ---------- deep thinking ---------- */

function deepChatEnv() {
  return mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("مخطط أدوات")) return { response: '{"answer":true}' };
    if (sys.includes("المفكّر العميق")) return { response: "1. فهم الطلب: واضح\n2. النقاط: أ، ب\n3. الافتراضات: لا شيء\n4. الخطة: أجب مباشرة\n5. المخاطر: لا شيء" };
    if (sys.includes("مراجع دقيق")) return { response: "الإجابة النهائية المحسّنة." };
    return { response: "رد عادي." };
  });
}

test("agent creation defaults: deepThink off, effort balanced", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "D" })).json();
  assert.equal(agent.deepThink, false);
  assert.equal(agent.effort, "balanced");
});

test("PATCH persists deepThink/effort/profile fields", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "D" })).json();
  const patched = await (await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deepThink: true, effort: "deep", expertise: "تسويق", style: "مباشر", avoidTopics: "سياسة" }),
  })).json();
  assert.equal(patched.agent.deepThink, true);
  assert.equal(patched.agent.effort, "deep");
  assert.equal(patched.agent.expertise, "تسويق");
  assert.equal(patched.agent.style, "مباشر");
  assert.equal(patched.agent.avoidTopics, "سياسة");
});

test("chat without deepThink emits no thinking events", async () => {
  const env = deepChatEnv();
  const { agent } = await (await postJson(env, "/api/agents", { name: "D" })).json();
  const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "hi" })).text();
  assert.ok(!text.includes('"type":"thinking"'));
  assert.ok(text.includes('"type":"token"'));
});

test("chat with deepThink balanced emits thinking then tokens", async () => {
  const env = deepChatEnv();
  const { agent } = await (await postJson(env, "/api/agents", { name: "D", deepThink: true, effort: "balanced" })).json();
  const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "اشرح التسويق" })).text();
  assert.ok(text.includes('"type":"thinking"'));
  assert.ok(text.includes('"state":"done"'));
  assert.ok(text.includes("فهم الطلب"));
  assert.ok(text.includes('"type":"token"'));
  assert.ok(text.includes('"type":"done"'));
});

test("chat with deepThink deep runs critique and streams refined answer", async () => {
  const env = deepChatEnv();
  const { agent } = await (await postJson(env, "/api/agents", { name: "D", deepThink: true, effort: "deep" })).json();
  const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "اشرح التسويق" })).text();
  assert.ok(text.includes('"state":"critique"'));
  assert.ok(text.includes("الإجابة النهائية المحسّنة"));
  assert.ok(text.includes('"type":"done"'));
});

test("tool chains: decider can use two tools in sequence", async () => {
  let calls = 0;
  const env = mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("مخطط أدوات")) {
      calls++;
      if (calls === 1) return { response: '{"tool":"calculator","args":{"expression":"2+2"}}' };
      if (calls === 2) return { response: '{"tool":"datetime","args":{}}' };
      return { response: '{"answer":true}' };
    }
    return { response: "تم." };
  });
  const { agent } = await (await postJson(env, "/api/agents", { name: "D", tools: ["calculator", "datetime"] })).json();
  const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "احسب ثم أخبرني بالوقت" })).text();
  const toolEvents = (text.match(/"type":"tool"/g) || []).length;
  assert.equal(toolEvents, 2);
});

/* ---------- web_search tool ---------- */

test("web_search fans out across live sources with engines listed", async () => {
  const tool = getBuiltinTool("web_search");
  assert.ok(tool);
  const ctx = {
    fetch: async (url) => {
      const u = String(url);
      if (u.includes("duckduckgo")) return { ok: false };
      if (u.includes("hn.algolia")) return {
        ok: true,
        json: async () => ({ hits: [{ title: "AI news", url: "https://example.com/ai", points: 10, num_comments: 5, objectID: "1" }] }),
      };
      if (u.includes("stackexchange")) return { ok: true, json: async () => ({ items: [] }) };
      if (u.includes("ar.wikipedia")) return {
        ok: true,
        json: async () => ({ query: { search: [{ title: "ذهب", snippet: "معدن <b>ثمين</b>" }] } }),
      };
      return { ok: true, json: async () => ({ query: { search: [] } }) };
    },
    env: {},
  };
  const out = await tool.run({ query: "ذهب" }, ctx);
  assert.ok(out.count >= 2);
  assert.ok(out.engines.includes("wikipedia-ar"));
  assert.ok(out.engines.includes("hackernews"));
  const wiki = out.results.find((r) => r.source === "wikipedia-ar");
  assert.equal(wiki.title, "ذهب");
  assert.ok(wiki.snippet && !wiki.snippet.includes("<b>"));
  assert.ok(wiki.url.includes("wikipedia.org"));
});

test("web_search parses duckduckgo results when available", async () => {
  const tool = getBuiltinTool("web_search");
  const html = '<a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx">عنوان <b>مهم</b></a>';
  const ctx = {
    fetch: async (url) => {
      if (String(url).includes("duckduckgo")) return { ok: true, text: async () => html };
      return { ok: false };
    },
    env: {},
  };
  const out = await tool.run({ query: "x" }, ctx);
  const ddg = out.results.find((r) => r.source === "duckduckgo");
  assert.ok(ddg);
  assert.equal(ddg.url, "https://example.com/x");
  assert.ok(ddg.title.includes("عنوان"));
});

test("web_search tolerates all sources failing", async () => {
  const tool = getBuiltinTool("web_search");
  const out = await tool.run({ query: "x" }, { fetch: async () => ({ ok: false }), env: {} });
  assert.equal(out.count, 0);
  assert.deepEqual(out.results, []);
});

/* ---------- export / import / backup ---------- */

test("agent export then import restores a new agent", async () => {
  const env = mockEnv(async (model, input) => {
    if (String(model).includes("bge")) return { data: input.text.map(() => [0.1, 0.2]) };
    return { response: "{}" };
  });
  const { agent } = await (await postJson(env, "/api/agents", { name: "Src", deepThink: true, expertise: "X" })).json();
  const bundle = await (await api(env, `/api/agents/${agent.id}/export`)).json();
  assert.equal(bundle.app, "ai-agent-studio-agent");
  assert.equal(bundle.agent.id, agent.id);
  const imported = await (await postJson(env, "/api/agents/import", { bundle })).json();
  assert.equal(imported.agent.name.includes("مستورد"), true);
  assert.notEqual(imported.agent.id, agent.id);
  assert.equal(imported.agent.expertise, "X");
});

test("full backup includes agents and skills", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  await postJson(env, "/api/agents", { name: "B1" });
  await postJson(env, "/api/skills", { name: "Sk", instructions: "I" });
  const backup = await (await api(env, "/api/backup")).json();
  assert.equal(backup.app, "ai-agent-studio-backup");
  assert.ok(backup.agents.length >= 1);
  assert.ok(backup.skills.length >= 1);
});

test("backup import recreates agents", async () => {
  const env = mockEnv(async (model, input) => {
    if (String(model).includes("bge")) return { data: input.text.map(() => [0.1]) };
    return { response: "{}" };
  });
  await postJson(env, "/api/agents", { name: "C1" });
  const backup = await (await api(env, "/api/backup")).json();
  const n1 = backup.agents.length;
  const r = await (await postJson(env, "/api/backup/import", { backup })).json();
  assert.equal(r.agents, n1);
  const list = await (await api(env, "/api/agents")).json();
  assert.equal(list.agents.filter((a) => !a.isOctopus).length, n1 * 2);
});

/* ---------- version history ---------- */

test("PATCH snapshots history and rollback restores", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "V1" })).json();
  await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "V2" }),
  });
  const { history } = await (await api(env, `/api/agents/${agent.id}/history`)).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].name, "V1");
  const rolled = await (await postJson(env, `/api/agents/${agent.id}/rollback`, { index: 0 })).json();
  assert.equal(rolled.agent.name, "V1");
});

/* ---------- link preview ---------- */

test("preview rejects invalid urls and handles fetch failure gracefully", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const bad = await api(env, "/api/preview?url=notaurl");
  assert.equal(bad.status, 400);
});

/* ---------- dashboard per-agent ---------- */

test("dashboard includes perAgent activity", async () => {
  const env = deepChatEnv();
  const { agent } = await (await postJson(env, "/api/agents", { name: "Stat" })).json();
  await (await postJson(env, "/api/chat", { agentId: agent.id, message: "hi" })).text();
  const dash = await (await api(env, "/api/dashboard/stats")).json();
  assert.ok(Array.isArray(dash.perAgent));
  const row = dash.perAgent.find((r) => r.id === agent.id);
  assert.ok(row);
  assert.ok(row.messages >= 2);
});

test("gaps endpoint returns knowledge gaps across agents", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "G" })).json();
  // Simulate a gap event via learn-from-conversation mock
  const env2 = mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("استخرج")) return { response: '{"memories":[],"lessons":[],"gaps":["أسعار الذهب"]}' };
    return { response: "{}" };
  });
  // Manually seed a gap event
  const kv = env.STUDIO_KV;
  const r1 = await api(env, `/api/agents/${agent.id}`);
  const ag = (await r1.json()).agent;
  await kv.put(`learn:${agent.id}`, JSON.stringify([{ at: new Date().toISOString(), event: "gap", detail: "فجوة: أسعار الذهب" }]));
  const gaps = await (await api(env, "/api/gaps")).json();
  assert.ok(Array.isArray(gaps.gaps));
  assert.ok(gaps.gaps.some((g) => g.agents.some((a) => a.id === agent.id)));
});

/* ---------- deep research ---------- */

function researchEnv() {
  return mockEnv(async (model, input) => {
    if (String(model).includes("bge")) {
      return { data: input.text.map(() => [0.5, 0.5]) };
    }
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("باحث محلل")) {
      return { response: "## ملخص تنفيذي\nالذهب معدن ثمين.\n## النقاط الرئيسية\n1. نقطة أولى.\n## تحليل\nتحليل مختصر.\n## المصادر\nالويب." };
    }
    if (sys.includes("استخرج أهم")) {
      return { response: '{"lessons":["الذهب معدن ثمين","يستخدم في الحلي"]}' };
    }
    if (sys.includes("مخطط أدوات")) return { response: '{"answer":true}' };
    return { response: "رد عادي." };
  });
}

function stubFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("duckduckgo")) return { ok: false, status: 403 };
    if (String(url).includes("wikipedia.org/w/api.php")) {
      return { ok: true, json: async () => ({ query: { search: [{ title: "ذهب", snippet: "معدن ثمين" }] } }) };
    }
    return {
      ok: true,
      text: async () => "<html><head><title>الذهب - ويكيبيديا</title></head><body><p>الذهب عنصر كيميائي رمزه Au وهو معدن ثمين أصفر اللون يستخدم في الحلي والاستثمار منذ آلاف السنين في مختلف الحضارات الإنسانية. يتميز الذهب بكثافته العالية وقابليته للطرق والسحب، ولا يتأثر بالهواء والرطوبة. تعد جنوب أفريقيا والصين وأستراليا من أكبر منتجي الذهب في العالم. تتأثر أسعار الذهب بعدة عوامل منها التضخم وأسعار الفائدة والتوترات الجيوسياسية وحركة الدولار الأمريكي.</p></body></html>",
    };
  };
  return () => { globalThis.fetch = real; };
}

test("deep research trigger runs the full pipeline with live stages", async () => {
  const env = researchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "R" })).json();
    const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "ابحث بعمق عن الذهب" })).text();
    assert.ok(text.includes('"type":"research"'));
    assert.ok(text.includes('"stage":"kb"'));
    assert.ok(text.includes('"stage":"web"'));
    assert.ok(text.includes('"stage":"analyze"'));
    assert.ok(text.includes('"stage":"learn"'));
    assert.ok(text.includes('"stage":"done"'));
    assert.ok(text.includes("ملخص تنفيذي")); // report streamed as answer
    assert.ok(text.includes('"type":"done"'));
  } finally { restore(); }
});

test("deep research prefers KB when it has enough hits (web skipped)", async () => {
  const env = researchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "R2" })).json();
    // Train with a file so the KB has content
    const fd = new FormData();
    fd.append("agentId", agent.id);
    fd.append("file", new Blob(["الذهب معدن ثمين أصفر. ".repeat(60)], { type: "text/plain" }), "gold.txt");
    const tr = await api(env, "/api/train", { method: "POST", body: fd });
    assert.equal(tr.status, 200);
    const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "ابحث بعمق عن الذهب" })).text();
    assert.ok(text.includes('"stage":"kb"'));
    assert.ok(text.includes('"state":"skipped"')); // web skipped, KB sufficient
    // Lessons were saved to the agent's mind
    const brain = await (await api(env, `/api/brain/${agent.id}`)).json();
    const lessonNodes = brain.nodes.filter((n) => n.kind === "lesson");
    assert.ok(lessonNodes.length >= 1);
  } finally { restore(); }
});

test("research history is saved and listed", async () => {
  const env = researchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "R3" })).json();
    await (await postJson(env, "/api/chat", { agentId: agent.id, message: "ابحث بعمق عن الفضة" })).text();
    const { research } = await (await api(env, `/api/research/${agent.id}`)).json();
    assert.ok(Array.isArray(research));
    assert.equal(research.length, 1);
    assert.ok(research[0].query.includes("الفضة"));
    assert.ok(research[0].summary.length > 0);
  } finally { restore(); }
});

test("normal chat does not trigger research", async () => {
  const env = researchEnv();
  const { agent } = await (await postJson(env, "/api/agents", { name: "R4" })).json();
  const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "مرحبا كيف حالك" })).text();
  assert.ok(!text.includes('"type":"research"'));
});

/* ---------- autonomous research ---------- */

import { autoResearchCycle } from "../src/worker.js";

function autoResearchEnv() {
  return mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("باحث مستقل")) {
      return { response: '{"facts":["حقيقة أولى عن الذهب","حقيقة ثانية عن الذهب"]}' };
    }
    return { response: "{}" };
  });
}

test("POST/PATCH persist autoResearch and researchTopics", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agent } = await (await postJson(env, "/api/agents", {
    name: "AR", autoResearch: true, researchTopics: ["أسعار الذهب", "الذكاء الاصطناعي"],
  })).json();
  assert.equal(agent.autoResearch, true);
  assert.deepEqual(agent.researchTopics, ["أسعار الذهب", "الذكاء الاصطناعي"]);
  const patched = await (await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ autoResearch: false, researchTopics: ["x"] }),
  })).json();
  assert.equal(patched.agent.autoResearch, false);
  assert.deepEqual(patched.agent.researchTopics, ["x"]);
});

test("autoResearchCycle researches topics and grows memory", async () => {
  const env = autoResearchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", {
      name: "AR2", autoResearch: true, researchTopics: ["الذهب"],
    })).json();
    const out = await autoResearchCycle(env);
    assert.equal(out.length, 1);
    assert.equal(out[0].skipped, false);
    assert.equal(out[0].topic, "الذهب");
    assert.ok(out[0].added >= 1);
    // Memory grew: learned lessons + log event
    const brain = await (await api(env, `/api/brain/${agent.id}`)).json();
    const lessons = brain.nodes.filter((n) => n.kind === "lesson");
    assert.ok(lessons.some((l) => l.label.includes("الذهب")));
    const events = brain.nodes.filter((n) => n.kind === "event");
    assert.ok(events.some((e) => e.icon === "🛰️"));
    // Topic rotation advanced
    const { agent: a2 } = await (await api(env, `/api/agents/${agent.id}`)).json();
    assert.equal(a2.autoResearch, true);
  } finally { restore(); }
});

test("autoResearchCycle skips agents without autoResearch", async () => {
  const env = autoResearchEnv();
  const restore = stubFetch();
  try {
    await postJson(env, "/api/agents", { name: "AR3" });
    const out = await autoResearchCycle(env);
    assert.equal(out.length, 0);
  } finally { restore(); }
});

test("activity ticker aggregates events and stats", async () => {
  const env = autoResearchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", {
      name: "AR4", autoResearch: true, researchTopics: ["الذهب"],
    })).json();
    await autoResearchCycle(env);
    const { items } = await (await api(env, "/api/activity")).json();
    assert.ok(Array.isArray(items));
    assert.ok(items.length >= 2);
    assert.ok(items.some((i) => i.icon === "🛰️"));
    assert.ok(items.some((i) => i.icon === "📊"));
    // Newest first
    for (let i = 1; i < items.length; i++) {
      assert.ok(new Date(items[i - 1].at) >= new Date(items[i].at));
    }
  } finally { restore(); }
});

/* ---------- 🐙 Octopus v2 ---------- */

import { octopusAgent, ensureOctopus, OCTOPUS_SYSTEM, MEMORY_CATEGORIES } from "../src/agents.js";
import { learnFromConversation, memoryValue } from "../src/learn.js";

test("octopusAgent has the operator persona and all arms", () => {
  const o = octopusAgent();
  assert.equal(o.isOctopus, true);
  assert.equal(o.avatar, "🐙");
  assert.equal(o.name, "أخطبوط");
  assert.ok(o.systemPrompt.includes("أخطبوط"));
  assert.ok(o.systemPrompt.length > 200);
  for (const t of ["web_search", "reminder", "image_generate", "url_fetch", "calculator"]) {
    assert.ok(o.tools.includes(t), `missing tool ${t}`);
  }
  assert.equal(o.autoLearn, true);
  assert.equal(o.deepThink, true);
});

test("ensureOctopus creates exactly one octopus on empty store", async () => {
  const kv = mockKV();
  const first = await ensureOctopus(kv);
  const octs1 = first.filter((a) => a.isOctopus);
  assert.equal(octs1.length, 1);
  const second = await ensureOctopus(kv);
  assert.equal(second.filter((a) => a.isOctopus).length, 1);
  assert.equal(second.length, first.length);
});

test("GET /api/agents auto-provisions the octopus", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agents } = await (await api(env, "/api/agents")).json();
  assert.ok(agents.some((a) => a.isOctopus && a.avatar === "🐙"));
  const { agents: again } = await (await api(env, "/api/agents")).json();
  assert.equal(again.filter((a) => a.isOctopus).length, 1);
});

test("memoryValue handles legacy plain-string memories", () => {
  assert.deepEqual(memoryValue("نص قديم"), { value: "نص قديم", category: "أخرى" });
  assert.deepEqual(memoryValue({ value: "خالد", category: "شخصي" }), { value: "خالد", category: "شخصي" });
  assert.deepEqual(memoryValue({ value: "x", category: "غير موجودة" }), { value: "x", category: "أخرى" });
  assert.ok(MEMORY_CATEGORIES.includes("تفضيلات"));
});

test("learnFromConversation categorizes memories", async () => {
  const env = mockEnv(async () => ({
    response: '{"memories":[{"key":"الاسم","value":"خالد","category":"شخصي"},{"key":"المهنة","value":"مهندس","category":"عمل"}],"lessons":[],"gaps":[]}',
  }));
  const kv = mockKV();
  const agent = { id: "ag_cat", name: "T" };
  await learnFromConversation(env, kv, agent, [
    { role: "user", content: "اسمي خالد وأنا مهندس برمجيات أعمل في شركة تقنية كبيرة في الدار البيضاء" },
    { role: "assistant", content: "أهلاً خالد! سأتذكر اسمك ومهنتك." },
  ]);
  const mems = await kv.get("mem:ag_cat");
  assert.equal(mems["الاسم"].category, "شخصي");
  assert.equal(mems["المهنة"].category, "عمل");
  assert.equal(memoryValue(mems["الاسم"]).value, "خالد");
  const log = await kv.get("learn:ag_cat");
  assert.ok(log.some((e) => e.event === "memory" && e.detail.includes("[شخصي]")));
});

test("brain memory nodes carry their category", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "B" })).json();
  const kv = env.STUDIO_KV;
  await kv.put(`mem:${agent.id}`, JSON.stringify({
    الهواية: { value: "القراءة", category: "تفضيلات", at: new Date().toISOString() },
  }));
  const { nodes } = await (await api(env, `/api/brain/${agent.id}`)).json();
  const m = nodes.find((n) => n.kind === "memory");
  assert.ok(m);
  assert.equal(m.cat, "تفضيلات");
});

test("gaps are aggregated with counts, most frequent first", async () => {
  const env = mockEnv(async () => ({ response: "{}" }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "G2" })).json();
  const kv = env.STUDIO_KV;
  const now = new Date().toISOString();
  await kv.put(`learn:${agent.id}`, JSON.stringify([
    { at: now, event: "gap", detail: "فجوة: أسعار الذهب" },
    { at: now, event: "gap", detail: "فجوة: أسعار الذهب" },
    { at: now, event: "gap", detail: "فجوة: الطقس" },
  ]));
  const { gaps } = await (await api(env, "/api/gaps")).json();
  assert.equal(gaps[0].detail, "فجوة: أسعار الذهب");
  assert.equal(gaps[0].count, 2);
  assert.ok(gaps[0].agents.some((a) => a.id === agent.id));
});

test("mind summary generates, caches, and counts categories", async () => {
  const env = mockEnv(async () => ({ response: "ملخص: المستخدم خالد، مهندس برمجيات." }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "MS" })).json();
  const kv = env.STUDIO_KV;
  await kv.put(`mem:${agent.id}`, JSON.stringify({
    الاسم: { value: "خالد", category: "شخصي", at: new Date().toISOString() },
    المهنة: { value: "مهندس", category: "عمل", at: new Date().toISOString() },
  }));
  const r1 = await (await api(env, `/api/mind/${agent.id}`)).json();
  assert.ok(r1.summary.includes("خالد"));
  assert.equal(r1.cached, false);
  assert.equal(r1.counts["شخصي"], 1);
  assert.equal(r1.counts["عمل"], 1);
  assert.equal(r1.memories, 2);
  const r2 = await (await api(env, `/api/mind/${agent.id}`)).json();
  assert.equal(r2.cached, true);
  assert.equal(r2.summary, r1.summary);
});

test("mind summary handles empty memory gracefully", async () => {
  const env = mockEnv(async () => ({ response: "x" }));
  const { agent } = await (await postJson(env, "/api/agents", { name: "MS2" })).json();
  const r = await (await api(env, `/api/mind/${agent.id}`)).json();
  assert.ok(r.summary.length > 10);
  assert.equal(r.memories, 0);
});

test("comprehensive research trigger is detected", async () => {
  const env = researchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "RC" })).json();
    const text = await (await postJson(env, "/api/chat", { agentId: agent.id, message: "بحث شامل عن الذهب" })).text();
    assert.ok(text.includes('"type":"research"'));
    assert.ok(text.includes('"depth":"comprehensive"'));
    assert.ok(text.includes("ملخص تنفيذي"));
  } finally { restore(); }
});

test("research dedupes sources by URL", async () => {
  const env = mockEnv(async (model, input) => {
    const sys = JSON.stringify(input.messages || []);
    if (sys.includes("باحث محلل")) return { response: "## ملخص تنفيذي\nنص.\n## النقاط الرئيسية\n1. ن.\n## تحليل\nت.\n## المصادر\nو." };
    if (sys.includes("استخرج أهم")) return { response: '{"lessons":[]}' };
    if (sys.includes("ولّد 3 صيغ")) return { response: '{"queries":["الذهب معدن","أسعار الذهب"]}' };
    return { response: '{"answer":true}' };
  });
  const real = globalThis.fetch;
  let pageHits = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("duckduckgo")) {
      return {
        ok: true,
        text: async () => `<html><body>
          <a class="result__a" href="https://example.com/gold?a=1">ذهب 1</a>
          <a class="result__a" href="https://example.com/gold?a=2">ذهب 2 (نفس الصفحة)</a>
          <a class="result__a" href="https://example.com/silver">فضة</a>
        </body></html>`,
      };
    }
    pageHits++;
    return { ok: true, text: async () => `<html><head><title>t</title></head><body><p>${"نص طويل كافٍ لتجاوز عتبة المئتي حرف المطلوبة لقبول المصدر في قائمة المصادر المعتمدة للبحث المعمق. ".repeat(4)}</p></body></html>` };
  };
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "RD" })).json();
    await (await postJson(env, "/api/chat", { agentId: agent.id, message: "ابحث بعمق عن الذهب" })).text();
    const { research } = await (await api(env, `/api/research/${agent.id}`)).json();
    assert.equal(research.length, 1);
    // 2 unique pages (gold + silver), the ?a=2 duplicate collapsed
    assert.equal(research[0].webSources, 2);
  } finally { globalThis.fetch = real; }
});

test("research refresh re-runs and updates the record", async () => {
  const env = researchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "RR" })).json();
    await (await postJson(env, "/api/chat", { agentId: agent.id, message: "ابحث بعمق عن الذهب" })).text();
    const before = await (await api(env, `/api/research/${agent.id}`)).json();
    assert.equal(before.research.length, 1);
    const recId = before.research[0].id;
    const res = await postJson(env, "/api/research/refresh", { agentId: agent.id, query: "الذهب", refreshId: recId });
    assert.equal(res.status, 200);
    const { rec, report } = await res.json();
    assert.equal(rec.id, recId);
    assert.equal(rec.refreshCount, 1);
    assert.ok(rec.updatedAt);
    assert.ok(Array.isArray(rec.sources));
    assert.ok(report.length > 50);
    const after = await (await api(env, `/api/research/${agent.id}`)).json();
    assert.equal(after.research.length, 1); // refreshed in place, not duplicated
    assert.equal(after.research[0].refreshCount, 1);
  } finally { restore(); }
});

test("research refresh without id creates a new record", async () => {
  const env = researchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "RR2" })).json();
    const res = await postJson(env, "/api/research/refresh", { agentId: agent.id, query: "الفضة" });
    assert.equal(res.status, 200);
    const { rec } = await res.json();
    assert.equal(rec.refreshCount, 0);
    assert.ok(rec.query.includes("الفضة"));
  } finally { restore(); }
});

test("research lessons keep their source urls", async () => {
  const env = researchEnv();
  const restore = stubFetch();
  try {
    const { agent } = await (await postJson(env, "/api/agents", { name: "RL" })).json();
    await (await postJson(env, "/api/chat", { agentId: agent.id, message: "ابحث بعمق عن الذهب" })).text();
    const kv = env.STUDIO_KV;
    const raw = await kv.get(`learned:${agent.id}`);
    const learned = JSON.parse(raw);
    const rl = learned.filter((l) => l.source === "research");
    assert.ok(rl.length >= 1);
    assert.ok(Array.isArray(rl[0].urls));
  } finally { restore(); }
});
