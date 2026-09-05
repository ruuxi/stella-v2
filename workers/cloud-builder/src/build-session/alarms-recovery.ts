import {
  isCloudBrowserSuspension,
  type CloudBrowserSuspension,
} from "@stella/contracts/cloud-browser";
import type {
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import {
  agentComputeKey,
  parsePersistedAgentCompute,
  type PersistedAgentCompute,
} from "../agent-compute-ladder.js";
import { sha256Hex } from "../hash.js";
import { INSTANCE_TIERS } from "../instance-size.js";
import {
  nativeHistoryCursorFromRows,
  validNativeStateCheckpointMac,
} from "../native-state-checkpoint.js";
import {
  SandboxLifecycleDeferredError,
  sandboxLifecycleFailureFields,
  type SandboxTarget,
} from "../sandbox-lifecycle.js";
import type { BuildSessionInternals } from "./host.js";
import {
  AgentTurnAuthorityLostError,
  OwnerPurgeFenceError,
} from "./shared/errors.js";
import {
  AGENT_RECOVERY_PENDING_KEY,
  AGENT_TURN_HEARTBEAT_MS,
  AGENT_WATCHDOG_DEADLINE_KEY,
  BUILDER_FALLBACK_MAX_RETRIES,
  OBSERVED_BROWSER_SUSPENSION_KEY,
  PENDING_BROWSER_SUSPENSION_KEY,
  agentComputeRecoveryClaimKey,
  agentExecutionMarkerKey,
  agentRecoveryIdentity,
  bindObservedBrowserSuspensionToCanonicalCodeCall,
  builderFallbackRetryKey,
  builderFallbackTranscriptKey,
  cloudBrowserSuspensionMarker,
  errorMessage,
  exactTurnIdentityMatches,
  log,
  nativeStateIntegrityKeyFor,
  pendingAppBuildPublicationKey,
  turnStateCheckpointOperationKey,
} from "./shared/keys.js";
import { validBuilderFallbackMessages } from "./public-helpers.js";
import type {
  AgentComputeRecoveryClaim,
  AgentExecutionMarker,
  BuilderFallbackInput,
  BuilderFallbackTranscript,
  ObservedBrowserSuspension,
  PendingAppBuildPublication,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
  TurnStateCheckpointOperation,
} from "./shared/types.js";

export type AlarmsRecoveryHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "agentTurnExecutions"
  | "exactTurnCancellations"
  | "abortUnpublishedTurnStateOperation"
  | "acknowledgeExactCancellationFromAlarm"
  | "admittedResidentPlacement"
  | "advanceAppBuildPublication"
  | "advanceBuilderFallback"
  | "appendThreadTranscript"
  | "assertAgentTurnIdentity"
  | "assertTurnWritable"
  | "claimTerminalDecision"
  | "cleanupOwnerPurgedTurnStorage"
  | "currentSandboxTarget"
  | "deleteTurnStoragePreservingExactCancellations"
  | "deliverBrowserSuspension"
  | "deliverExecutorLossTerminal"
  | "deliverTerminal"
  | "destroySandboxDurably"
  | "ensureBuilderFallbackTranscript"
  | "exactAgentExecutionMarker"
  | "exactTurnStateCheckpointOperations"
  | "executeTurnStateCheckpoint"
  | "fetchCanonicalAgentHistory"
  | "interruptAgentForBuilderFallback"
  | "mutateExactTurn"
  | "ownsExactTurn"
  | "publishAgentTurnWorkspace"
  | "quiesceCurrentAgentSession"
  | "reconcileAgentCheckpointAfterQuiescence"
  | "recoverAgentTurnAfterExecutorLoss"
  | "recoverObservedBrowserSuspension"
  | "recoverResidentAgentTurn"
  | "registerTurn"
  | "releaseAgentSessionResources"
  | "repairedResidentJournal"
  | "retainPendingBrowserSuspension"
  | "retireTerminalAppTurnStorage"
  | "runAlarm"
  | "runAlarmWithLease"
  | "setExactTurnAlarm"
  | "settleAgentTransientBackup"
  | "settleTerminalTransientWrites"
  | "terminateCurrentAgentSession"
  | "trackTurn"
  | "unregisterTurnLease"
>;

export const runScheduledTurnAlarm = async (
  host: AlarmsRecoveryHost,
): Promise<void> => {
  const turn = await host.ctx.storage.get<TurnRequest>("turn");
  if (!turn) return;
  if (turn.kind === "agent" && host.agentTurnExecutions.has(turn.turnId)) {
    const [watchdogDeadlineAt, recoveryPending] = await Promise.all([
      host.ctx.storage.get<number>(AGENT_WATCHDOG_DEADLINE_KEY),
      host.ctx.storage.get<string>(AGENT_RECOVERY_PENDING_KEY),
    ]);
    if (
      recoveryPending !== agentRecoveryIdentity(turn) &&
      typeof watchdogDeadlineAt === "number" &&
      Number.isFinite(watchdogDeadlineAt) &&
      watchdogDeadlineAt > Date.now()
    ) {
      // setAlarm() can race an alarm delivery that Cloudflare has already
      // begun. That stale callback then observes the successor turn and,
      // without this durable deadline fence, mistakes its live executor for
      // an orphan. Re-arm the real watchdog; only its actual deadline may
      // enter crash recovery while the local Effect fiber is still alive.
      await host.setExactTurnAlarm(
        turn,
        Math.min(watchdogDeadlineAt, Date.now() + AGENT_TURN_HEARTBEAT_MS),
      );
      log("info", "agent_watchdog_alarm_rearmed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        watchdogDeadlineAt,
      });
      return;
    }
    const running = host.agentTurnExecutions.get(turn.turnId);
    if (
      running &&
      typeof watchdogDeadlineAt === "number" &&
      Number.isFinite(watchdogDeadlineAt) &&
      watchdogDeadlineAt <= Date.now()
    ) {
      // The watchdog passed while this isolate still holds the run's fiber,
      // so the loop is hung, or stuck in a settlement it cannot finish.
      // Give it the bounded interrupt a Stop would, then drop the handle:
      // recovery below then treats the attempt the way it treats a replaced
      // isolate, instead of re-interrupting a fiber that never settles on
      // every alarm until the builder fallback gives up.
      log("error", "agent_watchdog_interrupting_hung_execution", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        watchdogDeadlineAt,
      });
      await running
        .interrupt(new Error("The agent ran out of time and was stopped."))
        .catch((error) => {
          log("error", "agent_watchdog_hung_execution_interrupt_failed", {
            turnId: turn.turnId,
            message: errorMessage(error),
          });
        });
      if (host.agentTurnExecutions.get(turn.turnId) === running) {
        host.agentTurnExecutions.delete(turn.turnId);
      }
    }
  }
  const hasTransientBuild = Boolean(
    await host.ctx.storage.get<string>(`transientBuild:${turn.turnId}`),
  );
  const hasPendingPublication = Boolean(
    await host.ctx.storage.get<PendingAppBuildPublication>(
      pendingAppBuildPublicationKey(turn.turnId),
    ),
  );
  if (
    (await host.ctx.storage.get<boolean>("terminalDelivered")) &&
    turn.kind !== "agent" &&
    !hasTransientBuild &&
    !hasPendingPublication
  )
    return;
  const alarmTurn = { ...turn };
  await host.trackTurn(turn.turnId, host.runAlarmWithLease(alarmTurn));
};

