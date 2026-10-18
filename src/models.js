// Model catalogue + neuron accounting for AI Agent Studio.
// Everything runs on Cloudflare Workers AI (free tier: 10,000 neurons/day).
// Neuron rates below are per official Workers AI pricing (docs page updated
// 2026-10-15). If Cloudflare changes prices, update here — /api/config and
// the dashboard read these numbers automatically.

/** Chat LLMs available per agent. Order of CHAT_FALLBACK = try-first. */
export const CHAT_MODELS = [
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
    label: "Llama 3.1 8B fp8-fast — الافتراضي (سريع ورخيص)",
    inPerM: 4119,
    outPerM: 34868,
  },
  {
    id: "@cf/meta/llama-3.2-3b-instruct",
    label: "Llama 3.2 3B — الأرخص",
    inPerM: 3089,
    outPerM: 26151,
  },
  {
    id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    label: "Llama 3.3 70B — الأقوى (أغلى)",
    inPerM: 20595,
    outPerM: 174340,
  },
];
export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].id;
/** Automatic fallback chain if a model is retired or errors. */
export const CHAT_FALLBACK = [
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  "@cf/meta/llama-3.2-3b-instruct",
];

/** Embedding model for the one-file training pipeline (RAG). */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
/** bge-base-en-v1.5: 100,000 neurons per 1M tokens (encode_text). */
export const EMBEDDING_PER_M_TOKENS = 100000;
export const EMBEDDING_DIMS = 768;

export const FREE_NEURONS_PER_DAY = 10000;

/** Rough token estimate for accounting (chars / 4). */
export function estTokens(text) {
  return Math.ceil((text || "").length / 4);
}

export function getChatModel(id) {
  return CHAT_MODELS.find((m) => m.id === id) || CHAT_MODELS[0];
}

/** Neuron cost estimate for one chat completion. */
export function chatNeurons(modelId, inputChars, outputChars) {
  const m = getChatModel(modelId);
  return Math.round((estTokens(String(inputChars)) / 1e6) * m.inPerM +
    (estTokens(String(outputChars)) / 1e6) * m.outPerM);
}

/** Neuron cost estimate for embedding one training file. */
export function embeddingNeurons(totalChars) {
  return Math.round((estTokens(String(totalChars)) / 1e6) * EMBEDDING_PER_M_TOKENS);
}

export function publicModels() {
  return CHAT_MODELS.map((m) => ({ id: m.id, label: m.label }));
}
