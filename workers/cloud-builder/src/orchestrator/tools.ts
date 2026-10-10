import { piBrainHandoffPrompt } from "@stella/contracts/turn-plane/pi-brain";
import type { AgentTool } from "@stella/runtime/kernel/agent-core/types.js";
import {
  AGENT_STATUS_TOOL_DESCRIPTOR,
  AGENT_STATUS_TOOL_REPLAY,
  parseSpawnDestination,
  PAUSE_AGENT_TOOL_DESCRIPTOR,
  PAUSE_AGENT_TOOL_REPLAY,
  SEND_MESSAGE_TOOL_DESCRIPTOR,
  SEND_MESSAGE_TOOL_REPLAY,
  SPAWN_AGENT_TOOL_DESCRIPTOR,
} from "@stella/runtime/kernel/tools/defs/agent-orchestration-def.js";
import type { TSchema } from "@sinclair/typebox";
import {
  agentDirectoryStatus,
  agentMessageResult,
  sendAgentMessage,
  sessionStatus,
} from "../agent-messaging.js";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { AgentHome } from "../agent-home.js";
import { createWorldMemory, ownerMemoryWorld } from "../world-memory.js";
import type { CloudSkillCatalogSnapshot } from "../cloud-home-store.js";
import { resolveCloudSpawnExecution } from "../cloud-spawn-model.js";
import { sha256Hex } from "../hash.js";
import { WORLD_ROOT, worldName } from "../workspace.js";
import {
  agentThreadElsewhereError,
  agentThreadElsewhereStatus,
  cancelDeviceAgent,
  continueDeviceAgent,
  DEVICE_AGENT_QUEUED_NOTE,
  type DeviceAgentCaller,
  readDeviceAgent,
  resolveConversationAgentThread,
  spawnDeviceAgent,
} from "../device-agent-tools.js";
import { STELLA_MESSAGE_TARGET } from "@stella/contracts/agent-directory";
import {
  type CloudAgentControlReceipt,
  type CloudAgentToolKind,
  dispatchCloudAgentTurn,
  isCloudAgentControlActive,
  agentStatusResult as sharedAgentStatusResult,
  pauseResult as sharedPauseResult,
  toolFingerprint as sharedToolFingerprint,
  toolScopedId as sharedToolScopedId,
  steerContainerAgent,
} from "../cloud-agent-dispatch.js";
import { stellaPromptTools } from "@stella/contracts/stella-prompts";
import { runHistoryQuery } from "../history-sql.js";
import {
  type CloudCodeSourceAgentTool,
  createCloudCodeAgentTool,
} from "../cloud-code-tool.js";
import { createCloudImageGenTool } from "../cloud-image-gen-tool.js";
import { createCloudWebTool } from "../cloud-web-tool.js";
import { createCloudHtmlTool } from "../cloud-html-tool.js";
import { unwrapRpc } from "../owner-store/errors.js";
import { createCloudDriveTool } from "../cloud-drive-tool.js";
import { createCloudSwitchDestinationTool } from "../cloud-switch-destination-tool.js";
import { createCloudReadTool } from "../cloud-read-tool.js";
import {
  createDriveFileSession,
  createWorldFilesWithDrive,
  runWorldToolWithDrive,
  type WorldStoreTools,
} from "../world-drive-files.js";
import { worldRelativeToolPath } from "../world/path.js";
import { createCloudScheduleTools } from "../cloud-schedule-tools.js";
import {
  type CloudConnectorDeclines,
  CloudConnectorDirectory,
  createCloudConnectClient,
} from "../cloud-connect-client.js";
import {
  listIntegrationActions,
  listIntegrationCatalog,
} from "../integrations/catalog.js";
import {
  type CloudConnectorConnectionOutcome,
  type CloudConnectorConnectionRequest,
  createCloudConnectorStatusTool,
} from "../cloud-connector-status-tool.js";
import { createCloudMapTool } from "../cloud-map-tool.js";
import { createCloudAskUserTool } from "../cloud-ask-user-tool.js";
import { mapsServerKey } from "../maps/google-resolve.js";
import { toolRequiresExplicitApproval } from "@stella/runtime/kernel/tools/code-tool.js";
import { sleepWithAbort } from "@stella/runtime/kernel/tools/effect-runtime.js";
import { BACKFILL_BATCH_RECORDS } from "../conversation-types.js";
import type { ChatTurnRequest, BrainHandoff } from "./types.js";
import {
  CONNECT_CARD_WAIT_MS,
  CONNECT_CARD_POLL_MS,
  BRAIN_HANDOFF_KEY,
  PI_HARNESS_AGENT_TOOL_NAMES,
} from "./constants.js";
import { OrchestratorPi } from "./pi.js";

