import { Deferred, Effect } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import type { PiChatRequest, PiChatUsageRequest } from "@stella/contracts/pi-chat";
import type { DeviceToolCall } from "@stella/contracts/turn-plane/device-tools";
import { RunnerUnavailableError } from "../errors.js";
import * as HostBus from "../host-bus.js";
import { piChatRequest } from "../pi-chats.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

/** A cloud agent's tool calls running here, by request id: each one's stop. */
const deviceToolStops = new Map<string, () => void>();

export const piChatHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_PI_CHAT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(() => new RunnerUnavailableError());
      const hostBus = yield* HostBus.Service;
      // Who is signed in lives on the runner.
      yield* session.runner.initialized;
      return yield* fromPromise(async () =>
        piChatRequest(session, hostBus, params as PiChatRequest | PiChatUsageRequest),
      );
    }),

  // A cloud agent's call, run with this computer's tool host until it ends
  // or the host stops it (`INTERNAL_WORKER_CANCEL_DEVICE_TOOL`).
  [METHOD_NAMES.INTERNAL_WORKER_RUN_DEVICE_TOOL]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(() => new RunnerUnavailableError());
      yield* session.runner.initialized;
      const runner = session.runnerCell.get();
      if (!runner) return yield* Effect.fail(new RunnerUnavailableError());
      const { requestId, call } = params as { requestId: string; call: DeviceToolCall };
      const stopped = Deferred.makeUnsafe<void>();
      deviceToolStops.set(requestId, () => {
        Deferred.doneUnsafe(stopped, Effect.void);
      });
      return yield* Effect.raceFirst(
        Effect.tryPromise({ try: (signal) => runner.piTools.runDevice(call, signal), catch: (error) => error }),
        Deferred.await(stopped).pipe(Effect.as({ text: "The call was stopped.", isError: true })),
      ).pipe(Effect.ensuring(Effect.sync(() => deviceToolStops.delete(requestId))));
    }),

  [METHOD_NAMES.INTERNAL_WORKER_CANCEL_DEVICE_TOOL]: (params) =>
    Effect.sync(() => {
      deviceToolStops.get((params as { requestId: string }).requestId)?.();
      return { ok: true as const };
    }),
};
