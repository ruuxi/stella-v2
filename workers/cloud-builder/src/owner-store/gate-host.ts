/**
 * What `OwnerGate` lends the owner-store domains: its snapshot, and direct
 * calls into the BuildSession and OrchestratorSession objects the domains
 * start, stop and annotate. These used to be control-plane callbacks over the
 * service secret; now they are object-to-object calls.
 */

import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import { PLACEMENT_PROTOCOL, type DeviceDestination } from "@stella/contracts/turn-plane/placement";
import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
  type CloudTurnStartRequest,
} from "@stella/contracts/turn-plane/turn-start";
import {
  CloudAgentDispatchRefused,
  dispatchCloudAgentTurn,
  steerCloudAgent,
} from "../cloud-agent-dispatch.js";
import { HEADER_CONVERSATION_ID, ORCHESTRATOR_INTERNAL_ORIGIN } from "../build-session/shared/keys.js";
import {
  agentCompletionPromptText,
  agentLifecycleReport,
} from "../build-session/terminal-delivery.js";
import { HEADER_OWNER } from "../conversation-types.js";
import { HEADER_TURN_AUTH_KIND } from "../turn-start-request.js";
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
  OwnerGateCancelInput,
  OwnerGateDispatchResult,
  OwnerGateStatusResult,
  OwnerGateSubmitInput,
} from "../owner-gate.js";
import { RpcError } from "./errors.js";
import { DispatchError, type AgentTurnDispatch, type OwnerHost } from "./registry.js";
import { startScheduledTurn } from "./scheduled-turn.js";

/** Idempotency keys of the dispatches the agent-thread ledger submits. */
export const DEVICE_AGENT_DISPATCH_PREFIX = "agent-thread:";

export const deviceAgentDispatchKey = (turnId: string, requeue = 0): string =>
  requeue > 0
    ? `${DEVICE_AGENT_DISPATCH_PREFIX}${turnId}:r${requeue}`
    : `${DEVICE_AGENT_DISPATCH_PREFIX}${turnId}`;

export const parseDeviceAgentDispatchKey = (
  key: string,
): { turnId: string; requeue: number } | null => {
  if (!key.startsWith(DEVICE_AGENT_DISPATCH_PREFIX)) return null;
  const match = /^([^:]+)(?::r(\d+))?$/u.exec(key.slice(DEVICE_AGENT_DISPATCH_PREFIX.length));
  if (!match) return null;
  return { turnId: match[1]!, requeue: match[2] ? Number(match[2]) : 0 };
};

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
  /** The gate's steer of a running device agent. */
  steerDispatch: OwnerHost["steerDeviceAgentTurn"];
  /** The gate's message to an agent a device runs locally. */
  messageLocalAgent: OwnerHost["messageLocalAgent"];
  /** The gate's own dispatch cancellation. */
  cancelDispatch: (input: OwnerGateCancelInput) => Promise<OwnerGateStatusResult>;
  /** The gate's devices, with live presence. */
  devices: () => Promise<{ devices: DeviceDestination[] }>;
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

/** A service-authenticated turn start on a conversation's orchestrator. */
const startOrchestratorTurn = async (
  deps: GateHostDependencies,
  target: { conversationId: string; ownerGeneration: string },
  body: CloudTurnStartRequest,
): Promise<Response> =>
  await deps.env.ORCHESTRATOR_SESSIONS.getByName(target.conversationId).fetch(
    `${ORCHESTRATOR_INTERNAL_ORIGIN}/turn`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER_OWNER]: deps.ownerId(),
        [HEADER_TURN_AUTH_KIND]: "service",
        [HEADER_CONVERSATION_ID]: target.conversationId,
        [TURN_OWNER_GENERATION_HEADER]: target.ownerGeneration,
      },
      body: JSON.stringify(body),
    },
  );