/** The orchestrator's tool set and connector connection requests. */
export abstract class OrchestratorTools extends OrchestratorPi {
  /**
   * The cloud orchestrator's tool catalog: the desktop orchestrator's exact
   * model-visible contract (`orchestrator.md`'s allowlist — code, html,
   * image_gen, web, map, Read, spawn_agent, send_message, pause_agent,
   * agent_status — plus the demoted schedule_* and connector_status tools
   * reachable inside code, and the `connect`, `history` and `memory` clients
   * inside code). The model reads one description and
   * calls one shape on either host; only the execution behind each tool
   * differs, and every cloud-specific difference is stated in the cloud
   * session overlay.
   *
   * Code-pinned on purpose — frontmatter allowlists are agent-writable home
   * data on desktop; in the cloud the execution surface is never data-driven.
   */
  protected async createTools(
    turn: ChatTurnRequest,
    agentHome: AgentHome,
    skillCatalog: CloudSkillCatalogSnapshot,
    memoryEnabled: boolean,
    /**
     * `pi`: the tools for a pi-durable conversation, whose harness has the
     * agent tools itself, so code's `tools.<name>` never reaches this loop's.
     */
    harness?: "pi",
  ): Promise<{
    tools: AgentTool[];
    promptTools: ReadonlySet<string>;
    /** Code and every other tool, demoted ones included. */
    catalog: readonly CloudCodeSourceAgentTool[];
  }> {
    const toolContext = {
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      conversationId: turn.conversationId,
      ownerInternal: async (name: string, args: unknown) =>
        unwrapRpc(
          await this.ownerGate(turn.ownerId).ownerInternal({
            name,
            args,
            ownerGeneration: turn.ownerGeneration,
          }),
        ),
    };
    // Resolved on first use: a turn that never reads a world file never
    // touches the world Durable Object. `drive/` is not in the world: a Read
    // under it reaches the user's drive itself (`world-drive-files.ts`).
    const worldBinding = this.env.WORLDS as typeof this.env.WORLDS | undefined;
    const world = worldBinding
      ? (() => {
          const store = async () =>
            worldBinding.getByName(await worldName(turn.ownerId));
          const worldTools: WorldStoreTools = {
            tool: async (call) => await (await store()).tool(call),
            stat: async (path) => await (await store()).stat(path),
            list: async (prefix, options) =>
              await (await store()).list(prefix, options),
            readFile: async (path, options) =>
              await (await store()).readFile(path, options),
            writeFile: async (path, bytes, options) =>
              await (await store()).writeFile(path, bytes, options),
            remove: async (path, options) =>
              await (await store()).remove(path, options),
            rename: async (from, to) => await (await store()).rename(from, to),
          };
          const drive = createDriveFileSession({
            turnId: turn.turnId,
            call: toolContext.ownerInternal,
          });
          const files = createWorldFilesWithDrive(worldTools, drive);
          return {
            tool: async (call: {
              name: "Read";
              arguments: Record<string, unknown>;
            }) => await runWorldToolWithDrive(call, worldTools, drive),
            // Read's image branch: the world's own Read is line-oriented and
            // refuses binaries, so pixels come from the files directly.
            stat: async (path: string) =>
              await files.stat(worldRelativeToolPath(path, WORLD_ROOT)),
            readFile: async (
              path: string,
              options?: { offset?: number; length?: number },
            ) =>
              await files.readFile(
                worldRelativeToolPath(path, WORLD_ROOT),
                options ?? {},
              ),
          };
        })()
      : undefined;
    const declines = this.connectorDeclines();
    // Connectors belong to the account: the same Store integrations the
    // desktop app connected, from the global catalog and the owner object.
    // One directory per turn memoizes the catalog and the owner's live
    // connections for every connect.* call and status check.
    const connectors = new CloudConnectorDirectory({
      source: {
        catalog: () => listIntegrationCatalog(this.env),
        actions: (args) => listIntegrationActions(this.env, args),
        connections: async () =>
          (await toolContext.ownerInternal("integrations.connections", {})) as {
            connections: Array<{ id: string; connected: boolean }>;
          },
        run: (args) => toolContext.ownerInternal("integrations.run", args),
      },
      declines,
    });

    /**
     * A deterministic id for one tool call, UUID-shaped so it can name a
     * Durable Object and travel wherever a turn id does. Deterministic on
     * purpose: a retried tool call after a lost response reaches the same
     * BuildSession with the same turn id, and both the gate and the session
     * classify it as a replay instead of admitting a second agent.
     */
    const toolScopedId = async (
      purpose: "thread" | "turn" | "message",
      toolCallId: string,
    ): Promise<string> =>
      await sharedToolScopedId({
        ownerGeneration: turn.ownerGeneration,
        parentTurnId: turn.turnId,
        purpose,
        toolCallId,
      });
    const deviceCaller: DeviceAgentCaller = {
      ownerInternal: toolContext.ownerInternal,
      ownerGeneration: turn.ownerGeneration,
      conversationId: turn.conversationId,
      parentTurnId: turn.turnId,
    };
    const threadNotFound = (threadId: string) =>
      new Error(
        `Thread not found in this conversation: ${threadId}. agent_status without a thread_id lists who you can reach.`,
      );
    /** An agent this conversation controls, or null for anyone else. */
    const ownConversationAgentControl = async (
      threadId: string,
    ): Promise<CloudAgentControlReceipt | null> => {
      try {
        return await this.requireCloudAgentControlReceipt(threadId, "any");
      } catch {
        const found = await resolveConversationAgentThread(
          deviceCaller,
          threadId,
        ).catch(() => null);
        return found?.kind === "adopted"
          ? await this.rememberCloudAgentControlReceipt(found.control)
          : null;
      }
    };
    const requirePausableAgentControl = async (
      threadId: string,
    ): Promise<CloudAgentControlReceipt> => {
      try {
        return await this.requireCloudAgentControlReceipt(threadId, "any");
      } catch {
        const found = await resolveConversationAgentThread(
          deviceCaller,
          threadId,
        ).catch(() => null);
        if (!found) throw threadNotFound(threadId);
        if (found.kind === "elsewhere") {
          throw agentThreadElsewhereError(found);
        }
        return await this.rememberCloudAgentControlReceipt(found.control);
      }
    };

    /**
     * Dispatch one agent attempt straight to its BuildSession. Admission is
     * the owner gate's agent lane; the
     * BuildSession mints its own capabilities from the owner id, generation,
     * audience and budget carried here — the parent's control-plane
     * capability is never shared with it.
     */
    const dispatchAgentTurn = async (
      args: {
        threadId: string;
        attemptGeneration: number;
        turnId: string;
        clientMsgId: string;
        description: string;
        prompt: string;
        execution: CloudExecutionSelection;
      },
      signal?: AbortSignal,
    ): Promise<CloudAgentControlReceipt> =>
      await dispatchCloudAgentTurn({
        dependencies: {
          env: this.env,
          ownerGateAdmit: async (input) =>
            await this.ownerGateAdmit(input.ownerId, {
              lane: "agent",
              turnId: input.turnId,
              conversationId: input.conversationId,
              expectedGeneration: input.expectedGeneration,
            }),
          releaseOwnerGate: async (input) => await this.releaseOwnerGate(input),
          deliverOwnerEvents: async (events) =>
            await this.deferOwnerEvents([...events]),
          // An agent on Stella's models runs in this conversation, at once.
          startPiThread: async (input) => await this.startPiThread(input),
        },
        caller: {
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          conversationId: turn.conversationId,
          parentTurnId: turn.turnId,
          agentDepth: 0,
        },
        attempt: args,
        ...(signal ? { signal } : {}),
      });

    const toolFingerprint = async (
      kind: CloudAgentToolKind,
      semanticInput: unknown,
    ): Promise<string> =>
      await sharedToolFingerprint({
        ownerGeneration: turn.ownerGeneration,
        parentTurnId: turn.turnId,
        kind,
        semanticInput,
      });
    const agentStatusResult = (control: CloudAgentControlReceipt) =>
      sharedAgentStatusResult(control);
    const pauseResult = (
      control: CloudAgentControlReceipt,
      disposition: "paused" | "pending" | "already_terminal",
    ) => sharedPauseResult(control, disposition);

    const tools: CloudCodeSourceAgentTool[] = [
      {
        ...SPAWN_AGENT_TOOL_DESCRIPTOR,
        label: "Spawn agent",
        // The outcome ledger replays a committed spawn, and the child's thread
        // and turn ids derive from the tool call id, so a rerun of a lost
        // dispatch is classified as a replay by the gate and the session.
        replay: "keyed",
        parameters:
          SPAWN_AGENT_TOOL_DESCRIPTOR.parameters as unknown as TSchema,
        execute: async (toolCallId, params, signal) => {
          const args = params as {
            description: string;
            prompt: string;
            model?: string;
            destination?: string;
          };
          const model = args.model?.trim();
          const destination = parseSpawnDestination(args.destination);
          // Parsed before the replay read so an invalid override fails the
          // same way every time, without consulting the ledger. A device
          // checks the model against its own routes instead.
          const execution =
            destination.kind === "device"
              ? turn.execution
              : resolveCloudSpawnExecution(model, turn.execution);
          const fingerprint = await toolFingerprint("spawn_agent", {
            description: args.description,
            prompt: args.prompt,
            model: model && model !== "default" ? model : null,
            device: destination.kind === "device" ? destination.deviceId : null,
          });
          let outcome = await this.readCloudAgentToolOutcome(
            turn,
            toolCallId,
            "spawn_agent",
            fingerprint,
          );
          let waitingForDevice = false;
          if (!outcome && destination.kind === "device") {
            const admitted = await spawnDeviceAgent(deviceCaller, {
              clientMsgId: await toolScopedId("turn", toolCallId),
              targetDeviceId: destination.deviceId,
              description: args.description,
              prompt: args.prompt,
              ...(model && model !== "default" ? { model } : {}),
              // Inherited from the turn, not asked of the model. Telling it to
              // forward drive paths is what produced an agent hunting a local
              // filesystem for `uploads/...`; the device resolves these itself.
              ...(turn.attachments?.length
                ? { attachments: turn.attachments }
                : {}),
            });
            waitingForDevice = admitted.waitingForDevice === true;
            outcome = await this.commitCloudAgentToolOutcome(
              turn,
              toolCallId,
              "spawn_agent",
              fingerprint,
              admitted,
            );
          }
          if (!outcome) {
            const admitted = await dispatchAgentTurn(
              {
                threadId: await toolScopedId("thread", toolCallId),
                attemptGeneration: 1,
                turnId: await toolScopedId("turn", toolCallId),
                clientMsgId: await toolScopedId("turn", toolCallId),
                description: args.description,
                prompt: args.prompt,
                execution,
              },
              signal,
            );
            outcome = await this.commitCloudAgentToolOutcome(
              turn,
              toolCallId,
              "spawn_agent",
              fingerprint,
              admitted,
            );
          }
          const control = outcome.control;
          return {
            content: [
              {
                type: "text",
                text: waitingForDevice
                  ? `Queued agent (thread_id: ${control.threadId}, status: queued, description: "${args.description}", device_id: ${control.executorDeviceId}). ${DEVICE_AGENT_QUEUED_NOTE} Either way an [Agent completed] or [Agent failed] message will arrive on this conversation. Stop it with pause_agent.`
                  : `Spawned agent (thread_id: ${control.threadId}, status: running, description: "${args.description}"${control.executorDeviceId ? `, device_id: ${control.executorDeviceId}` : ""}). It is running in the background and has NOT finished — an [Agent completed] message will arrive on this conversation with its report. Check on it with agent_status, steer it with send_message, or stop it with pause_agent.`,
              },
            ],
            details: {
              thread_id: control.threadId,
              status: "running",
              ...(waitingForDevice ? { waiting_for_device: true } : {}),
              description: args.description,
              attempt_generation: control.attemptGeneration,
              thread_updated_at: control.threadUpdatedAt,
              ...(control.executorDeviceId
                ? { device_id: control.executorDeviceId }
                : {}),
            },
          };
        },
      },
      {
        ...SEND_MESSAGE_TOOL_DESCRIPTOR,
        label: "Send message",
        replay: SEND_MESSAGE_TOOL_REPLAY,
        parameters:
          SEND_MESSAGE_TOOL_DESCRIPTOR.parameters as unknown as TSchema,
        execute: async (toolCallId, params, signal) => {
          const args = params as {
            thread_id: string;
            message: string;
          };
          const threadId = args.thread_id.trim();
          if (
            threadId === STELLA_MESSAGE_TARGET ||
            threadId === turn.conversationId
          ) {
            throw new Error(
              `${threadId} is you: you are Stella for this conversation. Message an agent or another session by its thread_id.`,
            );
          }
          const fingerprint = await toolFingerprint("send_message", {
            threadId,
            message: args.message,
          });
          let outcome = await this.readCloudAgentToolOutcome(
            turn,
            toolCallId,
            "send_message",
            fingerprint,
          );
          if (!outcome) {
            const prior = await ownConversationAgentControl(threadId);
            if (!prior) {
              return agentMessageResult(
                await sendAgentMessage(toolContext, {
                  messageId: await toolScopedId("message", toolCallId),
                  to: threadId,
                  text: args.message,
                  from: { threadId: turn.conversationId, label: "Stella" },
                }),
              );
            }
            let admitted: CloudAgentControlReceipt;
            let disposition: "steered" | "resumed";
            if (prior.executorDeviceId) {
              admitted = await continueDeviceAgent(deviceCaller, prior, {
                controlRequestId: await toolScopedId("turn", toolCallId),
                message: args.message,
              });
              // A running device agent is steered in place; a finished one
              // starts its next attempt.
              disposition =
                admitted.attemptGeneration === prior.attemptGeneration
                  ? "steered"
                  : "resumed";
            } else if (isCloudAgentControlActive(prior.status)) {
              const steer = {
                ownerId: turn.ownerId,
                ownerGeneration: turn.ownerGeneration,
                threadId: prior.threadId,
                messageId: await toolScopedId("turn", toolCallId),
                text: args.message,
              };
              // A pi agent here, or else an agent in its own container.
              const piSteered = await this.steerPiThread(steer);
              const steered =
                piSteered.accepted || piSteered.reason === "not_running"
                  ? piSteered
                  : await steerContainerAgent({ ...steer, env: this.env });
              if (!steered.accepted && steered.reason === "busy") {
                throw new Error(
                  `${prior.threadId} is starting up or just finishing in its container. Send the message again in a moment.`,
                );
              }
              if (steered.accepted) {
                if (steered.attemptGeneration !== prior.attemptGeneration) {
                  throw new Error(
                    `${prior.threadId} was continued while this message was in flight. Refresh its status and try again.`,
                  );
                }
                admitted = {
                  ...prior,
                  turnId: steered.turnId,
                  status: "running",
                  threadUpdatedAt: Math.max(
                    Date.now(),
                    prior.threadUpdatedAt + 1,
                  ),
                };
                disposition = "steered";
              } else {
                admitted = await dispatchAgentTurn(
                  {
                    threadId: prior.threadId,
                    attemptGeneration: prior.attemptGeneration + 1,
                    turnId: await toolScopedId("turn", toolCallId),
                    clientMsgId: await toolScopedId("turn", toolCallId),
                    description: prior.description ?? "Continued task",
                    prompt: args.message,
                    execution: prior.execution ?? turn.execution,
                  },
                  signal,
                );
                disposition = "resumed";
              }
            } else {
              admitted = await dispatchAgentTurn(
                {
                  threadId: prior.threadId,
                  attemptGeneration: prior.attemptGeneration + 1,
                  turnId: await toolScopedId("turn", toolCallId),
                  clientMsgId: await toolScopedId("turn", toolCallId),
                  description: prior.description ?? "Continued task",
                  prompt: args.message,
                  execution: prior.execution ?? turn.execution,
                },
                signal,
              );
              disposition = "resumed";
            }
            outcome = await this.commitCloudAgentToolOutcome(
              turn,
              toolCallId,
              "send_message",
              fingerprint,
              admitted,
              disposition,
            );
          }
          const control = outcome.control;
          return {
            content: [
              {
                type: "text",
                text:
                  outcome.disposition === "steered"
                    ? `Delivered to ${control.threadId}. It is still working and will use the new instruction before its next model call.`
                    : `Delivered to ${control.threadId}. It is working again — an [Agent completed] message will arrive with its report.`,
              },
            ],
            details: {
              thread_id: control.threadId,
              attempt_generation: control.attemptGeneration,
              thread_updated_at: control.threadUpdatedAt,
              steered: outcome.disposition === "steered",
            },
          };
        },
      },
      {
        ...AGENT_STATUS_TOOL_DESCRIPTOR,
        label: "Agent status",
        replay: AGENT_STATUS_TOOL_REPLAY,
        parameters:
          AGENT_STATUS_TOOL_DESCRIPTOR.parameters as unknown as TSchema,
        execute: async (_toolCallId, params) => {
          const args = params as { thread_id?: string };
          const threadId = (args.thread_id ?? "").trim();
          if (!threadId) {
            return await agentDirectoryStatus(toolContext, {
              conversationId: turn.conversationId,
            });
          }
          let control: CloudAgentControlReceipt;
          try {
            control = await this.requireCloudAgentControlReceipt(
              threadId,
              "any",
            );
          } catch {
            const found = await resolveConversationAgentThread(
              deviceCaller,
              threadId,
            ).catch(() => null);
            if (!found) {
              const session = await sessionStatus(
                toolContext,
                turn.conversationId,
                threadId,
              ).catch(() => null);
              if (session) return session;
              throw threadNotFound(threadId);
            }
            if (found.kind === "elsewhere") {
              return agentThreadElsewhereStatus(found);
            }
            control = await this.rememberCloudAgentControlReceipt(
              found.control,
            );
          }
          if (control.executorDeviceId) {
            control = await this.rememberCloudAgentControlReceipt(
              await readDeviceAgent(deviceCaller, control),
            );
          }
          return agentStatusResult(control);
        },
      },
      {
        ...PAUSE_AGENT_TOOL_DESCRIPTOR,
        label: "Pause agent",
        replay: PAUSE_AGENT_TOOL_REPLAY,
        parameters:
          PAUSE_AGENT_TOOL_DESCRIPTOR.parameters as unknown as TSchema,
        execute: async (toolCallId, params, signal) => {
          const args = params as { thread_id: string; reason?: string };
          const threadId = args.thread_id.trim();
          const fingerprint = await toolFingerprint("pause_agent", {
            threadId,
            reason: args.reason?.trim() || null,
          });
          const replay = await this.readCloudAgentToolOutcome(
            turn,
            toolCallId,
            "pause_agent",
            fingerprint,
          );
          if (replay) {
            return pauseResult(
              replay.control,
              replay.disposition === "pending" ||
                replay.disposition === "already_terminal"
                ? replay.disposition
                : "paused",
            );
          }
          const control = await requirePausableAgentControl(threadId);
          let disposition: "paused" | "pending" | "already_terminal";
          let finalControl = control;
          if (!isCloudAgentControlActive(control.status)) {
            disposition = "already_terminal";
          } else if (control.executorDeviceId) {
            disposition = "paused";
            finalControl = await this.rememberCloudAgentControlReceipt(
              await cancelDeviceAgent(
                deviceCaller,
                control,
                await sha256Hex(
                  JSON.stringify([
                    "pause_agent",
                    turn.turnId,
                    control.threadId,
                    toolCallId,
                  ]),
                ),
              ),
            );
          } else {
            if (!control.turnId) {
              throw new Error(
                `${control.threadId} has no exact running turn to pause. Wait for its latest lifecycle update and try again.`,
              );
            }
            // An agent on Stella's models runs here as a pi agent: it stops,
            // and its canceled report wakes this conversation.
            const paused = await this.pausePiThread({
              ownerId: turn.ownerId,
              ownerGeneration: turn.ownerGeneration,
              threadId: control.threadId,
              turnId: control.turnId,
              attemptGeneration: control.attemptGeneration,
            });
            if (paused === "changed") {
              throw new Error(
                `${control.threadId} was continued while it was being paused. Try again if the newer turn should also stop.`,
              );
            }
            if (paused !== "unknown") {
              disposition =
                paused === "terminal" ? "already_terminal" : "pending";
            } else {
              const cancelRequestId = await sha256Hex(
                JSON.stringify([
                  "pause_agent",
                  turn.turnId,
                  control.threadId,
                  toolCallId,
                ]),
              );
              // The BuildSession atomically claims cancellation, stops the
              // process, and delivers the terminal lifecycle wake. A
              // pre-dispatch pause is persisted there and consumed as soon as
              // the delayed turn arrives.
              const teardown = await this.env.BUILD_SESSIONS.getByName(
                control.threadId,
              ).fetch("https://build-session/cancel", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  ownerId: turn.ownerId,
                  ownerGeneration: turn.ownerGeneration,
                  turnId: control.turnId,
                  attemptGeneration: control.attemptGeneration,
                  cancelRequestId,
                  reason: "Paused by orchestrator.",
                }),
                ...(signal ? { signal } : {}),
              });
              const teardownResult = (await teardown
                .json()
                .catch(() => ({}))) as {
                canceled?: boolean;
                pending?: boolean;
                reason?: string;
              };
              if (teardown.status === 409) {
                if (teardownResult.reason === "terminal_already_decided") {
                  disposition = "already_terminal";
                } else {
                  throw new Error(
                    `${control.threadId} was continued while it was being paused. Try again if the newer turn should also stop.`,
                  );
                }
              } else if (!teardown.ok) {
                throw new Error(
                  `Could not pause ${control.threadId}. Try again.`,
                );
              } else if (
                teardown.status === 202 &&
                teardownResult.pending === true
              ) {
                disposition = "pending";
              } else {
                disposition = "paused";
                // The BuildSession decided the terminal; its lifecycle wake
                // repeats the same status and advances nothing further.
                finalControl = await this.rememberCloudAgentControlReceipt({
                  ...control,
                  status: "canceled",
                  threadUpdatedAt: Math.max(
                    Date.now(),
                    control.threadUpdatedAt + 1,
                  ),
                });
              }
            }
          }
          const outcome = await this.commitCloudAgentToolOutcome(
            turn,
            toolCallId,
            "pause_agent",
            fingerprint,
            finalControl,
            disposition,
          );
          return pauseResult(
            outcome.control,
            outcome.disposition === "pending" ||
              outcome.disposition === "already_terminal"
              ? outcome.disposition
              : disposition,
          );
        },
      },
      createCloudWebTool({ ownerInternal: toolContext.ownerInternal }),
      createCloudImageGenTool({
        ownerGeneration: turn.ownerGeneration,
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        ownerInternal: toolContext.ownerInternal,
        publishFiles: (writerKey, files) =>
          this.publishTurnFilesCard(turn.turnId, writerKey, files),
      }),
      createCloudHtmlTool({
        turnId: turn.turnId,
        ownerInternal: toolContext.ownerInternal,
        publishFiles: (writerKey, files) =>
          this.publishTurnFilesCard(turn.turnId, writerKey, files),
      }),
      createCloudMapTool({
        apiKey: mapsServerKey(this.env),
        ownerInternal: toolContext.ownerInternal,
      }),
      createCloudAskUserTool({
        conversationId: turn.conversationId,
        ownerInternal: toolContext.ownerInternal,
      }),
      createCloudReadTool({
        ...(agentHome.available
          ? { skills: { home: agentHome.cloudStore(), snapshot: skillCatalog } }
          : {}),
        ...(world ? { world } : {}),
      }),
      createCloudDriveTool({ ownerInternal: toolContext.ownerInternal }),
      ...createCloudScheduleTools(toolContext),
      createCloudConnectorStatusTool({
        directory: connectors,
        declines,
        requestConnection: (request, signal) =>
          this.requestCloudConnectorConnection(
            turn,
            toolContext.ownerInternal,
            request,
            signal,
          ),
      }),
    ];
    // The orchestrator's memory files are world files; with memory off it has
    // no `memory` client at all. Each write holds to the memory epoch it
    // started in, so one running when a wipe begins cannot undo it.
    const memory =
      memoryEnabled && worldBinding
        ? createWorldMemory(
            () => ownerMemoryWorld(worldBinding, turn.ownerId),
            agentHome.memoryEpochFence(),
          )
        : undefined;
    const codeTool = await createCloudCodeAgentTool({
      loader: this.env.LOADER,
      tools:
        harness === "pi"
          ? tools.filter((tool) => !PI_HARNESS_AGENT_TOOL_NAMES.has(tool.name))
          : tools,
      executionScope: `${turn.ownerGeneration}:${turn.conversationId}:${turn.turnId}`,
      connect: createCloudConnectClient(connectors),
      ...(memory ? { memory } : {}),
      ...(memoryEnabled
        ? {
            history: {
              sql: (query: string, params: readonly SqlStorageValue[]) =>
                runHistoryQuery(this.ctx.storage, query, params),
              read: (fromSeq: number, toSeq: number) =>
                this.archive.readRange(
                  Math.max(0, fromSeq),
                  toSeq,
                  BACKFILL_BATCH_RECORDS,
                ),
            },
          }
        : {}),
    });
    // Demotion, the device rule: with code in the active set a demoted tool
    // leaves the direct list and is callable only as tools.<name> inside
    // code. Approval-bearing tools stay direct so nested code can never
    // bypass their top-level approval flow.
    const direct = tools.filter(
      (tool) => !tool.demoted || toolRequiresExplicitApproval(tool.approval),
    );
    // Claude Code's Stella moves herself to one of the owner's computers
    // with this; pi's has it in her own harness. Direct only, never inside
    // code, and left out of the prompt's tools: the cloud prompt's
    // `switch_destination` text is pi's, which moves tools too.
    const switchDestination =
      harness === "pi"
        ? []
        : [
            createCloudSwitchDestinationTool({
              devices: async () =>
                (await this.ownerGate(turn.ownerId).devices()).devices,
              workingAgents: () => this.workingAgentDescriptions(),
              move: async (host, brief, toolCallId) => {
                await this.putTurnState({
                  [BRAIN_HANDOFF_KEY]: {
                    turnId: turn.turnId,
                    ownerId: turn.ownerId,
                    ownerGeneration: turn.ownerGeneration,
                    deviceId: host.deviceId,
                    clientMsgId: await toolScopedId("message", toolCallId),
                    prompt: piBrainHandoffPrompt("the cloud", brief),
                  } satisfies BrainHandoff,
                });
                await this.setPiBrain({ host: "device", ...host });
              },
            }),
          ];
    return {
      tools: [codeTool, ...direct, ...switchDestination],
      catalog: [codeTool, ...tools],
      // The prompt renders against everything this turn can call, demoted
      // tools inside code included, and `history` and `memory` only when
      // code has them.
      promptTools: stellaPromptTools(
        [codeTool.name, ...tools.map((tool) => tool.name)],
        { history: memoryEnabled, memory: memory !== undefined },
      ),
    };
  }

  /**
   * The user's memory of connect offers they declined, so the card is never
   * re-shown for that connector in this conversation.
   */
  protected connectorDeclines(): CloudConnectorDeclines {
    const key = (id: string) => `connector_decline:${id}`;
    return {
      isDeclined: async (id) =>
        (await this.ctx.storage.get<boolean>(key(id))) === true,
      recordDecline: async (id) => {
        await this.ctx.storage.put(key(id), true);
      },
    };
  }

  /**
   * Show the inline connect card and wait for the answer. The card is a
   * pending request row in the owner object that every signed-in client
   * watches (`connect.pending`); the user's answer
   * either finishes the account-level Composio connection or declines.
   * Polling is the wait: the turn holds the tool call open while the row
   * moves through pending → connecting → connected/declined/expired.
   */
  protected async requestCloudConnectorConnection(
    turn: ChatTurnRequest,
    ownerInternal: (name: string, args: unknown) => Promise<unknown>,
    request: CloudConnectorConnectionRequest,
    signal?: AbortSignal,
  ): Promise<CloudConnectorConnectionOutcome> {
    const post = async (
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const { action, ...args } = body;
      const card =
        action === "create"
          ? await ownerInternal("connect.request", {
              conversationId: turn.conversationId,
              turnId: turn.turnId,
              ...args,
            })
          : await ownerInternal(
              action === "cancel" ? "connect.cancel" : "connect.poll",
              args,
            );
      return { request: card ?? {} };
    };
    const readRequest = (payload: Record<string, unknown>) => {
      const record =
        payload.request && typeof payload.request === "object"
          ? (payload.request as Record<string, unknown>)
          : payload;
      return {
        requestId: typeof record.requestId === "string" ? record.requestId : "",
        state: typeof record.state === "string" ? record.state : "",
        expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : 0,
      };
    };
    let created: ReturnType<typeof readRequest>;
    try {
      created = readRequest(
        await post({
          action: "create",
          integrationId: request.id,
          name: request.name,
          ...(request.description ? { description: request.description } : {}),
          ...(request.iconUrl ? { iconUrl: request.iconUrl } : {}),
          ...(request.category ? { category: request.category } : {}),
          ...(request.reason ? { reason: request.reason } : {}),
        }),
      );
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "unsupported",
      };
    }
    if (!created.requestId) return { ok: false, reason: "unsupported" };
    const deadline = Math.min(
      created.expiresAt || Number.MAX_SAFE_INTEGER,
      Date.now() + CONNECT_CARD_WAIT_MS,
    );
    const cancel = async () => {
      await post({ action: "cancel", requestId: created.requestId }).catch(
        () => undefined,
      );
    };
    while (true) {
      if (signal?.aborted) {
        await cancel();
        return { ok: false, reason: "cancelled" };
      }
      let state: string;
      try {
        state = readRequest(
          await post({ action: "poll", requestId: created.requestId }),
        ).state;
      } catch {
        state = "";
      }
      if (state === "connected") return { ok: true, status: "connected" };
      if (state === "declined") return { ok: false, reason: "declined" };
      if (state === "canceled") return { ok: false, reason: "cancelled" };
      if (state === "expired" || Date.now() >= deadline) {
        await cancel();
        return { ok: false, reason: "timeout" };
      }
      // An abort just ends the wait; the loop's next check cancels the card.
      await sleepWithAbort(
        CONNECT_CARD_POLL_MS,
        signal,
        () => new Error("Connect card wait aborted."),
      ).catch(() => undefined);
    }
  }
}
