/**
 * Turn-plane outbox events, applied to the owner's own index. The
 * orchestrator and BuildSessions emit these through `TURN_OUTBOX`; the queue
 * consumer groups a batch by owner and hands each owner its events.
 */

import type { OutboxEvent } from "@stella/contracts/turn-plane/outbox";
import {
  applyAgentThreadEvent,
  type AgentThreadEffects,
} from "./domains/agent-threads.js";
import { applyConversationEvent } from "./domains/conversations.js";
import type { OwnerContext } from "./registry.js";

/** Parents before children, so a batch never applies a child to a missing row. */
const KIND_ORDER: Record<OutboxEvent["kind"], number> = {
  "conversation.created": 0,
  "turn.started": 1,
  "thread.spawned": 2,
  "conversation.index": 3,
  "turn.event": 4,
  "thread.completed": 5,
  "conversation.deleted": 6,
  "build.recorded": 7,
};

export const applyOwnerOutbox = (
  ctx: Pick<OwnerContext, "db" | "jobs" | "now">,
  events: readonly OutboxEvent[],
): AgentThreadEffects => {
  const { db } = ctx;
  const effects: AgentThreadEffects = { cards: [] };
  const ordered = [...events].sort(
    (left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind],
  );
  for (const event of ordered) {
    switch (event.kind) {
      case "conversation.created":
      case "conversation.index":
      case "conversation.deleted":
        applyConversationEvent(ctx, event);
        break;
      case "turn.started":
        applyConversationEvent(ctx, event);
        applyAgentThreadEvent(db, event, effects);
        break;
      case "turn.event":
      case "thread.spawned":
      case "thread.completed":
        applyAgentThreadEvent(db, event, effects);
        break;
      case "build.recorded":
        break;
    }
  }
  return effects;
};
