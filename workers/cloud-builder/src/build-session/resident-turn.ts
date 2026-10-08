/**
 * The resident (workerd) agent turn: the Stella loop that runs inside this
 * Durable Object, the compute ladder that lazily attaches a world for it, and
 * the durability, checkpoint and terminal sequence that closes it out.
 *
 * @see src/build-session/host.ts for why every call out takes `host`.
 */
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import { CODE_TOOL_NAME } from "@stella/runtime/kernel/tools/defs/code-def.js";
import { attachedToolPaths } from "@stella/executor-cloud/attached-tool-protocol";
import {
  agentComputeKey,
  createAgentComputeLadder,
  createLazySandboxAttachment,
  parsePersistedAgentCompute,
  type PersistedAgentCompute,
} from "../agent-compute-ladder.js";
import { AgentTurnJournal } from "../agent-turn-journal.js";
import { createBuildSessionAgentControl } from "../build-session-agent-control.js";
import {
  createExecutionContextSnapshot,
  mediaAccessForAudience,
  renderMediaAccess,
  renderExecutionDestination,
  renderExecutionDevices,
} from "@stella/contracts/execution-context";
import type { DeviceDestination } from "@stella/contracts/turn-plane/placement";
import { MAX_CLOUD_AGENT_DEPTH } from "../cloud-agent-dispatch.js";
import {
  createCloudCodeAgentTool,
  type CloudHistoryClient,
} from "../cloud-code-tool.js";
import { executorSessionEnvironment } from "../executor-session-env.js";
import { createGeneralAgentDoLocalTools } from "../general-agent-do-local-tools.js";
import { createResidentGeneralAgentTools } from "../general-agent-tools.js";
import {
  createResidentBrowserClient,
  type ResidentBrowserClient,
} from "../resident-browser.js";
import { createWorkerShellRouter } from "../worker-shell-router.js";
import { hydrateResidentDrive } from "../resident-drive.js";
import { createWorkerShellRunner } from "../worker-shell-runner.js";
import {
  parseTurnComputePlan,
  runResidentStellaLoop,
  turnComputePlanKey,
} from "../general-agent-turn.js";
import { sha256Hex } from "../hash.js";
import { INSTANCE_TIERS, initialInstanceSize } from "../instance-size.js";
import { nativeHistoryCursorFromRows } from "../native-state-checkpoint.js";
import { SteerMailbox } from "../steer-mailbox.js";
import { emitCloudTurnTelemetry } from "../telemetry.js";
import {
  TURN_BROKER_MAX_TTL_MS,
  issueTurnBrokerCredential,
  turnBrokerStorageKey,
  TURN_BROKER_DRIVE_PATHS,
} from "../turn-credential-broker.js";
import { issueWorldCapability } from "../world-capability.js";
import {
  forwardBrowserGatewayCommand,
  serveTurnDriveRequest,
} from "./turn-broker.js";
import { deliverWorldLinkedFiles } from "./world-linked-files.js";
import {
  agentTurnSessionId,
  worldName,
  WORLD_ROOT,
  worldSandboxId,
} from "../workspace.js";
import type { createAgentControlPlane } from "../agent-control-plane.js";
import type { SealedTurnTranscript } from "../agent-turn-journal.js";
import type {
  GeneralAgentTurnPlan,
  GeneralAgentTurnResult,
  TurnDurability,
} from "../general-agent-turn.js";
import type { InstanceSize } from "../instance-size.js";
import type { TurnExecutionContext } from "../turn-cancellation.js";
import type {
  TurnStateCandidate,
  TurnStateWorkspaceHead,
} from "../turn-state-registry.js";
import type { BuildSessionInternals } from "./host.js";
import {
  AgentTurnAuthorityLostError,
  AgentTurnError,
  OwnerPurgeFenceError,
  TurnStateRegistryBookkeepingError,
  isTurnStateAuthorityError,
} from "./shared/errors.js";
import {
  AGENT_TURN_HEARTBEAT_MS,
  AGENT_WATCHDOG_DEADLINE_KEY,
  OBSERVED_BROWSER_SUSPENSION_KEY,
  bindObservedBrowserSuspensionToCanonicalCursor,
  cloudBrowserSuspensionMarker,
  errorMessage,
  log,
  mintAgentTurnModelGateway,
  turnBrokerCredentialsPath,
  turnStateCheckpointOperationKey,
} from "./shared/keys.js";
import type {
  ObservedBrowserSuspension,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
  TurnStateCheckpointOperation,
} from "./shared/types.js";
import type { ExecutionSession } from "../sandbox-client.js";
import type {
  TurnBrokerTurnStateCheckpointReceipt,
  TurnBrokerTurnStateCheckpointRequest,
} from "@stella/contracts/turn-credential-broker";
import type { AgentHistoryRow } from "@stella/executor-cloud/agent-history";

export type ResidentTurnHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "startAgentTurn"
  | "residentAgentAborts"
  | "turnStateCheckpointRuns"
  | "agentTurnExecutions"
  | "agentControlPlane"
  | "emitTurnEvent"
  | "assertAgentExecutionActive"
  | "assertAgentTurnIdentity"
  | "attachAgentWorld"
  | "childAgentDispatchDependencies"
  | "claimTerminalDecision"
  | "clearUnattachedAgentSandboxTuple"
  | "currentSandbox"
  | "deleteTurnStoragePreservingExactCancellations"
  | "deliverBrowserSuspension"
  | "deliverResidentTerminal"
  | "deliverTerminal"
  | "destroySandboxDurably"
  | "event"
  | "executeTurnStateCheckpoint"
  | "fetchCanonicalAgentHistory"
  | "finishResidentAgentTurn"
  | "ownsExactTurn"
  | "persistAgentExecutionMarker"
  | "publishAgentTurnWorkspace"
  | "publishResidentTurnWorkspace"
  | "releaseAgentSessionResources"
  | "repairedResidentJournal"
  | "residentAttachHistory"
  | "resolveAgentTurnState"
  | "retainPendingBrowserSuspension"
  | "sandbox"
  | "setExactTurnAlarm"
  | "settleAgentTransientBackup"
