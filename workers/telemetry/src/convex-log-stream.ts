import type {
  InferenceCompletedTelemetry,
  TelemetryEventBody,
  ToolCompletedTelemetry,
} from "@stella/contracts/telemetry";

export const CONVEX_METRIC_PREFIX = "_stella_metric:";
export const MAX_CONVEX_LOG_STREAM_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_CONVEX_LOG_STREAM_AGE_MS = 15 * 60_000;
export const MAX_CONVEX_LOG_STREAM_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_LOG_EVENTS = 10_000;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const SAFE_PROVIDER_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+-]*)*$/u;
const PATH_OR_URL_PREFIX =
  /^(?:[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/|[\\/]|\.{1,2}(?:[\\/]|$))/u;
const INT32_MAX = 2_147_483_647;

type RecordValue = Record<string, unknown>;

export type ParsedConvexMetric = {
  ownerKey: string;
  timestamp: number;
  identityMaterial: string;
  event: TelemetryEventBody;
};

export type ParsedConvexLogStream = {
  metrics: ParsedConvexMetric[];
  ignored: number;
};

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const onlyKeys = (value: RecordValue, keys: readonly string[]) => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const label = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  SAFE_LABEL.test(value);

const providerModelId = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  !PATH_OR_URL_PREFIX.test(value) &&
  SAFE_PROVIDER_MODEL_ID.test(value);

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const optionalCount = (value: unknown): boolean =>
  value === undefined || count(value);

const optionalInt32Count = (value: unknown): boolean =>
  value === undefined || (count(value) && value <= INT32_MAX);

const duration = (value: unknown): value is number =>
  count(value) && value <= 30 * 24 * 60 * 60_000;

const messageValue = (message: string): string => {
  if (message.startsWith(CONVEX_METRIC_PREFIX)) return message;
  if (message.startsWith(`'${CONVEX_METRIC_PREFIX}`) && message.endsWith("'")) {
    return message.slice(1, -1);
  }
  if (message.startsWith(`"${CONVEX_METRIC_PREFIX}`)) {
    try {
      const parsed: unknown = JSON.parse(message);
      return typeof parsed === "string" ? parsed : message;
    } catch {
      return message;
    }
  }
  return message;
};

const inferenceMetric = (
  value: RecordValue,
): {
  ownerKey: string;
  occurredAtMs: number;
  event: InferenceCompletedTelemetry;
} | null => {
  if (
    !onlyKeys(value, [
      "kind",
      "ownerKey",
      "occurredAtMs",
      "model",
      "agentType",
      "durationMs",
      "success",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheWriteInputTokens",
      "reasoningTokens",
      "totalTokens",
      "costMicroCents",
      "fallbackUsed",
      "toolCalls",
    ]) ||
    typeof value.ownerKey !== "string" ||
    !HASH.test(value.ownerKey) ||
    !count(value.occurredAtMs) ||
    !providerModelId(value.model, 160) ||
    !label(value.agentType, 96) ||
    !duration(value.durationMs) ||
    typeof value.success !== "boolean" ||
    ![
      value.inputTokens,
      value.outputTokens,
      value.cachedInputTokens,
      value.cacheWriteInputTokens,
      value.reasoningTokens,
      value.totalTokens,
      value.costMicroCents,
    ].every(optionalCount) ||
    !optionalInt32Count(value.toolCalls) ||
    (value.fallbackUsed !== undefined &&
      typeof value.fallbackUsed !== "boolean")
  ) {
    return null;
  }
  return {
    ownerKey: value.ownerKey,
    occurredAtMs: value.occurredAtMs,
    event: {
      type: "inference.completed",
      provider: "stella-managed",
      model: value.model,
      agentType: value.agentType,
      durationMs: value.durationMs,
      success: value.success,
      ...(value.inputTokens !== undefined
        ? { inputTokens: value.inputTokens as number }
        : {}),
      ...(value.outputTokens !== undefined
        ? { outputTokens: value.outputTokens as number }
        : {}),
      ...(value.cachedInputTokens !== undefined
        ? { cachedInputTokens: value.cachedInputTokens as number }
        : {}),
      ...(value.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: value.cacheWriteInputTokens as number }
        : {}),
      ...(value.reasoningTokens !== undefined
        ? { reasoningTokens: value.reasoningTokens as number }
        : {}),
      ...(value.totalTokens !== undefined
        ? { totalTokens: value.totalTokens as number }
        : {}),
      ...(value.costMicroCents !== undefined
        ? { costMicroCents: value.costMicroCents as number }
        : {}),
      ...(value.fallbackUsed !== undefined
        ? { fallbackUsed: value.fallbackUsed as boolean }
        : {}),
      ...(value.toolCalls !== undefined
        ? { toolCalls: value.toolCalls as number }
        : {}),
    },
  };
};

