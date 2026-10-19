// Mandatory password gate + HMAC-signed session cookies + login rate limiting.
// No password is ever stored client-side: the session cookie is HttpOnly and
// the secret lives only as the APP_PASSWORD worker secret.

const te = new TextEncoder();

function b64url(bytes) {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, te.encode(data)));
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Create a signed session token. Never throws. */
export async function createSession(secret, days = 30) {
  const payload = b64url(te.encode(JSON.stringify({ exp: Date.now() + days * 864e5 })));
  const sig = await hmacSign(secret, payload);
  return `${payload}.${sig}`;
}

/** Verify the aas_session cookie. Returns true only for a valid, unexpired token. */
export async function verifySession(secret, cookieHeader) {
  try {
    const m = /(?:^|;\s*)aas_session=([^;]+)/.exec(String(cookieHeader || ""));
    if (!m) return false;
    const parts = m[1].split(".");
    if (parts.length !== 2) return false;
    const [payload, sig] = parts;
    const expect = await hmacSign(secret, payload);
    if (!safeEqual(sig, expect)) return false;
    const { exp } = JSON.parse(b64urlDecode(payload));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

export function sessionCookie(token, secure) {
  return `aas_session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure) {
  return `aas_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/* ---------------- login rate limiting (Cache API) ---------------- */

const LOGIN_FAIL_LIMIT = 5;
const LOGIN_BLOCK_SECONDS = 900; // 15 min

function rateKey(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return `https://ratelimit.local/login/${encodeURIComponent(ip)}`;
}

/** Returns {limited:boolean}. No-op (never limited) when Cache API is unavailable. */
export async function loginRateCheck(request) {
  try {
    if (typeof caches === "undefined") return { limited: false };
    const hit = await caches.default.match(rateKey(request));
    const fails = hit ? parseInt(await hit.text(), 10) || 0 : 0;
    return { limited: fails >= LOGIN_FAIL_LIMIT, fails };
  } catch {
    return { limited: false };
  }
}

export async function noteLoginFail(request) {
  try {
    if (typeof caches === "undefined") return;
    const key = rateKey(request);
    const hit = await caches.default.match(key);
    const fails = (hit ? parseInt(await hit.text(), 10) || 0 : 0) + 1;
    await caches.default.put(key, new Response(String(fails), {
      headers: { "Cache-Control": `max-age=${LOGIN_BLOCK_SECONDS}` },
    }));
  } catch { /* rate limiting is best-effort */ }
}

export async function clearLoginFails(request) {
  try {
    if (typeof caches === "undefined") return;
    await caches.default.delete(rateKey(request));
  } catch { /* best-effort */ }
}

/* ---------------- the gate ---------------- */

/**
 * Returns {status:"ok"} or {status:"no-secret"} (503) or {status:"unauthorized"} (401).
 * /api/config, /api/login, /api/session, /api/logout stay public so the login
 * screen can boot. /api/images/* keeps its unguessable-UUID exemption.
 * INTERNAL_TOKEN (when set) bypasses the cookie session for cron/internal tasks.
 */
export async function authGate(request, env) {
  const path = new URL(request.url).pathname;
  if (path === "/api/config" && request.method === "GET") return { status: "ok" };
  if (path === "/api/login" && request.method === "POST") return { status: "ok" };
  if (path === "/api/logout") return { status: "ok" };
  if (path === "/api/session" && request.method === "GET") return { status: "ok" };
  if (path.startsWith("/api/images/")) return { status: "ok" };

  const secret = env.APP_PASSWORD;
  if (!secret) return { status: "no-secret" };

  const internal = request.headers.get("x-internal-token") || "";
  if (env.INTERNAL_TOKEN && internal && safeEqual(internal, env.INTERNAL_TOKEN)) {
    return { status: "ok" };
  }
  // Legacy header (old cached PWA) — accepted during the transition.
  const legacy = request.headers.get("x-app-password") || "";
  if (legacy && safeEqual(legacy, secret)) return { status: "ok" };

  if (await verifySession(secret, request.headers.get("cookie"))) return { status: "ok" };
  return { status: "unauthorized" };
}

export function noSecretResponse() {
  return {
    code: "no-password",
    message: "لم يُعرَّف APP_PASSWORD بعد — عرّفه أولاً ثم أعد النشر",
    hint: "wrangler secret put APP_PASSWORD",
  };
}