>;

/**
 * D9. Turn what a lost isolate left in the journal into rows a thread can
 * read.
 *
 * A call in the interrupted tail is answered, never replayed. Its receipt
 * lives only in the daemon process the archive below is about to kill, and
 * the interrupted result says exactly that much: the effect is unknown.
 */

/**
 * The owner's devices as spawn destinations for a cloud agent that can start
 * agents of its own, and its own place (the cloud). Failed discovery is
 * advisory: the list says it is unavailable.
 */
const cloudAgentExecutionContext = async (
  env: Pick<Cloudflare.Env, "OWNER_GATES">,
  ownerId: string,
  audience: string,
): Promise<string> => {
  let devices: DeviceDestination[] | null = null;
  try {
    devices = (await env.OWNER_GATES.getByName(ownerId).devices()).devices;
  } catch {
    devices = null;
  }
  const snapshot = createExecutionContextSnapshot({
    devices,
    destination: { kind: "cloud" },
    media: { stella: mediaAccessForAudience(audience) },
  });
  return `${renderExecutionDevices(snapshot)}\n\n${renderExecutionDestination(snapshot)}\n\n${renderMediaAccess(snapshot)}`;
};

export const repairedResidentJournal = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  message: string,
): Promise<SealedTurnTranscript> => {
  const now = Date.now();
  const journal = AgentTurnJournal.open({
    sql: host.ctx.storage.sql,
    identity: {
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration!,
    },
    terminal: {
      prompt: turn.prompt,
      provider: turn.execution?.provider ?? "stella",
      model: turn.execution?.model ?? "unknown",
      finalText: "",
      error: message,
      timestamp: now,
    },
    now,
  });
  return await journal.repairInterruptedTail({
    resolveInterruptedCall: async () => "interrupted",
    terminalMessage: message,
  });
};

/**
 * D9's resident arm. Nothing was ever attached, so there is no disk to
 * archive and no fallback publication to advance: the journal is the whole
 * durable record of the turn, and the thread is owed a repaired transcript
 * followed by a failure.
 */
export const recoverResidentAgentTurn = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
): Promise<void> => {
  const message =
    "The agent stopped unexpectedly before it finished. Its reply was not completed.";
  if (!turn.threadId || !turn.turnBrokerRoute) return;
  // The journal cannot be sealed under a loop that is still appending to it.
  // A replacement isolate has nothing here, which is the common case.
  const running = host.agentTurnExecutions.get(turn.turnId);
  if (running) {
    await running.interrupt(new Error(message)).catch(() => undefined);
  }
  const recoveredPending: PendingTerminal = {
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    kind: "failed",
    payload: { message, reason: "resident_recovered" },
    threadError: message,
  };
  try {
    const repaired = await host.repairedResidentJournal(turn, message);
    await host
      .agentControlPlane(
        turn,
        turn.attemptGeneration!,
        turn.turnBrokerRoute.sessionId,
      )
      .appendAndVerifyTranscript(repaired);
  } catch (error) {
    log("error", "resident_agent_recovery_retry", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      message: errorMessage(error),
    });
    await host.setExactTurnAlarm(turn, Date.now() + 30_000);
    return;
  }
  if (
    !(await host.claimTerminalDecision(
      turn,
      recoveredPending,
      Date.now() + 30_000,
    ))
  ) {
    await host.setExactTurnAlarm(turn, Date.now() + 1_000);
    return;
  }
  if (
    (await host.deliverTerminal(turn, recoveredPending)) &&
    (await host.ownsExactTurn(turn))
  ) {
    await host.deleteTurnStoragePreservingExactCancellations(turn, true);
  }
  log("info", "resident_agent_turn_recovered", {
    turnId: turn.turnId,
    threadId: turn.threadId,
  });
};

/** How many replacement isolates may continue one resident attempt. */
export const RESIDENT_RESUME_MAX = 2;
/** A turn older than this fails the way it always has instead of resuming. */
export const RESIDENT_RESUME_MAX_AGE_MS = 15 * 60_000;
/**
 * Resuming this close to the watchdog would only buy a timeout mid-reply, so
 * the turn takes the ordinary failure path while it still can.
 */
const RESIDENT_RESUME_DEADLINE_MARGIN_MS = 30_000;

/**
 * The persisted model-gateway capability of one attempt. A resumed attempt
 * presents the same token, so the gateway's per-capability ledger keeps
 * counting the turn's spend and requests instead of granting a fresh budget.
 */
const residentModelGatewayKey = (
  turnId: string,
  attemptGeneration: number,
): string => `residentModelGateway:${turnId}:${attemptGeneration}`;

type PersistedResidentModelGateway = Readonly<{
  schemaVersion: 1;
  turnId: string;
  attemptGeneration: number;
  origin: string;
  capability: string;
  expiresAt: number;
}>;

/** A reused capability must outlive the rest of the turn's watchdog. */
const residentModelGateway = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  execution: Parameters<typeof mintAgentTurnModelGateway>[2],
  resume: boolean,
): Promise<{ origin: string; capability: string; reused: boolean }> => {
  const attemptGeneration = turn.attemptGeneration!;
  const key = residentModelGatewayKey(turn.turnId, attemptGeneration);
  if (resume) {
    const [stored, deadline] = await Promise.all([
      host.ctx.storage.get<PersistedResidentModelGateway>(key),
      host.ctx.storage.get<number>(AGENT_WATCHDOG_DEADLINE_KEY),
    ]);
    if (
      stored?.schemaVersion === 1 &&
      stored.turnId === turn.turnId &&
      stored.attemptGeneration === attemptGeneration &&
      typeof deadline === "number" &&
      stored.expiresAt > deadline + 60_000
    ) {
      return {
        origin: stored.origin,
        capability: stored.capability,
        reused: true,
      };
    }
  }
  const minted = await mintAgentTurnModelGateway(host.env, turn, execution);
  await host.ctx.storage.put(key, {
    schemaVersion: 1,
    turnId: turn.turnId,
    attemptGeneration,
    origin: minted.origin,
    capability: minted.capability,
    expiresAt: minted.expiresAt,
  } satisfies PersistedResidentModelGateway);
  return { origin: minted.origin, capability: minted.capability, reused: false };
};

