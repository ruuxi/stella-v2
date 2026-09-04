import {
  TURN_PLANE_PROTOCOL,
  type CloudAgentTurnStartResponse,
  type CloudTurnSource,
} from "@stella/contracts/turn-plane/turn-start";
import type {
  OutboxEvent,
  ThreadSpawnedEvent,
  TurnStartedEvent,
} from "@stella/contracts/turn-plane/outbox";
import type { OwnerSnapshot } from "@stella/contracts/turn-plane/owner-snapshot";
import { mintTurnCapabilities } from "../capability-signer.js";
import type { ExactTurnCancellation } from "../execution-placement-turn-cancellation.js";
import {
  parseTurnComputePlan,
  runGeneralAgentTurn,
  turnComputePlan,
  turnComputePlanKey,
  type TurnComputePlan,
} from "../general-agent-turn.js";
import { snapshotAllowsExecutionEngine } from "../owner-gate.js";
import {
  startTurnExecution,
  type TurnExecutionContext,
} from "../turn-cancellation.js";
import { worldSandboxId } from "../workspace.js";
import type { BuildSessionInternals } from "./host.js";
import { AgentTurnAuthorityLostError } from "./shared/errors.js";
import {
  AGENT_RECOVERY_PENDING_KEY,
  AGENT_TURN_HEARTBEAT_MS,
  AGENT_WATCHDOG_DEADLINE_KEY,
  CLOUD_TURN_SOURCES,
  OBSERVED_BROWSER_SUSPENSION_KEY,
  OWNER_GATE_REFUSAL_STATUS,
  PENDING_BROWSER_SUSPENSION_KEY,
  agentExecutionMarkerKey,
  builderFallbackTranscriptKey,
  errorMessage,
  exactTurnIdentityMatches,
  json,
  log,
} from "./shared/keys.js";
import type {
  AgentExecutionMarker,
  BuilderFallbackTranscript,
  ObservedBrowserSuspension,
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
} from "./shared/types.js";

export type AdmissionHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "agentTurnExecutions"
  | "appTurnExecutions"
  | "builderFallbackRecoveries"
  | "controlPlaneCapabilities"
  | "exactTurnCancellations"
  | "residentAgentAborts"
  | "acknowledgeExactAgentTurnCancellation"
  | "agentTurnAccepted"
  | "deleteTurnStoragePreservingExactCancellations"
  | "deliverTerminal"
  | "enqueueOutboxDurable"
  | "mutateExactTurn"
  | "outboxBase"
  | "ownerGateFor"
  | "ownsExactTurn"
  | "quiesceCurrentAgentSession"
  | "redeliverOrphan"
  | "releaseOwnerGate"
  | "runAgentTurn"
  | "runContainerAgentTurn"
  | "runResidentAgentTurn"
  | "runTurn"
  | "startAgentTurn"
  | "terminateCurrentAgentSession"
  | "trackTurn"
  | "unregisterTurn"
>;

export const startAgentTurn = (
  host: AdmissionHost,
  turn: TurnRequest,
  sandboxId: string | undefined,
): Promise<void> => {
  const existing = host.agentTurnExecutions.get(turn.turnId);
  if (existing) return existing.settled;
  const execution = startTurnExecution({
    work: (context) => host.runAgentTurn(turn, sandboxId, context),
    // Cleanup is part of fiber interruption and is bounded by the Effect
    // facade. A Stop ACK therefore means the exact command session and
    // container teardown completed (or the cancellation failed visibly).
    //
    // The resident loop is aborted first, the way `OrchestratorSession`
    // stops its own: the sweeps below cannot make an in-flight provider call
    // or tool return, and leaving the Agent running would let it start
    // container work behind a teardown that already ran.
    onInterrupt: () => {
      abortResidentAgent(host, turn);
      return host.builderFallbackRecoveries.has(turn.turnId)
        ? host.quiesceCurrentAgentSession(turn)
        : host.terminateCurrentAgentSession(turn);
    },
    // createSession() may ignore AbortSignal and resolve after the immediate
    // destroy. Sweep again after the underlying turn promise has unwound so
    // Stop can never ACK while that late session/container remains live.
    afterInterrupt: () => {
      abortResidentAgent(host, turn);
      return host.builderFallbackRecoveries.has(turn.turnId)
        ? host.quiesceCurrentAgentSession(turn)
        : host.terminateCurrentAgentSession(turn);
    },
  });
  host.agentTurnExecutions.set(turn.turnId, execution);
  const tracked = host.trackTurn(turn.turnId, execution.settled);
  const clear = () => {
    if (host.agentTurnExecutions.get(turn.turnId) === execution) {
      host.agentTurnExecutions.delete(turn.turnId);
    }
  };
  void tracked.then(clear, clear);
  return tracked;
};

