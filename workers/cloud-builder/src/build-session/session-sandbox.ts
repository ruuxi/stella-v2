/**
 * Sandbox handles, the container-running probe, durable destroy plus its debt
 * drain, and agent session teardown.
 *
 * @see src/build-session/host.ts for why every call out takes `host`.
 */
import { getSandbox } from "@cloudflare/sandbox";
import { attachedToolPaths } from "@stella/executor-cloud/attached-tool-protocol";
import {
  agentComputeKey,
  parsePersistedAgentCompute,
} from "../agent-compute-ladder.js";
import {
  advanceSandboxDestroyDebt,
  clearSandboxDestroyDebt,
  createSandboxDestroyDebt,
  isSandboxDestroyDue,
  listSandboxDestroyDebts,
  persistSandboxDestroyDebt,
  readSandboxDestroyDebt,
  sandboxDestroyDebtKey,
  SandboxLifecycleDeferredError,
  sandboxLifecycleFailureFields,
  SANDBOX_WORKLOADS,
} from "../sandbox-lifecycle.js";
import { PREVIEW_ACCESS_STORAGE_KEY } from "../vite-preview-access.js";
import { agentTurnSessionId } from "../workspace.js";
import type { InstanceSize } from "../instance-size.js";
import type {
  SandboxDestroyDebt,
  SandboxTarget,
  SandboxWorkload,
} from "../sandbox-lifecycle.js";
import type { BuildSessionInternals } from "./host.js";
import type { Env } from "./shared/env.js";
import {
  agentExecutionMarkerKey,
  exactTurnIdentityMatches,
  json,
  log,
  withInfrastructureDeadline,
} from "./shared/keys.js";
import type { AgentExecutionMarker, TurnRequest } from "./shared/types.js";

export type SessionSandboxHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "currentSandboxTarget"
  | "destroySandboxDurably"
  | "releaseAgentSessionResources"
  | "sandbox"
  | "sandboxContainerRunning"
>;

/** Container states in which a process sweep reaches a running process. */
const SANDBOX_RUNNING_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "healthy",
]);