/**
 * D9's first choice for a resident turn whose isolate was replaced (a
 * deploy, an eviction): continue it rather than fail it.
 *
 * Bounded three ways. At most {@link RESIDENT_RESUME_MAX} resumes per attempt,
 * counted durably before the resumed loop runs, so a turn that kills every
 * isolate it lands in still ends; only turns younger than
 * {@link RESIDENT_RESUME_MAX_AGE_MS}; and only while the original watchdog
 * deadline, which a resume never extends, leaves room to finish. Anything
 * else returns false and the caller takes {@link recoverResidentAgentTurn},
 * today's failure path.
 *
 * Only an unattached turn reaches here: a world attach writes the execution
 * marker, and a marked turn is recovered by archiving its disk.
 */
export const resumeResidentAgentTurn = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
): Promise<boolean> => {
  if (!turn.threadId || !turn.turnBrokerRoute) return false;
  if (host.agentTurnExecutions.has(turn.turnId)) return false;
  const attemptGeneration = turn.attemptGeneration!;
  const identity = { turnId: turn.turnId, attemptGeneration };
  const now = Date.now();
  const [rawPlan, deadline] = await Promise.all([
    host.ctx.storage.get(turnComputePlanKey(turn.turnId, attemptGeneration)),
    host.ctx.storage.get<number>(AGENT_WATCHDOG_DEADLINE_KEY),
  ]);
  const plan = parseTurnComputePlan(rawPlan, identity);
  const journal = AgentTurnJournal.open({
    sql: host.ctx.storage.sql,
    identity,
    terminal: {
      prompt: turn.prompt,
      provider: turn.execution?.provider ?? "stella",
      model: turn.execution?.model ?? "unknown",
      finalText: "",
      timestamp: now,
    },
    now,
  });
  const resumeCount = journal.resumeCount;
  const ageMs = plan ? now - plan.decidedAt : Number.POSITIVE_INFINITY;
  const refusal =
    plan?.plan.kind !== "resident_stella"
      ? "not_resident"
      : resumeCount >= RESIDENT_RESUME_MAX
        ? "resume_cap"
        : ageMs >= RESIDENT_RESUME_MAX_AGE_MS
          ? "too_old"
          : typeof deadline !== "number" ||
              !Number.isFinite(deadline) ||
              deadline - now <= RESIDENT_RESUME_DEADLINE_MARGIN_MS
            ? "watchdog"
            : undefined;
  if (refusal) {
    log("info", "resident_agent_turn_not_resumable", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      reason: refusal,
      resumeCount,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
    });
    return false;
  }
  const count = journal.bumpResume();
  if (
    !(await host.setExactTurnAlarm(
      turn,
      Math.min(deadline!, now + AGENT_TURN_HEARTBEAT_MS),
    ))
  ) {
    return false;
  }
  log("info", "resident_agent_turn_resumed", {
    turnId: turn.turnId,
    threadId: turn.threadId,
    attemptGeneration,
    resumeCount: count,
    journalRows: journal.rowCount,
    openToolCalls: journal.openToolCalls().length,
    sealed: journal.sealed,
    ageMs,
  });
  host.ctx.waitUntil(
    host
      .startAgentTurn(turn, undefined, { resume: true })
      .catch(() => undefined),
  );
  return true;
};

/**
 * Resolve what a lazy attach has to put on disk.
 *
 * The container path does this before it boots. A resident turn cannot: the
 * whole point is that a chat-only turn never pays for it. So it runs at
 * attach time instead, against the same owner fence and with the same
 * refusal when a predecessor's publication is still being repaired.
 */
export const resolveAgentWorldRestore = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  execution: TurnExecutionContext,
  history: AgentHistoryRow[],
): Promise<{
  turnStateWorkspaceRestore?: TurnStateWorkspaceHead;
  turnStateThreadRestore?: TurnStateCandidate;
  turnStateThreadRestoreConfirmationRequired: boolean;
}> => {
  const canonicalHistoryCursor = await nativeHistoryCursorFromRows(history);
  let resolved = await host.resolveAgentTurnState(turn, canonicalHistoryCursor);
  execution.assertActive();
  if (resolved.workspacePublication) {
    if (!resolved.workspacePublication.publishable) {
      throw new AgentTurnError(
        "This workspace is still recovering a previous agent turn. Try again shortly.",
      );
    }
    host.assertAgentTurnIdentity(turn);
    await host.publishAgentTurnWorkspace(
      turn,
      canonicalHistoryCursor,
      resolved.workspacePublication.operationId,
    );
    execution.assertActive();
    resolved = await host.resolveAgentTurnState(turn, canonicalHistoryCursor);
    execution.assertActive();
    if (resolved.workspacePublication) {
      throw new AgentTurnError(
        "This workspace is still recovering a previous agent turn. Try again shortly.",
      );
    }
  }
  execution.assertActive();
  return {
    ...(resolved.workspace
      ? { turnStateWorkspaceRestore: resolved.workspace }
      : {}),
    ...(resolved.restore ? { turnStateThreadRestore: resolved.restore } : {}),
    turnStateThreadRestoreConfirmationRequired: resolved.confirmationRequired,
  };
};

/**
 * Issue the daemon's broker capability exactly the way the container
 * executor gets it: a root-owned file above the world root, with the durable
 * record written before the container can present it. The raw turn token
 * never crosses this boundary.
 */
