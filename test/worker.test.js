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
  assert.equal(listed.agents.length, 1);

  const patched = await api(env, `/api/agents/${agent.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tone: "رسمي" }),
  });
  assert.equal((await patched.json()).agent.tone, "رسمي");

  const del = await api(env, `/api/agents/${agent.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const listed2 = await (await api(env, "/api/agents")).json();
  assert.equal(listed2.agents.length, 0);
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
  assert.equal(mem.memories["العملة المفضلة"], "الدرهم المغربي");

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

function imageEnv() {
  return mockEnv(async (model, args) => {
    assert.ok(String(model).includes("flux") || String(model).includes("dreamshaper"));
    assert.ok(args.prompt && args.prompt.length > 0);
    // FLUX returns base64 JSON
    return { image: Buffer.from("fake-png-bytes").toString("base64") };
  });
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

test("GET /api/images/:bad-id returns 404", async () => {
  const env = imageEnv();
  assert.equal((await api(env, "/api/images/nope")).status, 404);
  assert.equal((await api(env, "/api/images/123")).status, 404);
});