const abortResidentAgent = (host: AdmissionHost, turn: TurnRequest): void => {
  const abort = host.residentAgentAborts.get(turn.turnId);
  if (!abort) return;
  try {
    abort();
  } catch (error) {
    log("error", "resident_agent_abort_failed", {
      turnId: turn.turnId,
      message: errorMessage(error),
    });
  }
};

export const startAppTurn = (
  host: AdmissionHost,
  turn: TurnRequest,
): Promise<Response> => {
  const existing = host.appTurnExecutions.get(turn.turnId);
  if (existing) return existing.settled;
  const execution = startTurnExecution({
    work: (context) => host.runTurn(turn, context),
    // A pending platform createSession may materialize after the first
    // destroy. Interrupt closes the local admission latch; the second sweep
    // runs only after the underlying app-turn promise has unwound.
    onInterrupt: () => host.terminateCurrentAgentSession(turn),
    afterInterrupt: () => host.terminateCurrentAgentSession(turn),
  });
  host.appTurnExecutions.set(turn.turnId, execution);
  const tracked = host.trackTurn(turn.turnId, execution.settled);
  const clear = () => {
    if (host.appTurnExecutions.get(turn.turnId) === execution) {
      host.appTurnExecutions.delete(turn.turnId);
    }
  };
  void tracked.then(clear, clear);
  return tracked;
};

export const admittedResidentPlacement = async (
  host: AdmissionHost,
  turn: TurnRequest,
): Promise<boolean> => {
  if (
    turn.kind !== "agent" ||
    !Number.isSafeInteger(turn.attemptGeneration) ||
    turn.attemptGeneration! < 1
  ) {
    return false;
  }
  const identity = {
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
  };
  const admitted = parseTurnComputePlan(
    await host.ctx.storage.get(
      turnComputePlanKey(identity.turnId, identity.attemptGeneration),
    ),
    identity,
  );
  return admitted?.plan.kind === "resident_stella";
};

const admittedComputePlan = (
  host: AdmissionHost,
  turn: TurnRequest,
): TurnComputePlan | undefined => {
  if (!turn.execution || !Number.isSafeInteger(turn.attemptGeneration)) {
    return undefined;
  }
  return turnComputePlan({
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    execution: turn.execution,
    browserResume: turn.browserResume !== undefined,
    // D1: resident is the default for Stella. An operator turns the ladder
    // off by setting this to "0", which demotes every Stella turn to the
    // eager container path without touching the loop.
    residentDisabled: host.env.RESIDENT_GENERAL_AGENT_TURNS === "0",
    now: Date.now(),
  });
};

export const admitAgentTurnThroughOwnerGate = async (
  host: AdmissionHost,
  turn: TurnRequest,
): Promise<
  { ok: true; snapshot: OwnerSnapshot } | { ok: false; response: Response }