export const prepareAgentBrokerHandoff = async (
  host: ResidentTurnHost,
  args: {
    turn: TurnRequest;
    session: ExecutionSession;
    commandTimeoutMs: number;
    workspaceRestored: boolean;
  },
): Promise<{
  turnId: string;
  attemptGeneration: number;
  threadId: string;
  prompt: string;
  workspaceRestored: boolean;
  turnBroker: { credentialsPath: string };
  world: { origin: string; name: string; capability: string; fork?: string };
}> => {
  const { turn } = args;
  if (!turn.turnBrokerRoute || !turn.threadId) {
    throw new AgentTurnAuthorityLostError();
  }
  const brokerIdentity = {
    sessionId: turn.turnBrokerRoute.sessionId,
    ownerId: turn.ownerId,
    ownerGeneration: turn.ownerGeneration,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
  };
  const issued = await issueTurnBrokerCredential({
    identity: brokerIdentity,
    endpoint: turn.turnBrokerRoute.endpoint,
    now: Date.now(),
    ttlMs: Math.max(1, Math.min(TURN_BROKER_MAX_TTL_MS, args.commandTimeoutMs)),
  });
  await host.ctx.storage.put(
    turnBrokerStorageKey(brokerIdentity),
    issued.record,
  );
  const credentialsPath = turnBrokerCredentialsPath("/workspace");
  await args.session.writeFile(credentialsPath, JSON.stringify(issued.handoff));
  const protectedHandoff = await args.session.exec(
    `chmod 600 ${credentialsPath}`,
  );
  if (!protectedHandoff.success) {
    throw new Error("Turn broker handoff could not be protected.");
  }
  const name = await worldName(turn.ownerId);
  const worldCapability = await issueWorldCapability({
    secret: host.env.BUILDER_SERVICE_SECRET,
    worldName: name,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    now: Date.now(),
    ttlMs: Math.max(1, Math.min(30 * 60_000, args.commandTimeoutMs)),
  });
  return {
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    threadId: turn.threadId,
    prompt: turn.prompt,
    workspaceRestored: args.workspaceRestored,
    turnBroker: { credentialsPath },
    world: {
      origin: host.env.CLOUD_BUILDER_PUBLIC_URL.replace(/\/+$/u, ""),
      name,
      capability: worldCapability,
    },
  };
};

/**
 * A Stella turn whose agent loop runs right here.
 *
 * No container exists until a tool needs one. What that buys is on the
 * turn's critical path: a chat-only reply costs one local history read and
 * the model call, with no cold start, no squashfs restore, and nothing to
 * tear down when the user stops it.
 */
