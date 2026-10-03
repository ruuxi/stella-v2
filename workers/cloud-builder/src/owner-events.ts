/**
 * Delivery of turn-plane events to the owner's object.
 *
 * The orchestrator, BuildSession and conversation objects hand their events
 * straight to `OwnerGate.applyOwnerEvents`. A delivery that throws is the
 * caller's to keep and retry (a durable batch with an alarm, or a lagging
 * index the next turn end catches up); applying is idempotent, so a retried
 * batch costs only the duplicate checks.
 */

import {
  ownerReadsEvent,
  type OwnerEvent,
} from "@stella/contracts/turn-plane/owner-events";

export type OwnerEventsEnv = Pick<Cloudflare.Env, "OWNER_GATES">;

export const deliverOwnerEvents = async (
  env: OwnerEventsEnv,
  events: readonly OwnerEvent[],
): Promise<void> => {
  const byOwner = new Map<string, OwnerEvent[]>();
  for (const event of events) {
    if (!ownerReadsEvent(event)) continue;
    const batch = byOwner.get(event.ownerId) ?? [];
    batch.push(event);
    byOwner.set(event.ownerId, batch);
  }
  for (const [ownerId, batch] of byOwner) {
    await env.OWNER_GATES.getByName(ownerId).applyOwnerEvents(batch);
  }
};
