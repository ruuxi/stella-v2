import { Buffer } from "node:buffer";
import {
  DEFAULT_ESTIMATED_IMAGE_TOKENS,
  estimateModelVisibleImageTokens,
} from "./image-tokens.js";

export { DEFAULT_ESTIMATED_IMAGE_TOKENS, estimateModelVisibleImageTokens };

/** An arbitrary provider payload node, walked field by field. */
type PayloadObject = Record<string, any>;
type MeasureState = {
  maxBytes: number;
  imageTokens: number;
  imageCount: number;
  imageDecodedBytes: number;
};
const ESTIMATED_BYTES_PER_TOKEN = 3;
/** Fallback when an image-bearing provider item does not expose dimensions. */
const EXACT_INSPECTION_FRACTION = 0.75;
const JSON_ESCAPE_RE = /["\\\u0000-\u001f\ud800-\udfff]/;
// JSON.stringify writes these as two bytes (`\"`, `\n`, ...) and every other
// control character or lone surrogate as a six-byte `\uXXXX`.
const JSON_SHORT_ESCAPE_RE = /["\\\b\f\n\r\t]/g;
const JSON_UNICODE_ESCAPE_RE =
  /[\u0000-\u0007\u000b\u000e-\u001f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Exact decoded size for ordinary padded or unpadded base64 payloads. */
export const decodedBase64ByteLength = (value: unknown) => {
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

const binaryByteLength = (value: unknown) => {
  if (typeof value === "string") return decodedBase64ByteLength(value);
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  return 0;
};

/**
 * Normalize provider-specific image envelopes before recursively measuring
 * their generic object/string fields. This prevents Google inlineData and
 * Bedrock source.bytes from being charged as enormous text/number arrays.
 */
const normalizeImageValue = (
  key: string,
  value: unknown,
  parent?: PayloadObject,
): { metadata: unknown; decodedBytes: number } | null => {
  const normalizedKey = key.toLowerCase();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as PayloadObject;
    if (
      object.type === "image" ||
      object.type === "input_image" ||
      object.type === "image_url"
    ) {
      return {
        metadata: object,
        decodedBytes: binaryByteLength(
          object.data ?? object.image_url ?? object.url,
        ),
      };
    }
    const inlineData = object.inlineData ?? object.inline_data;
    if (
      inlineData &&
      typeof inlineData === "object" &&
      (typeof inlineData.data === "string" ||
        ArrayBuffer.isView(inlineData.data) ||
        inlineData.data instanceof ArrayBuffer)
    ) {
      return {
        metadata: { ...object, ...inlineData },
        decodedBytes: binaryByteLength(inlineData.data),
      };
    }
    const bedrockBytes = object.image?.source?.bytes;
    if (
      typeof bedrockBytes === "string" ||
      ArrayBuffer.isView(bedrockBytes) ||
      bedrockBytes instanceof ArrayBuffer ||
      Array.isArray(bedrockBytes)
    ) {
      return {
        metadata: object.image,
        decodedBytes: binaryByteLength(bedrockBytes),
      };
    }
    if (normalizedKey.includes("image_url")) {
      return { metadata: object, decodedBytes: 0 };
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

const addQuickString = (value: string, state: MeasureState) => {
  state.maxBytes += Buffer.byteLength(value, "utf8") + 2;
  if (!JSON_ESCAPE_RE.test(value)) return;
  state.maxBytes +=
    (value.match(JSON_SHORT_ESCAPE_RE)?.length ?? 0) +
    5 * (value.match(JSON_UNICODE_ESCAPE_RE)?.length ?? 0);
};

const measureQuick = (
  value: unknown,
  key: string,
  state: MeasureState,
  parent?: PayloadObject,
) => {
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
    const object = value as PayloadObject;
    const image = normalizeImageValue(key, object, parent);
    if (image) {
      state.imageCount += 1;
      state.imageDecodedBytes += image.decodedBytes;
      state.imageTokens += estimateModelVisibleImageTokens(image.metadata);
      addQuickString("[model-visible image]", state);
      return;
    }
    if (typeof object.toJSON === "function") {
      state.maxBytes = Number.POSITIVE_INFINITY;
      return;
    }
    state.maxBytes += 2;
    let fields = 0;
    for (const field in object) {
      if (!Object.prototype.hasOwnProperty.call(object, field)) continue;
      const item = object[field];
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
      measureQuick(item, field, state, object);
    }
  }
};

const estimatePayloadTokens = (payload: unknown, inputBudget: number) => {
  const quick: MeasureState = {
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
  const json = JSON.stringify(
    payload,
    function (this: PayloadObject, key, value) {
      const image = normalizeImageValue(key, value, this);
      if (image) {
        imageTokens += estimateModelVisibleImageTokens(image.metadata);
        return "[model-visible image]";
      }
      return value;
    },
  );
  const bytes = Buffer.byteLength(json ?? "", "utf8");
  return Math.ceil(bytes / ESTIMATED_BYTES_PER_TOKEN) + imageTokens;
};

export const getProviderPayloadImageStats = (payload: unknown) => {
  const state: MeasureState = {
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

/**
 * Estimate the model-visible tokens of an arbitrary provider payload: a quick
 * byte-based upper bound, with exact JSON measurement only when the quick
 * pass lands near the budget.
 */
export const estimateProviderPayloadTokens = (
  payload: unknown,
  inputBudget: number | undefined,
) =>
  estimatePayloadTokens(
    payload,
    inputBudget !== undefined && Number.isFinite(inputBudget) && inputBudget > 0
      ? inputBudget
      : Number.POSITIVE_INFINITY,
  );
