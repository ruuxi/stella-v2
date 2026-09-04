/**
 * The eager container agent turn: booting a world sandbox, attaching the
 * owner's world to its disk, running one executor attempt, the durable
 * execution markers that survive an evicted DO, and session quiesce.
 *
 * @see src/build-session/host.ts for why every call out takes `host`.
 */
import {
  agentComputeKey,
  parsePersistedAgentCompute,
} from "../agent-compute-ladder.js";
import { classifyAgentFailureDiagnostic } from "../agent-failure-diagnostic.js";
import { CloudHomeStore } from "../cloud-home-store.js";
import type { CloudSkillCatalogSnapshot } from "../cloud-home-store.js";
import { materializeCloudSkillSnapshot } from "../cloud-skill-materializer.js";
import { devAcceptanceProbesEnabled } from "../dev-acceptance-probes.js";
import { executorSessionEnvironment } from "../executor-session-env.js";
import { requiresExactThreadCandidate } from "../general-agent-turn.js";
import {
  initialInstanceSize,
  INSTANCE_TIERS,
  isOutOfMemoryFailure,
} from "../instance-size.js";
import type { InstanceSize } from "../instance-size.js";
import { nativeHistoryCursorFromRows } from "../native-state-checkpoint.js";
import {
  CapturedSessionAbandonedError,
  capturedSessionExec,
  strictSessionExec,
} from "../strict-session-process.js";
import { emitCloudTurnTelemetry } from "../telemetry.js";
import { createTurnRetryCancellation } from "../turn-cancellation.js";
import type {
  TurnExecutionContext,
  TurnRetryCancellation,
} from "../turn-cancellation.js";
import {
  issueTurnBrokerCredential,
  revokeTurnBrokerCredential,
  TURN_BROKER_MAX_TTL_MS,
  turnBrokerStorageKey,
} from "../turn-credential-broker.js";
import type { TurnBrokerRecord } from "../turn-credential-broker.js";
import { restoreTurnStateArchive } from "../turn-state-archive.js";
import { parseTurnStateCheckpointRequest } from "../turn-state-checkpoint.js";
import type {
  TurnStateCandidate,
  TurnStateWorkspaceHead,
} from "../turn-state-registry.js";
import {
  agentTurnSessionId,
  stellaRootForWorld,
  WORLD_ROOT,
  worldRootForFork,
  worldName,
} from "../workspace.js";
import { issueWorldCapability } from "../world-capability.js";
import { worldMaterializationCommand } from "../world-materialization.js";
import type { BuildSessionInternals } from "./host.js";
import {
  AgentTurnAuthorityLostError,
  AgentTurnError,
  OwnerPurgeFenceError,
  TurnStateOwnerCallError,
} from "./shared/errors.js";
import {
  AGENT_RECOVERY_PENDING_KEY,
  AGENT_TURN_HEARTBEAT_MS,
  AGENT_WATCHDOG_DEADLINE_KEY,
  agentComputeRecoveryClaimKey,
  agentExecutionMarkerKey,
  agentRecoveryIdentity,
  cloudBrowserSuspensionMarker,
  errorMessage,
  exactTurnIdentityMatches,
  json,
  log,
  mintAgentTurnModelGateway,
  nativeStateIntegrityKeyFor,
  normalizeToolWorkspaceRoot,
  sessionName,
  turnBrokerCredentialsPath,
  turnStateBaseWorkspaceRevisionKey,
  validBuilderFallbackMessages,
  validTurnStateCheckpointReceipt,
  withInfrastructureDeadline,
} from "./shared/keys.js";
import type {
  AgentComputeRecoveryClaim,
  AgentExecutionMarker,
  AgentExecutorResult,
  Execution,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
} from "./shared/types.js";
import type { ExecutionSession } from "@cloudflare/sandbox";
import { isCloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";
import { CLOUD_AGENT_TURN_RESULT_PATH } from "@stella/executor-cloud/agent-turn-result-file";
import { attachedToolPaths } from "@stella/executor-cloud/attached-tool-protocol";
import {
  runToolEffect,
  sleepWithAbort,
} from "@stella/runtime/kernel/tools/effect-runtime.js";
import { Effect } from "effect";

export type ContainerTurnHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "agentTurnExecutions"
  | "builderFallbackRecoveries"
  | "assertAgentExecutionActive"
  | "assertAgentTurnIdentity"
  | "attachAgentWorld"
  | "claimTerminalDecision"
  | "cleanupOwnerPurgedTurnStorage"
  | "confirmAgentTurnStateRestore"
  | "controlPlaneCapability"
  | "deleteTurnStoragePreservingExactCancellations"
  | "deliverBrowserSuspension"
  | "deliverTerminal"
  | "destroySandboxDurably"
  | "event"
  | "exactAgentExecutionMarker"
  | "fetchCanonicalAgentHistory"
  | "mutateExactTurn"
  | "ownsExactTurn"
  | "publishAgentTurnWorkspace"
  | "publishRequestedInteriorCandidate"
  | "quiesceCurrentAgentSession"
  | "reconcileAgentCheckpointAfterQuiescence"
  | "recoverObservedBrowserSuspension"
  | "releaseAgentSessionResources"
  | "resolveAgentTurnState"
  | "retainPendingBrowserSuspension"
  | "runAgentAttempt"
  | "sandbox"
  | "sandboxContainerRunning"
  | "setExactTurnAlarm"
  | "settleAgentTransientBackup"
  | "terminateCurrentAgentSession"
  | "unregisterTurn"
>;

/**
 * Seed `world/stella` on first use, then re-establish the directory boundary.
 *
 * GNU `cp -a source/. destination/` preserves the source directory's mode on
 * the existing destination. The immutable renderer source is 0755, while a
 * cloud workspace root must remain 0750, so the copy can otherwise make the
 * executor and its fallback checkpoint reject the freshly seeded world.
 */
export const seedFirstStellaToolWorkspace = async (
  session: Pick<ExecutionSession, "exec">,
  worldRoot: string = WORLD_ROOT,
): Promise<void> => {
  const stellaRoot = stellaRootForWorld(worldRoot);
  const seeded = await strictSessionExec(session, [
    "/bin/sh",
    "-lc",
    `set -eu; test ! -e '${stellaRoot}'; mkdir '${stellaRoot}'; cp -a /opt/stella/packages/desktop-ui/. '${stellaRoot}/'; ln -s /opt/stella/node_modules '${stellaRoot}/node_modules'; mkdir '${stellaRoot}/.stella'; cp /opt/stella/interior-seed.json '${stellaRoot}/.stella/interior-source.json'; chown -R 42424:42424 '${stellaRoot}'; chmod 0750 '${stellaRoot}'`,
  ]);
  if (!seeded.success) {
    throw new Error("The Stella interior source seed could not be created.");
  }
  await normalizeToolWorkspaceRoot(session, worldRoot);
};

/**
 * Probe the optional Stella checkout without letting an expected absence
 * surface as a non-zero command result. Sandbox RPC treats any such result as
 * a terminated session, so every filesystem state is reported on stdout and
 * invalid existing entries are rejected here.
 */
export const stellaToolWorkspaceExists = async (
  session: Pick<ExecutionSession, "exec">,
  worldRoot: string = WORLD_ROOT,
): Promise<boolean> => {
  const stellaRoot = stellaRootForWorld(worldRoot);
  const result = await session.exec(
    `if [ -e '${stellaRoot}' ] || [ -L '${stellaRoot}' ]; then if [ -d '${stellaRoot}' ] && [ ! -L '${stellaRoot}' ]; then printf '%s\\n' present; else printf '%s\\n' invalid; fi; else printf '%s\\n' absent; fi`,
  );
  if (!result.success) {
    throw new Error("The Stella interior source could not be inspected.");
  }
  switch (result.stdout.trim()) {
    case "present":
      return true;
    case "absent":
      return false;
    case "invalid":
      throw new Error(
        "The Stella interior source path is not a safe directory.",
      );
    default:
      throw new Error("The Stella interior source returned an invalid state.");
  }
};
export const parseAgentExecutorResult = (
  value: unknown,
): AgentExecutorResult | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const allowed = new Set([
    "outcome",
    "ok",
    "finalText",
    "error",
    "usage",
    "checkpointPolicy",
    "checkpointMs",
    "turnStateCheckpoint",
    "suspension",
    "builderFallback",
  ]);
  const boundedOutput = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    new TextEncoder().encode(candidate).byteLength <= 4 * 1024 * 1024;
  if (
    !Object.keys(result).every((key) => allowed.has(key)) ||
    (result.outcome !== undefined &&
      result.outcome !== "completed" &&
      result.outcome !== "suspended") ||
    typeof result.ok !== "boolean" ||
    (result.finalText !== undefined && !boundedOutput(result.finalText)) ||
    (result.error !== undefined && !boundedOutput(result.error)) ||
    (result.usage !== undefined &&
      (!result.usage ||
        typeof result.usage !== "object" ||
        Array.isArray(result.usage))) ||
    (result.checkpointMs !== undefined &&
      (!Number.isSafeInteger(result.checkpointMs) ||
        Number(result.checkpointMs) < 0)) ||
    (result.checkpointPolicy !== undefined &&
      result.checkpointPolicy !== "preserve_prior" &&
      result.checkpointPolicy !== "builder_fallback")
  ) {
    return null;
  }

  if (result.outcome === "suspended") {
    if (
      result.ok !== false ||
      result.finalText !== "" ||
      result.error !== undefined ||
      !isCloudBrowserSuspension(result.suspension) ||
      result.checkpointPolicy !== undefined ||
      result.builderFallback !== undefined
    ) {
      return null;
    }
  } else if (result.suspension !== undefined) {
    return null;
  }

  if (result.checkpointPolicy === "builder_fallback") {
    if (
      !result.builderFallback ||
      typeof result.builderFallback !== "object" ||
      Array.isArray(result.builderFallback)
    ) {
      return null;
    }
    const fallback = result.builderFallback as Record<string, unknown>;
    if (
      !Object.keys(fallback).every((key) =>
        ["historyCursor", "messages", "nativeCheckpoint"].includes(key),
      ) ||
      typeof fallback.historyCursor !== "string" ||
      !validBuilderFallbackMessages(fallback.messages) ||
      !parseTurnStateCheckpointRequest({
        schemaVersion: 1,
        historyCursor: fallback.historyCursor,
        ...(fallback.nativeCheckpoint !== undefined
          ? { nativeCheckpoint: fallback.nativeCheckpoint }
          : {}),
      }) ||
      result.turnStateCheckpoint !== undefined
    ) {
      return null;
    }
  } else if (result.builderFallback !== undefined) {
    return null;
  }

  if (result.checkpointPolicy === "preserve_prior") {
    if (result.turnStateCheckpoint !== undefined) return null;
  } else if (
    result.checkpointPolicy !== "builder_fallback" &&
    !validTurnStateCheckpointReceipt(result.turnStateCheckpoint)
  ) {
    return null;
  }
  return result as AgentExecutorResult;
};