export const runAlarmWithLease = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
): Promise<void> => {
  const originalLeaseId = turn.ownerPurgeLeaseId;
  const originalGeneration = turn.ownerPurgeGeneration;
  let auxiliaryLeaseId: string | undefined;
  let auxiliaryGeneration: string | undefined;
  let retireOriginalLease = false;
  try {
    const useRunLeaseForRecovery =
      turn.kind === "agent" &&
      (Boolean(
        await host.ctx.storage.get(
          agentComputeKey(turn.turnId, turn.attemptGeneration!),
        ),
      ) ||
        Boolean(
          await host.ctx.storage.get<AgentExecutionMarker>(
            agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
          ),
        ) ||
        Boolean(
          await host.ctx.storage.get<BuilderFallbackTranscript>(
            builderFallbackTranscriptKey(turn.turnId, turn.attemptGeneration!),
          ),
        ) ||
        Boolean(
          await host.ctx.storage.get<ObservedBrowserSuspension>(
            OBSERVED_BROWSER_SUSPENSION_KEY,
          ),
        ));
    if (useRunLeaseForRecovery) {
      // Turn-state mutation is authorized only by the exact run lease bound
      // to this workspace. Renew/rejoin that lease after isolate loss; an
      // auxiliary lease deliberately cannot checkpoint user bytes.
      turn.ownerPurgeGeneration = await host.registerTurn(turn);
    } else {
      turn.ownerPurgeGeneration = await host.registerTurn(turn, true);
      auxiliaryLeaseId = turn.ownerPurgeLeaseId;
      auxiliaryGeneration = turn.ownerPurgeGeneration;
    }
    await host.assertTurnWritable(turn);
    await host.runAlarm(turn);
    retireOriginalLease = !(await host.ctx.storage.get<TurnRequest>("turn"));
  } catch (error) {
    if (error instanceof OwnerPurgeFenceError) {
      if (!(await host.ownsExactTurn(turn))) return;
      const target = await host.currentSandboxTarget();
      if (await host.ownsExactTurn(turn)) {
        if (target) {
          if (turn.kind === "agent") {
            await host.terminateCurrentAgentSession(turn);
          } else {
            await host.destroySandboxDurably(target, "owner_fence_alarm");
          }
        }
      }
      try {
        // Confirmed sandbox teardown may have produced world-unregister
        // debt. Preserve it (and any destroy tombstone) while deleting the
        // exact turn, otherwise a transient owner-fence failure would erase
        // the only names capable of freeing the slot on the next alarm.
        retireOriginalLease = await host.cleanupOwnerPurgedTurnStorage(turn);
      } catch (cleanupError) {
        log("error", "owner_purge_alarm_cleanup_failed", {
          turnId: turn.turnId,
          message: errorMessage(cleanupError),
        });
      }
      return;
    }
    throw error;
  } finally {
    if (auxiliaryLeaseId && auxiliaryGeneration) {
      // An auxiliary alarm lease never owns transient bytes. Release it
      // directly even when the original run lease must remain as the fence
      // for backup-debt persistence.
      await host.unregisterTurnLease(
        turn,
        auxiliaryLeaseId,
        auxiliaryGeneration,
      );
    }
    if (retireOriginalLease && originalLeaseId && originalGeneration) {
      await host.unregisterTurnLease(turn, originalLeaseId, originalGeneration);
    }
  }
};

