import { Buffer } from "node:buffer";

const providerBudgets = new Map();
const providerPayloadEstimates = new Map();
const forcedCompactions = new Map();

const MAX_INPUT_FRACTION = 0.7;
const ESTIMATED_BYTES_PER_TOKEN = 3;

export const DEFAULT_ESTIMATED_IMAGE_TOKENS = 1_200;
const IMAGE_TILE_EDGE_PX = 512;
const IMAGE_DETAIL_MAX_EDGE_PX = 2_048;
const IMAGE_BASE_TOKENS = 85;
const IMAGE_TILE_TOKENS = 170;
const EXACT_INSPECTION_FRACTION = 0.75;
const JSON_ESCAPE_RE = /["\\\u0000-\u001f\ud800-\udfff]/;

export const setProviderContextWindow = (threadKey, contextWindow) => {
  const parsed = Number(contextWindow);
  if (!threadKey || !Number.isFinite(parsed) || parsed <= 0) {
    providerBudgets.delete(threadKey);
    return;
  }
  providerBudgets.set(threadKey, Math.floor(parsed));
};

export const clearProviderContextWindow = (threadKey) => {
  providerBudgets.delete(threadKey);
  providerPayloadEstimates.delete(threadKey);
};

export const getLastProviderPayloadTokens = (threadKey) => {
  const value = providerPayloadEstimates.get(threadKey);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const positiveDimension = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

export const estimateModelVisibleImageTokens = (value) => {
  const width = positiveDimension(value?.width ?? value?.widthPx);
  const height = positiveDimension(value?.height ?? value?.heightPx);
  if (!width || !height) return DEFAULT_ESTIMATED_IMAGE_TOKENS;
  const scale = Math.min(1, IMAGE_DETAIL_MAX_EDGE_PX / Math.max(width, height));
  const scaledWidth = Math.max(1, Math.ceil(width * scale));
  const scaledHeight = Math.max(1, Math.ceil(height * scale));
  const tiles =
    Math.ceil(scaledWidth / IMAGE_TILE_EDGE_PX) *
    Math.ceil(scaledHeight / IMAGE_TILE_EDGE_PX);
  return IMAGE_BASE_TOKENS + IMAGE_TILE_TOKENS * tiles;
};

export const decodedBase64ByteLength = (value) => {
  if (typeof value !== "string" || value.length === 0) return 0;
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const encoded = (comma >= 0 ? value.slice(comma + 1) : value).replace(
    /\s/g,
    "",
  );
  if (!encoded) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
};

const binaryByteLength = (value) => {
  if (typeof value === "string") return decodedBase64ByteLength(value);
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  return 0;
};

const normalizeImageValue = (key, value, parent) => {
  const normalizedKey = key.toLowerCase();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (
      value.type === "image" ||
      value.type === "input_image" ||
      value.type === "image_url"
    ) {
      return {
        metadata: value,
        decodedBytes: binaryByteLength(
          value.data ?? value.image_url ?? value.url,
        ),
      };
    }
    const inlineData = value.inlineData ?? value.inline_data;
    if (
      inlineData &&
      typeof inlineData === "object" &&
      (typeof inlineData.data === "string" ||
        ArrayBuffer.isView(inlineData.data) ||
        inlineData.data instanceof ArrayBuffer)
    ) {
      return {
        metadata: { ...value, ...inlineData },
        decodedBytes: binaryByteLength(inlineData.data),
      };
    }
    const bedrockBytes = value.image?.source?.bytes;
    if (
      typeof bedrockBytes === "string" ||
      ArrayBuffer.isView(bedrockBytes) ||
      bedrockBytes instanceof ArrayBuffer ||
      Array.isArray(bedrockBytes)
    ) {
      return {
        metadata: value.image,
        decodedBytes: binaryByteLength(bedrockBytes),
      };
    }
    if (normalizedKey.includes("image_url")) {
      return { metadata: value, decodedBytes: 0 };
    }
  }
  if (typeof value !== "string") return null;
  if (
    value.startsWith("data:image/") ||
    normalizedKey.includes("image_url") ||
    (parent &&
      typeof parent === "object" &&
      (parent.type === "image" || parent.type === "input_image") &&
      (key === "data" || key === "url"))
  ) {
    return {
      metadata: parent && typeof parent === "object" ? parent : {},
      decodedBytes: value.startsWith("data:image/")
        ? decodedBase64ByteLength(value)
        : 0,
    };
  }
  return null;
};

const addQuickString = (value, state) => {
  const bytes = Buffer.byteLength(value, "utf8") + 2;
  state.maxBytes += bytes + (JSON_ESCAPE_RE.test(value) ? value.length * 5 : 0);
};

const measureQuick = (value, key, state, parent) => {
  if (typeof value === "string") {
    const image = normalizeImageValue(key, value, parent);
    if (image) {
      state.imageCount += 1;
      state.imageDecodedBytes += image.decodedBytes;
      state.imageTokens += estimateModelVisibleImageTokens(image.metadata);
      addQuickString("[model-visible image]", state);
    } else {
      addQuickString(value, state);
    }
    return;
  }
  if (value === null || typeof value === "undefined") {
    state.maxBytes += 4;
    return;
  }
  if (typeof value === "number") {
    state.maxBytes += Number.isFinite(value) ? String(value).length : 4;
    return;
  }
  if (typeof value === "boolean") {
    state.maxBytes += value ? 4 : 5;
    return;
  }
  if (Array.isArray(value)) {
    state.maxBytes += 2 + Math.max(0, value.length - 1);
    for (const item of value) measureQuick(item, "", state, value);
    return;
  }
  if (typeof value === "object") {
    const image = normalizeImageValue(key, value, parent);
    if (image) {
      state.imageCount += 1;
      state.imageDecodedBytes += image.decodedBytes;
      state.imageTokens += estimateModelVisibleImageTokens(image.metadata);
      addQuickString("[model-visible image]", state);
      return;
    }
    if (typeof value.toJSON === "function") {
      state.maxBytes = Number.POSITIVE_INFINITY;
      return;
    }
    state.maxBytes += 2;
    let fields = 0;
    for (const field in value) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      const item = value[field];
      if (
        typeof item === "undefined" ||
        typeof item === "function" ||
        typeof item === "symbol"
      ) {
        continue;
      }
      if (fields > 0) state.maxBytes += 1;
      fields += 1;
      addQuickString(field, state);
      state.maxBytes += 1;
      measureQuick(item, field, state, value);
    }
  }
};

