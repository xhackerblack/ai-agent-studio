// Tests for the mandatory auth gate (src/auth.js). Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import {
  createSession, verifySession, sessionCookie,
  loginRateCheck, noteLoginFail, clearLoginFails,
} from "../src/auth.js";
import { __resetUsageForTests } from "../src/usage.js";
import { beforeEach } from "node:test";

beforeEach(() => __resetUsageForTests());

function mockEnv(aiRun, extra = {}) {
  return {
    AI: { run: aiRun || (async () => ({})) },
    APP_PASSWORD: "test-secret",
    STUDIO_KV: {
      _m: new Map(),
      async get(k, t) {
        const v = this._m.get(k);
        if (v === undefined) return null;
        return t === "json" ? JSON.parse(v) : v;
      },
      async put(k, v) { this._m.set(k, typeof v === "string" ? v : JSON.stringify(v)); },
      async delete(k) { this._m.delete(k); },
    },
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    ...extra,
  };
}

function req(env, path, opts = {}, cookie) {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.cookie = cookie;
  return worker.fetch(new Request(`https://x.test${path}`, { ...opts, headers }), env, {});
}

function mockCaches() {
  const m = new Map();
  globalThis.caches = {
    default: {
      async match(r) {
        const v = m.get(r.url);
        return v ? new Response(v) : undefined;
      },
      async put(r, res) { m.set(r.url, await res.text()); },
      async delete(r) { return m.delete(r.url); },
    },
  };
  return () => { delete globalThis.caches; };
}

/* ---------- session tokens ---------- */

test("session sign/verify roundtrip", async () => {
  const tok = await createSession("s3cr3t");
  assert.ok(await verifySession("s3cr3t", `aas_session=${tok}`));
  assert.equal(await verifySession("wrong", `aas_session=${tok}`), false);
});

test("tampered or expired sessions are rejected", async () => {
  const tok = await createSession("s3cr3t");
  const bad = tok.slice(0, -2) + "xx";
  assert.equal(await verifySession("s3cr3t", `aas_session=${bad}`), false);
  const expired = await createSession("s3cr3t", -1);
  assert.equal(await verifySession("s3cr3t", `aas_session=${expired}`), false);
  assert.equal(await verifySession("s3cr3t", ""), false);
});

test("session cookie is HttpOnly + SameSite=Strict", async () => {
  const c = sessionCookie("tok123", true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(sessionCookie("tok123", false), /Secure/);
});

/* ---------- the gate ---------- */

test("no APP_PASSWORD -> every /api path returns 503", async () => {
  const env = mockEnv(null, { APP_PASSWORD: undefined });
  for (const p of ["/api/agents", "/api/usage", "/api/settings"]) {
    const r = await req(env, p);
    assert.equal(r.status, 503, p);
    const b = await r.json();
    assert.equal(b.code, "no-password");
    assert.match(b.hint, /wrangler secret put/);
  }
});

test("config stays public and reports auth state", async () => {
  const env = mockEnv();
  const r = await req(env, "/api/config");
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.auth.required, true);
  assert.equal(b.auth.configured, true);
  const env2 = mockEnv(null, { APP_PASSWORD: undefined });
  const b2 = await (await req(env2, "/api/config")).json();
  assert.equal(b2.auth.configured, false);
});

test("full login flow: 401 -> login -> cookie -> 200 -> logout", async () => {
  const env = mockEnv();
  assert.equal((await req(env, "/api/agents")).status, 401);
  assert.equal((await req(env, "/api/session")).status, 401);

  const bad = await req(env, "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nope" }),
  });
  assert.equal(bad.status, 401);

  const good = await req(env, "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-secret" }),
  });
  assert.equal(good.status, 200);
  const setCookie = good.headers.get("set-cookie");
  assert.match(setCookie, /aas_session=/);
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(";")[0];

  assert.equal((await req(env, "/api/session", {}, cookie)).status, 200);
  assert.equal((await req(env, "/api/agents", {}, cookie)).status, 200);

  const out = await req(env, "/api/logout", { method: "POST" }, cookie);
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
});

test("INTERNAL_TOKEN bypasses the cookie session", async () => {
  const env = mockEnv(null, { INTERNAL_TOKEN: "tok-123" });
  const r = await req(env, "/api/agents", { headers: { "x-internal-token": "tok-123" } });
  assert.equal(r.status, 200);
  const r2 = await req(env, "/api/agents", { headers: { "x-internal-token": "wrong" } });
  assert.equal(r2.status, 401);
});

test("login rate limiting blocks after 5 failures", async () => {
  const restore = mockCaches();
  try {
    const env = mockEnv();
    const badBody = {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
      body: JSON.stringify({ password: "nope" }),
    };
    for (let i = 0; i < 5; i++) {
      assert.equal((await req(env, "/api/login", badBody)).status, 401);
    }
    assert.equal((await req(env, "/api/login", badBody)).status, 429);
    const rl = await loginRateCheck(new Request("https://x.test/", { headers: { "cf-connecting-ip": "1.2.3.4" } }));
    assert.equal(rl.limited, true);
    await clearLoginFails(new Request("https://x.test/", { headers: { "cf-connecting-ip": "1.2.3.4" } }));
    const rl2 = await loginRateCheck(new Request("https://x.test/", { headers: { "cf-connecting-ip": "1.2.3.4" } }));
    assert.equal(rl2.limited, false);
  } finally {
    restore();
  }
});