> => {
  const gate = host.ownerGateFor(turn.ownerId);
  let snapshot: OwnerSnapshot;
  if (turn.gateAdmittedByCaller) {
    try {
      snapshot = await gate.snapshot();
    } catch (error) {
      log("error", "agent_turn_snapshot_unavailable", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
      return {
        ok: false,
        response: json(
          {
            error: "Stella can't check your plan right now. Try again shortly.",
          },
          503,
        ),
      };
    }
    if (snapshot.ownerGeneration !== turn.ownerGeneration) {
      return {
        ok: false,
        response: json(
          { error: "This cloud owner generation is no longer current." },
          409,
        ),
      };
    }
    if (snapshot.enforcement?.status === "suspended") {
      return {
        ok: false,
        response: Response.json(
          {
            error: "This account can't use Stella's cloud right now.",
            code: "owner_suspended",
            retryable: false,
          },
          { status: 403, headers: { "cache-control": "no-store" } },
        ),
      };
    }
    if (!snapshot.writable) {
      return {
        ok: false,
        response: json(
          { error: "This account's cloud data is no longer available." },
          410,
        ),
      };
    }
    if (snapshot.isAnonymous) {
      return {
        ok: false,
        response: Response.json(
          {
            error: "Sign in to Stella to use cloud agents.",
            code: "sign_in_required",
            retryable: false,
          },
          { status: 403, headers: { "cache-control": "no-store" } },
        ),
      };
    }
  } else {
    const admission = await gate.admit({
      lane: "agent",
      turnId: turn.turnId,
      conversationId: turn.conversationId ?? "",
      expectedGeneration: turn.ownerGeneration,
    });
    if (!admission.ok) {
      return {
        ok: false,
        response: Response.json(
          {
            error: admission.message,
            code: admission.code,
            retryable: admission.retryable,
            ...(admission.retryAfterMs !== undefined
              ? { retryAfterMs: admission.retryAfterMs }
              : {}),
          },
          {
            status: OWNER_GATE_REFUSAL_STATUS[admission.code],
            headers: { "cache-control": "no-store" },
          },
        ),
      };
    }
    snapshot = admission.snapshot;
  }
  if (
    turn.execution &&
    !snapshotAllowsExecutionEngine(snapshot, turn.execution.engine)
  ) {
    if (!turn.gateAdmittedByCaller) await host.releaseOwnerGate(turn);
    return {
      ok: false,
      response: json(
        {
          error:
            turn.execution.engine === "anthropic"
              ? "Connect Claude before using that cloud execution route."
              : "Connect ChatGPT before using that cloud execution route.",
        },
        409,
      ),
    };
  }
  // The snapshot is the authority for both, overriding the dispatcher.
  turn.audience = snapshot.allowance.audience;
  turn.budgetMicroCents = snapshot.allowance.budgetMicroCents;
  try {
    // Both capabilities for this attempt, from the same admitted facts. The
    // control-plane half is cached here because it never leaves the object;
    // the model half is re-minted when the attempt actually starts, so its
    // 30-minute lifetime covers the run rather than the wait before it.
    const minted = await mintTurnCapabilities(host.env, {
      ownerId: turn.ownerId,
      ownerGeneration: turn.ownerGeneration,
      turnId: turn.turnId,
      conversationId: turn.conversationId ?? "",
      execution: turn.execution!,
      audience: turn.audience,
      budgetMicroCents: turn.budgetMicroCents,
      agentTypes: ["general"],
    });
    host.controlPlaneCapabilities.set(
      `${turn.turnId}:${turn.attemptGeneration ?? 1}`,
      {
        token: minted.controlPlane.token,
        expiresAt: minted.controlPlane.expiresAt,
      },
    );
  } catch (error) {
    if (!turn.gateAdmittedByCaller) await host.releaseOwnerGate(turn);
    log("error", "agent_turn_capability_mint_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      message: errorMessage(error),
    });
    return {
      ok: false,
      response: json(
        { error: "Stella can't authorize this agent right now. Try again." },
        503,
      ),
    };
  }
  return { ok: true, snapshot };
};

export const agentTurnAccepted = (
  host: AdmissionHost,
  turn: TurnRequest,
  replayed: boolean,
  extra: Record<string, unknown> = {},
): Response => {
  const body: CloudAgentTurnStartResponse = {
    protocol: TURN_PLANE_PROTOCOL,
    threadId: turn.threadId ?? "",
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration ?? 1,
    accepted: true,
    replayed,
  };
  return json({ ...body, ...extra }, 202);
};

const projectAgentTurnStart = async (
  host: AdmissionHost,
  turn: TurnRequest,
): Promise<void> => {
  const attemptGeneration = turn.attemptGeneration ?? 1;
  const createdAt = Date.now();
  const source = CLOUD_TURN_SOURCES.includes(turn.source as CloudTurnSource)
    ? (turn.source as CloudTurnSource)
    : undefined;
  const events: OutboxEvent[] = [
    {
      ...host.outboxBase(turn, turn.turnId),
      kind: "turn.started",
      turnId: turn.turnId,
      turnKind: "agent",
      conversationId: turn.conversationId ?? "",
      sessionId: turn.threadId ?? "",
      lane: "agent",
      ...(source ? { source } : {}),
      ...(turn.clientMsgId ? { clientMsgId: turn.clientMsgId } : {}),
      threadId: turn.threadId ?? "",
      attemptGeneration,
      agentType: "general",
      execution: turn.execution!,
      prompt: turn.prompt,
      createdAt,
    } satisfies TurnStartedEvent,
  ];
  if (attemptGeneration === 1 && !turn.gateAdmittedByCaller) {
    events.push({
      ...host.outboxBase(turn, `${turn.threadId}:${attemptGeneration}`),
      kind: "thread.spawned",
      threadId: turn.threadId ?? "",
      conversationId: turn.conversationId ?? "",
      parentTurnId: turn.parentTurnId ?? turn.turnId,
      ...(turn.parentThreadId ? { parentThreadId: turn.parentThreadId } : {}),
      agentDepth: turn.agentDepth,
      attemptGeneration,
      description: turn.description ?? "",
      prompt: turn.prompt,
      execution: turn.execution!,
      placement: "cloud",
      ...(turn.originDeviceId ? { originDeviceId: turn.originDeviceId } : {}),
      ...(turn.originConversationId
        ? { originConversationId: turn.originConversationId }
        : {}),
      createdAt,
    } satisfies ThreadSpawnedEvent);
  }
  await host.enqueueOutboxDurable(events);
};

