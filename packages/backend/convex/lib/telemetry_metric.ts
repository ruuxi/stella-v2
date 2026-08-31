import { hashSha256Hex } from "./crypto_utils";

export const TELEMETRY_METRIC_PREFIX = "_stella_metric:";

type InferenceMetric = {
  kind: "inference.completed";
  ownerKey: string;
  occurredAtMs: number;
  model: string;
  agentType: string;
  durationMs: number;
  success: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  costMicroCents?: number;
  fallbackUsed?: boolean;
  toolCalls?: number;
};

type ToolMetric = {
  kind: "tool.completed";
  ownerKey: string;
  occurredAtMs: number;
  toolName: string;
  agentType: string;
  durationMs: number;
  success: boolean;
};

const emit = (metric: InferenceMetric | ToolMetric): void => {
  // This marker mirrors OpenCode's `_metric:` structured Worker log. Convex
  // Log Streams forward it to the authenticated Cloudflare webhook; ordinary
  // logs are ignored by the telemetry Worker.
  console.log(`${TELEMETRY_METRIC_PREFIX}${JSON.stringify(metric)}`);
};

const ownerKey = (ownerId: string): Promise<string> =>
  hashSha256Hex(`stella:telemetry-owner:v1\0${ownerId}`);

const emitSafely = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch {
    // Never roll back the billing/usage transaction for a log line.
    console.warn("Stella telemetry metric emission failed");
  }
};

export const emitInferenceTelemetryMetric = async (
  input: Omit<InferenceMetric, "kind" | "ownerKey"> & { ownerId: string },
): Promise<void> => {
  await emitSafely(async () => {
    const { ownerId, ...metric } = input;
    emit({
      kind: "inference.completed",
      ownerKey: await ownerKey(ownerId),
      ...metric,
    });
  });
};

export const emitToolTelemetryMetric = async (
  input: Omit<ToolMetric, "kind" | "ownerKey"> & { ownerId: string },
): Promise<void> => {
  await emitSafely(async () => {
    const { ownerId, ...metric } = input;
    emit({
      kind: "tool.completed",
      ownerKey: await ownerKey(ownerId),
      ...metric,
    });
  });
};
