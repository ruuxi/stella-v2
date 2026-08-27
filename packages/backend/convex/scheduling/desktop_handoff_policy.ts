import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import {
  runAgentTurn,
  type RunAgentTurnBillingIdentity,
} from "../automation/runner";
import { requireConversationOwner } from "../auth";
import type { ManagedDispatchGuard } from "../runtime_ai/managed";

/**
 * Shared desktop handoff policy for backend-owned turns.
 *
 * Callers can prefer desktop execution when a device is online, then fall back
 * to backend execution if the handoff is unavailable or fails.
 */
export type DesktopTurnCandidate =
  | { mode: "desktop"; targetDeviceId: string }
  | { mode: "backend" };

export const buildDesktopTurnCandidates = (args: {
  targetDeviceId?: string | null;
}): DesktopTurnCandidate[] => {
  const candidates: DesktopTurnCandidate[] = [];
  if (args.targetDeviceId) {
    candidates.push({ mode: "desktop", targetDeviceId: args.targetDeviceId });
  }
  candidates.push({ mode: "backend" });
  return candidates;
};

export const resolveOwnedConversationId = async (
  ctx: QueryCtx | MutationCtx,
  ownerId: string,
  conversationId?: Id<"conversations">,
): Promise<Id<"conversations"> | null> => {
  if (conversationId) {
    const conversation = await requireConversationOwner(ctx, conversationId);
    return conversation?._id ?? null;
  }
  const conversation = await ctx.db
    .query("conversations")
    .withIndex("by_ownerId_and_isDefault", (q) => q.eq("ownerId", ownerId).eq("isDefault", true))
    .unique();
  return conversation?._id ?? null;
};

export const runAgentTurnWithBackendFallback = async (args: {
  ctx: ActionCtx;
  conversationId: Id<"conversations">;
  prompt: string;
  agentType: string;
  ownerId: string;
  ownerGeneration: string;
  modelDispatchGuard: ManagedDispatchGuard;
  billingIdentity: RunAgentTurnBillingIdentity;
  transient?: boolean;
  candidates: DesktopTurnCandidate[];
  userMessageId?: Id<"events">;
}): Promise<{
  result: Awaited<ReturnType<typeof runAgentTurn>>;
  selectedMode: DesktopTurnCandidate["mode"];
}> => {
  let lastExecutionError: Error | null = null;

  for (const candidate of args.candidates) {
    let result: Awaited<ReturnType<typeof runAgentTurn>>;
    try {
      result = await runAgentTurn({
        ctx: args.ctx,
        conversationId: args.conversationId,
        prompt: args.prompt,
        agentType: args.agentType,
        ownerId: args.ownerId,
        ownerGeneration: args.ownerGeneration,
        modelDispatchGuard: args.modelDispatchGuard,
        billingIdentity: args.billingIdentity,
        transient: args.transient,
        userMessageId: args.userMessageId,
      });
    } catch (error) {
      lastExecutionError = error as Error;
      continue;
    }
    // This helper has no downstream persistence/delivery CAS of its own, so
    // the awaited usage write inside runAgentTurn is its final synchronous
    // side effect. Do not replay a completed provider turn if settlement fails.
    await result.settleExecution("succeeded");
    return { result, selectedMode: candidate.mode };
  }

  throw lastExecutionError ?? new Error("No execution candidate succeeded");
};