export const acceptAgentTurn = async (
  host: AdmissionHost,
  turn: TurnRequest,
): Promise<Response> => {
  type Admission =
    | { response: Response }
    | {
        kind: "pre_canceled";
        cancellation: ExactTurnCancellation;
        ownsStorage: boolean;
      }
    | {
        kind: "start";
        sandboxId?: string;
        orphan?: PendingTerminal;
        orphanTurn?: TurnRequest;
      };
  const sharedWorldSandboxId = await worldSandboxId(turn.ownerId);
  const admission = await host.ctx.blockConcurrencyWhile(
    async (): Promise<Admission> => {
      const current = await host.ctx.storage.get<TurnRequest>("turn");
      if (current?.kind === "agent") {
        const exactReplay = exactTurnIdentityMatches(current, turn);
        if (current.turnId !== turn.turnId) {
          const currentCancellation =
            await host.exactTurnCancellations.matching({
              turnId: current.turnId,
              ownerId: current.ownerId,
              ownerGeneration: current.ownerGeneration,
              attemptGeneration: current.attemptGeneration,
            });
          if (currentCancellation?.state === "pending") {
            return {
              response: json(
                {
                  accepted: false,
                  reason: "cancellation_join_pending",
                  currentTurnId: current.turnId,
                },
                409,
              ),
            };
          }
        }
        const currentAttempt = current.attemptGeneration;
        const [executionMarker, fallbackJournal, observedSuspension] =
          Number.isSafeInteger(currentAttempt)
            ? await Promise.all([
                host.ctx.storage.get<AgentExecutionMarker>(
                  agentExecutionMarkerKey(current.turnId, currentAttempt!),
                ),
                host.ctx.storage.get<BuilderFallbackTranscript>(
                  builderFallbackTranscriptKey(current.turnId, currentAttempt!),
                ),
                host.ctx.storage.get<ObservedBrowserSuspension>(
                  OBSERVED_BROWSER_SUSPENSION_KEY,
                ),
              ])
            : [undefined, undefined, undefined];
        const pendingBrowserSuspension =
          await host.ctx.storage.get<PendingBrowserSuspension>(
            PENDING_BROWSER_SUSPENSION_KEY,
          );
        const locallyRunning = host.agentTurnExecutions.has(current.turnId);
        if (
          locallyRunning ||
          executionMarker ||
          fallbackJournal ||
          observedSuspension ||
          pendingBrowserSuspension
        ) {
          if (!locallyRunning) {
            await host.ctx.storage.setAlarm(Date.now() + 1_000);
          }
          return {
            response: exactReplay
              ? host.agentTurnAccepted(turn, true, {
                  recovering: !locallyRunning,
                })
              : json(
                  {
                    accepted: false,
                    reason: "previous_turn_recovering",
                    currentTurnId: current.turnId,
                  },
                  409,
                ),
          };
        }
      }
      const cancellation = await host.exactTurnCancellations.matching({
        turnId: turn.turnId,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        attemptGeneration: turn.attemptGeneration,
      });
      if (cancellation) {
        const ownsStorage = !current || current.turnId === turn.turnId;
        if (ownsStorage && cancellation.state === "pending") {
          await host.ctx.storage.put({
            turn,
            turnId: turn.turnId,
            terminal: false,
            terminalDelivered: false,
            alarmAttempts: 0,
            alarmReconcile: false,
          });
        }
        return {
          kind: "pre_canceled",
          cancellation,
          ownsStorage,
        };
      }
      const computePlan = admittedComputePlan(host, turn);
      const resident = computePlan?.plan.kind === "resident_stella";
      // A resident turn still starts without compute. If it attaches, it
      // uses the same owner-world container as the eager path.
      const sandboxId = resident ? undefined : sharedWorldSandboxId;
      // A predecessor whose terminal state never reached Convex left it
      // here. Taking over the DO takes the alarm with it, so this is its last
      // chance; the stale delivery below cannot mutate this successor.
      const orphan =
        await host.ctx.storage.get<PendingTerminal>("pendingTerminal");
      const orphanTurn = orphan
        ? await host.ctx.storage.get<TurnRequest>("turn")
        : undefined;
      await host.ctx.storage.put({
        ...(sandboxId ? { sandboxId } : {}),
        ...(computePlan
          ? {
              [turnComputePlanKey(turn.turnId, turn.attemptGeneration!)]:
                computePlan,
            }
          : {}),
        turn,
        turnId: turn.turnId,
        terminal: false,
        terminalDelivered: false,
        alarmAttempts: 0,
        alarmReconcile: false,
      });
      await host.ctx.storage.delete([
        "pendingTerminal",
        PENDING_BROWSER_SUSPENSION_KEY,
        OBSERVED_BROWSER_SUSPENSION_KEY,
        AGENT_RECOVERY_PENDING_KEY,
      ]);
      return {
        kind: "start",
        ...(sandboxId ? { sandboxId } : {}),
        orphan,
        orphanTurn,
      };
    },
  );
  if ("response" in admission) {
    await host.unregisterTurn(turn);
    // A refusal gives the slot straight back; an accepted replay keeps it,
    // because the attempt it names is still the one running.
    if (!admission.response.ok) await host.releaseOwnerGate(turn);
    return admission.response;
  }
  if (admission.kind === "pre_canceled") {
    if (admission.cancellation.state === "pending") {
      const delivered = await host.deliverTerminal(turn, {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
        kind: "canceled",
        payload: { message: "Stopped. Nothing was changed." },
        threadError: "The agent was stopped.",
      });
      if (delivered) {
        if (
          !(await host.acknowledgeExactAgentTurnCancellation(
            admission.cancellation,
          ))
        ) {
          await host.unregisterTurn(turn);
          return json(
            {
              accepted: false,
              canceled: true,
              reason: "cancellation_acknowledgement_lost",
            },
            503,
          );
        }
        if (admission.ownsStorage && (await host.ownsExactTurn(turn))) {
          await host.deleteTurnStoragePreservingExactCancellations(turn, true);
        }
      }
    }
    await host.unregisterTurn(turn);
    await host.releaseOwnerGate(turn);
    return host.agentTurnAccepted(turn, false, {
      canceled: true,
      preAdmission: true,
      durable: true,
    });
  }
  const { orphan, orphanTurn } = admission;
  const { sandboxId } = admission;
  if (
    orphan &&
    orphanTurn &&
    orphan.turnId === orphanTurn.turnId &&
    orphan.turnId !== turn.turnId
  ) {
    host.ctx.waitUntil(
      host
        .trackTurn(orphanTurn.turnId, host.redeliverOrphan(orphanTurn, orphan))
        .catch(() => undefined),
    );
  }
  const watchdogDeadlineAt =
    Date.now() + Math.max(1_000, turn.watchdogMs ?? 15 * 60_000);
  await host.mutateExactTurn(turn, async (txn) => {
    await txn.put(AGENT_WATCHDOG_DEADLINE_KEY, watchdogDeadlineAt);
    await txn.setAlarm(
      Math.min(watchdogDeadlineAt, Date.now() + AGENT_TURN_HEARTBEAT_MS),
    );
  });
  // Projected before the run starts: Convex has to know the attempt exists
  // even if this isolate dies in the next millisecond, and the outbox is
  // ordered behind a durable debt if the queue refuses.
  await projectAgentTurnStart(host, turn);
  host.ctx.waitUntil(
    host.startAgentTurn(turn, sandboxId).catch(() => undefined),
  );
  return host.agentTurnAccepted(turn, false);
};

export const runAgentTurn = async (
  host: AdmissionHost,
  turn: TurnRequest,
  sandboxId: string | undefined,
  execution: TurnExecutionContext,
): Promise<void> => {
  const identity = {
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration ?? 0,
  };
  const admitted = parseTurnComputePlan(
    await host.ctx.storage.get(
      turnComputePlanKey(identity.turnId, identity.attemptGeneration),
    ),
    identity,
  );
  await runGeneralAgentTurn({
    plan:
      admitted?.plan ??
      ({
        kind: "native_sandbox",
        ...(turn.execution ? { execution: turn.execution } : {}),
        reason: "unplaced",
      } as const),
    context: execution,
    resident: (plan) => host.runResidentAgentTurn(turn, plan, execution),
    native: async () => {
      // Admission mints the id for every plan that keeps the container
      // path, so an absent one here means this isolate is running a turn
      // whose reservation another attempt owns.
      if (!sandboxId) throw new AgentTurnAuthorityLostError();
      await host.runContainerAgentTurn(turn, sandboxId, execution);
    },
  });
};