export const runResidentAgentTurn = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  plan: Extract<GeneralAgentTurnPlan, { kind: "resident_stella" }>,
  execution: TurnExecutionContext,
  options: Readonly<{ resume?: boolean }> = {},
): Promise<GeneralAgentTurnResult> => {
  const resume = options.resume === true;
  const requestStarted = performance.now();
  const commandTimeoutMs = Number(host.env.TURN_TIMEOUT_MS);
  await host.assertAgentExecutionActive(turn, execution);
  if (!turn.threadId || !turn.turnBrokerRoute) {
    throw new AgentTurnAuthorityLostError();
  }
  const attemptGeneration = turn.attemptGeneration!;
  const identity = { turnId: turn.turnId, attemptGeneration };
  // These fields mirror the currently attached resource for alarm cleanup.
  // Clear a predecessor before this resident attempt can attach; an exact
  // replay with a compute record keeps the mirror for its existing session.
  await host.clearUnattachedAgentSandboxTuple(turn);
  // A resumed attempt already projected its start; the owner still reads it
  // as running, which is exactly what it is.
  if (!resume) {
    await host.event(
      turn,
      "auto",
      "started",
      { threadId: turn.threadId },
      false,
      execution.signal,
    );
  }
  execution.assertActive();

  const control = host.agentControlPlane(
    turn,
    attemptGeneration,
    turn.turnBrokerRoute.sessionId,
  );

  const sandboxId = await worldSandboxId(turn.ownerId);
  const ownerWorldName = await worldName(turn.ownerId);
  const world = host.env.WORLDS.getByName(ownerWorldName);
  const proposedSize: InstanceSize = initialInstanceSize({
    prompt: turn.prompt,
  });
  const instanceSize = proposedSize;
  const sessionId = agentTurnSessionId(turn.turnId);
  const daemonDirectory = attachedToolPaths(identity).directory;
  let attachedWorkspaceRestore: TurnStateWorkspaceHead | undefined;
  let residentHistory: AgentHistoryRow[] = [];
  let residentSandbox: ReturnType<ResidentTurnHost["sandbox"]> | undefined;
  const attachment = createLazySandboxAttachment(async () => {
    const { createAgentSandboxAttachment } = await import(
      "../agent-sandbox-attachment.js"
    );
    return createAgentSandboxAttachment({
      context: execution,
      attachWorld: async ({
        instanceSize: size,
        sessionId: attachedSessionId,
      }) => {
        await host.ctx.storage.put({ sandboxId, sandboxSize: size });
        residentSandbox = host.sandbox(sandboxId, size, "world");
        // The thread before this turn — exactly what the container path
        // resolves against. Read here rather than at admission so a
        // chat-only resident turn never pays for it. Resolving against an
        // empty history instead named the wrong cursor on every follow-up:
        // the previous turn's checkpoint could never be published or
        // restored, and each attach refused as "still recovering".
        residentHistory = host.residentAttachHistory(turn, execution);
        const restore = await resolveAgentWorldRestore(
          host,
          turn,
          execution,
          residentHistory,
        );
        attachedWorkspaceRestore = restore.turnStateWorkspaceRestore;
        const attached = await host.attachAgentWorld({
          turn,
          execution,
          sandbox: residentSandbox,
          size,
          history: residentHistory,
          commandTimeoutMs,
          sessionId: attachedSessionId,
          ...restore,
        });
        // D9's fork. Only a confirmed world is worth archiving, so the marker
        // lands after the restore: an eviction before this point releases the
        // incomplete session, and one after it recovers by archiving the disk
        // the way a lost container executor already does.
        await host.persistAgentExecutionMarker(turn, {
          schemaVersion: 1,
          turnId: turn.turnId,
          attemptGeneration,
          sandboxId,
          size,
          startedAt: Date.now(),
        });
        return attached;
      },
      prepareBrokerHandoff: async ({ session }) =>
        await prepareAgentBrokerHandoff(host, {
          turn,
          session,
          commandTimeoutMs,
          workspaceRestored: Boolean(attachedWorkspaceRestore),
        }),
      // The daemon runs on the sessionless facade, exactly as the eager
      // container path runs its executor: a background process started
      // through the `agent-run` session is a child of that session's
      // persistent shell and dies with it, and that shell is also where the
      // restore scripts, the readiness probe and every bridged call run.
      startDaemon: async (command, options) => {
        if (!residentSandbox) {
          throw new Error("The resident sandbox has not been attached.");
        }
        return await residentSandbox.startProcess(command, {
          cwd: options.cwd,
          env: executorSessionEnvironment(),
          processId: options.processId,
        });
      },
      release: async (target) => {
        await host.releaseAgentSessionResources({
          sandboxId: target.sandboxId,
          size: target.instanceSize,
          sessionId: target.sessionId,
          daemonDirectory: target.daemonDirectory,
          workload: "world",
        });
      },
      destroy: async (target) => {
        await host.destroySandboxDurably(
          {
            sandboxId: target.sandboxId,
            size: target.instanceSize,
            workload: "world",
          },
          "agent_oom_resize",
        );
      },
      // Without this the attachment's own diagnostics (a daemon that exited
      // before listening, or stopped answering mid-turn, with its stderr)
      // were thrown away, and a dead workspace bridge looked like a bare
      // "connection refused" to everyone downstream.
      emitEvent: (kind, payload) => {
        void host
          .event(turn, "auto", kind, payload, false, execution.signal)
          .catch(() => undefined);
      },
    });
  });

  const ladder = createAgentComputeLadder({
    ...identity,
    sandboxId,
    sessionId,
    daemonDirectory,
    initialInstanceSize: instanceSize,
    selectInstanceSize: async (initial) =>
      await world.selectContainerSize(initial),
    rememberInstanceSize: async (size) => {
      await world.rememberContainerSize(size);
    },
    store: {
      read: async () =>
        parsePersistedAgentCompute(
          await host.ctx.storage.get(
            agentComputeKey(turn.turnId, attemptGeneration),
          ),
          identity,
        ),
      write: async (record: PersistedAgentCompute) => {
        await host.ctx.storage.put(
          agentComputeKey(turn.turnId, attemptGeneration),
          record,
        );
      },
    },
    attachment,
    context: execution,
    emitEvent: (kind, payload) => {
      void host
        .event(turn, "auto", kind, payload, false, execution.signal)
        .catch(() => undefined);
    },
  });

  const agentControl = createBuildSessionAgentControl({
    storage: host.ctx.storage,
    env: host.env,
    dispatch: host.childAgentDispatchDependencies(),
    parent: {
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      conversationId: turn.conversationId!,
      turnId: turn.turnId,
      threadId: turn.threadId!,
      agentDepth: turn.agentDepth,
      execution: plan.execution,
    },
  });
  let driveKnown = new Map<string, number>();
  let hydration: Promise<boolean> | undefined;
  const prepareWorkspace = (): Promise<boolean> => {
    if (ladder.attached()) return Promise.resolve(false);
    return (hydration ??= (async () => {
      try {
        driveKnown = await hydrateResidentDrive({
          turnId: turn.turnId,
          prompt: turn.prompt,
          signal: execution.signal,
          world: {
            head: () => world.head(),
            stat: (path) => world.stat(path),
            list: (prefix, options) => world.list(prefix, options),
            readFile: (path) => world.readFile(path),
            putBlob: (stream, input) => world.putBlob(stream, input),
            commitShell: (change) => world.commitShell(change),
          },
          post: async (body, signal) => {
            signal.throwIfAborted();
            return await serveTurnDriveRequest(
              host.env,
              turn,
              TURN_BROKER_DRIVE_PATHS.sync,
              body as Record<string, unknown>,
            );
          },
        });
        return true;
      } catch (error) {
        execution.assertActive();
        log("info", "resident_drive_sandbox_fallback", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
        return false;
      }
    })());
  };
  const doLocal = createGeneralAgentDoLocalTools({
    control,
    agentControl,
    world: {
      tool: async (call, toolCallId) => {
        if (!(await prepareWorkspace()) || ladder.attached()) {
          const result = await ladder.execute({
            toolCallId,
            toolName: call.name,
            params: call.arguments,
          });
          return result.outcome.kind === "ok"
            ? { ok: true, output: result.outcome.text }
            : { ok: false, output: result.outcome.message };
        }
        return world.tool(call);
      },
    },
    signal: execution.signal,
  });
  // The cloud browser needs no container: every command is one bounded
  // request to the private Browser Gateway under this turn's authority, the
  // same forward the turn broker makes for the container executor. A login
  // handoff is observed here before the model ever sees it.
  const browser: ResidentBrowserClient | undefined = host.env.BROWSER_GATEWAY
    ? createResidentBrowserClient(async (command, request) =>
        await forwardBrowserGatewayCommand(host, turn, {
          command,
          signal: request.signal,
          brokerRequestId: command.requestId,
          requestFingerprint: request.requestFingerprint,
        }),
      )
    : undefined;
  // `code` runs in a Dynamic Worker the DO loads on demand, the same
  // executor the cloud orchestrator uses, so a resident agent evaluates
  // JavaScript without reserving a container. Only the DO-local tools are
  // reachable from inside code, and only the read-only ones among them, plus
  // the turn's cloud browser; a deployment without the loader keeps the
  // model-visible refusal instead.
  // `history` reads the conversation this agent was spawned from, through
  // that conversation's own Durable Object.
  const conversationId = turn.conversationId;
  const history: CloudHistoryClient | undefined = conversationId
    ? {
        sql: (query, params) =>
          host.env.ORCHESTRATOR_SESSIONS.getByName(conversationId).queryHistory(
            turn.ownerId,
            { op: "sql", query, params },
          ),
        read: (fromSeq, toSeq) =>
          host.env.ORCHESTRATOR_SESSIONS.getByName(conversationId).queryHistory(
            turn.ownerId,
            { op: "read", fromSeq, toSeq },
          ),
      }
    : undefined;
  const jsSandbox = host.env.LOADER
    ? new Map([
        [
          CODE_TOOL_NAME,
          await createCloudCodeAgentTool({
            loader: host.env.LOADER,
            tools: [...doLocal.values()],
            executionScope: `${turn.ownerGeneration}:${turn.threadId}:${turn.turnId}:${attemptGeneration}`,
            ...(browser ? { browser } : {}),
            ...(history ? { history } : {}),
          }),
        ],
      ])
    : undefined;

  // Bash runs in the just-bash worker shell until this turn attaches
  // a sandbox, and in the sandbox from then on. The shell reads the world
  // through a loopback scoped to this owner world; only this
  // Durable Object commits what a run changed.
  const workspaceRoot = WORLD_ROOT;
  const compute = createWorkerShellRouter({
    ladder,
    root: workspaceRoot,
    prepareWorkspace,
    signal: execution.signal,
    emitEvent: (kind, payload) => {
      void host
        .event(turn, "auto", kind, payload, false, execution.signal)
        .catch(() => undefined);
    },
    ...(host.env.LOADER
      ? {
          shell: createWorkerShellRunner({
            loader: host.env.LOADER,
            loopback: () =>
              host.ctx.exports.WorldShellFs({
                props: { worldName: ownerWorldName },
              }),
            world: {
              head: () => world.head(),
              commitShell: (change) => world.commitShell(change),
            },
            root: workspaceRoot,
            scope: ownerWorldName,
          }),
        }
      : {}),
  });

  let computeReleased = false;
  try {
    execution.assertActive();
    const modelGateway = await residentModelGateway(
      host,
      turn,
      plan.execution,
      resume,
    );
    execution.assertActive();
    const modelGatewayBinding = host.env.MODEL_GATEWAY;
    if (!modelGatewayBinding) {
      throw new Error("Model gateway is not configured.");
    }
    const result = await runResidentStellaLoop({
      turn: {
        kind: "agent",
        identity: {
          ownerId: turn.ownerId,
          ownerGeneration: turn.ownerGeneration,
          threadId: turn.threadId,
          turnId: turn.turnId,
          attemptGeneration,
        },
        prompt: turn.prompt,
        brokerRoute: turn.turnBrokerRoute,
        execution: plan.execution,
        ...(turn.browserResume ? { browserResume: turn.browserResume } : {}),
        audience: turn.audience,
        budgetMicroCents: turn.budgetMicroCents,
        watchdogMs: turn.watchdogMs ?? 15 * 60_000,
      },
      execution: plan.execution,
      context: execution,
      control,
      modelGateway: {
        origin: modelGateway.origin,
        capability: modelGateway.capability,
        fetch: (input, init) => modelGatewayBinding.fetch(input, init),
      },
      sql: host.ctx.storage.sql,
      tools: createResidentGeneralAgentTools(doLocal, compute, jsSandbox, {
        agentDepth: turn.agentDepth,
      }),
      steer: {
        drain: async () =>
          SteerMailbox.open(host.ctx.storage.sql).drain({
            turnId: turn.turnId,
            attemptGeneration,
          }),
        acknowledge: (ids) =>
          SteerMailbox.open(host.ctx.storage.sql).acknowledge(
            { turnId: turn.turnId, attemptGeneration },
            ids,
          ),
      },
      workspacePrompt: {
        office: false,
        history: Boolean(jsSandbox && history),
        ...(turn.agentDepth < MAX_CLOUD_AGENT_DEPTH
          ? {
              executionContext: await cloudAgentExecutionContext(
                host.env,
                turn.ownerId,
                turn.audience,
              ),
            }
          : {}),
      },
      now: () => Date.now(),
      onAgentStarted: (abort) => {
        host.residentAgentAborts.set(turn.turnId, abort);
      },
      ...(resume
        ? {
            resume: {
              onRepaired: (summary) => {
                log("info", "resident_agent_turn_resume_repaired", {
                  turnId: turn.turnId,
                  threadId: turn.threadId,
                  modelGatewayReused: modelGateway.reused,
                  ...summary,
                });
              },
            },
          }
        : {}),
      commit: async (sealed, finalText) =>
        await commitResidentTurnDurability(host, {
          turn,
          execution,
          ladder,
          sealed,
          finalText,
          control,
          commandTimeoutMs,
          driveKnown,
        }),
    });
    // A turn that used the browser and is not handing it to the user saves
    // the profile before its authority ends, as the container path does in
    // `checkpointCloudBrowserTurnBeforeTeardown`. A suspended profile is
    // under human control and receives no automation command.
    if (
      browser &&
      result.outcome !== "suspended" &&
      browser.used() &&
      !execution.signal.aborted
    ) {
      await browser.checkpoint(execution.signal).catch((error) => {
        log("error", "resident_browser_checkpoint_failed", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          message: errorMessage(error),
        });
      });
    }
    computeReleased = true;
    await host.finishResidentAgentTurn(turn, ladder, result, requestStarted);
    return result;
  } finally {
    host.residentAgentAborts.delete(turn.turnId);
    // The sweep for an exceptional exit only. A turn that reached its
    // completion sequence has already released what attached.
    if (!computeReleased) await ladder.teardown().catch(() => undefined);
  }
};