export const createGateHost = (deps: GateHostDependencies): OwnerHost => ({
  snapshot: deps.snapshot,
  purgeOwner: deps.purgeOwner,

  deviceDestinations: async () => (await deps.devices()).devices,

  async dispatchDeviceAgentTurn(input) {
    const result = await deps.submit({
      request: {
        protocol: PLACEMENT_PROTOCOL,
        // One dispatch per recorded attempt, so a retried job replays it.
        idempotencyKey: deviceAgentDispatchKey(input.turnId, input.requeue ?? 0),
        kind: "agent",
        ingress: input.requestingDeviceId ? "desktop" : "cloud",
        // The requester named this device; never hand the work to the cloud.
        subject: "computer",
        targetMode: "device",
        targetDeviceId: input.targetDeviceId,
        ...(input.requestingDeviceId ? { requestingDeviceId: input.requestingDeviceId } : {}),
        conversationId: input.conversationId,
        threadId: input.threadId,
        requiredCapabilities: ["agent"],
        payload: {
          schemaVersion: 1,
          prompt: input.prompt,
          conversationId: input.conversationId,
          clientMsgId: input.turnId,
          description: input.description,
          threadId: input.threadId,
          ...(input.model ? { model: input.model } : {}),
          // Same key and shape the chat placement uses, so the device's
          // `placementAttachmentPaths` reads both dispatch kinds identically.
          ...(input.attachments?.length
            ? { attachments: [...input.attachments] }
            : {}),
        },
      },
      expectedGeneration: input.ownerGeneration,
    });
    if (!result.ok) {
      throw new DispatchError(result.error.message, result.error.retryable);
    }
    const dispatch = result.response.dispatch;
    if (dispatch.state === "blocked" || dispatch.state === "failed") {
      throw new DispatchError(
        dispatch.errorMessage ?? "The device could not take the work. It may be offline or busy.",
        false,
        dispatch.errorCode,
      );
    }
    return { dispatchId: dispatch.dispatchId };
  },

  steerDeviceAgentTurn: (input) => deps.steerDispatch(input),

  messageLocalAgent: (input) => deps.messageLocalAgent(input),

  async steerAgentTurn(input) {
    const steered = await steerCloudAgent({
      env: deps.env,
      threadId: input.threadId,
      message: {
        id: input.messageId.slice(0, 256),
        kind: input.kind ?? "input",
        text: input.text,
        createdAt: Date.now(),
      },
    });
    return steered.accepted;
  },

  async cancelDeviceAgentTurn(input) {
    const result = await deps.cancelDispatch({
      dispatchId: input.dispatchId,
      cancelRequestId: input.cancelRequestId,
      reason: input.reason,
    });
    if (!result.ok && result.error.code !== "not_found") {
      throw new RpcError(
        result.error.retryable ? "UNAVAILABLE" : "CONFLICT",
        result.error.message,
      );
    }
  },

  async deliverAgentCompletion(input) {
    const text = agentCompletionPromptText(input);
    if (input.parentThreadId) {
      const steered = await steerCloudAgent({
        env: deps.env,
        threadId: input.parentThreadId,
        message: {
          id: `wake:${input.threadId}:${input.attemptGeneration}`.slice(0, 256),
          kind:
            input.status === "completed"
              ? "child_completed"
              : input.status === "canceled"
                ? "child_canceled"
                : "child_failed",
          text,
          threadId: input.threadId,
          attemptGeneration: input.attemptGeneration,
          createdAt: input.threadUpdatedAt,
        },
      });
      if (steered.accepted) return;
    }
    const response = await startOrchestratorTurn(deps, input, {
      protocol: TURN_PLANE_PROTOCOL,
      clientMsgId: `wake:${input.threadId}:${input.attemptGeneration}`.slice(0, 64),
      prompt: text,
      lane: "wake",
      source: "agent-thread",
      hiddenMessage: true,
      agentThreadControl: {
        lifecycleReport: agentLifecycleReport(input),
        threadId: input.threadId,
        attemptGeneration: input.attemptGeneration,
        threadUpdatedAt: input.threadUpdatedAt,
        status: input.status,
      },
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new Error(`Agent completion wake was refused (${response.status}).`);
    }
  },

  async startAgentMessageTurn(input) {
    const response = await startOrchestratorTurn(deps, input, {
      protocol: TURN_PLANE_PROTOCOL,
      clientMsgId: input.clientMsgId,
      prompt: input.prompt,
      lane: "wake",
      source: "agent-thread",
      hiddenMessage: true,
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown; retryable?: unknown };
    } | null;
    const retryable = body?.error?.retryable === true || response.status >= 500;
    throw new RpcError(
      retryable ? "UNAVAILABLE" : "CONFLICT",
      typeof body?.error?.message === "string"
        ? `That Stella session did not take the message: ${body.error.message}`
        : `That Stella session did not take the message (${response.status}).`,
      retryable ? { retryable: true } : undefined,
    );
  },

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
          ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
          agentDepth: input.parentThreadId ? 1 : 0,
        },
        attempt: {
          threadId: input.threadId,
          attemptGeneration: input.attemptGeneration,
          turnId: input.turnId,
          clientMsgId: input.clientMsgId,
          description: input.description,
          prompt: input.prompt,
          execution: input.execution,
          source: input.browserResume
            ? "browser-resume"
            : input.originDeviceId
              ? "desktop"
              : "agent-thread",
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