export const runAlarm = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
): Promise<void> => {
  if (!(await host.ownsExactTurn(turn))) return;
  let appPublication = await host.ctx.storage.get<PendingAppBuildPublication>(
    pendingAppBuildPublicationKey(turn.turnId),
  );
  const transientBuild = await host.ctx.storage.get<string>(
    `transientBuild:${turn.turnId}`,
  );
  if (!appPublication && transientBuild && turn.kind !== "agent") {
    // The watchdog/cancel may land during upload, before the callback replay
    // record exists. Fence further R2/KV writes first, then turn the bare
    // marker into durable cleanup work before any deleteAll can erase it.
    appPublication = {
      turnId: turn.turnId,
      phase: "cleanup",
      artifactPrefix: transientBuild,
      callbackBody: {},
      completionSeq: "auto",
      completionResult: {},
      failureMessage: "The app-build turn ended before publication.",
    };
    if (
      !(await host.mutateExactTurn(turn, async (txn) => {
        await txn.put({
          terminal: true,
          [pendingAppBuildPublicationKey(turn.turnId)]: appPublication!,
        });
      }))
    ) {
      return;
    }
  }
  if (appPublication?.turnId === turn.turnId) {
    const outcome = await host.advanceAppBuildPublication(turn, appPublication);
    if (outcome !== "retrying" && (await host.ownsExactTurn(turn))) {
      const target = await host.currentSandboxTarget();
      if (await host.ownsExactTurn(turn)) {
        if (target) {
          await host
            .destroySandboxDurably(target, "app_publication_alarm")
            .catch(() => undefined);
        }
      }
      await host.retireTerminalAppTurnStorage(turn);
    }
    return;
  }
  const browserSuspension =
    await host.ctx.storage.get<PendingBrowserSuspension>(
      PENDING_BROWSER_SUSPENSION_KEY,
    );
  if (browserSuspension) {
    if (
      browserSuspension.turnId !== turn.turnId ||
      browserSuspension.attemptGeneration !== turn.attemptGeneration
    ) {
      await host.mutateExactTurn(turn, async (txn) => {
        await txn.delete(PENDING_BROWSER_SUSPENSION_KEY);
      });
      return;
    }
    const target = await host.currentSandboxTarget();
    if (target) {
      await host.terminateCurrentAgentSession(turn).catch(() => undefined);
    }
    if (!(await host.ownsExactTurn(turn))) return;
    if (!(await host.deliverBrowserSuspension(turn, browserSuspension))) {
      return;
    }
    if (!(await host.settleAgentTransientBackup(turn))) {
      await host.setExactTurnAlarm(turn, Date.now() + 30_000);
      return;
    }
    await host.deleteTurnStoragePreservingExactCancellations(turn, true);
    return;
  }
  if (await host.ctx.storage.get<boolean>("terminalDelivered")) {
    const pending =
      await host.ctx.storage.get<PendingTerminal>("pendingTerminal");
    const exactCancellation =
      pending?.kind === "canceled" && pending.turnId === turn.turnId
        ? await host.exactTurnCancellations.matching({
            turnId: turn.turnId,
            ownerId: turn.ownerId,
            ownerGeneration: turn.ownerGeneration,
            attemptGeneration: turn.attemptGeneration,
          })
        : null;
    if (exactCancellation?.state === "pending") {
      if (
        !(await host.acknowledgeExactCancellationFromAlarm(
          turn,
          exactCancellation,
        ))
      ) {
        // Keep the durable terminal payload while another exact-run promise
        // is still joining. No age or state guess can advance the receipt.
        return;
      }
    }
    if (!(await host.settleTerminalTransientWrites(turn))) {
      await host.setExactTurnAlarm(turn, Date.now() + 30_000);
      return;
    }
    await host.deleteTurnStoragePreservingExactCancellations(turn);
    return;
  }
  // A terminal state already decided is not a timeout: the run finished, its
  // workspace is checkpointed, and the only thing left is getting the result
  // to Convex. Redelivering that is the whole point of the alarm here.
  const pending =
    await host.ctx.storage.get<PendingTerminal>("pendingTerminal");
  if (pending) {
    if (pending.turnId !== turn.turnId) {
      await host.mutateExactTurn(turn, async (txn) => {
        await txn.delete("pendingTerminal");
      });
    } else {
      let deliverable = pending;
      if (pending.terminateSandbox) {
        try {
          await host.terminateCurrentAgentSession(turn);
        } catch (error) {
          log("error", "pending_terminal_sandbox_termination_failed", {
            turnId: turn.turnId,
            ...sandboxLifecycleFailureFields(error),
          });
          await host.setExactTurnAlarm(turn, Date.now() + 30_000);
          return;
        }
        deliverable = { ...pending, terminateSandbox: false };
        if (
          !(await host.mutateExactTurn(turn, async (txn) => {
            await txn.put("pendingTerminal", deliverable);
          }))
        ) {
          return;
        }
      }
      const exactCancellation =
        deliverable.kind === "canceled"
          ? await host.exactTurnCancellations.matching({
              turnId: turn.turnId,
              ownerId: turn.ownerId,
              ownerGeneration: turn.ownerGeneration,
              attemptGeneration: turn.attemptGeneration,
            })
          : null;
      if (
        (await host.deliverTerminal(turn, deliverable, {
          preservePendingTerminal: exactCancellation?.state === "pending",
        })) &&
        (await host.ownsExactTurn(turn))
      ) {
        if (
          exactCancellation?.state === "pending" &&
          !(await host.acknowledgeExactCancellationFromAlarm(
            turn,
            exactCancellation,
          ))
        ) {
          return;
        }
        if (await host.settleTerminalTransientWrites(turn)) {
          await host.deleteTurnStoragePreservingExactCancellations(turn);
        } else {
          await host.setExactTurnAlarm(turn, Date.now() + 30_000);
        }
      }
      return;
    }
  }
  if (turn.kind === "agent") {
    const resident = await host.admittedResidentPlacement(turn);
    let marker: AgentExecutionMarker | undefined;
    try {
      marker = await host.exactAgentExecutionMarker(turn);
    } catch (error) {
      log("error", "agent_recovery_marker_invalid", {
        turnId: turn.turnId,
        message: errorMessage(error),
      });
      await host.setExactTurnAlarm(turn, Date.now() + 30_000);
      return;
    }
    if (marker) {
      const lost =
        "The agent stopped unexpectedly. Its workspace changes were saved, but its report could not be recovered.";
      let recoveredCheckpoint: TurnBrokerTurnStateCheckpointReceipt;
      try {
        recoveredCheckpoint = await host.recoverAgentTurnAfterExecutorLoss(
          turn,
          marker,
          lost,
          resident
            ? async () => {
                const sealed = await host.repairedResidentJournal(turn, lost);
                return {
                  historyCursor: sealed.historyCursor,
                  messages: sealed.rows.map((row) => ({
                    ordinal: row.ordinal,
                    role: row.role,
                    payloadJson: row.payloadJson,
                  })),
                };
              }
            : undefined,
        );
      } catch (error) {
        const retries = await recordBuilderFallbackRetry(host, turn);
        log("error", "agent_builder_fallback_alarm_retry", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          retries,
          message: errorMessage(error),
        });
        if (retries < BUILDER_FALLBACK_MAX_RETRIES) {
          await host.setExactTurnAlarm(turn, Date.now() + 30_000);
          return;
        }
        // Every retry boots the lost container again to read its disk. A
        // recovery that keeps failing must end, or the thread stays
        // "running" forever while an alarm restarts a container every
        // thirty seconds for nobody.
        log("error", "agent_builder_fallback_abandoned", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          retries,
        });
        await host.deliverExecutorLossTerminal(turn, {
          message:
            "The agent stopped unexpectedly and its workspace could not be recovered afterwards. Its report was lost.",
          threadError:
            "The agent stopped unexpectedly and its workspace could not be recovered.",
        });
        return;
      }
      let recoveredSuspension: CloudBrowserSuspension | null;
      try {
        recoveredSuspension = await host.recoverObservedBrowserSuspension(
          turn,
          recoveredCheckpoint,
        );
      } catch (error) {
        log("error", "browser_suspension_recovery_retry", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(error),
        });
        await host.setExactTurnAlarm(turn, Date.now() + 30_000);
        return;
      }
      if (recoveredSuspension) {
        const pendingBrowserSuspension: PendingBrowserSuspension = {
          schemaVersion: 1,
          turnId: turn.turnId,
          attemptGeneration: turn.attemptGeneration!,
          suspension: recoveredSuspension,
          payload: {
            suspension: recoveredSuspension,
            usage: {},
            coldContainerStartMs: 0,
            restoreMs: 0,
            checkpointMs: 0,
            wallClockMs: Math.max(0, Date.now() - marker.startedAt),
            instanceType: INSTANCE_TIERS[marker.size].instanceType,
          },
          createdAt: Date.now(),
        };
        if (
          !(await host.retainPendingBrowserSuspension(
            turn,
            pendingBrowserSuspension,
          ))
        ) {
          await host.setExactTurnAlarm(turn, Date.now() + 1_000);
          return;
        }
        try {
          await host.terminateCurrentAgentSession(turn);
        } catch (error) {
          log("error", "browser_suspension_sandbox_termination_deferred", {
            turnId: turn.turnId,
            threadId: turn.threadId,
            message: errorMessage(error),
          });
          return;
        }
        if (
          (await host.deliverBrowserSuspension(
            turn,
            pendingBrowserSuspension,
          )) &&
          (await host.ownsExactTurn(turn))
        ) {
          if (await host.settleAgentTransientBackup(turn)) {
            await host.deleteTurnStoragePreservingExactCancellations(
              turn,
              true,
            );
          } else {
            await host.setExactTurnAlarm(turn, Date.now() + 30_000);
          }
        }
        log("info", "browser_suspension_recovered_after_executor_loss", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          interactionId: recoveredSuspension.interactionId,
        });
        return;
      }
      await host.deliverExecutorLossTerminal(turn, {
        message:
          "The agent stopped unexpectedly. Its workspace changes were saved, but its report could not be recovered.",
        threadError:
          "The agent stopped unexpectedly after saving its workspace changes.",
      });
      return;
    }
    const computeRecovery = await recoverOrphanedAgentCompute(host, turn);
    if (computeRecovery === "retry") return;
    if (resident) {
      await host.recoverResidentAgentTurn(turn);
      return;
    }
  }

  const sandboxId = await host.ctx.storage.get<string>("sandboxId");
  let timeoutPending: PendingTerminal = {
    turnId: turn.turnId,
    attemptGeneration: turn.kind === "agent" ? turn.attemptGeneration! : 1,
    kind: "failed",
    payload: {
      message: "This took longer than expected, so Stella stopped. Try again.",
      reason: "timeout",
    },
    threadError: "The agent ran out of time and was stopped.",
    terminateSandbox: true,
  };
  if (!(await host.claimTerminalDecision(turn, timeoutPending))) {
    // A normal completion or cancellation claimed the same instant. Let its
    // durable payload, rather than this timeout fallback, own the next alarm.
    await host.setExactTurnAlarm(turn, Date.now() + 1_000);
    return;
  }
  try {
    await host.terminateCurrentAgentSession(turn);
  } catch (error) {
    if (!(error instanceof SandboxLifecycleDeferredError)) {
      log("error", "timeout_sandbox_termination_failed", {
        turnId: turn.turnId,
        sandboxId,
        ...sandboxLifecycleFailureFields(error),
      });
      await host.setExactTurnAlarm(turn, Date.now() + 30_000);
      return;
    }
    log("error", "timeout_sandbox_termination_deferred", {
      turnId: turn.turnId,
      sandboxId,
      ...sandboxLifecycleFailureFields(error),
    });
  }
  timeoutPending = { ...timeoutPending, terminateSandbox: false };
  if (
    !(await host.mutateExactTurn(turn, async (txn) => {
      await txn.put("pendingTerminal", timeoutPending);
    }))
  ) {
    return;
  }
  log("error", "turn_timed_out", {
    turnId: turn.turnId,
    appId: turn.appId,
    sandboxId,
  });
  const delivered = await host.deliverTerminal(turn, timeoutPending);
  if (delivered && (await host.ownsExactTurn(turn))) {
    if (await host.settleTerminalTransientWrites(turn)) {
      await host.deleteTurnStoragePreservingExactCancellations(turn);
    } else {
      await host.setExactTurnAlarm(turn, Date.now() + 30_000);
    }
  }
};

