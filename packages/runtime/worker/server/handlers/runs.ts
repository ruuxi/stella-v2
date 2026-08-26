import { Effect } from "effect";
import {
  METHOD_NAMES,
  type RuntimeAttachmentRef,
  type RuntimeLocalAgentRequest,
  type RuntimeOneShotCompletionRequest,
} from "@stella/contracts/protocol";
import {
  RunnerUnavailableError,
  WorkerNotInitializedError,
} from "../errors.js";
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
      return yield* fromPromise(() =>
        session.agentRuns.runAutomation(
          params as {
            conversationId: string;
            userPrompt: string;
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
          },
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
      return yield* fromPromise(() =>
        runner.runBlockingLocalAgent({
          ...payload,
          agentType: payload.agentType ?? "general",
        }),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CREATE_BACKGROUND_AGENT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(
        () => new RunnerUnavailableError(),
      );
      const payload = params as RuntimeLocalAgentRequest;
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
