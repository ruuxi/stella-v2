import { Context, Effect, Layer } from "effect";
import {
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
} from "@stella/contracts/agent-runtime";
import { NOTIFICATION_NAMES } from "@stella/contracts/protocol";
import * as HostBus from "../host-bus.js";
import * as SessionStorage from "./storage.js";
import type { AgentEventPayload } from "../types.js";

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
   * Close out runs the previous worker process left un-terminated, then
   * start the background prune sweep. Runs post-ready.
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
    const { runEventLog } = yield* SessionStorage.Service;

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
        for (const buffered of runEventLog.listBufferedRuns()) {
          if (buffered.hasTerminalEvent) continue;
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
        runEventLog.startBackgroundSweep();
      },
    };
  }),
);
