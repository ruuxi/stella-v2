/**
 * The outbox: the only write path from this data plane to Convex.
 *
 * Durable Objects append events to the `TURN_OUTBOX` queue (`enqueueOutbox`);
 * the Worker's queue consumer batches them into `POST /api/cloud/outbox`
 * (`deliverOutboxBatch`). Delivery is at-least-once and may reorder, which is
 * why every event carries an idempotency `key` and Convex fences projections
 * rather than appending. The consumer's only job is the transport verdict:
 *
 *   - 2xx: Convex applied, deduplicated, or permanently rejected each event.
 *     Rejections are logged and acked — a redelivery cannot change them.
 *   - 5xx, 408, 429, timeout, network failure: the whole batch is retried.
 *   - any other 4xx: a contract mismatch; acked and logged so a poisoned
 *     batch cannot block the queue behind it forever.
 *
 * Messages that are not outbox events at all are acked individually. There
 * is deliberately no partial retry: Convex applies a batch event by event and
 * idempotently, so retrying the whole batch after a transport failure costs
 * only duplicate-detection work.
 */

import {
  CONVEX_OUTBOX_PATH,
  OUTBOX_EVENT_VERSION,
  OUTBOX_MAX_BATCH,
  outboxEventId,
  type OutboxBatch,
  type OutboxBatchResult,
  type OutboxEvent,
} from "@stella/contracts/turn-plane/outbox";
import { convexSiteBase } from "./convex-site.js";

export type OutboxProducerEnv = {
  TURN_OUTBOX?: Pick<Queue<OutboxEvent>, "sendBatch">;
};

export type OutboxConsumerEnv = {
  STELLA_CONVEX_SITE_URL?: string;
  BUILDER_SERVICE_SECRET?: string;
};

export const OUTBOX_DELIVERY_TIMEOUT_MS = 30_000;

const log = (
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) => {
  console[level](
    JSON.stringify({
      service: "stella-v2-cloud-builder",
      component: "outbox",
      event,
      timestamp: new Date().toISOString(),
      ...fields,
    }),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Shape check only: Convex validates each kind's payload on ingest. */
export const isOutboxEvent = (value: unknown): value is OutboxEvent =>
  isRecord(value) &&
  value.v === OUTBOX_EVENT_VERSION &&
  typeof value.kind === "string" &&
  value.kind.length > 0 &&
  typeof value.key === "string" &&
  value.key.length > 0 &&
  typeof value.ownerId === "string" &&
  value.ownerId.length > 0 &&
  typeof value.ownerGeneration === "string" &&
  value.ownerGeneration.length > 0 &&
  typeof value.emittedAt === "number" &&
  Number.isFinite(value.emittedAt);

/**
 * Append events to the queue in `OUTBOX_MAX_BATCH`-sized sends. Throws when
 * the queue refuses: the caller owns the retry (a re-armed alarm, or a
 * `lagging()` index that the next turn end catches up).
 */
export const enqueueOutbox = async (
  env: OutboxProducerEnv,
  events: readonly OutboxEvent[],
): Promise<void> => {
  if (events.length === 0) return;
  const queue = env.TURN_OUTBOX;
  if (!queue) throw new Error("TURN_OUTBOX queue is not bound.");
  for (let offset = 0; offset < events.length; offset += OUTBOX_MAX_BATCH) {
    const chunk = events.slice(offset, offset + OUTBOX_MAX_BATCH);
    await queue.sendBatch(chunk.map((body) => ({ body })));
  }
};

export type OutboxDelivery = {
  disposition: "acked" | "retried" | "empty";
  status?: number;
  events: number;
  applied: number;
  duplicate: number;
  rejected: number;
};

type OutboxMessage = Pick<Message<unknown>, "body" | "ack">;

export type OutboxMessageBatch = {
  messages: readonly OutboxMessage[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
};

const parseResult = (value: unknown): OutboxBatchResult | null => {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.applied) ||
    !Array.isArray(value.duplicate) ||
    !Array.isArray(value.rejected)
  ) {
    return null;
  }
  return value as OutboxBatchResult;
};

const retryable = (status: number): boolean =>
  status >= 500 || status === 408 || status === 429;

export const deliverOutboxBatch = async (
  batch: OutboxMessageBatch,
  env: OutboxConsumerEnv,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OutboxDelivery> => {
  const events: OutboxEvent[] = [];
  for (const message of batch.messages) {
    if (isOutboxEvent(message.body)) {
      events.push(message.body);
    } else {
      log("error", "outbox_message_malformed", {
        preview: JSON.stringify(message.body ?? null).slice(0, 200),
      });
      message.ack();
    }
  }
  if (events.length === 0) {
    batch.ackAll();
    return {
      disposition: "empty",
      events: 0,
      applied: 0,
      duplicate: 0,
      rejected: 0,
    };
  }
  const base = convexSiteBase(env);
  const secret = env.BUILDER_SERVICE_SECRET;
  if (!base || !secret) {
    // Misconfiguration is not a reason to drop projections: leave them queued
    // for the deploy that fixes it.
    log("error", "outbox_unconfigured", { events: events.length });
    batch.retryAll({ delaySeconds: 30 });
    return {
      disposition: "retried",
      events: events.length,
      applied: 0,
      duplicate: 0,
      rejected: 0,
    };
  }
  const send = options.fetch ?? fetch;
  const body: OutboxBatch = { v: OUTBOX_EVENT_VERSION, events };
  let response: Response;
  try {
    response = await send(`${base}${CONVEX_OUTBOX_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(
        options.timeoutMs ?? OUTBOX_DELIVERY_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    log("error", "outbox_delivery_failed", {
      events: events.length,
      message: error instanceof Error ? error.message : String(error),
    });
    batch.retryAll();
    return {
      disposition: "retried",
      events: events.length,
      applied: 0,
      duplicate: 0,
      rejected: 0,
    };
  }
  if (response.ok) {
    const result = parseResult(await response.json().catch(() => null));
    if (!result) {
      // A 2xx without the verdict is an intermediary answering for Convex;
      // treat it as undelivered rather than assume the projections landed.
      log("error", "outbox_verdict_malformed", {
        status: response.status,
        events: events.length,
      });
      batch.retryAll();
      return {
        disposition: "retried",
        status: response.status,
        events: events.length,
        applied: 0,
        duplicate: 0,
        rejected: 0,
      };
    }
    for (const rejection of result.rejected) {
      log("error", "outbox_event_rejected", {
        id: outboxEventId(rejection),
        reason: rejection.reason,
      });
    }
    batch.ackAll();
    return {
      disposition: "acked",
      status: response.status,
      events: events.length,
      applied: result.applied.length,
      duplicate: result.duplicate.length,
      rejected: result.rejected.length,
    };
  }
  await response.body?.cancel().catch(() => undefined);
  if (retryable(response.status)) {
    log("error", "outbox_delivery_retrying", {
      status: response.status,
      events: events.length,
    });
    batch.retryAll();
    return {
      disposition: "retried",
      status: response.status,
      events: events.length,
      applied: 0,
      duplicate: 0,
      rejected: 0,
    };
  }
  log("error", "outbox_batch_refused", {
    status: response.status,
    events: events.length,
    ids: events.map(outboxEventId).slice(0, 50),
  });
  batch.ackAll();
  return {
    disposition: "acked",
    status: response.status,
    events: events.length,
    applied: 0,
    duplicate: 0,
    rejected: events.length,
  };
};
