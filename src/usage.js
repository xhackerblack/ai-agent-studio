// Quota guard + KV write budget for the free tier.
// Philosophy: counters are batched in memory and flushed periodically —
// approximate accuracy is accepted in exchange for far fewer KV writes.
// KV put failures are caught, logged, and never crash a request.

import { chatNeurons, CHAT_MODELS } from "./models.js";

export const DEFAULT_NEURON_CAP = 8000;
export const KV_WRITE_DAILY_LIMIT = 1000;
export const KV_WRITE_ALERT_AT = 800;

/** Rough per-generation neuron estimates (marked "estimated" in the UI). */
export const IMAGE_NEURONS_EST = {
  "@cf/black-forest-labs/flux-1-schnell": 500,
  "@cf/lykon/dreamshaper-8-lcm": 400,
};
export const VISION_NEURONS_EST = 200;

// Per-isolate in-memory batch (approximate by design).
const mem = { neurons: 0, kvWrites: 0, lastFlush: 0 };
const statBatch = {};
const errRing = [];
let flushingKv = false;

export function noteNeurons(n) {
  mem.neurons += Math.max(0, Math.round(n || 0));
}
export function noteKvWrite() {
  if (!flushingKv) mem.kvWrites += 1;
}
export function bumpStatBatched(key, by = 1) {
  statBatch[key] = (statBatch[key] || 0) + by;
}
export function noteError(where, err) {
  errRing.unshift({ at: new Date().toISOString(), where: String(where).slice(0, 80), err: String((err && (err.message || err.error)) || err || "unknown").slice(0, 200) });
  if (errRing.length > 20) errRing.length = 20;
}
export function recentErrors() {
  return errRing.slice();
}

const dayKey = () => `usage:${new Date().toISOString().slice(0, 10)}`;
const FLUSH_MIN_MS = 60000;
const FLUSH_MIN_UNITS = 200;

/** Flush batched counters + stats to KV. Safe to call often; writes at most ~1/min.
 *  force:true bypasses the time gate (used by tests); it does not move lastFlush. */
export async function flushUsage(kvH, force = false) {
  const now = Date.now();
  const statKeys = Object.keys(statBatch);
  const hasWork = mem.neurons > 0 || mem.kvWrites > 0 || statKeys.length > 0;
  if (!hasWork) return;
  if (!force) {
    if (now - mem.lastFlush < FLUSH_MIN_MS && mem.neurons + mem.kvWrites < FLUSH_MIN_UNITS && statKeys.length < 5) return;
    mem.lastFlush = now;
  }
  const n = mem.neurons, w = mem.kvWrites;
  mem.neurons = 0; mem.kvWrites = 0;
  const stats = {};
  for (const k of statKeys) { stats[k] = statBatch[k]; delete statBatch[k]; }
  flushingKv = true;
  try {
    const cur = (await kvH.get(dayKey()).catch(() => null)) || { neurons: 0, kvWrites: 0 };
    cur.neurons = (cur.neurons || 0) + n;
    cur.kvWrites = (cur.kvWrites || 0) + w;
    await kvH.set(dayKey(), cur);
    for (const [k, by] of Object.entries(stats)) {
      const sk = `stats:${new Date().toISOString().slice(0, 10)}:${k}`;
      const v = (await kvH.get(sk).catch(() => null)) || 0;
      await kvH.set(sk, v + by);
    }
  } catch (e) {
    noteError("flushUsage", e);
    mem.neurons += n; mem.kvWrites += w; // re-queue (approximate)
    for (const [k, by] of Object.entries(stats)) statBatch[k] = (statBatch[k] || 0) + by;
  } finally {
    flushingKv = false;
  }
}

/** Current quota state. `estimated:true` — neuron numbers are estimates. */
export async function getUsageState(kvH) {
  const day = (await kvH.get(dayKey()).catch(() => null)) || { neurons: 0, kvWrites: 0 };
  const settings = (await kvH.get("settings:usage").catch(() => null)) || {};
  const cap = Number(settings.cap) > 0 ? Number(settings.cap) : DEFAULT_NEURON_CAP;
  const used = (day.neurons || 0) + mem.neurons;
  const kvWrites = (day.kvWrites || 0) + mem.kvWrites;
  const pct = cap > 0 ? used / cap : 0;
  return {
    used: Math.round(used), cap, pct: Math.round(pct * 1000) / 10,
    kvWrites, kvWriteLimit: KV_WRITE_DAILY_LIMIT,
    kvAlert: kvWrites >= KV_WRITE_ALERT_AT,
    bgStopped: pct >= 0.7,   // background jobs (auto-research, self-learning) pause
    downgraded: pct >= 1,    // force cheapest model / block expensive calls
    estimated: true,
  };
}

export function cheapestChatModel() {
  return CHAT_MODELS.reduce((a, b) => (a.inPerM + a.outPerM) <= (b.inPerM + b.outPerM) ? a : b).id;
}

/** Estimate + record neurons for a chat completion. */
export function recordChatNeurons(modelId, messages, responseText) {
  try {
    const inputChars = JSON.stringify(messages || []).length;
    const outputChars = String(responseText || "").length;
    noteNeurons(chatNeurons(modelId, inputChars, outputChars));
  } catch { /* accounting must never break the call */ }
}

export function recordImageNeurons(modelId) {
  noteNeurons(IMAGE_NEURONS_EST[modelId] || 450);
}

export function recordVisionNeurons() {
  noteNeurons(VISION_NEURONS_EST);
}

export async function getResearchSettings(kvH) {
  const s = (await kvH.get("settings:research").catch(() => null)) || {};
  return {
    enabled: s.enabled !== false,
    everyH: [3, 6, 12, 24].includes(Number(s.everyH)) ? Number(s.everyH) : 3,
  };
}

/** Test hook: reset in-memory batches (tests only). */
export function __resetUsageForTests() {
  mem.neurons = 0; mem.kvWrites = 0; mem.lastFlush = 0;
  for (const k of Object.keys(statBatch)) delete statBatch[k];
  errRing.length = 0;
}