/**
 * Fence an admitted attachment whose isolate vanished before it could write
 * the execution marker. The claim and marker share one storage transaction:
 * either the restored world becomes archive-authoritative, or recovery owns
 * teardown, never both.
 */
const claimOrphanedAgentComputeRecovery = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
): Promise<PersistedAgentCompute | undefined> => {
  const attemptGeneration = turn.attemptGeneration!;
  const identity = { turnId: turn.turnId, attemptGeneration };
  const computeKey = agentComputeKey(turn.turnId, attemptGeneration);
  const markerKey = agentExecutionMarkerKey(turn.turnId, attemptGeneration);
  const claimKey = agentComputeRecoveryClaimKey(turn.turnId, attemptGeneration);
  return await host.ctx.storage.transaction(async (txn) => {
    const [current, raw, marker, existingClaim] = await Promise.all([
      txn.get<TurnRequest>("turn"),
      txn.get(computeKey),
      txn.get<AgentExecutionMarker>(markerKey),
      txn.get<AgentComputeRecoveryClaim>(claimKey),
    ]);
    if (!exactTurnIdentityMatches(current, turn) || marker) return undefined;
    if (raw === undefined) return undefined;
    const compute = parsePersistedAgentCompute(raw, identity);
    if (!compute) {
      throw new Error("Agent compute recovery record was invalid.");
    }
    if (compute.phase === "resident") return undefined;
    const sandboxId = compute.sandboxId!;
    if (
      existingClaim &&
      (existingClaim.schemaVersion !== 1 ||
        existingClaim.turnId !== turn.turnId ||
        existingClaim.attemptGeneration !== attemptGeneration ||
        existingClaim.sandboxId !== sandboxId)
    ) {
      throw new Error("Agent compute recovery claim was invalid.");
    }
    if (!existingClaim) {
      await txn.put(claimKey, {
        schemaVersion: 1,
        turnId: turn.turnId,
        attemptGeneration,
        sandboxId,
        createdAt: Date.now(),
      } satisfies AgentComputeRecoveryClaim);
    }
    return compute;
  });
};