/**
 * A completed resident turn releases its compute before its terminal is
 * delivered. Delivery deletes the exact compute record with the rest of the
 * turn's storage; after that, cleanup would no longer know which session and
 * daemon directory belong to the turn. Failure paths use the same order.
 */
export const finishResidentAgentTurn = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  ladder: Pick<ReturnType<typeof createAgentComputeLadder>, "teardown">,
  result: GeneralAgentTurnResult,
  requestStarted: number,
): Promise<void> => {
  await releaseResidentCompute(host, turn, ladder);
  if (result.outcome === "suspended") {
    if (await deliverResidentBrowserSuspension(host, turn, result, requestStarted)) {
      return;
    }
    // The handoff could not be bound to the committed transcript. The turn
    // ends as a failure the user can retry; the gateway interaction expires.
    await host.deliverResidentTerminal(
      turn,
      {
        outcome: "failed",
        ok: false,
        error: "Stella couldn't hand this sign-in over to you safely. Please try again.",
        usage: result.usage,
        compute: result.compute,
        durability: result.durability,
      },
      requestStarted,
    );
    return;
  }
  await host.deliverResidentTerminal(turn, result, requestStarted);
};

/**
 * Park a resident turn on a login handoff, the way the container path does.
 *
 * The gateway's suspension was recorded as an observation when it arrived;
 * it becomes user-visible only once the canonical transcript, which ends on
 * the unanswered Code call, binds it to that call. Then the secret-free wait
 * descriptor is retained durably (an alarm can redeliver it) and projected as
 * a nonterminal `waiting_for_user`. Returns false when the binding fails or a
 * terminal path already won, so the caller can fail the turn instead.
 */
