/**
 * Runs one exec_command in the just-bash worker shell and commits its effect.
 *
 * The Dynamic Worker proposes; this module disposes. It pins the world
 * revision before the run starts, and after the run hands back its change
 * set it asks the WorldStore to apply that set only if nothing the run read
 * or wrote changed since. So the answer to "did this command change the
 * workspace?" is always known here:
 *
 * - `fallback`: provably not. Nothing was committed, so the caller may run
 *   the same command in the sandbox without doubling any effect.
 * - `completed`: yes, exactly once, at `revision`.
 * - `failed`: unknown, because the commit call itself did not answer. The
 *   caller must not replay the command.
 */

import { RpcTarget } from "cloudflare:workers";
import type { WorkerShellControl } from "./worker-shell/entry.js";
import {
  WORKER_SHELL_LIMITS,
  type WorkerShellFallbackReason,
  type WorkerShellOutcome,
  type WorkerShellRequest,
  type WorldShellFsRpc,
} from "./worker-shell/protocol.js";
import type { WorldListingEntry } from "./world/types.js";

export type WorkerShellRunResult =
  | Readonly<{
      kind: "completed";
      stdout: string;
      stderr: string;
      exitCode: number;
      outputBytes: number;
      revision: number;
    }>
  | Readonly<{
      kind: "fallback";
      reason: WorkerShellFallbackReason | "workspace_changed" | "shell_failed";
      detail: string;
    }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type WorkerShellRunner = Readonly<{
  run(
    request: Omit<WorkerShellRequest, "root">,
    signal?: AbortSignal,
  ): Promise<WorkerShellRunResult>;
}>;

type ShellEntrypoint = {
  run(
    request: WorkerShellRequest,
    control: WorkerShellControl,
  ): Promise<WorkerShellOutcome>;
};

/** The WorldStore calls a run needs, for one world. */
export type WorkerShellWorldCommit = Readonly<{
  head(): Promise<{ revision: number }>;
  commitShell(input: {
    baseRevision: number;
    reads: { paths: readonly string[]; children: readonly string[] };
    entries: WorldListingEntry[];
    deleted: string[];
  }): Promise<
    | { status: "committed"; revision: number }
    | { status: "conflict"; paths: string[] }
    | { status: "missing_blobs"; missingBlobs: string[] }
  >;
}>;

export type WorkerShellBundle = Readonly<{
  id: string;
  modules: Readonly<Record<string, Readonly<{ js: string }>>>;
}>;

export type WorkerShellRunnerInput = Readonly<{
  loader: WorkerLoader;
  /** The scoped loopback for this world, e.g. from `ctx.exports`. */
  loopback: () => WorldShellFsRpc;
  world: WorkerShellWorldCommit;
  /** Absolute shell path of the workspace root. */
  root: string;
  /** Names the cached isolate; runs for one world may share it. */
  scope: string;
  bundle?: () => Promise<WorkerShellBundle>;
}>;

const loadBundle = async (): Promise<WorkerShellBundle> =>
  (await import("./worker-shell/shell-modules.generated.js")).default;

/** How long past its own deadline a run may take before it is abandoned. */
const RUN_GRACE_MS = 15_000;

/** Resolves when the tool call is cancelled; never rejects. */
class ShellControl extends RpcTarget implements WorkerShellControl {
  readonly #signal: AbortSignal | undefined;

  constructor(signal: AbortSignal | undefined) {
    super();
    this.#signal = signal;
  }

