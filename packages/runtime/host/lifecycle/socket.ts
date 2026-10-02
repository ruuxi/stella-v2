import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { Effect, Exit, type Scope } from "effect";
import {
  STELLA_RUNTIME_READY_METHOD,
  type RuntimeInitializeResult,
} from "@stella/contracts/protocol";
import { runtimeIpcPathUsesFilesystem } from "../../worker/runtime-paths.js";
import {
  describeRuntimeServerIdentityMismatch,
  parseRuntimeServerIdentity,
  type ExpectedRuntimeServerIdentity,
  type RuntimeServerIdentity,
} from "../../worker/server-identity.js";
import { WorkerNotReadyError } from "./errors.js";

/**
 * UDS attach + readiness probe. The probe is a raw JSON-RPC line exchange on
 * a throwaway socket (scoped: destroyed the moment the probe settles); the
 * peer-bound socket is a second, clean connection so the normal JsonRpcPeer
 * owns the stream from byte zero — identical to the old two-connection
 * handshake.
 */

const WORKER_READY_PROBE_ID = "__stella_runtime_ready_probe__";

export type ReadyProbeStatus =
  | "ready"
  | "version-mismatch"
  | "identity-mismatch"
  | "unavailable";

/**
 * The probe's verdict plus the identity the runtime reported (null for a
 * pre-identity runtime, or when the probe got no answer).
 */
export type ReadyProbeResult = {
  status: ReadyProbeStatus;
  identity: RuntimeServerIdentity | null;
  /** Why the identity was refused, for "identity-mismatch". */
  mismatch?: string;
};

export type ReadySocketResult =
  | { status: "ready"; socket: Socket; identity: RuntimeServerIdentity | null }
  | { status: "version-mismatch" | "unavailable"; identity: RuntimeServerIdentity | null }
  | { status: "identity-mismatch"; identity: RuntimeServerIdentity | null; mismatch: string };

const unavailableProbe: ReadyProbeResult = {
  status: "unavailable",
  identity: null,
};

/**
 * Connect to the worker socket, failing WorkerNotReadyError when the path is
 * absent, the connection is refused, or `timeoutMs` elapses. The deadline is
 * `Effect.timeoutOrElse`: its interrupt (like any external interruption)
 * destroys the pending socket via the callback's cleanup effect, then maps
 * to the same WorkerNotReadyError the old internal timer produced.
 */
const connectSocket = (
  socketPath: string,
  timeoutMs: number,
): Effect.Effect<Socket, WorkerNotReadyError> =>
  Effect.suspend(() => {
    if (runtimeIpcPathUsesFilesystem(socketPath) && !existsSync(socketPath)) {
      return Effect.fail(new WorkerNotReadyError({ socketPath }));
    }
    return Effect.callback<Socket, WorkerNotReadyError>((resume) => {
      let socket: Socket;
      try {
        socket = createConnection(socketPath);
      } catch {
        resume(Effect.fail(new WorkerNotReadyError({ socketPath })));
        return;
      }
      let settled = false;
      const finish = (result: Socket | null) => {
        if (settled) return;
        settled = true;
        if (result == null) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          resume(Effect.fail(new WorkerNotReadyError({ socketPath })));
          return;
        }
        resume(Effect.succeed(result));
      };
      socket.once("connect", () => {
        socket.setNoDelay(true);
        finish(socket);
      });
      socket.once("error", () => {
        finish(null);
      });
      return Effect.sync(() => {
        if (!settled) {
          settled = true;
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        }
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new WorkerNotReadyError({ socketPath })),
      }),
    );
  });

/**
 * One-shot readiness probe over an already-connected socket: write the probe
 * request, parse newline-delimited JSON until the matching id answers.
 * Malformed or unrelated lines are ignored (the worker may interleave other
 * traffic); errors and the timeout resolve "unavailable" — never a failure,
 * matching the old probe's tri-state result. With `expectedIdentity`, the
 * reported identity must also match (see `worker/server-identity.ts`).
 */
