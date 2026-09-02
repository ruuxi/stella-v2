import {
  GATEWAY_USAGE_EVENT_VERSION,
  type GatewayUsageBatch,
  type GatewayUsageEvent,
} from "@stella/contracts/gateway/usage";
import { createConvexClient, type ConvexClient } from "./convex-client.js";

/**
 * USAGE_QUEUE consumer: one `POST /api/gateway/usage` per batch.
 *
 *   2xx           ack the whole batch (Convex reports duplicates/rejections
 *                 per event in its body; those are logged, never retried —
 *                 the batch is idempotent on requestId).
 *   5xx / timeout retry the whole batch with a growing delay.
 *   other 4xx     log and ack: a bad batch must not poison the queue. The
 *                 malformed messages are already acked individually below.
 */
const RETRY_DELAY_SECONDS = [5, 15, 60, 180, 600] as const;

export const isUsageEvent = (value: unknown): value is GatewayUsageEvent => {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    event.v === GATEWAY_USAGE_EVENT_VERSION &&
    typeof event.requestId === "string" &&
    typeof event.capabilityId === "string" &&
    typeof event.ownerId === "string" &&
    typeof event.usage === "object" &&
    event.usage !== null &&
    typeof event.chargedMicroCents === "number"
  );
};

export const handleUsageBatch = async (
  batch: MessageBatch<unknown>,
  env: Pick<Env, "STELLA_CONVEX_SITE_URL" | "GATEWAY_SERVICE_SECRET">,
  convex: ConvexClient = createConvexClient(env),
): Promise<void> => {
  const events: GatewayUsageEvent[] = [];
  let maxAttempts = 1;
  for (const message of batch.messages) {
    if (isUsageEvent(message.body)) {
      events.push(message.body);
      maxAttempts = Math.max(maxAttempts, message.attempts);
    } else {
      console.error(
        `[model-gateway:usage] dropping malformed message id=${message.id}`,
      );
      message.ack();
    }
  }
  if (events.length === 0) return;

  const payload: GatewayUsageBatch = { v: GATEWAY_USAGE_EVENT_VERSION, events };
  const result = await convex.usage(payload);
  if (result.ok) {
    const body = result.body;
    if (body && Array.isArray(body.rejected) && body.rejected.length > 0) {
      console.error(
        `[model-gateway:usage] convex rejected ${body.rejected.length}/${events.length} events: ${JSON.stringify(body.rejected).slice(0, 2_000)}`,
      );
    }
    batch.ackAll();
    return;
  }
  if (result.status === null || result.retryable) {
    const delaySeconds =
      RETRY_DELAY_SECONDS[
        Math.min(maxAttempts, RETRY_DELAY_SECONDS.length) - 1
      ] ?? RETRY_DELAY_SECONDS[RETRY_DELAY_SECONDS.length - 1];
    console.warn(
      `[model-gateway:usage] convex unavailable status=${result.status ?? "none"}; retrying ${events.length} events in ${delaySeconds}s`,
    );
    batch.retryAll({ delaySeconds });
    return;
  }
  console.error(
    `[model-gateway:usage] convex refused batch status=${result.status} body=${JSON.stringify(result.body).slice(0, 2_000)}; acking ${events.length} events`,
  );
  batch.ackAll();
};
