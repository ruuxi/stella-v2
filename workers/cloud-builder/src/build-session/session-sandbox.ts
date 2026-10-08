/**
 * Sandbox handles, the container-running probe, durable destroy plus its debt
 * drain, and agent session teardown.
 *
 * @see src/build-session/host.ts for why every call out takes `host`.
 */
import { Effect } from "effect";
import {
  attachedToolPaths,
  attachedToolPathsForDirectory,
} from "@stella/executor-cloud/attached-tool-protocol";
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
import { sandboxClient } from "../sandbox-client.js";
import { snapshotAllowsCloudSandbox } from "../owner-gate.js";
import { agentSandboxId, agentTurnSessionId, worldName } from "../workspace.js";
import { initialInstanceSize } from "../instance-size.js";
import type { InstanceSize } from "../instance-size.js";
import type {
  SandboxDestroyDebt,
  SandboxTarget,
  SandboxWorkload,
} from "../sandbox-lifecycle.js";
import type { TurnExecutionContext } from "../turn-cancellation.js";
import type { BuildSessionInternals } from "./host.js";
import { AgentTurnError } from "./shared/errors.js";
import type { Env } from "./shared/env.js";
import {
  agentContainerSize,
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

/** Idle timeout for an agent or app-build container a release never stopped. */
const sandboxSleepAfterMs = (
  env: Pick<Env, "SANDBOX_IDLE_TIMEOUT_MS">,
): number | undefined => {
  const value = Number(env.SANDBOX_IDLE_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/** Used when `SANDBOX_PREWARM_IDLE_TIMEOUT_MS` is unset or malformed. */
const DEFAULT_PREWARM_IDLE_TIMEOUT_MS = 90_000;

/**
 * Idle timeout a container gets when a prewarm is what started it. A prewarm
 * buys the next turn its cold start, so it only has to outlive the few seconds
 * between admission and attach; the turn's own first container call lengthens
 * the timeout to `SANDBOX_IDLE_TIMEOUT_MS`. Capacity held by a prewarm whose
 * turn never arrives is released on this timeout instead of the post-turn one.
 */
const sandboxPrewarmSleepAfterMs = (
  env: Pick<
    Env,
    "SANDBOX_IDLE_TIMEOUT_MS" | "SANDBOX_PREWARM_IDLE_TIMEOUT_MS"
  >,
): number => {
  const configured = Number(env.SANDBOX_PREWARM_IDLE_TIMEOUT_MS);
  const prewarm =
    Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_PREWARM_IDLE_TIMEOUT_MS;
  const afterTurn = sandboxSleepAfterMs(env);
  return afterTurn === undefined ? prewarm : Math.min(prewarm, afterTurn);
};

/**
 * One sandbox handle per exact tuple. Every workload and size shares one
 * namespace: the object picks the instance size and network policy when it
 * starts the container, so the id alone addresses the container. `world`
 * names the owner's world store for an agent container (`SandboxBoot`); the
 * sandbox object remembers it, so only the call that starts it must say.
 */
export const sandboxHandle = (
  env: Env,
  target: SandboxTarget,
  idleTimeoutMs: number | undefined = sandboxSleepAfterMs(env),
  world?: string,
) =>
  sandboxClient(env.Sandbox, target.sandboxId, {
    size: target.size,
    workload: target.workload,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    ...(world ? { world } : {}),
  });

/**
 * Every id this worker mints: a lifecycle fingerprint (an agent thread's
 * container, the owner's own container, an app attempt) or a diagnostic echo.
 */
const RETIRE_SANDBOX_ID =
  /^(?:(?:agent|world|app)-[0-9a-f]{40}|echo-[0-9a-f-]{36})$/u;

const isWorldSandboxId = (sandboxId: string): boolean =>
  sandboxId.startsWith("agent-") || sandboxId.startsWith("world-");

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
    (isWorldSandboxId(sandboxId) && workload !== "world") ||
    (!isWorldSandboxId(sandboxId) && workload !== "app-build")
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

/**
 * `POST /orchestrator-turn/prewarm` `{ ownerId, threadId }`: start the
 * orchestrator thread's own container ahead of its CLI turn, without running
 * one. The OrchestratorSession calls it only while admitting an actual
 * `anthropic` turn, so the turn itself pays only for attach. Starts the exact
 * container the turn would use (`agentSandboxId` for this thread, its size)
 * but with the prewarm idle timeout, so capacity is released soon if the turn
 * never arrives; the turn's own first container call lengthens the timeout
 * to `SANDBOX_IDLE_TIMEOUT_MS`. A running container is left alone. Never
 * touches this session's turn state. Only the orchestrator is prewarmed: a
 * spawned agent's thread is not known until it is spawned.
 *
 *   200 { prewarmed: true, alreadyRunning: boolean, startMs?: number }
 *   502 { prewarmed: false, reason: "start_failed" }
 *   400 / 409 malformed, or another owner's or thread's session
 */
export const prewarmOrchestratorContainer = async (
  host: SessionSandboxHost,
  request: Request,
): Promise<Response> => {
  const raw = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const ownerId = typeof raw?.ownerId === "string" ? raw.ownerId.trim() : "";
  const threadId =
    typeof raw?.threadId === "string" ? raw.threadId.trim() : "";
  if (!ownerId || ownerId.length > 512 || !threadId || threadId.length > 512) {
    return json({ error: "ownerId and threadId are required." }, 400);
  }
  const stored = await host.ctx.storage.get<TurnRequest>("turn");
  if (
    stored &&
    (stored.ownerId !== ownerId ||
      (stored.threadId !== undefined && stored.threadId !== threadId))
  ) {
    return json({ prewarmed: false, reason: "owner_mismatch" }, 409);
  }
  const snapshot = await host.env.OWNER_GATES.getByName(ownerId)
    .snapshot()
    .catch(() => null);
  if (!snapshot || !snapshotAllowsCloudSandbox(snapshot)) {
    return json({ prewarmed: false, reason: "subscription_required" }, 403);
  }
  const size = await agentContainerSize(
    host.ctx.storage,
    initialInstanceSize({ prompt: "" }),
  );
  const handle = sandboxHandle(
    host.env,
    {
      sandboxId: await agentSandboxId(ownerId, threadId),
      size,
      workload: "world",
    },
    sandboxPrewarmSleepAfterMs(host.env),
    await worldName(ownerId),
  );
  if (await host.sandboxContainerRunning(handle)) {
    return json({ prewarmed: true, alreadyRunning: true });
  }
  const started = performance.now();
  try {
    // Every container RPC starts the instance; this one does nothing else.
    await withInfrastructureDeadline(
      handle.exec("true", { origin: "internal" }),
      120_000,
      "Orchestrator container prewarm did not settle.",
    );
  } catch (error) {
    log("error", "orchestrator_container_prewarm_failed", {
      ...sandboxLifecycleFailureFields(error),
    });
    return json({ prewarmed: false, reason: "start_failed" }, 502);
  }
  const startMs = Math.round(performance.now() - started);
  log("info", "orchestrator_container_prewarmed", {
    instanceSize: size,
    startMs,
  });
  return json({ prewarmed: true, alreadyRunning: false, startMs });
};

/** How long an agent waits for one of its owner's container slots. */
const AGENT_CONTAINER_WAIT_MS = 3 * 60_000;
const AGENT_CONTAINER_POLL_MS = 5_000;

/**
 * Take one of the owner's agent container slots (`OWNER_AGENT_CONTAINER_LIMIT`)
 * before this thread's container starts. When all are taken, the agent waits
 * for one to be released, then gives up with a message that says why. The
 * orchestrator's own container takes no slot.
 */
export const acquireAgentContainerSlot = async (
  host: Pick<SessionSandboxHost, "env">,
  turn: TurnRequest,
  sandboxId: string,
  execution: TurnExecutionContext,
): Promise<void> => {
  if (turn.agentRole === "orchestrator") return;
  const gate = host.env.OWNER_GATES.getByName(turn.ownerId);
  const deadline = Date.now() + AGENT_CONTAINER_WAIT_MS;
  const queuedAt = Date.now();
  let queued = false;
  for (;;) {
    execution.assertActive();
    const slot = await gate.acquireAgentContainer({ sandboxId });
    if (slot.ok) {
      log("info", "agent_container_acquired", {
        threadId: turn.threadId,
        sandbox: sandboxId.slice(0, 16),
        running: slot.running,
        limit: slot.limit,
        waitedMs: Date.now() - queuedAt,
      });
      return;
    }
    if (!queued) {
      queued = true;
      log("info", "agent_container_queued", {
        threadId: turn.threadId,
        sandbox: sandboxId.slice(0, 16),
        running: slot.running,
        limit: slot.limit,
      });
    }
    if (Date.now() >= deadline) {
      throw new AgentTurnError(
        `Your cloud is already running ${slot.limit} agents' workspaces, its limit. This agent waited ${AGENT_CONTAINER_WAIT_MS / 60_000} minutes for one of them to finish. Try again once one is done.`,
      );
    }
    await execution.cancellation.sleep(AGENT_CONTAINER_POLL_MS);
  }
};

export const sandbox = (
  host: Pick<SessionSandboxHost, "env">,
  id: string,
  size: InstanceSize = "large",
  workload: SandboxWorkload = "app-build",
  world?: string,
) =>
  sandboxHandle(
    host.env,
    { sandboxId: id, size, workload },
    sandboxSleepAfterMs(host.env),
    world,
  );

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
  try {
    const state = await withInfrastructureDeadline(
      sandbox.getState(),
      10_000,
      "Sandbox state read did not settle.",
    );
    return state.status === "running";
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
      // A resize restarts the same world larger; every other reason discards it.
      sandbox.destroy({ keepSnapshot: event === "agent_oom_resize" }),
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
 * The sandbox this DO is currently responsible for. The id addresses the
 * container; the size and workload say how to start it again.
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
  const turn = await host.ctx.storage.get<TurnRequest>("turn");
  // The slot goes back whether or not the container is still up: a stopped
  // or lost container holds no capacity.
  if (turn?.ownerId) {
    await host.env.OWNER_GATES.getByName(turn.ownerId)
      .releaseAgentContainer({ sandboxId: target.sandboxId })
      .catch(() => undefined);
  }
  if (!(await host.sandboxContainerRunning(sandbox))) return;
  const paths = attachedToolPathsForDirectory(target.daemonDirectory);
  const session = await sandbox
    .getSession(target.sessionId)
    .catch(() => undefined);
  const teardownExec = async (command: string) => {
    if (session) {
      try {
        const result = await session.exec(command, { origin: "internal" });
        if (result.success) return result;
      } catch {
        // The persistent session shell can already be gone after quiesce.
      }
    }
    return await sandbox.exec(command, { origin: "internal" });
  };
  const identity = await withInfrastructureDeadline(
    teardownExec(`cat -- '${paths.daemonPid.replace(/'/gu, `'"'"'`)}'`),
    5_000,
    "Attached daemon identity read did not settle.",
  )
    .then((result) => {
      if (!result.success) return undefined;
      const value: unknown = JSON.parse(result.stdout);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const pid = "pid" in value ? value.pid : undefined;
      const pgid = "pgid" in value ? value.pgid : undefined;
      return Number.isSafeInteger(pid) && pid === pgid && Number(pid) > 1
        ? Number(pgid)
        : undefined;
    })
    .catch(() => undefined);
  if (identity !== undefined) {
    await withInfrastructureDeadline(
      teardownExec(`kill -TERM -- -${identity}`),
      5_000,
      "Attached daemon group SIGTERM did not settle.",
    ).catch(() => undefined);
    await withInfrastructureDeadline(
      Effect.runPromise(Effect.sleep(500)),
      1_000,
      "Attached daemon group grace period did not settle.",
    ).catch(() => undefined);
    await withInfrastructureDeadline(
      teardownExec(`kill -KILL -- -${identity}`),
      5_000,
      "Attached daemon group SIGKILL did not settle.",
    ).catch(() => undefined);
  }
  // Never `killAllProcesses`: it ignores the session argument. The SDK id is
  // only a fallback for the `setsid --wait` wrapper after this turn's private
  // group was signalled.
  await withInfrastructureDeadline(
    sandbox.killProcess(
      `attached-daemon-${target.sessionId}`.slice(0, 64),
      "SIGKILL",
    ),
    10_000,
    "Attached daemon teardown did not settle.",
  ).catch(() => undefined);
  await withInfrastructureDeadline(
    teardownExec(
      `rm -rf -- '${target.daemonDirectory.replace(/'/gu, `'"'"'`)}'`,
    ),
    5_000,
    "Attached daemon directory removal did not settle.",
  ).catch(() => undefined);
  await sandbox.deleteSession(target.sessionId).catch(() => undefined);
  // The orchestrator's container serves the user's chat: it stays warm for
  // the next message until its idle timeout, and its disk, which never
  // installs anything, must not replace the agents' latest snapshot.
  if (turn?.agentRole === "orchestrator") return;
  // A released agent container is the warmest copy of this owner's setup:
  // the next agent container to start, this thread's or another's, resumes
  // from its filesystem. Then it stops instead of idling until its timeout.
  await sandbox.release().catch(() => undefined);
};