const recoverOrphanedAgentCompute = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
): Promise<"none" | "recovered" | "retry"> => {
  let compute: PersistedAgentCompute | undefined;
  try {
    compute = await claimOrphanedAgentComputeRecovery(host, turn);
  } catch (error) {
    log("error", "agent_compute_recovery_claim_invalid", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      message: errorMessage(error),
    });
    await host.setExactTurnAlarm(turn, Date.now() + 30_000);
    return "retry";
  }
  if (!compute) return "none";
  const target: SandboxTarget = {
    sandboxId: compute.sandboxId!,
    size: compute.instanceSize,
    workload: "world",
  };
  try {
    await host.releaseAgentSessionResources({
      ...target,
      workload: "world",
      sessionId: compute.sessionId!,
      daemonDirectory: compute.daemonDirectory!,
    });
  } catch (error) {
    log("error", "agent_compute_recovery_release_deferred", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      instanceSize: compute.instanceSize,
      ...sandboxLifecycleFailureFields(error),
    });
    return "retry";
  }
  const attemptGeneration = turn.attemptGeneration!;
  const computeKey = agentComputeKey(turn.turnId, attemptGeneration);
  const claimKey = agentComputeRecoveryClaimKey(turn.turnId, attemptGeneration);
  let removed = false;
  await host.ctx.storage.transaction(async (txn) => {
    const [current, marker, raw, claim, sharedSandboxId] = await Promise.all([
      txn.get<TurnRequest>("turn"),
      txn.get<AgentExecutionMarker>(
        agentExecutionMarkerKey(turn.turnId, attemptGeneration),
      ),
      txn.get(computeKey),
      txn.get<AgentComputeRecoveryClaim>(claimKey),
      txn.get<string>("sandboxId"),
    ]);
    const latest = parsePersistedAgentCompute(raw, {
      turnId: turn.turnId,
      attemptGeneration,
    });
    if (
      !exactTurnIdentityMatches(current, turn) ||
      marker ||
      !latest ||
      latest.phase === "resident" ||
      latest.sandboxId !== compute!.sandboxId ||
      claim?.schemaVersion !== 1 ||
      claim.turnId !== turn.turnId ||
      claim.attemptGeneration !== attemptGeneration ||
      claim.sandboxId !== compute!.sandboxId
    ) {
      return;
    }
    await txn.delete([computeKey, claimKey]);
    if (sharedSandboxId === compute!.sandboxId) {
      await txn.delete(["sandboxId", "sandboxSize"]);
    }
    removed = true;
  });
  if (!removed) {
    await host.setExactTurnAlarm(turn, Date.now() + 1_000);
    return "retry";
  }
  log("info", "agent_compute_orphan_recovered", {
    turnId: turn.turnId,
    threadId: turn.threadId,
    instanceSize: compute.instanceSize,
    phase: compute.phase,
  });
  return "recovered";
};

/**
 * `resolveInput` runs after quiescence, never before. A resident turn's rows
 * come from a journal the loop is still appending to until the interrupt
 * above has unwound it, and sealing that journal early would fail the very
 * loop whose rows recovery is trying to keep.
 */
export const recoverAgentTurnAfterExecutorLoss = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  marker: AgentExecutionMarker,
  error: string,
  resolveInput?: () => Promise<BuilderFallbackInput>,
): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  await host.interruptAgentForBuilderFallback(turn);
  return await host.reconcileAgentCheckpointAfterQuiescence(
    turn,
    marker,
    error,
    await resolveInput?.(),
  );
};