export const deliverResidentBrowserSuspension = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  result: Extract<GeneralAgentTurnResult, { outcome: "suspended" }>,
  requestStarted: number,
): Promise<boolean> => {
  const observation = await host.ctx.storage.get<ObservedBrowserSuspension>(
    OBSERVED_BROWSER_SUSPENSION_KEY,
  );
  const bound = observation
    ? await bindObservedBrowserSuspensionToCanonicalCursor({
        observation,
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        historyCursor: result.durability.transcript.historyCursor,
        rows: host.fetchCanonicalAgentHistory(turn, {
          excludeCurrentTurn: false,
        }),
      })
    : null;
  if (
    !bound ||
    cloudBrowserSuspensionMarker(bound) !==
      cloudBrowserSuspensionMarker(result.suspension)
  ) {
    log("error", "browser_suspension_checkpoint_mismatch", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      resident: true,
    });
    return false;
  }
  const wallClockMs = Math.round(performance.now() - requestStarted);
  const compute = result.compute;
  const coldContainerStartMs =
    compute.kind === "sandbox" ? compute.coldStartMs : 0;
  const restoreMs = compute.kind === "sandbox" ? compute.restoreMs : 0;
  const instanceType =
    compute.kind === "sandbox"
      ? INSTANCE_TIERS[compute.instanceSize].instanceType
      : undefined;
  const pending: PendingBrowserSuspension = {
    schemaVersion: 1,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    suspension: bound,
    payload: {
      suspension: bound,
      usage: result.usage,
      coldContainerStartMs,
      restoreMs,
      checkpointMs: 0,
      wallClockMs,
      ...(instanceType ? { instanceType } : {}),
    },
    createdAt: Date.now(),
  };
  // A stop that landed first owns the turn; the handoff is then moot.
  if (!(await host.retainPendingBrowserSuspension(turn, pending))) return true;
  const delivered = await host.deliverBrowserSuspension(turn, pending);
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
    interactionId: bound.interactionId,
    resident: true,
    wallClockMs,
  });
  emitCloudTurnTelemetry(host.ctx, host.env, {
    type: "cloud.turn",
    workload: "agent",
    phase: "suspended",
    wallClockMs,
    coldContainerStartMs,
    restoreMs,
    checkpointMs: 0,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    llmCalls: result.usage.llmCalls,
    ...(instanceType ? { instanceType } : {}),
  });
  return true;
};

/** Release resident compute without withholding the turn terminal. */
export const releaseResidentCompute = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  ladder: Pick<ReturnType<typeof createAgentComputeLadder>, "teardown">,
): Promise<void> => {
  try {
    await ladder.teardown();
  } catch (error) {
    log("error", "resident_compute_release_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      message: errorMessage(error),
    });
  }
};

/**
 * D6, sequenced by the code that owns `turn-state-archive`.
 *
 * A turn that never attached commits its transcript and nothing else. One
 * that did commits the archive first, because a
 * canonical cursor must never name a world checkpoint that was never created.
 */
export const commitResidentTurnDurability = async (
  host: ResidentTurnHost,
  args: {
    turn: TurnRequest;
    execution: TurnExecutionContext;
    ladder: ReturnType<typeof createAgentComputeLadder>;
    sealed: SealedTurnTranscript;
    driveKnown?: ReadonlyMap<string, number>;
    /** The turn's final assistant text; delivered files derive from its links. */
    finalText: string;
    control: ReturnType<typeof createAgentControlPlane>;
    commandTimeoutMs: number;
  },
): Promise<Exclude<TurnDurability, { kind: "none" }>> => {
  const { turn, execution, ladder, sealed, control } = args;
  if (!ladder.attached()) {
    // No sandbox ever quiesced for this turn, so its reply-linked files are
    // delivered from the world the Durable Object's own tools wrote into.
    await deliverWorldLinkedFiles(host, {
      turn,
      finalText: args.finalText,
      signal: execution.signal,
      known: args.driveKnown,
      log: (event, fields) => log("error", event, fields),
    }).catch((error) => {
      log("error", "world_linked_files_failed", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
    });
    return {
      kind: "transcript_only",
      transcript: await control.appendAndVerifyTranscript(sealed),
    };
  }
  await ladder.quiesce(extractLocalFileLinkPaths(args.finalText));
  execution.assertActive();
  let checkpoint: TurnBrokerTurnStateCheckpointReceipt;
  try {
    checkpoint = await runResidentTurnStateCheckpoint(host, {
      turn,
      historyCursor: sealed.historyCursor,
    });
  } catch (error) {
    if (!(error instanceof TurnStateRegistryBookkeepingError)) throw error;
    const transcript = await control.appendAndVerifyTranscript(sealed);
    log("error", "turn_state_publish_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      phase: "checkpoint_registry",
      historyCursor: error.historyCursor,
      manifestId: error.manifestId,
      message: errorMessage(error.cause),
    });
    return { kind: "transcript_only", transcript };
  }
  // Only the orchestrator's native-only checkpoint names no world, and the
  // orchestrator never runs as a resident agent.
  const manifestId = checkpoint.manifestId;
  if (manifestId === undefined) {
    throw new Error("A resident turn's checkpoint named no world manifest.");
  }
  const transcript = await control.appendAndVerifyTranscript(sealed);
  try {
    await host.publishResidentTurnWorkspace(turn, execution, checkpoint);
  } catch (error) {
    if (
      error instanceof AgentTurnAuthorityLostError ||
      error instanceof OwnerPurgeFenceError ||
      isTurnStateAuthorityError(error)
    ) {
      throw error;
    }
    log("error", "turn_state_publish_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      phase: "workspace_publish",
      historyCursor: checkpoint.historyCursor,
      manifestId: checkpoint.manifestId,
      message: errorMessage(error),
    });
    return { kind: "transcript_only", transcript };
  }
  return {
    kind: "workspace_manifest",
    transcript,
    historyCursor: checkpoint.historyCursor,
    manifestId,
  };
};

