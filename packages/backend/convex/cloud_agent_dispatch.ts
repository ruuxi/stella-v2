import { ConvexError, v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ManagedModelAudience } from "@stella/contracts/gateway/capability";
import { ownerModelAllowanceFields, resolveOwnerExecution } from "./cloud_apps";
import {
  cloudExecutionSelectionValidator,
  type CloudExecutionSelection,
} from "./lib/cloud_execution";
import { isBuilderTurnError, startBuilderAgentTurn } from "./lib/builder_turns";
import { assertOwnerDataAccessActive } from "./owner_lifecycle";
import { cloudBrowserResumeReceiptValidator } from "./schema/cloud_browser";

/**
 * Convex-started agent turns: the one place Convex still tells a BuildSession
 * to run. Used by the desktop runtime's cloud `spawn_agent` (and its
 * continuation) and by hosted-browser resumes; execution placement's agent
 * branch calls the same client inline. The orchestrator's own spawns go
 * OrchestratorSession -> BuildSession and never pass through here.
 *
 * Admission on the builder side is idempotent on the Convex-minted `turnId`,
 * so a lost response is safe to send again. Transport failures get a few
 * spaced re-sends; a definitive refusal fails the thread so Activity and the
 * desktop's recovery subscription see the outcome.
 */

const MAX_DISPATCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 15_000;

const readableError = (error: unknown): string => {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  if (
    data &&
    typeof data === "object" &&
    typeof (data as { message?: unknown }).message === "string"
  ) {
    return (data as { message: string }).message;
  }
  return error instanceof Error ? error.message : String(error);
};

const log = (event: string, fields: Record<string, unknown>) =>
  console.warn(
    JSON.stringify({
      service: "convex-cloud-agent-dispatch",
      event,
      ...fields,
    }),
  );

export const dispatchCloudAgentTurnInternal = internalAction({
  args: {
    ownerId: v.string(),
    ownerGeneration: v.string(),
    conversationId: v.string(),
    threadId: v.string(),
    turnId: v.string(),
    attemptGeneration: v.number(),
    prompt: v.string(),
    description: v.string(),
    execution: v.optional(cloudExecutionSelectionValidator),
    source: v.union(
      v.literal("desktop"),
      v.literal("placement"),
      v.literal("browser-resume"),
      v.literal("agent-thread"),
    ),
    clientMsgId: v.optional(v.string()),
    parentTurnId: v.optional(v.string()),
    workspaceForkId: v.optional(v.string()),
    originDeviceId: v.optional(v.string()),
    originConversationId: v.optional(v.string()),
    browserResume: v.optional(cloudBrowserResumeReceiptValidator),
    dispatchAttempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const dispatchAttempt = args.dispatchAttempt ?? 1;
    const fail = async (message: string) => {
      await ctx.runMutation(
        internal.cloud_apps.failCloudAgentDispatchInternal,
        {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          conversationId: args.conversationId,
          threadId: args.threadId,
          turnId: args.turnId,
          attemptGeneration: args.attemptGeneration,
          message,
          now: Date.now(),
        },
      );
    };
    try {
      const { generation } = await assertOwnerDataAccessActive(
        ctx,
        args.ownerId,
      );
      if (generation !== args.ownerGeneration) {
        log("agent_dispatch_generation_stale", { turnId: args.turnId });
        return null;
      }
    } catch (error) {
      log("agent_dispatch_owner_unavailable", {
        turnId: args.turnId,
        message: readableError(error),
      });
      return null;
    }
    let execution: CloudExecutionSelection;
    try {
      execution =
        args.execution ?? (await resolveOwnerExecution(ctx, args.ownerId));
    } catch (error) {
      await fail(readableError(error));
      return null;
    }
    let allowance: { audience: ManagedModelAudience; budgetMicroCents: number };
    try {
      allowance = await ownerModelAllowanceFields(
        ctx,
        args.ownerId,
        args.ownerGeneration,
      );
    } catch (error) {
      if (error instanceof ConvexError) {
        await fail(readableError(error));
        return null;
      }
      throw error;
    }
    try {
      await startBuilderAgentTurn({
        request: {
          ownerId: args.ownerId,
          ownerGeneration: args.ownerGeneration,
          conversationId: args.conversationId,
          threadId: args.threadId,
          agentDepth: 1,
          attemptGeneration: args.attemptGeneration,
          turnId: args.turnId,
          prompt: args.prompt,
          description: args.description,
          execution,
          audience: allowance.audience,
          budgetMicroCents: allowance.budgetMicroCents,
          source: args.source,
          ...(args.clientMsgId ? { clientMsgId: args.clientMsgId } : {}),
          ...(args.parentTurnId ? { parentTurnId: args.parentTurnId } : {}),
          ...(args.workspaceForkId
            ? { workspace: "fork", workspaceForkId: args.workspaceForkId }
            : {}),
          ...(args.originDeviceId
            ? { originDeviceId: args.originDeviceId }
            : {}),
          ...(args.originConversationId
            ? { originConversationId: args.originConversationId }
            : {}),
          ...(args.browserResume ? { browserResume: args.browserResume } : {}),
        },
      });
      return null;
    } catch (error) {
      const definitive =
        isBuilderTurnError(error) &&
        (!error.retryable || error.code === "unconfigured");
      if (definitive || dispatchAttempt >= MAX_DISPATCH_ATTEMPTS) {
        log("agent_dispatch_failed", {
          turnId: args.turnId,
          dispatchAttempt,
          message: readableError(error),
        });
        await fail(
          isBuilderTurnError(error) && !error.retryable
            ? error.message
            : "Stella couldn't start that agent. Try again in a moment.",
        );
        return null;
      }
      log("agent_dispatch_retrying", {
        turnId: args.turnId,
        dispatchAttempt,
        message: readableError(error),
      });
      await ctx.scheduler.runAfter(
        RETRY_DELAY_MS,
        internal.cloud_agent_dispatch.dispatchCloudAgentTurnInternal,
        { ...args, dispatchAttempt: dispatchAttempt + 1 },
      );
      return null;
    }
  },
});
