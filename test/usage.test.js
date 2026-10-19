// Tests for the quota guard + KV budget (src/usage.js). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import {
  DEFAULT_NEURON_CAP, noteNeurons, noteKvWrite, noteError, recentErrors,
  bumpStatBatched, flushUsage, getUsageState, cheapestChatModel,
  recordImageNeurons, getResearchSettings, __resetUsageForTests,
} from "../src/usage.js";
import { beforeEach } from "node:test";

beforeEach(() => __resetUsageForTests());

function mockKV() {
  const m = new Map();
  return {
    async get(k) { const v = m.get(k); return v === undefined ? null : JSON.parse(v); },
    async set(k, v) { m.set(k, JSON.stringify(v)); },
    async del(k) { m.delete(k); },
  };
}

function mockEnv(aiRun, kvPut) {
  return {
    AI: { run: aiRun || (async () => ({})) },
    APP_PASSWORD: "test-secret",
    INTERNAL_TOKEN: "test-internal",
    STUDIO_KV: {
      _m: new Map(),
      async get(k, t) {
        const v = this._m.get(k);
        if (v === undefined) return null;
        return t === "json" ? JSON.parse(v) : v;
      },
      async put(k, v) {
        if (kvPut === "throw") throw new Error("KV put failed: daily write limit");
        this._m.set(k, typeof v === "string" ? v : JSON.stringify(v));
      },
      async delete(k) { this._m.delete(k); },
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
  };
}

async function api(env, path, opts = {}) {
  const headers = { "x-internal-token": "test-internal", ...(opts.headers || {}) };
  return worker.fetch(new Request(`https://x.test${path}`, { ...opts, headers }), env, {});
}
async function postJson(env, path, body) {
  return api(env, path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* ---------- state & thresholds ---------- */

test("default quota state: 8000 cap, estimated, nothing stopped", async () => {
  const s = await getUsageState(mockKV());
  assert.equal(s.cap, DEFAULT_NEURON_CAP);
  assert.equal(s.used, 0);
  assert.equal(s.estimated, true);
  assert.equal(s.bgStopped, false);
  assert.equal(s.downgraded, false);
  assert.equal(s.kvAlert, false);
});

test("70% stops background work, 100% downgrades", async () => {
  const kv = mockKV();
  const day = `usage:${new Date().toISOString().slice(0, 10)}`;
  await kv.set(day, { neurons: 5600, kvWrites: 10 });
  const s70 = await getUsageState(kv);
  assert.equal(s70.bgStopped, true);
  assert.equal(s70.downgraded, false);
  await kv.set(day, { neurons: 8000, kvWrites: 10 });
  const s100 = await getUsageState(kv);
  assert.equal(s100.bgStopped, true);
  assert.equal(s100.downgraded, true);
});

test("custom cap is honored", async () => {
  const kv = mockKV();
  await kv.set("settings:usage", { cap: 2000 });
  const day = `usage:${new Date().toISOString().slice(0, 10)}`;
  await kv.set(day, { neurons: 2000, kvWrites: 0 });
  const s = await getUsageState(kv);
  assert.equal(s.cap, 2000);
  assert.equal(s.downgraded, true);
});

test("KV write counter alerts at 800/day", async () => {
  const kv = mockKV();
  const day = `usage:${new Date().toISOString().slice(0, 10)}`;
  await kv.set(day, { neurons: 0, kvWrites: 799 });
  assert.equal((await getUsageState(kv)).kvAlert, false);
  noteKvWrite();
  assert.equal((await getUsageState(kv)).kvAlert, true);
});

test("cheapestChatModel picks the 3B model", () => {
  assert.match(cheapestChatModel(), /3b-instruct/);
});

/* ---------- batching ---------- */

test("counters batch in memory and flush to KV", async () => {
  const kv = mockKV();
  noteNeurons(1234);
  noteKvWrite(); noteKvWrite();
  bumpStatBatched("messages", 2);
  await flushUsage(kv);
  const day = `usage:${new Date().toISOString().slice(0, 10)}`;
  const d = await kv.get(day);
  assert.equal(d.neurons, 1234);
  assert.equal(d.kvWrites, 2);
  const statsDay = new Date().toISOString().slice(0, 10);
  assert.equal(await kv.get(`stats:${statsDay}:messages`), 2);
});

test("image neuron estimates are recorded", async () => {
  const kv = mockKV();
  recordImageNeurons("@cf/black-forest-labs/flux-1-schnell");
  await flushUsage(kv);
  const day = `usage:${new Date().toISOString().slice(0, 10)}`;
  assert.ok((await kv.get(day)).neurons >= 400);
});

/* ---------- resilience ---------- */

test("KV put failure is logged and the request continues", async () => {
  const env = mockEnv(null, "throw");
  const res = await postJson(env, "/api/agents", { name: "صامد" });
  assert.equal(res.status, 201); // not a 500 — the request survived
  const errs = recentErrors();
  assert.ok(errs.length > 0);
  assert.match(errs[0].where, /kv\.put/);
});

test("research settings default to enabled / 3h", async () => {
  const rs = await getResearchSettings(mockKV());
  assert.equal(rs.enabled, true);
  assert.equal(rs.everyH, 3);
});

test("settings endpoints roundtrip", async () => {
  const env = mockEnv();
  const get1 = await (await api(env, "/api/settings")).json();
  assert.equal(get1.usageCap, 8000);
  const post = await postJson(env, "/api/settings", { usageCap: 5000, researchEnabled: false, researchEveryH: 12 });
  assert.equal(post.status, 200);
  const get2 = await (await api(env, "/api/settings")).json();
  assert.equal(get2.usageCap, 5000);
  assert.equal(get2.researchEnabled, false);
  assert.equal(get2.researchEveryH, 12);
});

test("usage endpoint exposes state + recent errors", async () => {
  const env = mockEnv();
  noteError("test", new Error("boom"));
  const b = await (await api(env, "/api/usage")).json();
  assert.equal(b.estimated, true);
  assert.ok(Array.isArray(b.errors));
  assert.ok(b.errors.some((e) => e.err.includes("boom")));
});