/** What a lazy resident attach restores against: the thread before this turn. */
export const residentAttachHistory = (
  host: ResidentTurnHost,
  turn: TurnRequest,
  execution: TurnExecutionContext,
): AgentHistoryRow[] => {
  return host.fetchCanonicalAgentHistory(turn, {
    excludeCurrentTurn: true,
    signal: execution.signal,
  });
};

/**
 * Publish the checkpoint an attached resident turn just committed, the way
 * the container path does at its own completion. Left as a candidate, it
 * could only be published by the thread's next turn, and only while that
 * turn's history cursor still matched; a chat-only turn in between moved
 * the cursor and left every later attach refusing as "still recovering".
 * The transcript is already verified canonical, so the receipt's cursor is
 * the one cloud history names.
 */
export const publishResidentTurnWorkspace = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  execution: TurnExecutionContext,
  checkpoint: TurnBrokerTurnStateCheckpointReceipt,
): Promise<void> => {
  execution.assertActive();
  host.assertAgentTurnIdentity(turn);
  await host.publishAgentTurnWorkspace(
    turn,
    checkpoint.historyCursor,
    checkpoint.operationId,
  );
  execution.assertActive();
};

/**
 * Run the deterministic turn-state operation for an attached resident turn.
 *
 * The container path reaches the same code through a broker request, whose
 * id makes a replay idempotent. A resident turn is its own requester, so the
 * id is derived from the exact attempt instead: an alarm replay resumes this
 * operation rather than manufacturing a second archive.
 */
export const runResidentTurnStateCheckpoint = async (
  host: ResidentTurnHost,
  args: {
    turn: TurnRequest;
    historyCursor: string;
  },
): Promise<TurnBrokerTurnStateCheckpointReceipt> => {
  const { turn } = args;
  const attemptGeneration = turn.attemptGeneration!;
  const requestId = await sha256Hex(
    `resident-turn-state:${turn.turnId}:${attemptGeneration}`,
  );
  const operationKey = turnStateCheckpointOperationKey(requestId);
  const existing =
    await host.ctx.storage.get<TurnStateCheckpointOperation>(operationKey);
  if (existing?.state === "succeeded") return existing.receipt;
  const payload: TurnBrokerTurnStateCheckpointRequest = {
    schemaVersion: 1,
    historyCursor: args.historyCursor,
  };
  const operation: Extract<
    TurnStateCheckpointOperation,
    { state: "pending" }
  > & { payload: TurnBrokerTurnStateCheckpointRequest } = {
    state: "pending",
    turnId: turn.turnId,
    attemptGeneration,
    requestId,
    requestFingerprint: await sha256Hex(JSON.stringify(payload)),
    createdAt: existing?.createdAt ?? Date.now(),
    payload,
  };
  await host.ctx.storage.put(operationKey, operation);
  const inFlight = host.turnStateCheckpointRuns.get(requestId);
  if (inFlight) return await inFlight;
  const run = host.executeTurnStateCheckpoint({
    turn,
    operationKey,
    operation,
  });
  host.turnStateCheckpointRuns.set(requestId, run);
  try {
    return await run;
  } finally {
    host.turnStateCheckpointRuns.delete(requestId);
  }
};

/**
 * The resident arm's terminal event. Same envelope the container path
 * delivers, minus the fields a resident turn genuinely does not have: there
 * is no cold start and no restore to report when nothing booted.
 */
export const deliverResidentTerminal = async (
  host: ResidentTurnHost,
  turn: TurnRequest,
  result: GeneralAgentTurnResult,
  requestStarted: number,
): Promise<void> => {
  const wallClockMs = Math.round(performance.now() - requestStarted);
  const compute = result.compute;
  const shared = {
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      llmCalls: result.usage.llmCalls,
    },
    coldContainerStartMs: compute.kind === "sandbox" ? compute.coldStartMs : 0,
    restoreMs: compute.kind === "sandbox" ? compute.restoreMs : 0,
    checkpointMs: 0,
    wallClockMs,
    ...(compute.kind === "sandbox"
      ? { instanceType: INSTANCE_TIERS[compute.instanceSize].instanceType }
      : {}),
  };
  const pending: PendingTerminal = result.ok
    ? {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        kind: "completed",
        payload: { finalText: result.finalText, ...shared },
      }
    : {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        kind: "failed",
        payload: {
          message:
            result.outcome === "failed"
              ? result.error
              : "The agent stopped and could not continue.",
        },
        threadError:
          result.outcome === "failed"
            ? result.error
            : "The agent stopped and could not continue.",
      };
  const delivered = await host.deliverTerminal(turn, pending);
  if (delivered && (await host.ownsExactTurn(turn))) {
    await host.deleteTurnStoragePreservingExactCancellations(turn, true);
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
    coldContainerStartMs: shared.coldContainerStartMs,
    restoreMs: shared.restoreMs,
    checkpointMs: 0,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    llmCalls: result.usage.llmCalls,
    ...(shared.instanceType ? { instanceType: shared.instanceType } : {}),
  });
};