const readCloudAgentTurnResultText = async (
  session: Pick<ExecutionSession, "readFile">,
): Promise<string | undefined> => {
  try {
    const recorded = await session.readFile(CLOUD_AGENT_TURN_RESULT_PATH, {
      encoding: "base64",
    });
    const bytes = Uint8Array.from(atob(recorded.content), (character) =>
      character.charCodeAt(0),
    );
    try {
      if (bytes.byteLength > 4 * 1024 * 1024) return undefined;
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch {
    return undefined;
  }
};

export const waitForCloudAgentTurnResultText = async (
  session: Pick<ExecutionSession, "readFile">,
  signals: readonly AbortSignal[],
  cancellation?: TurnRetryCancellation,
): Promise<string> => {
  const abortError = (): Error | undefined => {
    if (cancellation?.aborted) {
      return cancellation.reason instanceof Error
        ? cancellation.reason
        : new Error("Agent result observation was canceled.");
    }
    const signal = signals.find((candidate) => candidate.aborted);
    if (!signal) return undefined;
    return signal.reason instanceof Error
      ? signal.reason
      : new Error("Agent result observation was canceled.");
  };
  const combinedSignal =
    signals.length > 0 ? AbortSignal.any([...signals]) : undefined;
  while (true) {
    const reason = abortError();
    if (reason) throw reason;
    const recorded = await readCloudAgentTurnResultText(session);
    const afterReadReason = abortError();
    if (afterReadReason) throw afterReadReason;
    if (recorded !== undefined) {
      // `writeFile()` can make the destination visible before every byte has
      // landed. Never let a partial-but-readable root result win the race and
      // trigger executor quiescence; wait until the same strict decoder used
      // after capture accepts the complete payload.
      try {
        if (
          parseAgentExecutorResult(JSON.parse(recorded) as unknown) !== null
        ) {
          return recorded;
        }
      } catch {
        // The executor is still publishing the file. Poll the fixed path again.
      }
    }
    const signalDelay = sleepWithAbort(250, combinedSignal, (activeSignal) =>
      activeSignal.reason instanceof Error
        ? activeSignal.reason
        : new Error("Agent result observation was canceled."),
    );
    await (cancellation
      ? Promise.race([signalDelay, cancellation.sleep(250)])
      : signalDelay);
  }
};

export const quiesceCurrentAgentSession = async (
  host: ContainerTurnHost,
  turn: TurnRequest,
): Promise<void> => {
  const target = await host.ctx.storage.transaction(async (transaction) => {
    const [current, sandboxId, size] = await Promise.all([
      transaction.get<TurnRequest>("turn"),
      transaction.get<string>("sandboxId"),
      transaction.get<InstanceSize>("sandboxSize"),
    ]);
    if (!sandboxId || !exactTurnIdentityMatches(current, turn)) {
      throw new AgentTurnAuthorityLostError();
    }
    return { sandboxId, size: size ?? ("large" as const) };
  });
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
  const sandbox = host.sandbox(target.sandboxId, target.size, "world");
  const executionSessionId =
    compute?.sessionId ?? agentTurnSessionId(turn.turnId);
  if (!(await host.sandboxContainerRunning(sandbox))) return;
  // The container is shared by every agent of the owner world and the SDK's
  // `killAllProcesses` ignores its session argument, so only this attempt's
  // own executor process is killed before its session is deleted.
  await sandbox
    .killProcess(
      sessionName(
        `agent-executor-${turn.turnId}-${turn.attemptGeneration}`,
      ),
      "SIGKILL",
    )
    .catch(() => undefined);
  await sandbox.deleteSession(executionSessionId).catch(() => undefined);
};

export const exactAgentExecutionMarker = async (
  host: ContainerTurnHost,
  turn: TurnRequest,
): Promise<AgentExecutionMarker | undefined> => {
  const marker = await host.ctx.storage.get<AgentExecutionMarker>(
    agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
  );
  if (!marker) return undefined;
  if (
    marker.schemaVersion !== 1 ||
    marker.turnId !== turn.turnId ||
    marker.attemptGeneration !== turn.attemptGeneration ||
    !Number.isSafeInteger(marker.startedAt) ||
    marker.startedAt < 0 ||
    !marker.sandboxId ||
    (marker.size !== "small" && marker.size !== "large")
  ) {
    throw new Error("Agent execution recovery marker was invalid.");
  }
  return marker;
};

export const persistAgentExecutionMarker = async (
  host: ContainerTurnHost,
  turn: TurnRequest,
  marker: AgentExecutionMarker,
): Promise<void> => {
  const claimKey = agentComputeRecoveryClaimKey(
    turn.turnId,
    turn.attemptGeneration!,
  );
  await host.ctx.storage.transaction(async (txn) => {
    const [current, claim] = await Promise.all([
      txn.get<TurnRequest>("turn"),
      txn.get<AgentComputeRecoveryClaim>(claimKey),
    ]);
    if (!exactTurnIdentityMatches(current, turn) || claim) {
      throw new AgentTurnAuthorityLostError();
    }
    await txn.put(
      agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
      marker,
    );
  });
};

export const clearUnattachedAgentSandboxTuple = async (
  host: ContainerTurnHost,
  turn: TurnRequest,
): Promise<void> => {
  const attemptGeneration = turn.attemptGeneration!;
  const identity = { turnId: turn.turnId, attemptGeneration };
  await host.ctx.storage.transaction(async (txn) => {
    const [current, raw] = await Promise.all([
      txn.get<TurnRequest>("turn"),
      txn.get(agentComputeKey(turn.turnId, attemptGeneration)),
    ]);
    if (!exactTurnIdentityMatches(current, turn)) {
      throw new AgentTurnAuthorityLostError();
    }
    const compute = parsePersistedAgentCompute(raw, identity);
    if (!compute?.sandboxId) {
      await txn.delete(["sandboxId", "sandboxSize"]);
    }
  });
};

export const interruptAgentForBuilderFallback = async (
  host: ContainerTurnHost,
  turn: TurnRequest,
): Promise<void> => {
  const running = host.agentTurnExecutions.get(turn.turnId);
  if (!running) {
    await host.quiesceCurrentAgentSession(turn);
    return;
  }
  host.builderFallbackRecoveries.add(turn.turnId);
  try {
    await running.interrupt(
      new Error("The Builder is recovering this turn's durable workspace."),
    );
  } finally {
    host.builderFallbackRecoveries.delete(turn.turnId);
  }
};

export const runContainerAgentTurn = async (
  host: ContainerTurnHost,
  turn: TurnRequest,
  sandboxId: string,
  execution: TurnExecutionContext,
): Promise<void> => {
  const commandTimeoutMs = Number(host.env.TURN_TIMEOUT_MS);
  const requestStarted = performance.now();
  let sandbox = host.sandbox(sandboxId, "large", "world");
  const sessionId = agentTurnSessionId(turn.turnId);
  const daemonDirectory = attachedToolPaths({
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
  }).directory;
  const world = host.env.WORLDS.getByName(await worldName(turn.ownerId));
  log("info", "agent_turn_started", {
    turnId: turn.turnId,
    threadId: turn.threadId,
    sessionId: host.ctx.id.toString(),
  });
  try {
    await host.assertAgentExecutionActive(turn, execution);
    await host.event(
      turn,
      "auto",
      "started",
      { threadId: turn.threadId },
      false,
      execution.signal,
    );
    execution.assertActive();

    // Thread transcript for send_input continuations: the DO fetches it
    // (service secret) and hands it to the executor, which holds only the
    // turn token. Fetched once, before any sandbox exists, so an escalation
    // retry does not pay for it twice.
    const history = host.fetchCanonicalAgentHistory(turn, {
      excludeCurrentTurn: true,
      signal: execution.signal,
    });
    execution.assertActive();

    const canonicalHistoryCursor = await nativeHistoryCursorFromRows(history);
    let resolvedTurnState = await host.resolveAgentTurnState(
      turn,
      canonicalHistoryCursor,
    );
    execution.assertActive();
    if (resolvedTurnState.workspacePublication) {
      if (!resolvedTurnState.workspacePublication.publishable) {
        throw new AgentTurnError(
          "This workspace is still recovering a previous agent turn. Try again shortly.",
        );
      }
      host.assertAgentTurnIdentity(turn);
      await host.publishAgentTurnWorkspace(
        turn,
        canonicalHistoryCursor,
        resolvedTurnState.workspacePublication.operationId,
      );
      execution.assertActive();
      resolvedTurnState = await host.resolveAgentTurnState(
        turn,
        canonicalHistoryCursor,
      );
      execution.assertActive();
      if (resolvedTurnState.workspacePublication) {
        throw new AgentTurnError(
          "This workspace is still recovering a previous agent turn. Try again shortly.",
        );
      }
    }
    const turnStateWorkspaceRestore = resolvedTurnState.workspace;
    const turnStateThreadRestore = resolvedTurnState.restore;
    if (resolvedTurnState.registryPresent && !turnStateWorkspaceRestore) {
      throw new AgentTurnError(
        "This workspace's saved state is incomplete. Try again after Stella finishes recovering it.",
      );
    }
    if (
      resolvedTurnState.threadRegistryPresent &&
      !turnStateThreadRestore &&
      requiresExactThreadCandidate(turn.execution)
    ) {
      throw new AgentTurnError(
        "This agent's saved session no longer matches its cloud conversation. Start a new agent thread to continue safely.",
      );
    }
    await host.ctx.storage.put(
      turnStateBaseWorkspaceRevisionKey(turn.turnId, turn.attemptGeneration!),
      resolvedTurnState.baseWorkspaceRevision,
    );
    execution.assertActive();

    // The mirror snapshot is pinned once for the logical turn, before either
    // sandbox attempt. An OOM retry therefore cannot silently pick up a
    // device-side skill edit that landed halfway through the turn.
    const cloudSkillHome = host.env.AGENT_HOME
      ? new CloudHomeStore(host.env.AGENT_HOME, {
          base: host.env.STELLA_CONVEX_SITE_URL,
          // Owner-scoped control-plane reads and writes, authorized by this
          // turn rather than by the worker's shared secret.
          bearer: await host.controlPlaneCapability(turn),
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          assertExternalWrite: async () =>
            await host.assertAgentExecutionActive(turn, execution),
        })
      : undefined;
    const cloudSkillCatalog = cloudSkillHome
      ? await cloudSkillHome.loadSkillCatalog("general")
      : undefined;
    execution.assertActive();

    // Without the small class bound there is only one rung, so start (and
    // stay) on the large one rather than pretending to size anything.
    const proposedSize: InstanceSize = !host.env.SANDBOX_SMALL
      ? "large"
      : initialInstanceSize({ prompt: turn.prompt });
    let size = await world.selectContainerSize(proposedSize);
    await host.ctx.storage.put("sandboxSize", size);
    execution.assertActive();
    sandbox = host.sandbox(sandboxId, size, "world");
    let escalated = false;
    let attempt = await host.runAgentAttempt({
      turn,
      execution,
      sandbox,
      size,
      turnStateWorkspaceRestore,
      turnStateWorkspaceRestoreConfirmationRequired:
        resolvedTurnState.workspaceConfirmationRequired,
      turnStateThreadRestore,
      turnStateThreadRestoreConfirmationRequired:
        resolvedTurnState.confirmationRequired,
      history,
      cloudSkillHome,
      cloudSkillCatalog,
      commandTimeoutMs,
      sessionId,
    });
    execution.assertActive();

    // One escalation, one retry. The failed attempt's sandbox is discarded
    // rather than checkpointed — an OOM-killed workspace is not a state
    // worth persisting — so the retry restores the same checkpoint the
    // first attempt did.
    if (
      attempt.oom &&
      size === "small" &&
      (await host.ownsExactTurn(turn)) &&
      !(await host.ctx.storage.get<boolean>("terminal"))
    ) {
      await host.ctx.storage.delete(
        agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
      );
      await host.destroySandboxDurably(
        { sandboxId, size, workload: "world" },
        "agent_oom_resize",
      );
      execution.assertActive();
      size = "large";
      escalated = true;
      await world.rememberContainerSize("large");
      await host.ctx.storage.put({
        sandboxId,
        sandboxSize: size,
      });
      execution.assertActive();
      await host.assertAgentExecutionActive(turn, execution);
      // The watchdog budget was spent on the attempt that died; without a
      // fresh one the retry is guaranteed to be cut off mid-run and the
      // escalation buys nothing.
      const watchdogDeadlineAt =
        Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000);
      await host.ctx.storage.put(
        AGENT_WATCHDOG_DEADLINE_KEY,
        watchdogDeadlineAt,
      );
      await host.ctx.storage.setAlarm(
        Math.min(watchdogDeadlineAt, Date.now() + AGENT_TURN_HEARTBEAT_MS),
      );
      execution.assertActive();
      log("info", "agent_turn_resized", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        instanceType: INSTANCE_TIERS[size].instanceType,
      });
      await host
        .event(
          turn,
          "auto",
          "resized",
          {
            reason: "out_of_memory",
            instanceType: INSTANCE_TIERS[size].instanceType,
          },
          false,
          execution.signal,
        )
        .catch(() => undefined);
      execution.assertActive();
      sandbox = host.sandbox(sandboxId, size, "world");
      attempt = await host.runAgentAttempt({
        turn,
        execution,
        sandbox,
        size,
        turnStateWorkspaceRestore,
        turnStateWorkspaceRestoreConfirmationRequired:
          resolvedTurnState.workspaceConfirmationRequired,
        turnStateThreadRestore,
        turnStateThreadRestoreConfirmationRequired:
          resolvedTurnState.confirmationRequired,
        history,
        cloudSkillHome,
        cloudSkillCatalog,
        commandTimeoutMs,
        sessionId,
      });
      execution.assertActive();
    }
    const { coldContainerStartMs, restoreMs } = attempt;
    let result = attempt.result;
    let builderFallbackUsed = false;
    let interiorCandidate:
      | Awaited<ReturnType<BuildSessionInternals["publishInteriorCandidate"]>>
      | undefined;

    // A stale turn (alarm fired, or a successor continuation took over
    // this thread's DO) must not checkpoint over the successor's restore
    // or report on the shared thread.
    if (
      !(await host.ownsExactTurn(turn)) ||
      (await host.ctx.storage.get<boolean>("terminal"))
    ) {
      await host
        .releaseAgentSessionResources({
          sandboxId,
          size,
          workload: "world",
          sessionId,
          daemonDirectory,
        })
        .catch(() => undefined);
      log("info", "agent_turn_superseded", {
        turnId: turn.turnId,
        threadId: turn.threadId,
      });
      return;
    }

    if (result.checkpointPolicy === "builder_fallback") {
      try {
        const marker = await host.exactAgentExecutionMarker(turn);
        if (!marker) {
          throw new Error("Agent execution recovery marker was missing.");
        }
        await host.quiesceCurrentAgentSession(turn);
        const fallbackReceipt =
          await host.reconcileAgentCheckpointAfterQuiescence(
            turn,
            marker,
            result.error ??
              "The agent stopped unexpectedly after making workspace changes.",
            result.builderFallback,
          );
        const recoveredSuspension = await host.recoverObservedBrowserSuspension(
          turn,
          fallbackReceipt,
          execution.signal,
        );
        if (recoveredSuspension) {
          // The executor process/finalizer was lost after the Gateway wait,
          // checkpoint, and transcript all committed. Reconstruct only the
          // secret-free result; the canonical transcript supplies the outer
          // Code id and the durable Gateway observation supplies the rest.
          result = {
            outcome: "suspended",
            ok: false,
            finalText: "",
            usage: result.usage ?? {},
            checkpointMs: result.checkpointMs ?? 0,
            turnStateCheckpoint: fallbackReceipt,
            suspension: recoveredSuspension,
          };
          builderFallbackUsed = false;
        } else {
          builderFallbackUsed = true;
          result = {
            ...result,
            checkpointPolicy: undefined,
            turnStateCheckpoint: fallbackReceipt,
          };
        }
      } catch (error) {
        // The journal and sandbox disk are retained. Alarm replay resumes
        // the same operation/request ids; it never manufactures a second
        // archive after a lost checkpoint/transcript/publication response.
        log("error", "agent_builder_fallback_deferred", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(error),
        });
        await host.setExactTurnAlarm(turn, Date.now() + 1_000);
        return;
      }
    }

    if (result.ok) {
      const interior = await host.publishRequestedInteriorCandidate({
        turn,
        sandbox,
        commandTimeoutMs,
        turnExecution: execution,
      });
      if (interior.outcome === "abandoned") {
        await host
          .releaseAgentSessionResources({
            sandboxId,
            size,
            workload: "world",
            sessionId,
            daemonDirectory,
          })
          .catch(() => undefined);
        return;
      }
      if (interior.outcome === "published") {
        interiorCandidate = interior.candidate;
      }
      if (interior.outcome === "failed") {
        result = { ...result, ok: false, error: interior.error };
      }
    }

    // The executor's broker receipt proves that the deterministic workspace
    // (and optional native) archive pair committed before the transcript was
    // accepted. There is deliberately no second SDK backup here: that would
    // reintroduce random-address orphan bytes and split the atomic boundary.
    const checkpointMs =
      Number.isSafeInteger(result.checkpointMs) && result.checkpointMs! >= 0
        ? result.checkpointMs!
        : 0;
    let checkpointError: string | undefined;
    const checkpoint = result.turnStateCheckpoint;
    if (result.checkpointPolicy !== "preserve_prior") {
      if (!validTurnStateCheckpointReceipt(checkpoint)) {
        checkpointError =
          "The executor did not return a valid turn-state receipt.";
      } else {
        try {
          await host.assertAgentExecutionActive(turn, execution);
          const canonicalRows = host.fetchCanonicalAgentHistory(turn, {
            excludeCurrentTurn: false,
            signal: execution.signal,
          });
          execution.assertActive();
          if (
            (await nativeHistoryCursorFromRows(canonicalRows)) !==
            checkpoint.historyCursor
          ) {
            throw new Error(
              "The checkpoint transcript was not canonical in cloud history.",
            );
          }
          await host.publishAgentTurnWorkspace(
            turn,
            checkpoint.historyCursor,
            checkpoint.operationId,
          );
          execution.assertActive();
          const published = await host.resolveAgentTurnState(
            turn,
            checkpoint.historyCursor,
            { allowMissingNative: builderFallbackUsed },
          );
          if (
            published.workspacePublication ||
            !published.workspace ||
            !published.restore ||
            published.workspace.operationId !== checkpoint.operationId ||
            published.workspace.manifestId !== checkpoint.manifestId ||
            published.restore.workspace.manifestId !== checkpoint.manifestId
          ) {
            throw new Error(
              "The canonical turn state did not match its checkpoint receipt.",
            );
          }
        } catch (error) {
          // Transcript acceptance already makes this cursor canonical. A
          // response lost during promotion is restart-safe: the next turn's
          // registry-first resolve performs the same exact promotion. Keep
          // the committed receipt visible, but do not manufacture a second
          // archive or fall back to a legacy pointer.
          if (error instanceof TurnStateOwnerCallError && error.status >= 500) {
            log("error", "turn_state_promotion_deferred", {
              turnId: turn.turnId,
              message: errorMessage(error),
            });
            // Do not terminalize or destroy the only sandbox while the
            // canonical transcript points at an unpublished workspace.
            // The durable checkpoint operation + execution marker let the
            // alarm replay this exact publication after response loss.
            throw error;
          } else {
            checkpointError = errorMessage(error);
          }
        }
      }
    }
    if (
      !(await host.ownsExactTurn(turn)) ||
      (await host.ctx.storage.get<boolean>("terminal"))
    ) {
      await host
        .releaseAgentSessionResources({
          sandboxId,
          size,
          workload: "world",
          sessionId,
          daemonDirectory,
        })
        .catch(() => undefined);
      return;
    }
    if (checkpointError) {
      log("error", "agent_turn_state_invalid", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: checkpointError,
      });
      await host
        .event(
          turn,
          "auto",
          "checkpoint_failed",
          {
            message:
              "Stella could not validate the durable workspace receipt for this turn.",
          },
          false,
          execution.signal,
        )
        .catch(() => undefined);
      execution.assertActive();
      if (result.ok) {
        result = {
          ...result,
          ok: false,
          error:
            "Stella could not validate the durable workspace receipt for this turn. Please retry before continuing this agent.",
          finalText:
            `${result.finalText ?? ""}\n\nHeads up: Stella could not validate the durable workspace receipt for this turn. Please retry before continuing this agent.`.trim(),
        };
      } else if (result.outcome === "suspended") {
        // A human wait is resumable only from the exact checkpoint whose
        // transcript ends at the browser tool call. Never expose a takeover
        // for a turn whose continuation receipt cannot be reconstructed.
        result = {
          outcome: "completed",
          ok: false,
          error:
            "Stella couldn't hand this sign-in over to you safely. Please try again.",
        };
      }
    }

    if (
      result.outcome === "suspended" &&
      result.suspension &&
      validTurnStateCheckpointReceipt(result.turnStateCheckpoint)
    ) {
      const verifiedSuspension = await host.recoverObservedBrowserSuspension(
        turn,
        result.turnStateCheckpoint,
        execution.signal,
      );
      if (
        !verifiedSuspension ||
        cloudBrowserSuspensionMarker(verifiedSuspension) !==
          cloudBrowserSuspensionMarker(result.suspension)
      ) {
        log("error", "browser_suspension_checkpoint_mismatch", {
          turnId: turn.turnId,
          threadId: turn.threadId,
        });
        result = {
          outcome: "completed",
          ok: false,
          error:
            "Stella couldn't hand this sign-in over to you safely. Please try again.",
          turnStateCheckpoint: result.turnStateCheckpoint,
        };
      } else {
        result = { ...result, suspension: verifiedSuspension };
      }
    }

    const wallClockMs = Math.round(performance.now() - requestStarted);
    if (result.outcome === "suspended" && result.suspension) {
      const pendingBrowserSuspension: PendingBrowserSuspension = {
        schemaVersion: 1,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        suspension: result.suspension,
        payload: {
          suspension: result.suspension,
          usage: result.usage,
          coldContainerStartMs,
          restoreMs,
          checkpointMs,
          wallClockMs,
          instanceType: INSTANCE_TIERS[size].instanceType,
        },
        createdAt: Date.now(),
      };
      // Stop/timeout and suspension are competing decisions. Commit the
      // secret-free wait descriptor only while no terminal path has won,
      // and remove the execution marker in the same transaction so alarm
      // recovery cannot mistake this intentionally exited executor for a
      // crashed one.
      const retained = await host.retainPendingBrowserSuspension(
        turn,
        pendingBrowserSuspension,
      );
      await host
        .releaseAgentSessionResources({
          sandboxId,
          size,
          workload: "world",
          sessionId,
          daemonDirectory,
        })
        .catch(() => undefined);
      if (!retained) return;

      const delivered = await host.deliverBrowserSuspension(
        turn,
        pendingBrowserSuspension,
      );
      if (delivered && (await host.ownsExactTurn(turn))) {
        if (await host.settleAgentTransientBackup(turn)) {
          await host.deleteTurnStoragePreservingExactCancellations(turn, true);
        } else {
          await host.setExactTurnAlarm(turn, Date.now() + 30_000);
        }
      }
      log("info", "agent_turn_suspended_for_browser_handoff", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        interactionId: result.suspension.interactionId,
        wallClockMs,
      });
      emitCloudTurnTelemetry(host.ctx, host.env, {
        type: "cloud.turn",
        workload: "agent",
        phase: "suspended",
        wallClockMs,
        coldContainerStartMs,
        restoreMs,
        checkpointMs,
        ...(typeof result.usage?.inputTokens === "number"
          ? { inputTokens: result.usage.inputTokens }
          : {}),
        ...(typeof result.usage?.outputTokens === "number"
          ? { outputTokens: result.usage.outputTokens }
          : {}),
        ...(typeof result.usage?.llmCalls === "number"
          ? { llmCalls: result.usage.llmCalls }
          : {}),
        instanceType: INSTANCE_TIERS[size].instanceType,
      });
      return;
    }

    let pending: PendingTerminal;
    if (result.ok) {
      pending = {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        kind: "completed",
        payload: {
          finalText: result.finalText ?? "",
          usage: result.usage,
          coldContainerStartMs,
          restoreMs,
          checkpointMs,
          wallClockMs,
          instanceType: INSTANCE_TIERS[size].instanceType,
          ...(interiorCandidate ? { interiorCandidate } : {}),
        },
      };
    } else {
      let message = result.error ?? "The agent failed.";
      if (checkpointError) {
        message = `${message} Do not continue this agent until the turn is retried.`;
      }
      pending = {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        kind: "failed",
        payload: { message },
        threadError: message,
      };
    }
    const delivered = await host.deliverTerminal(turn, pending);
    await host
      .releaseAgentSessionResources({
        sandboxId,
        size,
        workload: "world",
        sessionId,
        daemonDirectory,
      })
      .catch(() => undefined);
    // Storage is the redelivery's only memory: clear it once the terminal
    // state is in Convex, and leave it — with the alarm deliverTerminal
    // re-armed — when it is not.
    if (delivered && (await host.ownsExactTurn(turn))) {
      if (await host.settleAgentTransientBackup(turn)) {
        await host.deleteTurnStoragePreservingExactCancellations(turn, true);
      } else {
        await host.setExactTurnAlarm(turn, Date.now() + 30_000);
      }
    }
    log("info", "agent_turn_finished", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      ok: result.ok,
      wallClockMs,
    });
    emitCloudTurnTelemetry(host.ctx, host.env, {
      type: "cloud.turn",
      workload: "agent",
      phase: result.ok ? "completed" : "failed",
      wallClockMs,
      coldContainerStartMs,
      restoreMs,
      checkpointMs,
      ...(typeof result.usage?.inputTokens === "number"
        ? { inputTokens: result.usage.inputTokens }
        : {}),
      ...(typeof result.usage?.outputTokens === "number"
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      ...(typeof result.usage?.llmCalls === "number"
        ? { llmCalls: result.usage.llmCalls }
        : {}),
      instanceType: INSTANCE_TIERS[size].instanceType,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (host.builderFallbackRecoveries.has(turn.turnId)) {
      // Alarm recovery owns the exact kill/join/archive sequence. Destroying
      // the sandbox here would discard the only surviving workspace bytes
      // between quiescence and the deterministic Builder checkpoint.
      log("info", "agent_turn_yielded_to_builder_fallback", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message,
      });
      return;
    }
    let executionMarker: AgentExecutionMarker | undefined;
    try {
      executionMarker = await host.exactAgentExecutionMarker(turn);
    } catch (markerError) {
      log("error", "agent_recovery_marker_invalid", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(markerError),
      });
      await host.setExactTurnAlarm(turn, Date.now() + 30_000);
      return;
    }
    if (
      executionMarker &&
      !(
        error instanceof CapturedSessionAbandonedError &&
        error.disposition === "compute_released"
      ) &&
      !(error instanceof AgentTurnAuthorityLostError) &&
      !(error instanceof OwnerPurgeFenceError) &&
      (await host.ownsExactTurn(turn)) &&
      !(await host.ctx.storage.get<boolean>("terminal"))
    ) {
      // A model-controlled process was admitted. Retain the disk and let
      // the alarm resume the durable fallback journal after this promise
      // has fully unwound; snapshotting from this catch could race a late
      // descendant or a platform exec promise that has not joined yet.
      log("error", "agent_turn_recovery_scheduled", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message,
      });
      await host.mutateExactTurn(turn, async (txn) => {
        await txn.put(AGENT_RECOVERY_PENDING_KEY, agentRecoveryIdentity(turn));
        await txn.setAlarm(Date.now() + 1_000);
      });
      return;
    }
    if (await host.ctx.storage.get<boolean>("terminal")) return;
    try {
      await host.terminateCurrentAgentSession(turn);
    } catch (releaseError) {
      log("error", "agent_session_release_deferred", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(releaseError),
      });
      await host.claimTerminalDecision(
        turn,
        {
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          kind: "failed",
          payload: {
            message: "The agent hit a problem and stopped. Try again.",
          },
          threadError: "The agent hit a problem and stopped. Try again.",
          terminateSandbox: true,
        },
        Date.now() + 30_000,
      );
      return;
    }
    const failureCode = classifyAgentFailureDiagnostic(message);
    log("error", "agent_turn_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      message,
      failureCode,
    });
    if (error instanceof AgentTurnAuthorityLostError) {
      // Rotation/reset may have admitted another physical executor under the
      // same logical turn id. Never project this stale isolate's unwind as a
      // terminal outcome or delete shared DO state; its sandbox is already
      // gone and the authoritative attempt owns recovery.
      log("info", "agent_turn_authority_lost", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration,
      });
      return;
    }
    // Fencing: a stale unwind (successor accepted on this thread's DO, or
    // the alarm already owns terminal delivery) must not fail the thread,
    // kill the successor's watchdog, or wipe shared storage.
    if (!(await host.ownsExactTurn(turn))) return;
    if (await host.ctx.storage.get<boolean>("terminal")) return;
    if (error instanceof OwnerPurgeFenceError) {
      try {
        await host.cleanupOwnerPurgedTurnStorage(turn);
      } catch (cleanupError) {
        log("error", "owner_purge_agent_cleanup_failed", {
          turnId: turn.turnId,
          message: errorMessage(cleanupError),
        });
      }
      return;
    }
    // Raw infrastructure errors stay in logs; only messages written for a
    // person reach the thread and the event.
    const friendly =
      error instanceof AgentTurnError
        ? error.userMessage
        : devAcceptanceProbesEnabled(host.env)
          ? `The agent hit a problem and stopped. Try again. [diagnostic: turn.${failureCode}]`
          : "The agent hit a problem and stopped. Try again.";
    const delivered = await host.deliverTerminal(turn, {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      kind: "failed",
      payload: { message: friendly },
      threadError: friendly,
    });
    // Undelivered leaves storage and the re-armed alarm in place, so the
    // turn cannot stay "running" forever.
    if (delivered && (await host.ownsExactTurn(turn))) {
      if (await host.settleAgentTransientBackup(turn)) {
        await host.deleteTurnStoragePreservingExactCancellations(turn, true);
      } else {
        await host.setExactTurnAlarm(turn, Date.now() + 30_000);
      }
    }
  } finally {
    await host.unregisterTurn(turn);
  }
};

