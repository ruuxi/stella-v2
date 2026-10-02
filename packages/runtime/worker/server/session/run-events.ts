import { Context, Effect, Layer } from "effect";
import {
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from "@stella/contracts/agent-runtime";
import { NOTIFICATION_NAMES } from "@stella/contracts/protocol";
import * as HostBus from "../host-bus.js";
import * as SessionStorage from "./storage.js";
import type { AgentEventPayload } from "../types.js";
import { RunAdmissionStore } from "../../../kernel/storage/run-admission.js";
import { createRuntimeLogger } from "../../../kernel/debug.js";

const logger = createRuntimeLogger("worker.run-events");

/**
 * Streaming run-event emission and replay over the persistent ring buffer
 * (`kernel/storage/run-event-log.ts`). Every RUN_EVENT notification is
 * persisted BEFORE it goes on the wire so a host that disconnects mid-notify
 * still sees the event on reconnect.
 */
export interface Interface {
  /**
   * Persist + notify. Synchronous on purpose: the runner invokes the run
   * callbacks that call this from non-Effect code mid-stream.
   */
  readonly emit: (event: AgentEventPayload) => void;
  readonly resumeAfter: (args: {
    runId: string;
    lastSeq: number;
  }) => { events: AgentEventPayload[]; exhausted: boolean };
  readonly ack: (args: { runId: string; lastSeq: number }) => number;
  readonly listBufferedRuns: () => ReturnType<
    SessionStorage.Interface["runEventLog"]["listBufferedRuns"]
  >;
  /**
   * Close out runs the previous worker process left un-terminated, then start
   * the background prune sweeps (run events, thread summaries). Runs post-ready.
   */
  readonly startupBackfill: () => void;
}

export class Service extends Context.Service<Service, Interface>()(
  "@stella/runtime/worker/RunEventBus",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hostBus = yield* HostBus.Service;
    const { runEventLog, chatStore, db } = yield* SessionStorage.Service;
    const threadSummaryStore = chatStore.threadSummaryStore;
    // Rows written before this instant belong to a previous worker process.
    const sessionStartedAt = Date.now();

    // This layer sits between RunnerHandle and CliBridge in the session
    // chain, so on teardown the log stops right after the runner does —
    // `runner stop → runEventLog.stop → bridge stop → brokers cleared →
    // db.close`, the exact old stopWorkerServices order.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        runEventLog.stop();
        threadSummaryStore.stopBackgroundSweep();
      }),
    );

    const emit = (event: AgentEventPayload) => {
      // INSERT OR IGNORE collapses (runId, seq) collisions for the rare
      // synthetic terminal markers (e.g. seq=MAX_SAFE_INTEGER) — both copies
      // describe the same terminal state, so retaining the first is fine.
      runEventLog.append({
        runId: event.runId,
        seq: event.seq,
        payload: event as unknown as Record<string, unknown>,
      });
      hostBus.notify(NOTIFICATION_NAMES.RUN_EVENT, event);
    };

    return {
      emit,
      resumeAfter: ({ runId, lastSeq }) => {
        const result = runEventLog.resumeAfter({ runId, lastSeq });
        return {
          events: result.events.map(
            (record) => record.payload as unknown as AgentEventPayload,
          ),
          exhausted: result.exhausted,
        };
      },
      ack: ({ runId, lastSeq }) => runEventLog.ack({ runId, lastSeq }),
      listBufferedRuns: () => runEventLog.listBufferedRuns(),
      startupBackfill: () => {
        // Runs the durable-run recovery plan resumes this boot keep their
        // event stream open: the resumed run continues it (`run-task.ts`).
        const resumes = (runId: string): boolean => {
          try {
            return chatStore.runTasks.isResumeOwned(runId);
          } catch {
            return false;
          }
        };
        const resumedRunIds = new Set<string>();
        const bufferedRuns = runEventLog.listBufferedRuns();
        for (const buffered of bufferedRuns) {
          if (buffered.hasTerminalEvent) continue;
          if (resumes(buffered.runId)) {
            resumedRunIds.add(buffered.runId);
            continue;
          }
          runEventLog.append({
            runId: buffered.runId,
            seq: Number.MAX_SAFE_INTEGER,
            payload: {
              type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
              runId: buffered.runId,
              seq: Number.MAX_SAFE_INTEGER,
              conversationId: buffered.conversationId,
              outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
              reason: "worker_restart",
              error: "Stella restarted before this run could finish.",
              rootRunId: buffered.runId,
            },
          });
        }
        // A durable chat run the plan gave up on whose events were all acked
        // (pruned) still owes its client a terminal: without one a client
        // that saw it start keeps showing it as working.
        try {
          const buffered = new Set(bufferedRuns.map((run) => run.runId));
          for (const row of chatStore.runTasks.recoveryPlan().abandoned) {
            if (row.agentType !== "orchestrator" || buffered.has(row.runId)) {
              continue;
            }
            runEventLog.append({
              runId: row.runId,
              seq: Number.MAX_SAFE_INTEGER,
              payload: {
                type: AGENT_STREAM_EVENT_TYPES.RUN_FINISHED,
                runId: row.runId,
                seq: Number.MAX_SAFE_INTEGER,
                conversationId: row.conversationId,
                ...(row.abortRequested
                  ? {
                      outcome: AGENT_RUN_FINISH_OUTCOMES.CANCELED,
                      reason: "Canceled",
                    }
                  : {
                      outcome: AGENT_RUN_FINISH_OUTCOMES.ERROR,
                      reason: "worker_restart",
                      error: "Stella restarted before this run could finish.",
                    }),
                rootRunId: row.runId,
              },
            });
          }
        } catch (error) {
          logger.warn("run-task.abandoned-terminal-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Admissions left open by the dead process settle unless their run
        // resumes: nothing else will ever answer them.
        try {
          for (const row of chatStore.runTasks.recoveryPlan().resumable) {
            resumedRunIds.add(row.runId);
          }
          const settled = new RunAdmissionStore(db).settleStale({
            keepRunIds: resumedRunIds,
            updatedBefore: sessionStartedAt,
          });
          if (settled > 0) {
            logger.info("run-admission.stale-settled", { settled });
          }
        } catch (error) {
          logger.warn("run-admission.stale-settle-failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        runEventLog.startBackgroundSweep();
        // Recall's durable summaries live in the main database and have their
        // own retention bound; same post-ready slot as the run-event sweep.
        threadSummaryStore.startBackgroundSweep();
      },
    };
  }),
);
