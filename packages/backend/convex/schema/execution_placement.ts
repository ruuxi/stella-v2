import { v, type Infer } from "convex/values";

/**
 * Execution placement lives in the cloud-builder's owner gate Durable Object
 * (`@stella/contracts/turn-plane/placement`): it owns the dispatch row, the
 * device presence sockets, the offer window and the claim handoff. Convex
 * keeps only these validators.
 */

export const executionIngressValidator = v.union(
  v.literal("desktop"),
  v.literal("mobile"),
  v.literal("browser"),
  v.literal("cloud"),
  v.literal("schedule"),
);

export const executionRequestKindValidator = v.union(
  v.literal("chat"),
  v.literal("agent"),
);

export const executionSubjectValidator = v.union(
  v.literal("portable"),
  v.literal("computer"),
  v.literal("cloud"),
);

export const executionPlacementValidator = v.union(
  v.literal("computer"),
  v.literal("cloud"),
);

export const executionTargetModeValidator = v.union(
  v.literal("automatic"),
  v.literal("cloud"),
  v.literal("device"),
);

export type ExecutionPlacement = Infer<typeof executionPlacementValidator>;

export const executionCapabilityValidator = v.union(
  v.literal("chat"),
  v.literal("agent"),
  v.literal("computer-use"),
  v.literal("local-files"),
  v.literal("local-apps"),
  // A build that can resolve the dispatch payload's drive-path attachments.
  // Gating on a capability rather than a protocol bump keeps a desktop that
  // predates attachments eligible for every turn that has none.
  v.literal("attachments"),
);

export type ExecutionCapability = Infer<typeof executionCapabilityValidator>;

/** Mirrors `DispatchState` in `@stella/contracts/turn-plane/placement`. */
export const executionDispatchStateValidator = v.union(
  v.literal("offering"),
  v.literal("computer_claimed"),
  v.literal("computer_accepted"),
  v.literal("computer_running"),
  v.literal("cloud_committed"),
  v.literal("cloud_running"),
  v.literal("cancel_pending"),
  v.literal("reconciliation_required"),
  v.literal("blocked"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("canceled"),
);