/**
 * Bring a container up with this owner's world on disk: create the command
 * session, restore the canonical archives (or seed a first world), verify
 * the packaged renderer still matches, and confirm the restore with the
 * owner fence.
 *
 * Shared by the eager container path and the compute ladder's lazy attach,
 * which is the whole point: a mid-turn attach has to land on exactly the
 * disk an eager boot would have produced, or the two placements would
 * disagree about what a checkpoint means. It deliberately does not emit
 * `sandbox_ready` — the eager path reports a boot, the ladder reports an
 * attach, and the payloads differ.
 */
export const attachAgentWorld = async (
  host: ContainerTurnHost,
  args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>;
    size: InstanceSize;
    turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
    turnStateWorkspaceRestoreConfirmationRequired: boolean;
    turnStateThreadRestore?: TurnStateCandidate;
    turnStateThreadRestoreConfirmationRequired: boolean;
    history: AgentHistoryRow[];
    commandTimeoutMs: number;
    sessionId: string;
  },
): Promise<{
  session: ExecutionSession;
  coldContainerStartMs: number;
  restoreMs: number;
}> => {
  const { turn, execution: turnExecution, sandbox } = args;
  const worldRoot = worldRootForFork(turn.workspaceForkId);
  const stellaRoot = stellaRootForWorld(worldRoot);
  const coldStarted = performance.now();
  await host.assertAgentExecutionActive(turn, turnExecution);
  const session = await sandbox.createSession({
    id: args.sessionId,
    cwd: "/opt/stella",
    commandTimeoutMs: args.commandTimeoutMs,
    env: executorSessionEnvironment(),
  });
  turnExecution.assertActive();
  const coldContainerStartMs = Math.round(performance.now() - coldStarted);

  // Sandbox disk is a projection of the world object, never its owner.
  let restoreMs = 0;
  await normalizeToolWorkspaceRoot(session, worldRoot);
  turnExecution.assertActive();
  const restoreStarted = performance.now();
  const name = await worldName(turn.ownerId);
  const world = host.env.WORLDS.getByName(name);
  const forkOptions = turn.workspaceForkId
    ? { fork: turn.workspaceForkId }
    : {};
  const head = await world.head(forkOptions);
  const capability = await issueWorldCapability({
    secret: host.env.BUILDER_SERVICE_SECRET,
    worldName: name,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    now: Date.now(),
    ttlMs: Math.max(1, Math.min(30 * 60_000, args.commandTimeoutMs)),
  });
  const origin = host.env.CLOUD_BUILDER_PUBLIC_URL.replace(/\/+$/u, "");
  const exportUrl = new URL(`${origin}/internal/worlds/${name}/export`);
  exportUrl.searchParams.set("manifest", head.manifestId);
  if (turn.workspaceForkId) {
    exportUrl.searchParams.set("fork", turn.workspaceForkId);
  }
  const materialized = await session.exec(
    worldMaterializationCommand({
      worldRoot,
      manifestId: head.manifestId,
      exportUrl: exportUrl.toString(),
      capability,
    }),
    { origin: "internal", timeout: args.commandTimeoutMs },
  );
  if (!materialized.success)
    throw new AgentTurnError("Stella could not materialize this world.");
  turnExecution.assertActive();
  restoreMs = Math.round(performance.now() - restoreStarted);

  // `world/stella` is a real, buildable renderer checkout from the immutable
  // image, never an empty directory the model has to invent. Once it exists
  // its recorded seed has to still match the image, or a self-update would
  // be built on top of a renderer Stella no longer ships.
  const stellaPresent = await stellaToolWorkspaceExists(session, worldRoot);
  turnExecution.assertActive();
  if (!stellaPresent) {
    await seedFirstStellaToolWorkspace(session, worldRoot);
    turnExecution.assertActive();
  } else {
    const readJson = async (filePath: string) => {
      const read = await session.readFile(filePath, { encoding: "base64" });
      turnExecution.assertActive();
      return JSON.parse(atob(read.content)) as Record<string, unknown>;
    };
    const [interiorState, imageSeed] = await Promise.all([
      readJson(`${stellaRoot}/.stella/interior-source.json`),
      readJson("/opt/stella/interior-seed.json"),
    ]);
    const interiorSeedRevision =
      typeof interiorState.upstreamSeedRevision === "string"
        ? interiorState.upstreamSeedRevision
        : interiorState.buildId === undefined &&
            typeof interiorState.sourceRevision === "string"
          ? interiorState.sourceRevision
          : null;
    if (
      !interiorSeedRevision ||
      typeof imageSeed.sourceRevision !== "string" ||
      interiorSeedRevision !== imageSeed.sourceRevision
    ) {
      throw new AgentTurnError(
        "Stella's packaged renderer changed since this world was created. Its existing customizations need an upstream migration before another self-update can be built.",
      );
    }
  }
  if (args.turnStateThreadRestore?.native) {
    const nativeRestoreStarted = performance.now();
    turnExecution.assertActive();
    await restoreTurnStateArchive({
      session,
      bucket: host.env.BACKUP_BUCKET,
      archive: args.turnStateThreadRestore.native,
      target: { kind: "native" },
    });
    turnExecution.assertActive();
    restoreMs += Math.round(performance.now() - nativeRestoreStarted);
  }
  turnExecution.assertActive();
  if (args.turnStateWorkspaceRestore || args.turnStateThreadRestore) {
    await host.confirmAgentTurnStateRestore(
      turn,
      await nativeHistoryCursorFromRows(args.history),
      args.turnStateWorkspaceRestore,
      args.turnStateWorkspaceRestoreConfirmationRequired,
      args.turnStateThreadRestore,
      args.turnStateThreadRestoreConfirmationRequired,
    );
    turnExecution.assertActive();
  }
  return { session, coldContainerStartMs, restoreMs };
};

