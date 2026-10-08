import crypto from "node:crypto";
import { Effect } from "effect";
import {
  METHOD_NAMES,
  type RuntimeAttachmentRef,
  type RuntimeLocalAgentCancellationRequest,
  type RuntimeLocalAgentMessageRequest,
  type RuntimeLocalAgentSteerRequest,
  type RuntimeLocalAgentRequest,
  type RuntimeOneShotCompletionRequest,
  type RuntimePlacementAutomationCancellationRequest,
} from "@stella/contracts/protocol";
import {
  RunnerUnavailableError,
  WorkerNotInitializedError,
} from "../errors.js";
import * as HostBus from "../host-bus.js";
import { piChatsFor, piRuntimeEnabled } from "../pi-chats.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";
import type { AgentEventPayload } from "../types.js";

export const runsHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_GET_ACTIVE]: () =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      // Tolerate the runner still building (post-ready window): no runner ⇒
      // no active run.
      return (
        sessions.current()?.runnerCell.get()?.getActiveOrchestratorRun() ?? null
      );
    }),

  // Worker-side replay: read everything past `lastSeq` for `runId` from
  // the persistent ring buffer. This is the path Electron takes after a
  // restart — by the time the host reconnects, the in-memory host buffer
  // is gone but the worker still has every event.
  [METHOD_NAMES.INTERNAL_WORKER_RESUME_EVENTS]: (params) =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      const payload = params as { runId?: unknown; lastSeq?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!runId) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      const lastSeq = Number.isFinite(Number(payload?.lastSeq))
        ? Number(payload.lastSeq)
        : 0;
      const session = sessions.current();
      if (!session) {
        return { events: [] as AgentEventPayload[], exhausted: true };
      }
      return session.runEvents.resumeAfter({ runId, lastSeq });
    }),

  // Host ack — every event the host successfully forwards to the renderer
  // gets acked back so the worker can prune. Best-effort: under-acking
  // just retains rows longer; over-acking before the renderer actually
  // saw an event would lose it on reconnect, so the host should only
  // ack after `webContents.send` resolves.
  [METHOD_NAMES.INTERNAL_WORKER_ACK_EVENTS]: (params) =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      const payload = params as { runId?: unknown; lastSeq?: unknown };
      const runId =
        typeof payload?.runId === "string" ? payload.runId.trim() : "";
      const lastSeq = Number.isFinite(Number(payload?.lastSeq))
        ? Number(payload.lastSeq)
        : Number.NaN;
      if (!runId || !Number.isFinite(lastSeq)) {
        return { pruned: 0 };
      }
      const pruned = sessions.current()?.runEvents.ack({ runId, lastSeq }) ?? 0;
      return { pruned };
    }),

  // Probe used by a reconnecting host to discover which runs are still
  // worth subscribing to — combines the live runner's active run with
  // retained event-log rows (a run that just completed but whose terminal
  // event hasn't been acked is still resumable).
  [METHOD_NAMES.INTERNAL_WORKER_LIST_ACTIVE_RUNS]: () =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      const session = sessions.current();
      const runner = session?.runnerCell.get() ?? null;
      const activeRun = runner?.getActiveOrchestratorRun() ?? null;
      const activeAgentRuns = runner?.listActiveAgentRuns() ?? [];
      const result: Array<{
        runId: string;
        conversationId: string;
        kind: "active" | "buffered";
        uiVisibility?: "visible" | "hidden";
      }> = [];
      const seenRunIds = new Set<string>();
      if (activeRun) {
        result.push({
          runId: activeRun.runId,
          conversationId: activeRun.conversationId,
          kind: "active",
        });
        seenRunIds.add(activeRun.runId);
      }
      for (const agentRun of activeAgentRuns) {
        if (seenRunIds.has(agentRun.runId)) continue;
        result.push({
          runId: agentRun.runId,
          conversationId: agentRun.conversationId,
          kind: "active",
          uiVisibility: "hidden",
        });
        seenRunIds.add(agentRun.runId);
      }
      const activeRunId = activeRun?.runId ?? null;
      for (const buffered of session?.runEvents.listBufferedRuns() ?? []) {
        if (buffered.runId === activeRunId || seenRunIds.has(buffered.runId)) {
          continue;
        }
        result.push({
          runId: buffered.runId,
          conversationId: buffered.conversationId,
          kind: "buffered",
        });
      }
      return { runs: result };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_RUN_AUTOMATION]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const automation = params as {
        conversationId: string;
        userPrompt: string;
        rejectIfBusy?: boolean;
        executionPlacementRunId?: string;
        userMessageEventId?: string;
        userAuthoredPrompt?: boolean;
      };
      // On pi-durable the host's own turns (schedule fires, watch
      // escalations, heartbeats) run in the conversation's harness. A chat
      // placed here from another device keeps the loop until placement runs
      // on pi too.
      if (piRuntimeEnabled() && !automation.executionPlacementRunId) {
        const hostBus = yield* HostBus.Service;
        return yield* fromPromise(async () =>
          (await piChatsFor(session, hostBus)).automation(automation.conversationId, {
            requestId: automation.userMessageEventId || `automation:${crypto.randomUUID()}`,
            prompt: automation.userPrompt,
            visible: automation.userAuthoredPrompt === true,
            ...(automation.rejectIfBusy ? { rejectIfBusy: true } : {}),
          }),
        );
      }
      return yield* fromPromise(() =>
        session.agentRuns.runAutomation(
          params as {
            conversationId: string;
            userPrompt: string;
            rejectIfBusy?: boolean;
            executionPlacementRunId?: string;
            ownerGeneration?: string;
            agentType?: string;
            modelOverride?: string;
            toolWorkspaceRoot?: string;
            attachments?: RuntimeAttachmentRef[];
            connectorDeliveryTarget?: {
              requestId: string;
              conversationId: string;
              provider?: string;
              externalMessageId?: string;
            };
            userMessageEventId?: string;
            userAuthoredPrompt?: boolean;
          },
        ),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CANCEL_PLACEMENT_AUTOMATION]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as RuntimePlacementAutomationCancellationRequest;
      const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
      if (!runId) {
        throw new Error(
          "An execution-placement automation cancellation requires runId.",
        );
      }
      const runner = yield* fromPromise(() =>
        session.runner.ensureInitialized(),
      );
      return yield* fromPromise(() =>
        runner.cancelPlacementAutomation(
          runId,
          typeof payload.reason === "string" ? payload.reason : undefined,
        ),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_RUN_BLOCKING_AGENT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as RuntimeLocalAgentRequest;
      const runner = yield* fromPromise(() =>
        session.runner.ensureInitialized(),
      );
      // Before the agent starts, so its brief can name real paths. A failed
      // download fails the agent here rather than starting one that will
      // report it cannot find the file the user attached.
      const attachments = yield* fromPromise(() =>
        session.agentRuns.materializeAgentAttachments({
          conversationId: payload.conversationId,
          ...(payload.attachments ? { attachments: payload.attachments } : {}),
        }),
      );
      return yield* fromPromise(() =>
        runner.runBlockingLocalAgent({
          ...payload,
          agentType: payload.agentType ?? "general",
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_STEER_BLOCKING_AGENT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as RuntimeLocalAgentSteerRequest;
      const runner = yield* fromPromise(() =>
        session.runner.ensureInitialized(),
      );
      return yield* fromPromise(() =>
        runner.steerBlockingLocalAgent(
          String(payload.agentId ?? ""),
          String(payload.text ?? ""),
          String(payload.messageId ?? ""),
        ),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_DELIVER_AGENT_MESSAGE]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as RuntimeLocalAgentMessageRequest;
      const runner = yield* fromPromise(() =>
        session.runner.ensureInitialized(),
      );
      const outcome = yield* fromPromise(() =>
        runner.deliverLocalAgentMessage(
          String(payload.threadId ?? ""),
          String(payload.text ?? ""),
          String(payload.messageId ?? ""),
          String(payload.ownerGeneration ?? ""),
        ),
      );
      return { outcome };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CANCEL_BLOCKING_AGENT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as RuntimeLocalAgentCancellationRequest;
      const agentId =
        typeof payload.agentId === "string" ? payload.agentId.trim() : "";
      if (!agentId) {
        throw new Error(
          "A blocking local-agent cancellation requires agentId.",
        );
      }
      const runner = yield* fromPromise(() =>
        session.runner.ensureInitialized(),
      );
      return yield* fromPromise(() =>
        runner.cancelBlockingLocalAgent(
          agentId,
          typeof payload.reason === "string" ? payload.reason : undefined,
          typeof payload.executionId === "string"
            ? payload.executionId
            : undefined,
        ),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_AGENT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as RuntimeLocalAgentRequest;
      // On pi-durable an agent the app starts (an app-source merge, memory
      // sync) is a pi agent of the conversation's orchestrator.
      if (piRuntimeEnabled()) {
        const hostBus = yield* HostBus.Service;
        return yield* fromPromise(async () =>
          (await piChatsFor(session, hostBus)).startAgent(payload.conversationId, {
            key: payload.threadId || crypto.randomUUID(),
            description: payload.description,
            prompt: payload.prompt,
          }),
        );
      }
      const runner = yield* fromPromise(() =>
        session.runner.ensureInitialized(),
      );
      return yield* fromPromise(() =>
        runner.createBackgroundAgent({
          ...payload,
          agentType: payload.agentType ?? "general",
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_GET_AGENT_SNAPSHOT]: (params) =>
    Effect.gen(function* () {
      const sessions = yield* WorkerSessions.Service;
      // Tolerate the runner still building (post-ready window): a fresh
      // worker has no in-memory agent yet, so a missing snapshot is the
      // right answer.
      const runner = sessions.current()?.runnerCell.get() ?? null;
      if (!runner) return null;
      return yield* fromPromise(() =>
        runner.getLocalAgentSnapshot((params as { agentId: string }).agentId),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_APPEND_THREAD_MESSAGE]: (params) =>
    Effect.gen(function* () {
      // Don't drop the message if the runner is still building (post-ready
      // window) — wait for the background build, then append.
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const runner = yield* session.runner.joined;
      runner.appendThreadMessage(
        params as {
          threadKey: string;
          role: "user" | "assistant";
          content: string;
        },
      );
      return { ok: true };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_WEB_SEARCH]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as {
        query: string;
        category?: string;
      };
      const runner = yield* fromPromise(() =>
        session.runner.ensureInitialized(),
      );
      return yield* fromPromise(() =>
        runner.webSearch(payload.query, {
          category: payload.category,
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_ONE_SHOT_COMPLETION]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new WorkerNotInitializedError(),
      );
      return yield* fromPromise(() =>
        session.agentRuns.oneShotCompletion(
          params as RuntimeOneShotCompletionRequest,
        ),
      );
    }),
};
