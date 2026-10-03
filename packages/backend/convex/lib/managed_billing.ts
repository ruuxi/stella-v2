import { ConvexError } from "convex/values";
import type { ManagedModelAudience } from "../agent/model";
import type { ManagedDispatchGuard } from "../runtime_ai/managed";

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