const toolMetric = (
  value: RecordValue,
): {
  ownerKey: string;
  occurredAtMs: number;
  event: ToolCompletedTelemetry;
} | null => {
  if (
    !onlyKeys(value, [
      "kind",
      "ownerKey",
      "occurredAtMs",
      "toolName",
      "agentType",
      "durationMs",
      "success",
    ]) ||
    typeof value.ownerKey !== "string" ||
    !HASH.test(value.ownerKey) ||
    !count(value.occurredAtMs) ||
    !label(value.toolName, 128) ||
    !label(value.agentType, 96) ||
    !duration(value.durationMs) ||
    typeof value.success !== "boolean"
  ) {
    return null;
  }
  return {
    ownerKey: value.ownerKey,
    occurredAtMs: value.occurredAtMs,
    event: {
      type: "tool.completed",
      toolName: value.toolName,
      agentType: value.agentType,
      durationMs: value.durationMs,
      success: value.success,
    },
  };
};

const metric = (
  message: string,
): {
  ownerKey: string;
  occurredAtMs: number;
  event: TelemetryEventBody;
} | null => {
  const decoded = messageValue(message);
  if (!decoded.startsWith(CONVEX_METRIC_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(decoded.slice(CONVEX_METRIC_PREFIX.length));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.kind === "inference.completed") return inferenceMetric(value);
  if (value.kind === "tool.completed") return toolMetric(value);
  return null;
};

export const parseConvexLogStream = (
  value: unknown,
): ParsedConvexLogStream | null => {
  if (!Array.isArray(value) || value.length > MAX_LOG_EVENTS) return null;
  const metrics: ParsedConvexMetric[] = [];
  let ignored = 0;
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (item.topic !== "console") {
      ignored += 1;
      continue;
    }
    if (
      !count(item.timestamp) ||
      typeof item.message !== "string" ||
      item.is_truncated === true ||
      !isRecord(item.function) ||
      typeof item.function.request_id !== "string" ||
      !isRecord(item.convex) ||
      typeof item.convex.deployment_name !== "string"
    ) {
      ignored += 1;
      continue;
    }
    const parsed = metric(item.message);
    if (!parsed) {
      ignored += 1;
      continue;
    }
    metrics.push({
      ownerKey: parsed.ownerKey,
      timestamp: parsed.occurredAtMs,
      identityMaterial: `${item.convex.deployment_name}\0${item.function.request_id}\0${item.timestamp}\0${messageValue(item.message)}`,
      event: parsed.event,
    });
  }
  return { metrics, ignored };
};

export const hasFreshConvexLogStreamTimestamps = (
  value: unknown,
  now = Date.now(),
): boolean =>
  Array.isArray(value) &&
  value.length <= MAX_LOG_EVENTS &&
  value.every(
    (item) =>
      isRecord(item) &&
      count(item.timestamp) &&
      item.timestamp >= now - MAX_CONVEX_LOG_STREAM_AGE_MS &&
      item.timestamp <= now + MAX_CONVEX_LOG_STREAM_FUTURE_SKEW_MS,
  );

const hexBytes = (value: string): Uint8Array | null => {
  if (!/^[0-9a-f]{64}$/u.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
};

export const verifyConvexLogStreamSignature = async (
  body: Uint8Array,
  signatureHeader: string | null,
  secret: string | null | undefined,
): Promise<boolean> => {
  const signature =
    signatureHeader?.startsWith("sha256=") && signatureHeader.length === 71
      ? hexBytes(signatureHeader.slice(7))
      : null;
  if (!signature || !secret || secret.length > 8_192) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify("HMAC", key, signature, body);
};