export const reconcileAgentCheckpointAfterQuiescence = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  marker: AgentExecutionMarker,
  error: string,
  input?: BuilderFallbackInput,
): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  await host.assertTurnWritable(turn);
  host.assertAgentTurnIdentity(turn);

  const fallbackKey = builderFallbackTranscriptKey(
    turn.turnId,
    turn.attemptGeneration!,
  );
  const existingFallback =
    await host.ctx.storage.get<BuilderFallbackTranscript>(fallbackKey);
  if (existingFallback) {
    return await host.advanceBuilderFallback(turn, existingFallback);
  }

  const canonicalRows = host.fetchCanonicalAgentHistory(turn, {
    excludeCurrentTurn: false,
  });
  const canonicalCursor = await nativeHistoryCursorFromRows(canonicalRows);
  let operations = await host.exactTurnStateCheckpointOperations(turn);
  for (const operation of operations) {
    if (!operation.payload) {
      await host.ctx.storage.delete(
        turnStateCheckpointOperationKey(operation.requestId),
      );
      continue;
    }
    let pending:
      | (Extract<TurnStateCheckpointOperation, { state: "pending" }> & {
          payload: TurnBrokerTurnStateCheckpointRequest;
        })
      | undefined;
    if (operation.state === "pending") {
      pending = {
        ...operation,
        payload: operation.payload,
      };
    } else if (operation.state === "failed" && operation.operationId) {
      const operationKey = turnStateCheckpointOperationKey(operation.requestId);
      pending = await host.ctx.storage.transaction(async (transaction) => {
        const current =
          await transaction.get<TurnStateCheckpointOperation>(operationKey);
        if (
          !current ||
          current.state !== "failed" ||
          current.turnId !== operation.turnId ||
          current.attemptGeneration !== operation.attemptGeneration ||
          current.requestFingerprint !== operation.requestFingerprint ||
          !current.operationId ||
          !current.payload
        ) {
          throw new Error("Failed checkpoint recovery operation changed.");
        }
        const resumed: Extract<
          TurnStateCheckpointOperation,
          { state: "pending" }
        > & { payload: TurnBrokerTurnStateCheckpointRequest } = {
          state: "pending",
          turnId: current.turnId,
          attemptGeneration: current.attemptGeneration,
          requestId: current.requestId,
          requestFingerprint: current.requestFingerprint,
          createdAt: current.createdAt,
          operationId: current.operationId,
          payload: current.payload,
        };
        await transaction.put(operationKey, resumed);
        return resumed;
      });
    }
    if (pending) {
      await host.executeTurnStateCheckpoint({
        turn,
        operationKey: turnStateCheckpointOperationKey(pending.requestId),
        operation: pending,
      });
    }
  }
  operations = await host.exactTurnStateCheckpointOperations(turn);
  const accepted = operations.filter(
    (
      operation,
    ): operation is Extract<
      TurnStateCheckpointOperation,
      { state: "succeeded" }
    > =>
      operation.state === "succeeded" &&
      operation.receipt.historyCursor === canonicalCursor,
  );
  if (accepted.length > 1) {
    throw new Error("Multiple agent checkpoints matched canonical history.");
  }
  if (accepted[0]) {
    await host.publishAgentTurnWorkspace(
      turn,
      canonicalCursor,
      accepted[0].operationId,
    );
    return accepted[0].receipt;
  }

  // A browser suspension can lose the executor after the durable archive
  // commit but before its direct transcript callback completes. The exact
  // checkpoint request carries that secret-free transcript, so replay it
  // through the same durable Builder journal before considering a synthetic
  // failure. This publishes the original archive/cursor; it never creates a
  // second workspace checkpoint.
  const browserRecovery = await ensureObservedBrowserSuspensionRecoveryJournal(
    host,
    turn,
    operations,
  );
  if (browserRecovery) {
    return await host.advanceBuilderFallback(turn, browserRecovery);
  }

  // A checkpoint whose transcript never became canonical must remain
  // invisible. Retire its pre-registered native objects before preparing a
  // fresh synthetic cursor.
  for (const operation of operations) {
    await host.abortUnpublishedTurnStateOperation(
      turn,
      operation,
      canonicalCursor,
    );
  }
  const fallback = await host.ensureBuilderFallbackTranscript(turn, {
    ...(input ?? {}),
    error,
  });
  return await host.advanceBuilderFallback(turn, fallback);
};

const syntheticBuilderFallbackMessages = (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  message: string,
  createdAt: number,
): Array<{ ordinal: number; role: string; payloadJson: string }> => {
  const execution = turn.execution;
  const rows = [
    {
      role: "user",
      content: [{ type: "text", text: turn.prompt }],
      timestamp: createdAt,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: message }],
      timestamp: createdAt,
      api: "stella-cloud",
      provider: execution?.provider ?? "stella",
      model: execution?.model ?? "unknown",
      stopReason: "error",
      errorMessage: message,
    },
  ];
  return rows.map((row, ordinal) => ({
    ordinal,
    role: row.role,
    payloadJson: JSON.stringify(row),
  }));
};

export const ensureBuilderFallbackTranscript = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  input?: BuilderFallbackInput & { error?: string },
): Promise<BuilderFallbackTranscript> => {
  const key = builderFallbackTranscriptKey(
    turn.turnId,
    turn.attemptGeneration!,
  );
  const validateExisting = (
    existing: BuilderFallbackTranscript,
  ): BuilderFallbackTranscript => {
    if (
      existing.schemaVersion !== 1 ||
      existing.turnId !== turn.turnId ||
      existing.attemptGeneration !== turn.attemptGeneration ||
      !validBuilderFallbackMessages(existing.messages) ||
      !Number.isSafeInteger(existing.createdAt) ||
      existing.createdAt < 0 ||
      !/^[0-9a-f]{64}$/u.test(existing.requestFingerprint)
    ) {
      throw new Error("Builder fallback journal was invalid.");
    }
    return existing;
  };
  const existing = await host.ctx.storage.get<BuilderFallbackTranscript>(key);
  if (existing) {
    return validateExisting(existing);
  }
  const createdAt = Date.now();
  const messages = input?.messages
    ? structuredClone(input.messages)
    : syntheticBuilderFallbackMessages(
        host,
        turn,
        input?.error ??
          "The agent stopped unexpectedly after making workspace changes.",
        createdAt,
      );
  if (!validBuilderFallbackMessages(messages)) {
    throw new Error("Builder fallback transcript was invalid.");
  }
  const historyCursor = await nativeHistoryCursorFromRows(
    messages.map((message) => ({ ...message, turnId: turn.turnId })),
  );
  if (input?.historyCursor && input.historyCursor !== historyCursor) {
    throw new Error("Builder fallback transcript cursor was invalid.");
  }
  if (input?.nativeCheckpoint) {
    const integrityKey = await nativeStateIntegrityKeyFor(host.env, turn);
    if (
      input.nativeCheckpoint.cursor !== historyCursor ||
      !(await validNativeStateCheckpointMac({
        checkpoint: input.nativeCheckpoint,
        threadId: turn.threadId!,
        integrityKey,
      }))
    ) {
      throw new Error("Builder fallback native checkpoint was invalid.");
    }
  }
  const payload: TurnBrokerTurnStateCheckpointRequest = {
    schemaVersion: 1,
    historyCursor,
    ...(input?.nativeCheckpoint
      ? { nativeCheckpoint: input.nativeCheckpoint }
      : {}),
  };
  const requestId = crypto.randomUUID();
  const requestFingerprint = await sha256Hex(
    JSON.stringify([
      1,
      turn.ownerGeneration,
      turn.turnId,
      turn.attemptGeneration,
      payload,
      messages,
    ]),
  );
  const fallback: BuilderFallbackTranscript = {
    schemaVersion: 1,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    requestId,
    requestFingerprint,
    createdAt,
    payload,
    messages,
    transcriptCommitted: false,
    workspacePublished: false,
  };
  const operation: Extract<TurnStateCheckpointOperation, { state: "pending" }> =
    {
      state: "pending",
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      requestId,
      requestFingerprint,
      createdAt,
      payload,
    };
  return await host.ctx.storage.transaction(async (transaction) => {
    const current = await transaction.get<TurnRequest>("turn");
    if (!exactTurnIdentityMatches(current, turn)) {
      throw new AgentTurnAuthorityLostError();
    }
    const replay = await transaction.get<BuilderFallbackTranscript>(key);
    if (replay) {
      return validateExisting(replay);
    }
    await transaction.put({
      [key]: fallback,
      [turnStateCheckpointOperationKey(requestId)]: operation,
    });
    return fallback;
  });
};