const estimatePayloadTokens = (payload, inputBudget) => {
  const quick = {
    maxBytes: 0,
    imageTokens: 0,
    imageCount: 0,
    imageDecodedBytes: 0,
  };
  measureQuick(payload, "", quick);
  const maxTokens =
    Math.ceil(quick.maxBytes / ESTIMATED_BYTES_PER_TOKEN) + quick.imageTokens;
  if (maxTokens < inputBudget * EXACT_INSPECTION_FRACTION) {
    return maxTokens;
  }

  let imageTokens = 0;
  const json = JSON.stringify(payload, function (key, value) {
    const image = normalizeImageValue(key, value, this);
    if (image) {
      imageTokens += estimateModelVisibleImageTokens(image.metadata);
      return "[model-visible image]";
    }
    return value;
  });
  const bytes = Buffer.byteLength(json ?? "", "utf8");
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN) + imageTokens;
};

export const getProviderPayloadImageStats = (payload) => {
  const state = {
    maxBytes: 0,
    imageTokens: 0,
    imageCount: 0,
    imageDecodedBytes: 0,
  };
  measureQuick(payload, "", state);
  return {
    count: state.imageCount,
    decodedBytes: state.imageDecodedBytes,
  };
};

export const providerInputBudgetTokens = (contextWindow) => {
  const parsed = Number(contextWindow);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(8_000, Math.floor(parsed * MAX_INPUT_FRACTION));
};

export const estimateProviderPayloadTokens = (payload, inputBudget) =>
  estimatePayloadTokens(
    payload,
    Number.isFinite(inputBudget) && inputBudget > 0
      ? inputBudget
      : Number.POSITIVE_INFINITY,
  );

export const preflightProviderPayload = (threadKey, payload, model) => {
  const liveContextWindow = Number(model?.contextWindow);
  const contextWindow =
    Number.isFinite(liveContextWindow) && liveContextWindow > 0
      ? Math.floor(liveContextWindow)
      : providerBudgets.get(threadKey);
  if (!contextWindow) return;

  const inputBudget = Math.max(
    8_000,
    Math.floor(contextWindow * MAX_INPUT_FRACTION),
  );
  const estimatedTokens = estimatePayloadTokens(payload, inputBudget);

  if (threadKey) {
    providerPayloadEstimates.set(threadKey, estimatedTokens);
  }
  if (estimatedTokens < inputBudget) return;

  throw new Error(
    `Context preflight context_length_exceeded before provider dispatch: ` +
      `estimated ${estimatedTokens} model-visible tokens against a ${contextWindow}-token ` +
      `window (${inputBudget}-token safe input budget) for ${model?.provider ?? "provider"}/${model?.id ?? "model"}.`,
  );
};

export const withForcedThreadCompaction = async (threadKey, run) => {
  forcedCompactions.set(threadKey, (forcedCompactions.get(threadKey) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const remaining = (forcedCompactions.get(threadKey) ?? 1) - 1;
    if (remaining > 0) forcedCompactions.set(threadKey, remaining);
    else forcedCompactions.delete(threadKey);
  }
};

export const isThreadCompactionForced = (threadKey) =>
  (forcedCompactions.get(threadKey) ?? 0) > 0;