/**
 * One sandbox attempt at an agent turn: boot, restore the workspace, hand
 * the executor its input, run it. Kept separate from {@link runAgentTurn}
 * so an OOM escalation can repeat it on a bigger instance without
 * duplicating any of the turn's lifecycle or fencing.
 */
export const runAgentAttempt = async (
  host: ContainerTurnHost,
  args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    sandbox: ReturnType<BuildSessionInternals["sandbox"]>;
    size: InstanceSize;
    /** Latest canonical owner world manifest, shared across all threads. */
    turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
    turnStateWorkspaceRestoreConfirmationRequired: boolean;
    /** Canonical transcript/native state for this exact thread only. */
    turnStateThreadRestore?: TurnStateCandidate;
    turnStateThreadRestoreConfirmationRequired: boolean;
    history: AgentHistoryRow[];
    cloudSkillHome?: CloudHomeStore;
    cloudSkillCatalog?: CloudSkillCatalogSnapshot;
    commandTimeoutMs: number;
    sessionId: string;
  },
): Promise<{
  result: AgentExecutorResult;
  oom: boolean;
  coldContainerStartMs: number;
  restoreMs: number;
}> => {
  const { turn, execution: turnExecution, sandbox } = args;
  const world = await host.attachAgentWorld(args);
  const { session, coldContainerStartMs, restoreMs } = world;
  await host.event(
    turn,
    "auto",
    "sandbox_ready",
    {
      coldContainerStartMs,
      restoreMs,
      restored: Boolean(args.turnStateWorkspaceRestore),
      instanceType: INSTANCE_TIERS[args.size].instanceType,
    },
    false,
    turnExecution.signal,
  );
  let cloudSkills:
    | Awaited<ReturnType<typeof materializeCloudSkillSnapshot>>
    | undefined = undefined;
  if (args.cloudSkillHome && args.cloudSkillCatalog) {
    turnExecution.assertActive();
    cloudSkills = await materializeCloudSkillSnapshot({
      home: args.cloudSkillHome,
      snapshot: args.cloudSkillCatalog,
      session,
      assertActive: () => turnExecution.assertActive(),
    });
    turnExecution.assertActive();
  }

  // The native CLI's resumable session lives in the root-only backup mount.
  // Its full-tree attestation is bound to this builder-derived owner/thread
  // key, consumed before any model or tool process starts.
  const nativeStateIntegrityKey = await nativeStateIntegrityKeyFor(
    host.env,
    turn,
  );
  turnExecution.assertActive();

  if (!turn.turnBrokerRoute) {
    throw new AgentTurnAuthorityLostError();
  }
  const brokerIdentity = {
    sessionId: turn.turnBrokerRoute.sessionId,
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
  };
  const issuedBroker = await issueTurnBrokerCredential({
    identity: brokerIdentity,
    endpoint: turn.turnBrokerRoute.endpoint,
    now: Date.now(),
    ttlMs: Math.max(1, Math.min(TURN_BROKER_MAX_TTL_MS, args.commandTimeoutMs)),
  });
  const brokerRecordKey = turnBrokerStorageKey(brokerIdentity);
  await host.ctx.storage.put(brokerRecordKey, issuedBroker.record);
  turnExecution.assertActive();
  const brokerCredentialsPath = turnBrokerCredentialsPath();
  let credentialsPath: string | undefined;
  let projectInput: Record<string, unknown> | undefined;
  let execution: Execution | undefined;
  let capturedExecutionError: unknown;
  let recordedExecutorResultText: string | undefined;
  let recordedResultProcessQuiesced = false;
  try {
    await session.writeFile(
      brokerCredentialsPath,
      JSON.stringify(issuedBroker.handoff),
    );
    const protectedBrokerHandoff = await session.exec(
      `chmod 600 ${brokerCredentialsPath}`,
    );
    if (!protectedBrokerHandoff.success) {
      throw new Error("Turn broker handoff could not be protected.");
    }
    turnExecution.assertActive();

    // The sandbox reaches the model gateway directly with a turn capability
    // minted here. Minting happens after the broker handoff is protected
    // and right before the executor is admitted, so the capability's
    // lifetime tracks the attempt as closely as possible.
    if (!turn.execution) throw new AgentTurnAuthorityLostError();
    const modelGateway = await mintAgentTurnModelGateway(
      host.env,
      turn,
      turn.execution,
    );
    turnExecution.assertActive();

    // turn-input.json sits above the world root on purpose: the
    // checkpoint only covers the root, so nothing here reaches a durable
    // backup. The executor unlinks it before any model or tool process
    // exists, so the capability never becomes readable by agent shells.
    turnExecution.assertActive();
    await session.writeFile(
      "/workspace/turn-input.json",
      JSON.stringify({
        kind: "agent",
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        conversationId: turn.conversationId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration,
        prompt: turn.prompt,
        workspaceRestored: Boolean(args.turnStateWorkspaceRestore),
        nativeStateIntegrityKey,
        turnBroker: { credentialsPath: brokerCredentialsPath },
        world: {
          origin: host.env.CLOUD_BUILDER_PUBLIC_URL.replace(/\/+$/u, ""),
          name: await worldName(turn.ownerId),
          ...(turn.workspaceForkId ? { fork: turn.workspaceForkId } : {}),
          capability: await issueWorldCapability({
            secret: host.env.BUILDER_SERVICE_SECRET,
            worldName: await worldName(turn.ownerId),
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration!,
            now: Date.now(),
            ttlMs: Math.max(1, Math.min(30 * 60_000, args.commandTimeoutMs)),
          }),
        },
        modelGateway: {
          origin: modelGateway.origin,
          capability: modelGateway.capability,
        },
        history: args.history,
        ...(turn.browserResume ? { browserResume: turn.browserResume } : {}),
        ...(cloudSkills ? { skills: cloudSkills } : {}),
        ...(turn.execution ? { execution: turn.execution } : {}),
      }),
    );
    turnExecution.assertActive();
    // Remove any result left by a lost predecessor before this exact
    // executor is admitted. The file sits in root-owned /workspace, outside
    // every checkpointed/model-writable workspace root.
    await session
      .deleteFile(CLOUD_AGENT_TURN_RESULT_PATH)
      .catch(() => undefined);
    turnExecution.assertActive();
    const markerKey = agentExecutionMarkerKey(
      turn.turnId,
      turn.attemptGeneration!,
    );
    turnExecution.assertActive();
    log("info", "agent_executor_admission_started", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      attemptGeneration: turn.attemptGeneration,
    });
    const executorProcessId = sessionName(
      `agent-executor-${turn.turnId}-${turn.attemptGeneration}`,
    );
    const resultPollCancellation = createTurnRetryCancellation();
    const captureOutcome = capturedSessionExec(
      sandbox,
      ["bun", "packages/executor-cloud/src/cli.ts", "--agent-turn"],
      args.commandTimeoutMs,
      {
        cwd: "/opt/stella",
        env: executorSessionEnvironment(),
        // The root-only result file is authoritative. Bound the optional
        // stdout transfer well below the durable execution-marker alarm so
        // this invocation can recover the file before alarm fallback runs.
        resultTimeoutMs: 10_000,
        processId: executorProcessId,
        signal: turnExecution.signal,
        onAbandon: async ({ phase, processId }) => {
          if (phase === "process_unsettled") {
            try {
              // An exact tree-aware kill is sufficient to stop every
              // model-controlled writer. Keep the session for the durable
              // Builder fallback, which performs its own final session
              // teardown before reading the workspace.
              await withInfrastructureDeadline(
                sandbox.killProcess(processId, "SIGKILL"),
                35_000,
                "Captured session process kill did not settle.",
              );
              return "session_quiesced" as const;
            } catch {
              // A kill ambiguity must not reach Builder fallback. Fence a
              // generic terminal result before rotating the sandbox lifetime;
              // alarm replay will only retry teardown/delivery, never archive
              // a newly recreated empty container.
            }
          }
          const teardownPending: PendingTerminal = {
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration!,
            kind: "failed",
            payload: {
              message: "The agent hit a problem and stopped. Try again.",
            },
            threadError: "The agent hit a problem and stopped. Try again.",
            terminateSandbox: true,
          };
          await host.claimTerminalDecision(
            turn,
            teardownPending,
            Date.now() + 1_000,
          );
          await host.terminateCurrentAgentSession(turn);
          await host.ctx.storage
            .transaction(async (transaction) => {
              if (
                exactTurnIdentityMatches(
                  await transaction.get<TurnRequest>("turn"),
                  turn,
                )
              ) {
                await transaction.delete(markerKey);
              }
            })
            .catch((error) => {
              log("error", "agent_execution_marker_cleanup_deferred", {
                turnId: turn.turnId,
                threadId: turn.threadId,
                message: errorMessage(error),
              });
            });
          return "compute_released" as const;
        },
        onStarted: async () => {
          // The durable marker means the trusted executor that can spawn
          // model-controlled children exists, not merely that its sandbox
          // and turn input are ready. This keeps cancellation and fallback
          // recovery from resolving a process RPC for a command that never
          // crossed the sessionless process boundary.
          turnExecution.assertActive();
          const marker = await host.ctx.storage.transaction(
            async (transaction): Promise<AgentExecutionMarker> => {
              const [current, currentSandboxId, currentSize] =
                await Promise.all([
                  transaction.get<TurnRequest>("turn"),
                  transaction.get<string>("sandboxId"),
                  transaction.get<InstanceSize>("sandboxSize"),
                ]);
              if (
                !exactTurnIdentityMatches(current, turn) ||
                !currentSandboxId ||
                currentSize !== args.size
              ) {
                throw new AgentTurnAuthorityLostError();
              }
              const value: AgentExecutionMarker = {
                schemaVersion: 1,
                turnId: turn.turnId,
                attemptGeneration: turn.attemptGeneration!,
                sandboxId: currentSandboxId,
                size: args.size,
                startedAt: Date.now(),
              };
              await transaction.put(markerKey, value);
              return value;
            },
          );
          if (marker.turnId !== turn.turnId) {
            throw new AgentTurnAuthorityLostError();
          }
          turnExecution.assertActive();
          log("info", "agent_executor_process_started", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            attemptGeneration: turn.attemptGeneration,
          });
        },
      },
    ).then(
      (capturedExecution) =>
        ({
          kind: "execution" as const,
          execution: capturedExecution,
        }) as const,
      (error: unknown) =>
        ({ kind: "execution_error" as const, error }) as const,
    );
    const resultFileOutcome = waitForCloudAgentTurnResultText(
      session,
      [turnExecution.signal],
      resultPollCancellation,
    ).then(
      (resultText) => ({ kind: "result_file" as const, resultText }) as const,
      (error: unknown) =>
        ({ kind: "result_file_error" as const, error }) as const,
    );
    const firstOutcome = await Promise.race([
      captureOutcome,
      resultFileOutcome,
    ]);
    resultPollCancellation.abort(
      new Error("Agent process observation already settled."),
    );
    if (firstOutcome.kind === "execution") {
      execution = firstOutcome.execution;
      recordedResultProcessQuiesced = true;
    } else if (firstOutcome.kind === "execution_error") {
      capturedExecutionError = firstOutcome.error;
      recordedResultProcessQuiesced = !(
        firstOutcome.error instanceof CapturedSessionAbandonedError
      );
    } else if (firstOutcome.kind === "result_file_error") {
      throw firstOutcome.error;
    } else {
      recordedExecutorResultText = firstOutcome.resultText;
      const captureAfterFile = await Promise.race([
        captureOutcome,
        runToolEffect(
          Effect.sleep(1_000).pipe(
            Effect.as({ kind: "capture_pending" as const }),
          ),
        ),
      ]);
      if (captureAfterFile.kind === "execution") {
        execution = captureAfterFile.execution;
        recordedResultProcessQuiesced = true;
      } else if (captureAfterFile.kind === "execution_error") {
        capturedExecutionError = captureAfterFile.error;
        recordedResultProcessQuiesced =
          !(captureAfterFile.error instanceof CapturedSessionAbandonedError) ||
          captureAfterFile.error.disposition === "session_quiesced";
      } else {
        // The executor writes this file only after its checkpoint and
        // transcript work has completed. If Cloudflare's process registry is
        // still waiting, stop that exact process tree before accepting the
        // root-only result.
        await withInfrastructureDeadline(
          sandbox.killProcess(executorProcessId, "SIGKILL"),
          10_000,
          "Completed agent executor could not be quiesced.",
        );
        recordedResultProcessQuiesced = true;
      }
    }
    turnExecution.assertActive();
  } catch (error) {
    capturedExecutionError = error;
  } finally {
    recordedExecutorResultText ??= await readCloudAgentTurnResultText(session);
    await session
      .deleteFile(CLOUD_AGENT_TURN_RESULT_PATH)
      .catch(() => undefined);
    // The executor unlinks this the moment it has read it; this is the
    // backstop for an executor that died before it got that far, so the
    // token cannot outlive the process that needed it.
    if (credentialsPath) {
      await session.deleteFile(credentialsPath).catch(() => undefined);
    }
    await session.deleteFile(brokerCredentialsPath).catch(() => undefined);
    await host.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<TurnBrokerRecord>(brokerRecordKey);
      if (
        current?.capabilityHash === issuedBroker.record.capabilityHash &&
        current.state === "active"
      ) {
        await txn.put(
          brokerRecordKey,
          revokeTurnBrokerCredential(current, Date.now()),
        );
      }
    });
  }
  let recordedExecutorResult: AgentExecutorResult | null = null;
  if (recordedExecutorResultText) {
    try {
      recordedExecutorResult = parseAgentExecutorResult(
        JSON.parse(recordedExecutorResultText) as unknown,
      );
    } catch {
      recordedExecutorResult = null;
    }
  }
  if (
    recordedExecutorResult &&
    recordedResultProcessQuiesced &&
    !turnExecution.signal.aborted
  ) {
    log("info", "agent_executor_result_file_recovered", {
      turnId: turn.turnId,
      threadId: turn.threadId,
    });
    return {
      result: recordedExecutorResult,
      oom: false,
      coldContainerStartMs,
      restoreMs,
    };
  }
  if (capturedExecutionError) {
    throw capturedExecutionError;
  }
  if (!execution) {
    throw new Error("Captured agent executor returned no process result.");
  }
  if (execution.success) {
    try {
      const parsed =
        recordedExecutorResult ??
        parseAgentExecutorResult(
          JSON.parse(
            execution.stdout.trim().split("\n").at(-1) ?? "{}",
          ) as unknown,
        );
      if (!parsed) throw new Error("invalid agent executor result");
      return {
        result: parsed,
        oom: false,
        coldContainerStartMs,
        restoreMs,
      };
    } catch {
      return {
        result: {
          ok: false,
          error: "The agent's report was unreadable.",
          checkpointPolicy: "builder_fallback",
        },
        oom: false,
        coldContainerStartMs,
        restoreMs,
      };
    }
  }
  const oom = isOutOfMemoryFailure({
    exitCode: execution.exitCode,
    stdout: execution.stdout,
    stderr: execution.stderr,
  });
  const failureCode = classifyAgentFailureDiagnostic(execution.stderr);
  log("error", "agent_executor_failed", {
    turnId: turn.turnId,
    threadId: turn.threadId,
    oom,
    instanceType: INSTANCE_TIERS[args.size].instanceType,
    failureCode,
  });
  return {
    result: {
      ok: false,
      error: oom
        ? "The agent ran out of memory and stopped. Try again with a smaller slice of the work."
        : devAcceptanceProbesEnabled(host.env)
          ? `The agent hit a problem and stopped. Try again. [diagnostic: executor.${failureCode}]`
          : "The agent hit a problem and stopped. Try again.",
      checkpointPolicy: oom ? "preserve_prior" : "builder_fallback",
    },
    oom,
    coldContainerStartMs,
    restoreMs,
  };
};
