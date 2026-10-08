import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import {
  AGENT_STATUS_TOOL_DESCRIPTOR,
  PAUSE_AGENT_TOOL_DESCRIPTOR,
  SEND_MESSAGE_TOOL_DESCRIPTOR,
  SPAWN_AGENT_TOOL_DESCRIPTOR,
  parseSpawnDestination,
} from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
import { STELLA_MESSAGE_TARGET } from "@stella/contracts/agent-directory";
import {
  agentDirectoryStatus,
  agentMessageResult,
  sendAgentMessage,
  sessionStatus,
} from "./agent-messaging.js";
import {
  DEVICE_AGENT_QUEUED_NOTE,
  agentThreadElsewhereStatus,
  cancelDeviceAgent,
  continueDeviceAgent,
  lookupConversationAgentThread,
  readDeviceAgent,
  spawnDeviceAgent,
  type DeviceAgentCaller,
} from "./device-agent-tools.js";
import { describeAgentThreadLookup } from "@stella/contracts/backend/agent-thread-lookup";
import { unwrapRpc } from "./owner-store/errors.js";
import {
  CLOUD_AGENT_DEPTH_LIMIT_ERROR,
  MAX_CLOUD_AGENT_DEPTH,
  agentStatusResult,
  commitCloudAgentToolOutcome,
  dispatchCloudAgentTurn,
  isCloudAgentControlActive,
  pauseResult,
  readCloudAgentToolOutcome,
  rememberCloudAgentControlReceipt,
  requireCloudAgentControlReceipt,
  steerCloudAgent,
  toolFingerprint,
  toolScopedId,
  type CloudAgentControlReceipt,
  type CloudAgentControlStorage,
  type CloudAgentDispatchAttempt,
  type CloudAgentDispatchDependencies,
  type CloudAgentToolKind,
} from "./cloud-agent-dispatch.js";
import type { GeneralAgentAgentControl } from "./general-agent-do-local-tools.js";
import { resolveCloudSpawnExecution } from "./cloud-spawn-model.js";
import { sha256Hex } from "./hash.js";

export type BuildSessionAgentControlParent = Readonly<{
  ownerId: string;
  ownerGeneration: string;
  conversationId: string;
  turnId: string;
  threadId: string;
  /** The agent that started this one; absent when Stella did. */
  parentThreadId?: string;
  /** This agent's description, which labels the messages it sends. */
  description: string;
  agentDepth: number;
  execution: CloudExecutionSelection;
}>;

export type BuildSessionAgentControlDependencies = Readonly<{
  storage: CloudAgentControlStorage;
  env: Pick<Cloudflare.Env, "BUILD_SESSIONS" | "OWNER_GATES">;
  dispatch: CloudAgentDispatchDependencies;
  parent: BuildSessionAgentControlParent;
  now?: () => number;
}>;

const textResult = (
  text: string,
  details: Record<string, unknown>,
): AgentToolResult<unknown> => ({
  content: [{ type: "text", text }],
  details,
});

