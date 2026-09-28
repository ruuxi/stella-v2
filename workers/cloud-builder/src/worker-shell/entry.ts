/**
 * Main module of the worker-shell Dynamic Worker.
 *
 * It holds no authority of its own: `env.WORLD` is a loopback the
 * BuildSession minted for one owner world and fork, the isolate has no
 * outbound network, and the run's result is a proposal the BuildSession may
 * commit. Bundled with just-bash by `scripts/build-worker-shell.mjs`.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkerShellOutcome,
  WorkerShellRequest,
  WorldShellFsRpc,
} from "./protocol.js";
import {
  runWorkerShell,
  type WorkerShellDispatchHooks,
  type WorkerShellHookScope,
} from "./run.js";

type Env = { WORLD: WorldShellFsRpc };

/** The BuildSession's side of one run: resolves when the call is cancelled. */
export type WorkerShellControl = { cancelled(): Promise<void> };

const current = new AsyncLocalStorage<WorkerShellDispatchHooks>();

// The call sites the bundle build patches into just-bash read this global.
Object.defineProperty(globalThis, "__stellaWorkerShell", {
  value: Object.freeze({
    userScript: (path: string) => current.getStore()?.userScript(path),
    commandNotFound: (name: string) =>
      current.getStore()?.commandNotFound(name),
    limit: (message: string) => current.getStore()?.limit(message),
    commandResult: (result: { stderr?: unknown; exitCode?: unknown }) =>
      current.getStore()?.commandResult(result),
  }),
  enumerable: false,
  configurable: false,
  writable: false,
});

const hookScope: WorkerShellHookScope = {
  run: (hooks, body) => current.run(hooks, body),
};

export default class StellaWorkerShell extends WorkerEntrypoint<Env> {
  async run(
    request: WorkerShellRequest,
    control?: WorkerShellControl,
  ): Promise<WorkerShellOutcome> {
    const world = this.env.WORLD;
    return await runWorkerShell(
      request,
      {
        stat: (paths) => world.stat(paths),
        children: (path) => world.children(path),
        read: (path, options) => world.read(path, options),
        putBlob: (bytes) => world.putBlob(bytes),
      },
      {
        hooks: hookScope,
        ...(control ? { cancelled: control.cancelled() } : {}),
      },
    );
  }
}