  cancelled(): Promise<void> {
    const signal = this.#signal;
    if (!signal) return new Promise<void>(() => undefined);
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
}

const settledBy = (signal: AbortSignal): Promise<"aborted"> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

const dispose = (value: unknown): void => {
  const disposer = (value as { [Symbol.dispose]?: () => void } | null)?.[
    Symbol.dispose
  ];
  try {
    disposer?.call(value);
  } catch {
    // Already released.
  }
};

export const createWorkerShellRunner = (
  input: WorkerShellRunnerInput,
): WorkerShellRunner => {
  const bundle = input.bundle ?? loadBundle;

  const attempt = async (
    request: WorkerShellRequest,
    signal: AbortSignal | undefined,
  ): Promise<
    | Readonly<{ kind: "outcome"; outcome: WorkerShellOutcome; baseRevision: number }>
    | Readonly<{ kind: "cancelled" }>
    | Readonly<{ kind: "shell_failed"; detail: string }>
  > => {
    // Pinned before the first read, so any write that lands during the run
    // is one the commit check can see.
    const { revision: baseRevision } = await input.world.head();
    const shell = await bundle();
    const worker = input.loader.get(
      `stella-worker-shell:${shell.id}:${input.scope}`,
      () => ({
        compatibilityDate: "2026-07-22",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "shell.js",
        modules: shell.modules as Record<string, { js: string }>,
        env: { WORLD: input.loopback() },
        // The shell has no network. Anything that needs one is refused by the
        // eligibility rules and runs under the sandbox's egress policy.
        globalOutbound: null,
        limits: { cpuMs: WORKER_SHELL_LIMITS.cpuMs },
      }),
    );
    const entrypoint = worker.getEntrypoint() as unknown as ShellEntrypoint;
    const control = new ShellControl(signal);
    const abandon = AbortSignal.timeout(request.timeoutMs + RUN_GRACE_MS);
    try {
      const settled = await Promise.race([
        entrypoint.run(request, control).then(
          (outcome) => ({ kind: "outcome" as const, outcome }),
          (error: unknown) => ({
            kind: "shell_failed" as const,
            detail:
              error instanceof Error ? error.message : "the shell isolate failed",
          }),
        ),
        ...(signal ? [settledBy(signal)] : []),
        settledBy(abandon).then(() => ({
          kind: "shell_failed" as const,
          detail: "the lightweight shell did not answer in time",
        })),
      ]);
      if (settled === "aborted") return { kind: "cancelled" };
      if (settled.kind === "shell_failed") return settled;
      return { kind: "outcome", outcome: settled.outcome, baseRevision };
    } finally {
      dispose(entrypoint);
    }
  };

  return {
    async run(partial, signal) {
      const request: WorkerShellRequest = { ...partial, root: input.root };
      let refused = "the workspace changed under the command twice";
      // One retry: a conflict means another writer touched what this run
      // used. Nothing was applied, so running again is safe; a second
      // conflict hands the command to the sandbox, which serializes itself.
      for (let tries = 0; tries < 2; tries += 1) {
        if (signal?.aborted) return { kind: "cancelled" };
        const result = await attempt(request, signal);
        if (result.kind === "cancelled") return result;
        if (result.kind === "shell_failed") {
          return { kind: "fallback", reason: "shell_failed", detail: result.detail };
        }
        const { outcome, baseRevision } = result;
        if (outcome.kind === "fallback") return outcome;
        // A cancelled call must not change the workspace, even when the
        // shell finished first.
        if (signal?.aborted) return { kind: "cancelled" };
        let committed;
        try {
          committed = await input.world.commitShell({
            baseRevision,
            reads: outcome.reads,
            entries: [...outcome.changes.entries],
            deleted: [...outcome.changes.deleted],
          });
        } catch (error) {
          return {
            kind: "failed",
            message: `The workspace did not confirm this command's changes (${
              error instanceof Error ? error.message : "commit failed"
            }). They may or may not have been applied; check the files before running it again.`,
          };
        }
        if (committed.status === "committed") {
          return {
            kind: "completed",
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            exitCode: outcome.exitCode,
            outputBytes: outcome.outputBytes,
            revision: committed.revision,
          };
        }
        // Uploaded blobs are pinned while a commit is pending, so a missing
        // one is a store fault. Either way nothing was applied.
        refused =
          committed.status === "conflict"
            ? `the workspace changed under the command twice${
                committed.paths.length > 0
                  ? ` (${committed.paths.slice(0, 5).join(", ")})`
                  : ""
              }`
            : "the workspace lost the command's uploaded contents";
      }
      return { kind: "fallback", reason: "workspace_changed", detail: refused };
    },
  };
};
