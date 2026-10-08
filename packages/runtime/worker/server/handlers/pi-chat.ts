import { Effect } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import type { PiChatRequest } from "@stella/contracts/pi-chat";
import { RunnerUnavailableError } from "../errors.js";
import * as HostBus from "../host-bus.js";
import { piChatRequest } from "../pi-chats.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

export const piChatHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_PI_CHAT]: (params) =>
    Effect.gen(function* () {
      const session = yield* WorkerSessions.sessionOrFail(() => new RunnerUnavailableError());
      const hostBus = yield* HostBus.Service;
      // Who is signed in lives on the runner.
      yield* session.runner.initialized;
      return yield* fromPromise(async () =>
        piChatRequest(session, hostBus, params as PiChatRequest),
      );
    }),
};
