import { ConvexError } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { ManagedModelAudience } from "../agent/model";
import type { ManagedDispatchGuard } from "../runtime_ai/managed";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { fetchBillingAccess } from "../billing_bridge";

/**
 * Convex no longer spends on managed providers: media, voice, dictation,
 * music, search and synthesis are served by cloud-builder, which owns
 * billing. The legacy remote-turn runtime that still imports these (deleted
 * with phase 7) is refused before any provider call.
 */

export type ManagedModelAccess = {
  allowed: boolean;
  plan: "free" | "go" | "pro";
  unlimited: boolean;
  downgraded: boolean;
  modelAudience: ManagedModelAudience;
  retryAfterMs: number;
  message: string;
  /** Lifecycle generation admitted with this managed request. */
  ownerGeneration: string;
};

/** The owner's plan audience, for the public model catalog. */
export async function resolveManagedModelAccess(
  ctx: Pick<ActionCtx, "runQuery">,
  ownerId: string,
  options?: { isAnonymous?: boolean },
): Promise<ManagedModelAccess> {
  const { generation: ownerGeneration } = await assertOwnerDataAccessActive(ctx, ownerId);
  const access = await fetchBillingAccess(ownerId, {
    ...(options?.isAnonymous !== undefined ? { isAnonymous: options.isAnonymous } : {}),
  });
  return {
    allowed: access.allowed,
    plan: access.plan,
    unlimited: access.unlimited,
    downgraded: access.downgraded,
    modelAudience: access.audience,
    retryAfterMs: access.retryAfterMs,
    message: access.message,
    ownerGeneration,
  };
}

const managedUsageRetired = () =>
  new ConvexError({
    code: "SERVICE_UNAVAILABLE",
    message: "Managed model usage is not served by Convex.",
  });

export async function assertManagedUsageAllowed(
  _ctx: unknown,
  _ownerId: string,
): Promise<ManagedModelAccess> {
  throw managedUsageRetired();
}

export function createManagedUsageDispatchGuard(
  _ctx: unknown,
  _args: Record<string, unknown>,
): ManagedDispatchGuard {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    beginDispatch: async () => {
      throw managedUsageRetired();
    },
    finishExecution: async () => {},
  };
}