/** Idle timeout for an unpinned shared world or app-build container. */
const sandboxSleepAfterMs = (
  env: Pick<Env, "SANDBOX_IDLE_TIMEOUT_MS">,
): number | undefined => {
  const value = Number(env.SANDBOX_IDLE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/**
 * One unpinned sandbox handle per exact tuple. Size selects the namespace as
 * much as the id does: the classes are separate namespaces, so a handle built
 * for the wrong size silently addresses a different container.
 */
export const sandboxHandle = (env: Env, target: SandboxTarget) => {
  const namespace =
    target.workload === "app-build"
      ? env.APP_BUILD_SANDBOX
      : target.size === "small" && env.SANDBOX_SMALL
        ? env.SANDBOX_SMALL
        : env.Sandbox;
  const sleepAfter = sandboxSleepAfterMs(env);
  return getSandbox(namespace, target.sandboxId, {
    transport: "rpc",
    enableDefaultSession: false,
    keepAlive: false,
    ...(sleepAfter === undefined ? {} : { sleepAfter }),
    normalizeId: true,
    containerTimeouts: {
      instanceGetTimeoutMS: 60_000,
      portReadyTimeoutMS: 120_000,
    },
    labels: { service: "stella-v2", workload: target.workload },
  });
};

/** Every id this worker mints: a lifecycle fingerprint or a diagnostic echo. */
const RETIRE_SANDBOX_ID =
  /^(?:(?:world|app)-[0-9a-f]{40}|echo-[0-9a-f-]{36})$/u;

/**
 * Retire one container by its exact tuple, for the inventory reaper. There is
 * no per-instance stop in Wrangler or the public API and only the sandbox
 * object holds the container handle, so the reaper's adapter posts the tuple
 * here and the worker destroys it. Never guesses a namespace from the id.
 */
export const retireSandboxInstance = async (
  env: Env,
  request: Request,
): Promise<Response> => {
  const raw = (await request.json().catch(() => null)) as unknown;
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
  const size = body.size;
  const workload = body.workload;
  if (
    !RETIRE_SANDBOX_ID.test(sandboxId) ||
    (size !== "small" && size !== "large") ||
    typeof workload !== "string" ||
    !(SANDBOX_WORKLOADS as readonly string[]).includes(workload) ||
    (sandboxId.startsWith("world-") && workload !== "world") ||
    (!sandboxId.startsWith("world-") && workload !== "app-build")
  ) {
    return json({ ok: false, reason: "invalid_target" }, 400);
  }
  const target: SandboxTarget = {
    sandboxId,
    size,
    workload: workload as SandboxWorkload,
  };
  const sandbox = sandboxHandle(env, target);
  try {
    await withInfrastructureDeadline(
      sandbox.destroy(),
      30_000,
      "Sandbox destruction did not settle.",
    );
  } catch (error) {
    const failure = sandboxLifecycleFailureFields(error);
    log("error", "sandbox_operator_destroy_failed", {
      workload: target.workload,
      instanceSize: target.size,
      ...failure,
    });
    return json(
      {
        ok: false,
        reason: "destroy_failed",
        target,
        ...failure,
      },
      502,
    );
  }
  log("info", "sandbox_retired_by_operator", {
    workload: target.workload,
    instanceSize: target.size,
  });
  return json({ ok: true, target });
};

export const sandbox = (
  host: Pick<SessionSandboxHost, "env">,
  id: string,
  size: InstanceSize = "large",
  workload: SandboxWorkload = "app-build",
) => sandboxHandle(host.env, { sandboxId: id, size, workload });

/**
 * Whether the sandbox's container is running right now, answered by the
 * sandbox object itself and never by the container. Every container RPC
 * (process kills included) starts the instance if it is not running, so a
 * teardown that asks the container anything boots the very thing it is
 * retiring. An unanswerable state counts as not running: `destroy()` is the
 * authoritative SIGKILL either way, and a skipped process sweep only costs
 * a native child the prompt stop it would otherwise get.
 */
export const sandboxContainerRunning = async (
  _host: SessionSandboxHost,
  sandbox: ReturnType<BuildSessionInternals["sandbox"]>,
): Promise<boolean> => {
  const stateful = sandbox as typeof sandbox & {
    getState?: () => Promise<{ status?: unknown } | undefined>;
  };
  if (typeof stateful.getState !== "function") return false;
  try {
    const state = await withInfrastructureDeadline(
      stateful.getState(),
      10_000,
      "Sandbox state read did not settle.",
    );
    return SANDBOX_RUNNING_STATUSES.has(String(state?.status ?? ""));
  } catch (error) {
    log("error", "sandbox_state_read_failed", {
      ...sandboxLifecycleFailureFields(error),
    });
    return false;
  }
};

/**
 * Convert one exact sandbox target into durable teardown debt before the
 * first lifecycle RPC leaves this object.
 */
export const destroySandboxDurably = async (
  host: SessionSandboxHost,
  target: SandboxTarget,
  event: string,
): Promise<void> => {
  // Revocation precedes every container lifecycle RPC. A failed or delayed
  // destroy can never leave the signed proxy usable while retirement waits.
  await host.ctx.storage.delete(PREVIEW_ACCESS_STORAGE_KEY);
  const now = Date.now();
  let debt!: SandboxDestroyDebt;
  await host.ctx.storage.transaction(async (txn) => {
    debt =
      (await readSandboxDestroyDebt(txn, target)) ??
      createSandboxDestroyDebt(target, now);
    const debtKey = sandboxDestroyDebtKey(target);
    await txn.put(debtKey, debt);
    const existingAlarm = await txn.getAlarm();
    await txn.setAlarm(
      existingAlarm === null
        ? debt.nextAttemptAt
        : Math.min(existingAlarm, debt.nextAttemptAt),
    );
  });
  const sandbox = host.sandbox(target.sandboxId, target.size, target.workload);
  try {
    await withInfrastructureDeadline(
      sandbox.destroy(),
      30_000,
      "Sandbox destruction did not settle.",
    );
  } catch (error) {
    const advanced = advanceSandboxDestroyDebt(debt, Date.now());
    await persistSandboxDestroyDebt(host.ctx.storage, advanced);
    log("error", "sandbox_destroy_deferred", {
      lifecycleReason: event,
      workload: target.workload,
      instanceSize: target.size,
      attemptCount: advanced.attemptCount,
      retryDelayMs: Math.max(0, advanced.nextAttemptAt - Date.now()),
      ...sandboxLifecycleFailureFields(error),
    });
    throw new SandboxLifecycleDeferredError();
  }
  await clearSandboxDestroyDebt(host.ctx.storage, debt);
  log("info", "sandbox_destroyed", {
    lifecycleReason: event,
    workload: target.workload,
    instanceSize: target.size,
    attempts: debt.attemptCount + 1,
  });
};

/** Alarm-owned retry pass. Every target is exact; no id-only guessing. */
export const retryDueSandboxDestroyDebts = async (
  host: SessionSandboxHost,
  now = Date.now(),
): Promise<void> => {
  const debts = await listSandboxDestroyDebts(host.ctx.storage);
  for (const debt of debts) {
    if (!isSandboxDestroyDue(debt, now)) continue;
    await host
      .destroySandboxDurably(debt.target, "alarm_retry")
      .catch(() => undefined);
  }
};

/** Re-arm the earliest remaining debt without postponing another alarm. */
export const scheduleSandboxDestroyDebtAlarm = async (
  host: SessionSandboxHost,
): Promise<void> => {
  const debts = await listSandboxDestroyDebts(host.ctx.storage);
  const next = debts.reduce<number | null>(
    (earliest, debt) =>
      earliest === null
        ? debt.nextAttemptAt
        : Math.min(earliest, debt.nextAttemptAt),
    null,
  );
  if (next === null) return;
  const existing = await host.ctx.storage.getAlarm();
  await host.ctx.storage.setAlarm(
    existing === null ? next : Math.min(existing, next),
  );
};

/**
 * The sandbox this DO is currently responsible for. Size matters as much as
 * id: the two container classes are separate namespaces, so destroying by
 * id alone against the wrong one silently leaves a live container behind.
 */
export const currentSandboxTarget = async (
  host: SessionSandboxHost,
): Promise<SandboxTarget | undefined> => {
  const [storedSandboxId, storedSize, turn] = await Promise.all([
    host.ctx.storage.get<string>("sandboxId"),
    host.ctx.storage.get<InstanceSize>("sandboxSize"),
    host.ctx.storage.get<TurnRequest>("turn"),
  ]);
  if (
    turn?.kind === "agent" &&
    Number.isSafeInteger(turn.attemptGeneration) &&
    turn.attemptGeneration! >= 1
  ) {
    const identity = {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    };
    const compute = parsePersistedAgentCompute(
      await host.ctx.storage.get(
        agentComputeKey(identity.turnId, identity.attemptGeneration),
      ),
      identity,
    );
    // A valid exact compute record is tuple authority as a whole. Resident
    // means no sandbox; attaching and later phases carry both exact id and
    // namespace-selecting size. Never combine either with a stale mirror.
    if (compute) {
      return compute.sandboxId
        ? {
            sandboxId: compute.sandboxId,
            size: compute.instanceSize,
            workload: "world",
          }
        : undefined;
    }
    return storedSandboxId
      ? {
          sandboxId: storedSandboxId,
          size: storedSize ?? "large",
          workload: "world",
        }
      : undefined;
  }
  return storedSandboxId
    ? {
        sandboxId: storedSandboxId,
        size: storedSize ?? "large",
        workload: "app-build",
      }
    : undefined;
};

export const currentSandbox = async (host: SessionSandboxHost) => {
  const target = await host.currentSandboxTarget();
  return target
    ? host.sandbox(target.sandboxId, target.size, target.workload)
    : undefined;
};

/** Release one turn's processes, daemon, session, and bridge directory. */
export const terminateCurrentAgentSession = async (
  host: SessionSandboxHost,
  turn: TurnRequest,
): Promise<void> => {
  const target = await host.ctx.storage.transaction(async (txn) => {
    const markerKey =
      turn.kind === "agent" &&
      Number.isSafeInteger(turn.attemptGeneration) &&
      turn.attemptGeneration! >= 1
        ? agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!)
        : undefined;
    const computeIdentity =
      turn.kind === "agent" &&
      Number.isSafeInteger(turn.attemptGeneration) &&
      turn.attemptGeneration! >= 1
        ? {
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration!,
          }
        : undefined;
    const [current, storedSandboxId, storedSize, executionMarker, compute] =
      await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get<string>("sandboxId"),
        txn.get<InstanceSize>("sandboxSize"),
        markerKey
          ? txn.get<AgentExecutionMarker>(markerKey)
          : Promise.resolve(undefined),
        computeIdentity
          ? txn
              .get(
                agentComputeKey(
                  computeIdentity.turnId,
                  computeIdentity.attemptGeneration,
                ),
              )
              .then((value) =>
                parsePersistedAgentCompute(value, computeIdentity),
              )
          : Promise.resolve(null),
      ]);
    // The ladder's exact record wins over the eager-path mirrors.
    const sandboxId = compute ? compute.sandboxId : storedSandboxId;
    if (!sandboxId || (!compute && !exactTurnIdentityMatches(current, turn))) {
      return undefined;
    }
    const size = compute
      ? compute.instanceSize
      : (storedSize ?? ("large" as const));
    return {
      sandboxId,
      size,
      workload:
        turn.kind === "agent" ? ("world" as const) : ("app-build" as const),
      sessionId: compute?.sessionId ?? agentTurnSessionId(turn.turnId),
      daemonDirectory:
        compute?.daemonDirectory ??
        attachedToolPaths({
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration ?? 1,
        }).directory,
      executorAdmitted:
        executionMarker?.schemaVersion === 1 &&
        executionMarker.turnId === turn.turnId &&
        executionMarker.attemptGeneration === turn.attemptGeneration &&
        executionMarker.sandboxId === sandboxId &&
        executionMarker.size === size,
    };
  });
  if (!target) return;
  if (turn.kind !== "agent") return;
  await host.releaseAgentSessionResources({ ...target, workload: "world" });
};