export const createBuildSessionAgentControl = (
  deps: BuildSessionAgentControlDependencies,
): GeneralAgentAgentControl => {
  const now = deps.now ?? Date.now;
  const parent = deps.parent;
  const scopedId = async (
    purpose: "thread" | "turn" | "message",
    toolCallId: string,
  ): Promise<string> =>
    await toolScopedId({
      ownerGeneration: parent.ownerGeneration,
      parentTurnId: parent.turnId,
      purpose,
      toolCallId,
    });
  const fingerprint = async (
    kind: CloudAgentToolKind,
    semanticInput: unknown,
  ): Promise<string> =>
    await toolFingerprint({
      ownerGeneration: parent.ownerGeneration,
      parentTurnId: parent.turnId,
      kind,
      semanticInput,
    });
  const dispatch = async (
    attempt: CloudAgentDispatchAttempt,
    signal?: AbortSignal,
  ): Promise<CloudAgentControlReceipt> =>
    await dispatchCloudAgentTurn({
      dependencies: deps.dispatch,
      caller: {
        ownerId: parent.ownerId,
        ownerGeneration: parent.ownerGeneration,
        conversationId: parent.conversationId,
        parentTurnId: parent.turnId,
        parentThreadId: parent.threadId,
        agentDepth: parent.agentDepth,
      },
      attempt,
      ...(signal ? { signal } : {}),
    });
  const readOutcome = async (
    toolCallId: string,
    kind: CloudAgentToolKind,
    value: string,
  ) =>
    await readCloudAgentToolOutcome({
      storage: deps.storage,
      parentTurnId: parent.turnId,
      toolCallId,
      kind,
      fingerprint: value,
    });
  const commitOutcome = async (
    toolCallId: string,
    kind: CloudAgentToolKind,
    value: string,
    control: CloudAgentControlReceipt,
    disposition?:
      | "paused"
      | "pending"
      | "already_terminal"
      | "steered"
      | "resumed",
  ) =>
    await commitCloudAgentToolOutcome({
      storage: deps.storage,
      parentTurnId: parent.turnId,
      toolCallId,
      kind,
      fingerprint: value,
      value: control,
      ...(disposition ? { disposition } : {}),
    });

  const deviceCaller: DeviceAgentCaller = {
    ownerInternal: async (name, args) =>
      unwrapRpc(
        await deps.env.OWNER_GATES.getByName(parent.ownerId).ownerInternal({
          name,
          args,
          ownerGeneration: parent.ownerGeneration,
        }),
      ),
    ownerGeneration: parent.ownerGeneration,
    conversationId: parent.conversationId,
    parentTurnId: parent.turnId,
    parentThreadId: parent.threadId,
  };

  return {
    execute: async (toolName, toolCallId, params, signal) => {
      if (toolName === SPAWN_AGENT_TOOL_DESCRIPTOR.name) {
        if (parent.agentDepth >= MAX_CLOUD_AGENT_DEPTH) {
          throw new Error(CLOUD_AGENT_DEPTH_LIMIT_ERROR);
        }
        const description =
          typeof params.description === "string" ? params.description : "";
        const prompt = typeof params.prompt === "string" ? params.prompt : "";
        const model =
          typeof params.model === "string" ? params.model.trim() : "";
        const destination = parseSpawnDestination(params.destination);
        // A device checks the model against its own routes instead.
        const execution =
          destination.kind === "device"
            ? parent.execution
            : resolveCloudSpawnExecution(model, parent.execution);
        const value = await fingerprint("spawn_agent", {
          description,
          prompt,
          model: model && model !== "default" ? model : null,
          device: destination.kind === "device" ? destination.deviceId : null,
        });
        let outcome = await readOutcome(toolCallId, "spawn_agent", value);
        let waitingForDevice = false;
        if (!outcome && destination.kind === "device") {
          const spawned = await spawnDeviceAgent(deviceCaller, {
            clientMsgId: await scopedId("turn", toolCallId),
            targetDeviceId: destination.deviceId,
            description,
            prompt,
            ...(model && model !== "default" ? { model } : {}),
          });
          waitingForDevice = spawned.waitingForDevice === true;
          outcome = await commitOutcome(
            toolCallId,
            "spawn_agent",
            value,
            spawned,
          );
        }
        if (!outcome) {
          const turnId = await scopedId("turn", toolCallId);
          const control = await dispatch(
            {
              threadId: await scopedId("thread", toolCallId),
              attemptGeneration: 1,
              turnId,
              clientMsgId: turnId,
              description,
              prompt,
              execution,
            },
            signal,
          );
          outcome = await commitOutcome(
            toolCallId,
            "spawn_agent",
            value,
            control,
          );
        }
        return textResult(
          waitingForDevice
            ? `Queued agent (thread_id: ${outcome.control.threadId}, status: queued, description: "${description}", device_id: ${outcome.control.executorDeviceId}). ${DEVICE_AGENT_QUEUED_NOTE} Either way an [Agent completed] or [Agent failed] message will arrive on this agent thread. Stop it with pause_agent.`
            : `Spawned agent (thread_id: ${outcome.control.threadId}, status: running, description: "${description}"${outcome.control.executorDeviceId ? `, device_id: ${outcome.control.executorDeviceId}` : ""}). It is running in the background and has NOT finished — an [Agent completed] message will arrive on this agent thread with its report. Check on it with agent_status, steer it with send_message, or stop it with pause_agent.`,
          {
            thread_id: outcome.control.threadId,
            status: "running",
            ...(waitingForDevice ? { waiting_for_device: true } : {}),
            description,
            ...(outcome.control.executorDeviceId
              ? { device_id: outcome.control.executorDeviceId }
              : {}),
            attempt_generation: outcome.control.attemptGeneration,
            thread_updated_at: outcome.control.threadUpdatedAt,
          },
        );
      }

      if (toolName === SEND_MESSAGE_TOOL_DESCRIPTOR.name) {
        const threadId =
          typeof params.thread_id === "string" ? params.thread_id.trim() : "";
        const message =
          typeof params.message === "string" ? params.message : "";
        const value = await fingerprint("send_message", { threadId, message });
        let outcome = await readOutcome(toolCallId, "send_message", value);
        if (!outcome) {
          const prior = await requireCloudAgentControlReceipt({
            storage: deps.storage,
            threadId,
          }).catch(() => null);
          if (!prior) {
            return agentMessageResult(
              await sendAgentMessage(deviceCaller, {
                messageId: await scopedId("message", toolCallId),
                to:
                  threadId === STELLA_MESSAGE_TARGET
                    ? parent.conversationId
                    : threadId,
                text: message,
                from: { threadId: parent.threadId, label: parent.description },
              }),
            );
          }
          let control: CloudAgentControlReceipt;
          let disposition: "steered" | "resumed";
          if (prior.executorDeviceId) {
            control = await continueDeviceAgent(deviceCaller, prior, {
              controlRequestId: await scopedId("turn", toolCallId),
              message,
            });
            // A running device agent is steered in place; a finished one
            // starts its next attempt.
            disposition =
              control.attemptGeneration === prior.attemptGeneration
                ? "steered"
                : "resumed";
          } else if (isCloudAgentControlActive(prior.status)) {
            const steered = await steerCloudAgent({
              env: deps.env,
              threadId,
              message: {
                id: await scopedId("turn", toolCallId),
                kind: "input",
                text: message,
                createdAt: now(),
              },
              ...(signal ? { signal } : {}),
            });
            if (steered.accepted) {
              if (steered.attemptGeneration !== prior.attemptGeneration) {
                throw new Error(
                  `${threadId} was continued while this message was in flight. Refresh its status and try again.`,
                );
              }
              control = {
                ...prior,
                turnId: steered.turnId,
                status: "running",
                threadUpdatedAt: Math.max(now(), prior.threadUpdatedAt + 1),
              };
              disposition = "steered";
            } else {
              const turnId = await scopedId("turn", toolCallId);
              control = await dispatch(
                {
                  threadId,
                  attemptGeneration: prior.attemptGeneration + 1,
                  turnId,
                  clientMsgId: turnId,
                  description: prior.description ?? "Continued task",
                  prompt: message,
                  execution: prior.execution ?? parent.execution,
                },
                signal,
              );
              disposition = "resumed";
            }
          } else {
            const turnId = await scopedId("turn", toolCallId);
            control = await dispatch(
              {
                threadId,
                attemptGeneration: prior.attemptGeneration + 1,
                turnId,
                clientMsgId: turnId,
                description: prior.description ?? "Continued task",
                prompt: message,
                execution: prior.execution ?? parent.execution,
              },
              signal,
            );
            disposition = "resumed";
          }
          outcome = await commitOutcome(
            toolCallId,
            "send_message",
            value,
            control,
            disposition,
          );
        }
        return textResult(
          outcome.disposition === "steered"
            ? `Delivered to ${outcome.control.threadId}. It is still working and will use the new instruction before its next model call.`
            : `Delivered to ${outcome.control.threadId}. It is working again — an [Agent completed] message will arrive with its report.`,
          {
            thread_id: outcome.control.threadId,
            attempt_generation: outcome.control.attemptGeneration,
            thread_updated_at: outcome.control.threadUpdatedAt,
            steered: outcome.disposition === "steered",
          },
        );
      }

      if (toolName === AGENT_STATUS_TOOL_DESCRIPTOR.name) {
        const threadId =
          typeof params.thread_id === "string" ? params.thread_id.trim() : "";
        if (!threadId) {
          return await agentDirectoryStatus(deviceCaller, {
            conversationId: parent.conversationId,
            threadId: parent.threadId,
            ...(parent.parentThreadId
              ? { parentThreadId: parent.parentThreadId }
              : {}),
          });
        }
        let control: CloudAgentControlReceipt;
        try {
          control = await requireCloudAgentControlReceipt({
            storage: deps.storage,
            threadId,
          });
        } catch {
          const thread = await lookupConversationAgentThread(
            deviceCaller,
            threadId,
          ).catch(() => null);
          if (thread) {
            return agentThreadElsewhereStatus({
              kind: "elsewhere",
              thread,
              text: describeAgentThreadLookup(thread, { host: "cloud" }),
            });
          }
          const session = await sessionStatus(
            deviceCaller,
            parent.conversationId,
            threadId,
          ).catch(() => null);
          if (session) return session;
          throw new Error(
            `Thread not found: ${threadId}. agent_status without a thread_id lists who you can reach.`,
          );
        }
        if (control.executorDeviceId) {
          control = await rememberCloudAgentControlReceipt(
            deps.storage,
            await readDeviceAgent(deviceCaller, control),
          );
        }
        return agentStatusResult(control, now());
      }

      if (toolName === PAUSE_AGENT_TOOL_DESCRIPTOR.name) {
        const threadId =
          typeof params.thread_id === "string" ? params.thread_id.trim() : "";
        const reason =
          typeof params.reason === "string" ? params.reason.trim() : "";
        const value = await fingerprint("pause_agent", {
          threadId,
          reason: reason || null,
        });
        const replay = await readOutcome(toolCallId, "pause_agent", value);
        if (replay) {
          return pauseResult(
            replay.control,
            replay.disposition === "pending" ||
              replay.disposition === "already_terminal"
              ? replay.disposition
              : "paused",
          );
        }
        const control = await requireCloudAgentControlReceipt({
          storage: deps.storage,
          threadId,
        });
        let finalControl = control;
        let disposition: "paused" | "pending" | "already_terminal";
        if (!isCloudAgentControlActive(control.status)) {
          disposition = "already_terminal";
        } else if (control.executorDeviceId) {
          disposition = "paused";
          finalControl = await rememberCloudAgentControlReceipt(
            deps.storage,
            await cancelDeviceAgent(
              deviceCaller,
              control,
              await sha256Hex(
                JSON.stringify(["pause_agent", parent.turnId, threadId, toolCallId]),
              ),
            ),
          );
        } else {
          if (!control.turnId) {
            throw new Error(
              `${threadId} has no exact running turn to pause. Wait for its latest lifecycle update and try again.`,
            );
          }
          const cancelRequestId = await sha256Hex(
            JSON.stringify([
              "pause_agent",
              parent.turnId,
              threadId,
              toolCallId,
            ]),
          );
          const response = await deps.env.BUILD_SESSIONS.getByName(
            threadId,
          ).fetch("https://build-session/cancel", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ownerId: parent.ownerId,
              ownerGeneration: parent.ownerGeneration,
              turnId: control.turnId,
              attemptGeneration: control.attemptGeneration,
              cancelRequestId,
              reason: "Paused by orchestrator.",
            }),
            ...(signal ? { signal } : {}),
          });
          const body = (await response.json().catch(() => ({}))) as {
            pending?: boolean;
            reason?: string;
          };
          if (response.status === 409) {
            if (body.reason !== "terminal_already_decided") {
              throw new Error(
                `${threadId} was continued while it was being paused. Try again if the newer turn should also stop.`,
              );
            }
            disposition = "already_terminal";
          } else if (!response.ok) {
            throw new Error(`Could not pause ${threadId}. Try again.`);
          } else if (response.status === 202 && body.pending === true) {
            disposition = "pending";
          } else {
            disposition = "paused";
            finalControl = await rememberCloudAgentControlReceipt(
              deps.storage,
              {
                ...control,
                status: "canceled",
                threadUpdatedAt: Math.max(now(), control.threadUpdatedAt + 1),
              },
            );
          }
        }
        const outcome = await commitOutcome(
          toolCallId,
          "pause_agent",
          value,
          finalControl,
          disposition,
        );
        return pauseResult(outcome.control, disposition);
      }

      throw new Error(`${toolName} is not an agent orchestration tool.`);
    },
  };
};