export const advanceBuilderFallback = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  fallback: BuilderFallbackTranscript,
): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  const fallbackKey = builderFallbackTranscriptKey(
    turn.turnId,
    turn.attemptGeneration!,
  );
  const storedFallback =
    await host.ctx.storage.get<BuilderFallbackTranscript>(fallbackKey);
  if (
    !storedFallback ||
    storedFallback.requestId !== fallback.requestId ||
    storedFallback.requestFingerprint !== fallback.requestFingerprint
  ) {
    throw new Error("Builder fallback journal changed before replay.");
  }
  fallback = storedFallback;
  const persistProgress = async (
    next: BuilderFallbackTranscript,
  ): Promise<BuilderFallbackTranscript> =>
    await host.ctx.storage.transaction(async (transaction) => {
      const [currentTurn, current] = await Promise.all([
        transaction.get<TurnRequest>("turn"),
        transaction.get<BuilderFallbackTranscript>(fallbackKey),
      ]);
      if (
        !exactTurnIdentityMatches(currentTurn, turn) ||
        !current ||
        current.requestId !== next.requestId ||
        current.requestFingerprint !== next.requestFingerprint ||
        (current.checkpointReceipt &&
          JSON.stringify(current.checkpointReceipt) !==
            JSON.stringify(next.checkpointReceipt)) ||
        (current.transcriptCommitted && !next.transcriptCommitted) ||
        (current.workspacePublished && !next.workspacePublished)
      ) {
        throw new Error("Builder fallback journal changed during replay.");
      }
      const merged: BuilderFallbackTranscript = {
        ...next,
        ...(current.checkpointReceipt
          ? { checkpointReceipt: current.checkpointReceipt }
          : {}),
        transcriptCommitted:
          current.transcriptCommitted || next.transcriptCommitted,
        workspacePublished:
          current.workspacePublished || next.workspacePublished,
      };
      await transaction.put(fallbackKey, merged);
      return merged;
    });
  const operationKey = turnStateCheckpointOperationKey(fallback.requestId);
  await host.quiesceCurrentAgentSession(turn);
  let receipt = fallback.checkpointReceipt;
  if (!receipt) {
    const operation =
      await host.ctx.storage.get<TurnStateCheckpointOperation>(operationKey);
    if (!operation) throw new Error("Builder fallback checkpoint is missing.");
    if (operation.state === "failed") {
      throw new Error("Builder fallback checkpoint permanently failed.");
    }
    if (operation.state === "succeeded") {
      receipt = operation.receipt;
    } else {
      receipt = await host.executeTurnStateCheckpoint({
        turn,
        operationKey,
        operation: {
          ...operation,
          payload: fallback.payload,
        },
      });
    }
    fallback = await persistProgress({
      ...fallback,
      checkpointReceipt: receipt,
    });
  }
  if (!fallback.transcriptCommitted) {
    // The rows are committed to this thread's own table; the projection
    // rides the outbox. Re-appending the same ordinals is a no-op, so the
    // replay this journal exists for cannot double-write the transcript.
    await host.appendThreadTranscript(turn, fallback.messages);
    const canonicalRows = host.fetchCanonicalAgentHistory(turn, {
      excludeCurrentTurn: false,
    });
    if (
      (await nativeHistoryCursorFromRows(canonicalRows)) !==
      fallback.payload.historyCursor
    ) {
      throw new Error("Builder fallback transcript was not canonical.");
    }
    fallback = await persistProgress({
      ...fallback,
      transcriptCommitted: true,
    });
  }
  if (!fallback.workspacePublished) {
    await host.publishAgentTurnWorkspace(
      turn,
      fallback.payload.historyCursor,
      receipt.operationId,
    );
    fallback = await persistProgress({
      ...fallback,
      workspacePublished: true,
    });
  }
  return receipt;
};

/** One more failed builder-fallback pass for this exact attempt; returns the total. */
const recordBuilderFallbackRetry = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
): Promise<number> => {
  const key = builderFallbackRetryKey(turn.turnId, turn.attemptGeneration!);
  const retries = ((await host.ctx.storage.get<number>(key)) ?? 0) + 1;
  await host.ctx.storage.put(key, retries);
  return retries;
};

