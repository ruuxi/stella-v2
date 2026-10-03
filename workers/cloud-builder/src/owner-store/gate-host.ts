/**
 * What `OwnerGate` lends the owner-store domains: its snapshot, and direct
 * calls into the BuildSession and OrchestratorSession objects the domains
 * start, stop and annotate. These used to be Convex callbacks over the
 * service secret; now they are object-to-object calls.
 */

import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import {
  CloudAgentDispatchRefused,
  dispatchCloudAgentTurn,
} from "../cloud-agent-dispatch.js";
import { OwnerPurgeFenceError } from "../build-session/shared/errors.js";
import {
  ConversationEditHttpError,
  runConversationEdit,
} from "../conversation-edit-runner.js";
import { withOwnerActivityLease, type OwnerFenceCaller } from "../owner-activity-lease.js";
import type { OwnerEvent } from "@stella/contracts/turn-plane/owner-events";
import type {
  OwnerGateAdmission,
  OwnerGateAdmitInput,
  OwnerGateDispatchResult,
  OwnerGateSubmitInput,
} from "../owner-gate.js";
import { RpcError } from "./errors.js";
import { DispatchError, type AgentTurnDispatch, type OwnerHost } from "./registry.js";
import { startScheduledTurn } from "./scheduled-turn.js";

type GateHostEnv = Pick<
  Cloudflare.Env,
  "BUILD_SESSIONS" | "WORLDS" | "ORCHESTRATOR_SESSIONS"
> &
  Partial<Pick<Cloudflare.Env, "CLOUD_BUILDER_PUBLIC_URL">>;

export type GateHostDependencies = {
  ownerId: () => string;
  env: GateHostEnv;
  snapshot: () => Promise<OwnerSnapshot>;
  admit: (input: OwnerGateAdmitInput) => Promise<OwnerGateAdmission>;
  release: (input: { turnId: string }) => Promise<void>;
  /** The gate's own desktop dispatch. */
  submit: (input: OwnerGateSubmitInput) => Promise<OwnerGateDispatchResult>;
  /** Invalidate the gate's cached home context. */
  homeChanged: (ownerGeneration: string, revision: number) => Promise<void>;
  /** The gate's memory policy change, refusals as `RpcError`. */
  changeMemoryPolicy: OwnerHost["changeMemoryPolicy"];
  /** This object's owner fence, called in-process. */
  fence: OwnerFenceCaller;
  /** The gate's own `applyOwnerEvents`, called in-process. */
  applyOwnerEvents: (events: OwnerEvent[]) => Promise<void>;
  /** One reset or deletion pass across every store. */
  purgeOwner: OwnerHost["purgeOwner"];
  log: (level: "info" | "error", event: string, fields: Record<string, unknown>) => void;
};

export const createGateHost = (deps: GateHostDependencies): OwnerHost => ({
  snapshot: deps.snapshot,
  purgeOwner: deps.purgeOwner,

  async dispatchAgentTurn(input: AgentTurnDispatch): Promise<void> {
    try {
      await dispatchCloudAgentTurn({
        dependencies: {
          env: deps.env,
          ownerGateAdmit: async (admit) =>
            await deps.admit({
              lane: "agent",
              turnId: admit.turnId,
              conversationId: admit.conversationId,
              expectedGeneration: admit.expectedGeneration,
            }),
          releaseOwnerGate: async ({ turnId }) => await deps.release({ turnId }),
          deliverOwnerEvents: async (events) => await deps.applyOwnerEvents([...events]),
        },
        caller: {
          ownerId: deps.ownerId(),
          ownerGeneration: input.ownerGeneration,
          conversationId: input.conversationId,
          agentDepth: 0,
        },
        attempt: {
          threadId: input.threadId,
          attemptGeneration: input.attemptGeneration,
          turnId: input.turnId,
          clientMsgId: input.clientMsgId,
          description: input.description,
          prompt: input.prompt,
          execution: input.execution,
          source: input.browserResume ? "browser-resume" : "desktop",
          ...(input.originDeviceId ? { originDeviceId: input.originDeviceId } : {}),
          ...(input.originConversationId
            ? { originConversationId: input.originConversationId }
            : {}),
          ...(input.browserResume ? { browserResume: input.browserResume } : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DispatchError(message, !(error instanceof CloudAgentDispatchRefused));
    }
  },

  async cancelAgentTurn(input) {
    const response = await deps.env.BUILD_SESSIONS.getByName(input.threadId).fetch(
      "https://build-session/cancel",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerId: deps.ownerId(),
          ownerGeneration: input.ownerGeneration,
          turnId: input.turnId,
          attemptGeneration: input.attemptGeneration,
          cancelRequestId: input.cancelRequestId,
          reason: "Paused by orchestrator.",
        }),
      },
    );
    if (response.status === 409) return "changed";
    if (!response.ok) {
      throw new Error(`Stopping the agent failed (${response.status}).`);
    }
    return "canceled";
  },

  async postConversationCard(input) {
    try {
      const response = await deps.env.ORCHESTRATOR_SESSIONS.getByName(input.conversationId).fetch(
        "https://orchestrator-session/cards",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerId: deps.ownerId(),
            ownerGeneration: input.ownerGeneration,
            sourceTurnId: input.sourceTurnId,
            card: input.card,
          }),
        },
      );
      if (!response.ok) {
        deps.log("error", "conversation_card_refused", {
          conversationId: input.conversationId,
          status: response.status,
        });
      }
    } catch (error) {
      // A card is a receipt for work that already happened; losing one must
      // never fail anything else.
      deps.log("error", "conversation_card_failed", {
        conversationId: input.conversationId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async runConversationEdit(request) {
    try {
      return await withOwnerActivityLease(
        (path, body) => deps.fence(path, { ...body, ownerId: deps.ownerId() }),
        request.ownerGeneration,
        `conversation-edit:${request.operationId}`,
        async () => await runConversationEdit(deps.env, request),
      );
    } catch (error) {
      if (error instanceof ConversationEditHttpError) {
        throw new RpcError(
          error.status === 409 ? "CONFLICT" : error.status === 404 ? "NOT_FOUND" : "UNAVAILABLE",
          error.message,
        );
      }
      if (error instanceof OwnerPurgeFenceError) {
        throw new RpcError("CONFLICT", "Your cloud data is being reset. Try again in a moment.");
      }
      throw error;
    }
  },

  homeChanged: deps.homeChanged,

  changeMemoryPolicy: deps.changeMemoryPolicy,

  startScheduledTurn: async (input) => await startScheduledTurn(deps, input),
});