export const releaseAgentSessionResources = async (
  host: SessionSandboxHost,
  target: {
    sandboxId: string;
    size: InstanceSize;
    workload: "world";
    sessionId: string;
    daemonDirectory: string;
  },
): Promise<void> => {
  const sandbox = host.sandbox(target.sandboxId, target.size, target.workload);
  if (!(await host.sandboxContainerRunning(sandbox))) return;
  // Never `killAllProcesses` here: the SDK ignores its session argument and
  // kills every process in the container, and the container is shared by
  // every agent of the owner world (observed 2026-09-04: a child's turn end
  // killed its parent's daemon). Only this turn's own daemon is killed; its
  // session shell and the shell's children end with `deleteSession`.
  await withInfrastructureDeadline(
    sandbox.killProcess(
      `attached-daemon-${target.sessionId}`.slice(0, 64),
      "SIGKILL",
    ),
    10_000,
    "Attached daemon teardown did not settle.",
  ).catch(() => undefined);
  const session = await sandbox
    .getSession(target.sessionId)
    .catch(() => undefined);
  await session
    ?.exec(`rm -rf -- '${target.daemonDirectory.replace(/'/gu, `'"'"'`)}'`, {
      origin: "internal",
    })
    .catch(() => undefined);
  await sandbox.deleteSession(target.sessionId).catch(() => undefined);
};