const probeWorkerRpcReadiness = (
  socket: Socket,
  timeoutMs: number,
  expectedProtocolVersion?: string,
  expectedIdentity?: ExpectedRuntimeServerIdentity,
): Effect.Effect<ReadyProbeResult> =>
  Effect.callback<ReadyProbeResult>((resume) => {
    let buffer = "";
    let settled = false;
    const finish = (result: ReadyProbeResult) => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      resume(Effect.succeed(result));
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as {
              id?: unknown;
              result?: unknown;
              error?: unknown;
            };
            if (message.id === WORKER_READY_PROBE_ID) {
              if (message.error) {
                finish(unavailableProbe);
                return;
              }
              const result = message.result as
                | (Partial<RuntimeInitializeResult> & { identity?: unknown })
                | undefined;
              const identity = parseRuntimeServerIdentity(result?.identity);
              if (
                expectedProtocolVersion &&
                result?.protocolVersion !== expectedProtocolVersion
              ) {
                finish({ status: "version-mismatch", identity });
                return;
              }
              const mismatch = expectedIdentity
                ? describeRuntimeServerIdentityMismatch(
                    expectedIdentity,
                    identity,
                  )
                : null;
              if (mismatch) {
                finish({ status: "identity-mismatch", identity, mismatch });
                return;
              }
              finish({ status: "ready", identity });
              return;
            }
          } catch {
            // Ignore unrelated malformed probe data and keep waiting.
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    };
    const onError = () => finish(unavailableProbe);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(
      `${JSON.stringify({
        id: WORKER_READY_PROBE_ID,
        method: STELLA_RUNTIME_READY_METHOD,
      })}\n`,
    );
    return Effect.sync(() => {
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
    });
  }).pipe(
    // Deadline as Effect.timeoutOrElse: the timeout interrupt detaches the
    // probe listeners via the cleanup effect, then resolves "unavailable" —
    // never a failure, matching the old probe's tri-state result.
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.succeed(unavailableProbe),
    }),
  );

/**
 * Probe on a scoped throwaway socket, then — only when ready — hand back a
 * clean peer socket. The clean socket is acquired into the AMBIENT scope
 * with an exit-aware release: it survives a successful attach (ownership
 * passes to the caller's JsonRpcPeer) but is destroyed when the attach
 * scope closes in failure or interruption, so an interrupted attach cannot
 * leak a connected socket.
 */
export const connectReadySocket = (
  socketPath: string,
  timeoutMs: number,
  expectedProtocolVersion?: string,
  expectedIdentity?: ExpectedRuntimeServerIdentity,
): Effect.Effect<ReadySocketResult, never, Scope.Scope> =>
  Effect.gen(function* () {
    const probed = yield* Effect.scoped(
      Effect.gen(function* () {
        const probeSocket = yield* Effect.acquireRelease(
          connectSocket(socketPath, timeoutMs),
          (socket) =>
            Effect.sync(() => {
              try {
                socket.destroy();
              } catch {
                // ignore
              }
            }),
        );
        return yield* probeWorkerRpcReadiness(
          probeSocket,
          timeoutMs,
          expectedProtocolVersion,
          expectedIdentity,
        );
      }),
    ).pipe(Effect.catch(() => Effect.succeed(unavailableProbe)));
    if (probed.status === "identity-mismatch") {
      return {
        status: "identity-mismatch",
        identity: probed.identity,
        mismatch: probed.mismatch ?? "identity mismatch",
      };
    }
    if (probed.status !== "ready") {
      return { status: probed.status, identity: probed.identity };
    }
    const probedIdentity = probed.identity;
    const socket = yield* Effect.acquireRelease(
      connectSocket(socketPath, timeoutMs),
      (acquired, exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.sync(() => {
              try {
                acquired.destroy();
              } catch {
                // ignore
              }
            }),
    ).pipe(
      Effect.map(
        (acquired): ReadySocketResult => ({
          status: "ready",
          socket: acquired,
          identity: probedIdentity,
        }),
      ),
      Effect.catch(() =>
        Effect.succeed({
          status: "unavailable",
          identity: null,
        } as ReadySocketResult),
      ),
    );
    return socket;
  });
