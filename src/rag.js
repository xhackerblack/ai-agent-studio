// RAG helpers: text chunking, cosine similarity, retrieval ranking.
// Embeddings themselves are produced by Workers AI (bge-base-en-v1.5) and
// stored in KV next to their chunks; retrieval is brute-force cosine search,
// which is plenty fast for the "one file per agent" training scale.

export const CHUNK_SIZE = 600; // characters
export const CHUNK_OVERLAP = 80;
export const MAX_CHUNKS_PER_FILE = 400;
export const TOP_K = 5;

/** Split text into overlapping chunks on sentence/line boundaries. */
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const clean = String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
  if (!clean) return [];
  // Prefer splitting on sentence ends, then newlines.
  const sentences = clean.split(/(?<=[.!?؟\n])\s+/);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + " " + s).trim().length > size && current.trim()) {
      chunks.push(current.trim());
      // Overlap: keep the tail of the previous chunk.
      current = current.slice(Math.max(0, current.length - overlap)) + " " + s;
    } else {
      current = (current ? current + " " : "") + s;
    }
    if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
  }
  if (current.trim() && chunks.length < MAX_CHUNKS_PER_FILE) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

export function norm(a) {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity in [-1, 1]. Returns 0 for zero vectors. */
export function cosine(a, b) {
  const n = norm(a) * norm(b);
  if (!n) return 0;
  return dot(a, b) / n;
}

/**
 * Rank stored chunks against a query embedding.
 * chunks: [{text, embedding}]. Returns top-k [{text, score}] sorted desc.
 */
export function retrieve(chunks, queryEmbedding, k = TOP_K) {
  const scored = [];
  for (const c of chunks || []) {
    if (!c || !Array.isArray(c.embedding)) continue;
    scored.push({ text: c.text, score: cosine(queryEmbedding, c.embedding) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, k);
}

/** Minimum similarity for a chunk to be considered relevant. */
export const RELEVANCE_THRESHOLD = 0.25;

export function relevantChunks(chunks, queryEmbedding, k = TOP_K) {
  return retrieve(chunks, queryEmbedding, k).filter((r) => r.score >= RELEVANCE_THRESHOLD);
}
