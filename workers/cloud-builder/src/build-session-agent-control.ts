import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { AgentToolResult } from "@stella/runtime/kernel/agent-core/types.js";
import {
  AGENT_STATUS_TOOL_DESCRIPTOR,
  PAUSE_AGENT_TOOL_DESCRIPTOR,
  SEND_INPUT_TOOL_DESCRIPTOR,
  SPAWN_AGENT_TOOL_DESCRIPTOR,
} from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
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
  agentDepth: number;
  execution: CloudExecutionSelection;
}>;

export type BuildSessionAgentControlDependencies = Readonly<{
  storage: CloudAgentControlStorage;
  env: Pick<Cloudflare.Env, "BUILD_SESSIONS">;
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
    purpose: "thread" | "turn",
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
        const execution = resolveCloudSpawnExecution(model, parent.execution);
        const value = await fingerprint("spawn_agent", {
          description,
          prompt,
          model: model && model !== "default" ? model : null,
        });
        let outcome = await readOutcome(toolCallId, "spawn_agent", value);
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
          `Spawned agent (thread_id: ${outcome.control.threadId}, status: running, description: "${description}"). It is running in the background and has NOT finished — an [Agent completed] message will arrive on this agent thread with its report. Check on it with agent_status, steer it with send_input, or stop it with pause_agent.`,
          {
            thread_id: outcome.control.threadId,
            status: "running",
            description,
            attempt_generation: outcome.control.attemptGeneration,
            thread_updated_at: outcome.control.threadUpdatedAt,
          },
        );
      }

      if (toolName === SEND_INPUT_TOOL_DESCRIPTOR.name) {
        const threadId =
          typeof params.thread_id === "string" ? params.thread_id.trim() : "";
        const message =
          typeof params.message === "string" ? params.message : "";
        const value = await fingerprint("send_input", { threadId, message });
        let outcome = await readOutcome(toolCallId, "send_input", value);
        if (!outcome) {
          const prior = await requireCloudAgentControlReceipt({
            storage: deps.storage,
            threadId,
          });
          let control: CloudAgentControlReceipt;
          let disposition: "steered" | "resumed";
          if (isCloudAgentControlActive(prior.status)) {
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
            "send_input",
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
        if (!threadId) throw new Error("thread_id is required.");
        try {
          return agentStatusResult(
            await requireCloudAgentControlReceipt({
              storage: deps.storage,
              threadId,
            }),
            now(),
          );
        } catch {
          throw new Error(
            `Thread not found in this agent: ${threadId}. agent_status only sees agents spawned from this agent thread.`,
          );
        }
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
