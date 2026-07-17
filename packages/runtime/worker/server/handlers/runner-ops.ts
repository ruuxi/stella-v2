import { Effect } from "effect";
import { METHOD_NAMES } from "@stella/contracts/protocol";
import { RunnerUnavailableError } from "../errors.js";
import * as WorkerSessions from "../sessions.js";
import { fromPromise, type WorkerRpcHandlers } from "../rpc.js";

/**
 * Runner-hosted operations that require the runner to EXIST but not to have
 * finished initializing (the old `ensureRunner()` — no build join): store
 * browsing, shell process control, Google Workspace connection management.
 */
const runnerNow = Effect.flatMap(
  WorkerSessions.sessionOrFail(() => new RunnerUnavailableError()),
  (session) => session.runner.current,
);

export const runnerOpsHandlers: WorkerRpcHandlers = {
  [METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_PACKAGES]: () =>
    Effect.flatMap(runnerNow, (runner) =>
      fromPromise(() => runner.listStorePackages()),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_GET_STORE_PACKAGE]: (params) =>
    Effect.flatMap(runnerNow, (runner) =>
      fromPromise(() =>
        runner.getStorePackage((params as { packageId: string }).packageId),
      ),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_LIST_STORE_RELEASES]: (params) =>
    Effect.flatMap(runnerNow, (runner) =>
      fromPromise(() =>
        runner.listStorePackageReleases(
          (params as { packageId: string }).packageId,
        ),
      ),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_GET_STORE_RELEASE]: (params) =>
    Effect.flatMap(runnerNow, (runner) => {
      const payload = params as { packageId: string; releaseNumber: number };
      return fromPromise(() =>
        runner.getStorePackageRelease(payload.packageId, payload.releaseNumber),
      );
    }),

  [METHOD_NAMES.INTERNAL_WORKER_KILL_ALL_SHELLS]: () =>
    Effect.map(runnerNow, (runner) => {
      runner.killAllShells();
      return { ok: true };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_KILL_SHELL_BY_PORT]: (params) =>
    Effect.map(runnerNow, (runner) => {
      runner.killShellsByPort((params as { port: number }).port);
      return { ok: true };
    }),

  [METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_AUTH_STATUS]: () =>
    Effect.flatMap(runnerNow, (runner) =>
      fromPromise(() => runner.googleWorkspaceGetAuthStatus()),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_CONNECT]: () =>
    Effect.flatMap(runnerNow, (runner) =>
      fromPromise(() => runner.googleWorkspaceConnect()),
    ),

  [METHOD_NAMES.INTERNAL_WORKER_GOOGLE_WORKSPACE_DISCONNECT]: () =>
    Effect.flatMap(runnerNow, (runner) =>
      fromPromise(() => runner.googleWorkspaceDisconnect()),
    ),
};