export const recoverObservedBrowserSuspension = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  checkpoint: TurnBrokerTurnStateCheckpointReceipt,
  signal?: AbortSignal,
): Promise<CloudBrowserSuspension | null> => {
  const observation = await host.ctx.storage.get<ObservedBrowserSuspension>(
    OBSERVED_BROWSER_SUSPENSION_KEY,
  );
  if (!observation) return null;
  const rows = host.fetchCanonicalAgentHistory(turn, {
    excludeCurrentTurn: false,
    ...(signal ? { signal } : {}),
  });
  return await bindObservedBrowserSuspensionToCanonicalCodeCall({
    observation,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    checkpoint,
    rows,
  });
};

export const retainPendingBrowserSuspension = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  pending: PendingBrowserSuspension,
): Promise<boolean> => {
  return await host.ctx.storage.transaction(async (txn) => {
    const [current, terminal, pendingTerminal, existingPending, observed] =
      await Promise.all([
        txn.get<TurnRequest>("turn"),
        txn.get<boolean>("terminal"),
        txn.get<PendingTerminal>("pendingTerminal"),
        txn.get<PendingBrowserSuspension>(PENDING_BROWSER_SUSPENSION_KEY),
        txn.get<ObservedBrowserSuspension>(OBSERVED_BROWSER_SUSPENSION_KEY),
      ]);
    if (
      !exactTurnIdentityMatches(current, turn) ||
      terminal ||
      pendingTerminal
    ) {
      return false;
    }
    if (existingPending) {
      return (
        existingPending.turnId === pending.turnId &&
        existingPending.attemptGeneration === pending.attemptGeneration &&
        cloudBrowserSuspensionMarker(existingPending.suspension) ===
          cloudBrowserSuspensionMarker(pending.suspension)
      );
    }
    if (
      !observed ||
      observed.turnId !== turn.turnId ||
      observed.attemptGeneration !== turn.attemptGeneration ||
      !isCloudBrowserSuspension(observed.suspension) ||
      cloudBrowserSuspensionMarker({
        ...observed.suspension,
        toolCallId: pending.suspension.toolCallId,
      }) !== cloudBrowserSuspensionMarker(pending.suspension)
    ) {
      return false;
    }
    await txn.put(PENDING_BROWSER_SUSPENSION_KEY, pending);
    await txn.delete(OBSERVED_BROWSER_SUSPENSION_KEY);
    await txn.delete(
      agentExecutionMarkerKey(turn.turnId, turn.attemptGeneration!),
    );
    await txn.setAlarm(Date.now() + 30_000);
    return true;
  });
};

const ensureObservedBrowserSuspensionRecoveryJournal = async (
  host: AlarmsRecoveryHost,
  turn: TurnRequest,
  operations: TurnStateCheckpointOperation[],
): Promise<BuilderFallbackTranscript | null> => {
  const observation = await host.ctx.storage.get<ObservedBrowserSuspension>(
    OBSERVED_BROWSER_SUSPENSION_KEY,
  );
  if (!observation) return null;
  const candidates: Array<{
    operation: Extract<TurnStateCheckpointOperation, { state: "succeeded" }>;
    messages: NonNullable<
      TurnBrokerTurnStateCheckpointRequest["suspensionTranscript"]
    >;
  }> = [];
  for (const operation of operations) {
    if (
      operation.state !== "succeeded" ||
      !operation.payload.suspensionTranscript
    ) {
      continue;
    }
    const messages = operation.payload.suspensionTranscript;
    const bound = await bindObservedBrowserSuspensionToCanonicalCodeCall({
      observation,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
      checkpoint: operation.receipt,
      rows: messages.map((message) => ({
        ...message,
        turnId: turn.turnId,
      })),
    });
    if (bound) candidates.push({ operation, messages });
  }
  if (candidates.length > 1) {
    throw new Error(
      "Multiple suspended checkpoints matched the Browser Gateway wait.",
    );
  }
  const candidate = candidates[0];
  if (!candidate || !validBuilderFallbackMessages(candidate.messages)) {
    return null;
  }
  const { operation, messages } = candidate;
  const fallbackKey = builderFallbackTranscriptKey(
    turn.turnId,
    turn.attemptGeneration!,
  );
  const fallback: BuilderFallbackTranscript = {
    schemaVersion: 1,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    requestId: operation.requestId,
    requestFingerprint: operation.requestFingerprint,
    createdAt: operation.createdAt,
    payload: operation.payload,
    messages: structuredClone(messages),
    checkpointReceipt: operation.receipt,
    transcriptCommitted: false,
    workspacePublished: false,
  };
  return await host.ctx.storage.transaction(async (transaction) => {
    const [currentTurn, currentObserved, currentOperation, existing] =
      await Promise.all([
        transaction.get<TurnRequest>("turn"),
        transaction.get<ObservedBrowserSuspension>(
          OBSERVED_BROWSER_SUSPENSION_KEY,
        ),
        transaction.get<TurnStateCheckpointOperation>(
          turnStateCheckpointOperationKey(operation.requestId),
        ),
        transaction.get<BuilderFallbackTranscript>(fallbackKey),
      ]);
    if (!exactTurnIdentityMatches(currentTurn, turn)) {
      throw new AgentTurnAuthorityLostError();
    }
    if (existing) {
      if (
        existing.requestId !== fallback.requestId ||
        existing.requestFingerprint !== fallback.requestFingerprint ||
        JSON.stringify(existing.messages) !== JSON.stringify(fallback.messages)
      ) {
        throw new Error("Browser suspension recovery journal conflicted.");
      }
      return existing;
    }
    if (
      !currentObserved ||
      currentObserved.turnId !== observation.turnId ||
      currentObserved.attemptGeneration !== observation.attemptGeneration ||
      currentObserved.responseBodySha256 !== observation.responseBodySha256 ||
      !currentOperation ||
      currentOperation.state !== "succeeded" ||
      currentOperation.requestFingerprint !== operation.requestFingerprint ||
      JSON.stringify(currentOperation.receipt) !==
        JSON.stringify(operation.receipt) ||
      JSON.stringify(currentOperation.payload) !==
        JSON.stringify(operation.payload)
    ) {
      throw new Error("Browser suspension recovery state changed.");
    }
    await transaction.put(fallbackKey, fallback);
    return fallback;
  });
};
