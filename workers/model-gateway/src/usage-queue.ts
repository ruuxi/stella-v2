import {
  GATEWAY_USAGE_EVENT_VERSION,
  type GatewayUsageBatch,
  type GatewayUsageEvent,
} from "@stella/contracts/gateway/usage";
import type { BillingControlRpc } from "@stella/contracts/gateway/usage";
import { billingControl } from "./billing-control.js";

/**
 * USAGE_QUEUE consumer. Each batch settles into the owners' billing ledgers
 * on cloud-builder (`BillingControl.ingestUsage`), which also takes the
 * owners' risk signals from it.
 * Settlement is idempotent on `requestId`, so a retried batch is safe.
 *
 *   settled   ack the whole batch (rejections are logged, never retried).
 *   a failure retry the whole batch with a growing delay.
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
  env: Pick<Env, "BILLING">,
  billing: BillingControlRpc = billingControl(env),
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
  const retryDelay = () =>
    RETRY_DELAY_SECONDS[Math.min(maxAttempts, RETRY_DELAY_SECONDS.length) - 1] ??
    RETRY_DELAY_SECONDS[RETRY_DELAY_SECONDS.length - 1];
  try {
    const settled = await billing.ingestUsage(payload);
    if (settled.rejected.length > 0) {
      console.error(
        `[model-gateway:usage] billing rejected ${settled.rejected.length}/${events.length} events: ${JSON.stringify(settled.rejected).slice(0, 2_000)}`,
      );
    }
  } catch (error) {
    const delaySeconds = retryDelay();
    console.warn(
      `[model-gateway:usage] billing unavailable (${error instanceof Error ? error.message : String(error)}); retrying ${events.length} events in ${delaySeconds}s`,
    );
    batch.retryAll({ delaySeconds });
    return;
  }
  batch.ackAll();
};
