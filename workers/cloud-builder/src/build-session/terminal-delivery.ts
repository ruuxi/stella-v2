import { Effect } from "effect";
import { isCloudBrowserSuspension } from "@stella/contracts/cloud-browser";
import type { ThreadCompletedEvent } from "@stella/contracts/turn-plane/outbox";
import {
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
  TURN_PROMPT_MAX_CHARS,
  type CloudTurnStartRequest,
} from "@stella/contracts/turn-plane/turn-start";
import { runToolEffect } from "@stella/runtime/kernel/tools/effect-runtime.js";
import {
  rememberCloudAgentControlReceipt,
  steerCloudAgent,
} from "../cloud-agent-dispatch.js";
import { HEADER_OWNER } from "../conversation-hub.js";
import { worldName } from "../workspace.js";
import type { WorldListingEntry } from "../world/types.js";
import type {
  ExactTurnCancellation,
  ExactTurnCancellationRequest,
} from "../execution-placement-turn-cancellation.js";
import {
  SandboxLifecycleDeferredError,
  sandboxLifecycleFailureFields,
} from "../sandbox-lifecycle.js";
import { SteerMailbox, parseSteerMessage } from "../steer-mailbox.js";
import {
  nextTurnEventSeq,
  purgeThreadTranscript,
} from "../thread-transcript.js";
import { HEADER_TURN_AUTH_KIND } from "../turn-start-request.js";
import type { BuildSessionInternals } from "./host.js";
import {
  AGENT_WATCHDOG_DEADLINE_KEY,
  HEADER_CONVERSATION_ID,
  OBSERVED_BROWSER_SUSPENSION_KEY,
  ORCHESTRATOR_INTERNAL_ORIGIN,
  OWNER_PURGE_STALE_LEASE_GRACE_MS,
  PENDING_BROWSER_SUSPENSION_KEY,
  errorMessage,
  exactTurnIdentityMatches,
  json,
  log,
} from "./shared/keys.js";
import { OwnerPurgeFenceError } from "./shared/errors.js";
import type {
  PendingBrowserSuspension,
  PendingTerminal,
  TurnRequest,
} from "./shared/types.js";

export type TerminalDeliveryHost = Pick<
  BuildSessionInternals,
  | "ctx"
  | "env"
  | "runningTurns"
  | "appTurnExecutions"
  | "agentTurnExecutions"
  | "exactTurnCancellations"
  | "acknowledgeExactAgentTurnCancellation"
  | "assertTurnWritable"
  | "claimTerminalDecision"
  | "cleanupTransientWrites"
  | "currentSandboxTarget"
  | "deleteTurnStoragePreservingExactCancellations"
  | "deliverTerminal"
  | "destroySandboxDurably"
  | "enqueueOutboxDurable"
  | "event"
  | "mutateExactTurn"
  | "outboxBase"
  | "ownsExactTurn"
  | "registerTurn"
  | "releaseOwnerGate"
  | "runAlarmWithLease"
  | "setExactTurnAlarm"
  | "settleAgentTransientBackup"
  | "terminateCurrentAgentSession"
  | "unregisterTurnLease"
  | "wakeParentAgentOrConversation"
  | "wakeParentConversation"
>;

/**
 * Atomically claim this DO's one terminal decision. Cancel, timeout and the
 * normal process unwind are separate async paths; a read-then-write fence
 * lets the loser overwrite the winner between awaits.
 */
export const claimTerminalDecision = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  pending: PendingTerminal,
  alarmAt?: number,
): Promise<boolean> => {
  return await host.ctx.storage.transaction(async (txn) => {
    const [currentTurn, terminalAlreadyDecided, decided] = await Promise.all([
      txn.get<TurnRequest>("turn"),
      txn.get<boolean>("terminal"),
      txn.get<PendingTerminal>("pendingTerminal"),
    ]);
    if (!exactTurnIdentityMatches(currentTurn, turn)) return false;
    if (
      terminalAlreadyDecided &&
      (!decided ||
        decided.turnId !== pending.turnId ||
        decided.kind !== pending.kind ||
        decided.eventKind !== pending.eventKind)
    ) {
      return false;
    }
    await txn.put({
      terminal: true,
      pendingTerminal: pending,
      alarmAttempts: 0,
    });
    await txn.delete(PENDING_BROWSER_SUSPENSION_KEY);
    await txn.delete(OBSERVED_BROWSER_SUSPENSION_KEY);
    if (alarmAt !== undefined) {
      await txn.setAlarm(alarmAt);
    }
    return true;
  });
};

/**
 * Decide a turn's terminal state and get it to Convex, durably.
 *
 * Delivery is two callbacks — the terminal event, then the thread's final
 * state — and either can fail on a transient Convex 5xx. Both are recorded
 * in DO storage before the first attempt and retried by a re-armed alarm:
 * the success path used to throw straight into the failure handler, which
 * reported "The agent hit a problem and stopped" over a completed,
 * checkpointed turn and discarded the agent's report with it.
 *
 * Redelivery is safe: Convex rejects every event after the first terminal
 * one (answering `terminalAccepted: false` rather than an error) and the
 * thread mutation is a no-op once the thread is terminal, so a retry can
 * never produce a second terminal state.
 *
 * Returns whether the state is known to have landed; storage (and its
 * alarm) must stay intact when it has not.
 */
export const deliverTerminal = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  pendingInput: PendingTerminal,
  options: { preservePendingTerminal?: boolean } = {},
): Promise<boolean> => {
  let pending = pendingInput;
  // Fencing: a stale turn may still deliver its own outcome (Convex sorts
  // out which one is terminal), but it must not write over the successor's
  // storage or arm the successor's alarm.
  const owns = await host.ownsExactTurn(turn);
  // The second callback is *thread*-scoped, and the only thing that fences
  // it Convex-side is the thread not being "running" — which a successor
  // continuation has just undone. So a stale payload replayed here (the
  // orphan in acceptAgentTurn) would complete the thread out from under the
  // turn now running on it: the user is told the agent stopped, and the
  // live turn's own report is later dropped as a duplicate. Read the
  // successor once, before either callback, so a mid-delivery takeover
  // cannot flip the decision halfway through.
  const successor = owns
    ? undefined
    : await host.ctx.storage.get<TurnRequest>("turn");
  const supersededThread =
    successor !== undefined &&
    !exactTurnIdentityMatches(successor, turn) &&
    successor.threadId === turn.threadId;
  if (
    (turn.kind === "agent" &&
      (!Number.isSafeInteger(turn.attemptGeneration) ||
        pending.attemptGeneration !== turn.attemptGeneration)) ||
    (turn.kind !== "agent" && pending.attemptGeneration !== 1)
  ) {
    log("error", "terminal_attempt_generation_mismatch", {
      turnId: turn.turnId,
      pendingAttemptGeneration: pending.attemptGeneration,
      turnAttemptGeneration: turn.attemptGeneration,
    });
    return false;
  }
  // Both are fixed before the decision is claimed, so a redelivery repeats
  // the same event ordinal and the same wake fingerprint instead of minting
  // new ones the control plane would have to reconcile.
  const decided: PendingTerminal = {
    ...pending,
    eventSeq:
      pending.eventSeq ??
      nextTurnEventSeq(
        host.ctx.storage.sql,
        turn.turnId,
        turn.attemptGeneration ?? 1,
      ),
    completedAt: pending.completedAt ?? Date.now(),
  };
  pending = decided;
  if (owns) {
    if (!(await host.claimTerminalDecision(turn, decided))) {
      const current =
        await host.ctx.storage.get<PendingTerminal>("pendingTerminal");
      log("info", "terminal_decision_superseded", {
        turnId: turn.turnId,
        attemptedKind: pending.kind,
        decidedKind: current?.kind,
      });
      return false;
    }
  }
  try {
    // Turn-scoped and unconditional: this is what gives the turn — orphaned
    // or not — its one terminal state, and Convex rejects a second one.
    await host.event(
      turn,
      pending.eventSeq ?? "auto",
      pending.eventKind ?? pending.kind,
      pending.payload,
      true,
    );
    if (turn.kind === "agent" && turn.threadId) {
      if (supersededThread) {
        log("info", "terminal_thread_completion_skipped", {
          turnId: turn.turnId,
          threadId: turn.threadId,
          kind: pending.kind,
        });
      } else {
        const finalText =
          typeof pending.payload.finalText === "string"
            ? pending.payload.finalText
            : "";
        const completedAt = pending.completedAt ?? Date.now();
        const resultJson =
          pending.kind === "completed"
            ? JSON.stringify({ finalText })
            : undefined;
        const errorMessage =
          pending.kind === "completed"
            ? undefined
            : (pending.threadError ?? "The agent stopped.");
        await host.enqueueOutboxDurable([
          {
            ...host.outboxBase(
              turn,
              `${turn.threadId}:${turn.turnId}:${turn.attemptGeneration ?? 1}`,
            ),
            kind: "thread.completed",
            threadId: turn.threadId,
            turnId: turn.turnId,
            attemptGeneration: turn.attemptGeneration ?? 1,
            status: pending.kind,
            ...(resultJson ? { resultJson } : {}),
            ...(errorMessage ? { errorMessage } : {}),
            completedAt,
          } satisfies ThreadCompletedEvent,
        ]);
        // The projection above is how the UI learns the thread ended; it is
        // NOT how the parent conversation learns. Convex used to do both in
        // one mutation, so the wake rode on the callback's latency and its
        // retry ladder. The parent session lives one Durable Object away, so
        // it is woken directly and the outbox stays a pure projection.
        await host.wakeParentAgentOrConversation(turn, {
          status: pending.kind,
          threadUpdatedAt: completedAt,
          ...(resultJson ? { resultJson } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        });
      }
    }
    if (owns) {
      await host.ctx.storage.transaction(async (txn) => {
        if (
          !exactTurnIdentityMatches(await txn.get<TurnRequest>("turn"), turn)
        ) {
          return;
        }
        await txn.put("terminalDelivered", true);
        if (!options.preservePendingTerminal) {
          await txn.delete("pendingTerminal");
        }
      });
    }
    // The owner's agent slot goes back the moment the outcome is durable —
    // every terminal path (normal unwind, watchdog, cancel, recovery)
    // funnels through here, so this is the one release that matters.
    await host.releaseOwnerGate(turn);
    return true;
  } catch (error) {
    log("error", "terminal_delivery_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      kind: pending.kind,
      message: errorMessage(error),
    });
    if (!owns) return false;
    // No exponential ladder any more: delivery is an outbox append plus a
    // Durable Object call, both of which fail fast and locally. The one
    // fixed retry exists so a queue outage or a parent object that is
    // briefly unavailable does not strand a decided terminal.
    let attempts = 0;
    const retained = await host.ctx.storage.transaction(async (txn) => {
      if (!exactTurnIdentityMatches(await txn.get<TurnRequest>("turn"), turn)) {
        return false;
      }
      attempts = ((await txn.get<number>("alarmAttempts")) ?? 0) + 1;
      await txn.put("alarmAttempts", attempts);
      await txn.setAlarm(Date.now() + 30_000);
      return true;
    });
    if (!retained) return false;
    if (attempts === 6 || attempts % 20 === 0) {
      log("error", "terminal_delivery_still_retrying", {
        turnId: turn.turnId,
        attempts,
        message: errorMessage(error),
      });
    }
    return false;
  }
};

const agentCompletionText = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  completion: {
    status: "completed" | "failed" | "canceled";
    resultJson?: string;
    errorMessage?: string;
  },
): Promise<string> => {
  let resultText = completion.errorMessage ?? "";
  if (completion.resultJson) {
    try {
      const parsed = JSON.parse(completion.resultJson) as {
        finalText?: unknown;
      };
      resultText =
        typeof parsed.finalText === "string" && parsed.finalText.trim()
          ? parsed.finalText
          : completion.resultJson;
    } catch {
      resultText = completion.resultJson;
    }
  }
  const label =
    completion.status === "completed"
      ? "[Agent completed]"
      : completion.status === "canceled"
        ? "[Agent canceled]"
        : "[Agent failed]";
  const description = turn.description?.trim() || turn.threadId;
  let forkText = "";
  if (turn.workspaceForkId) {
    const world = host.env.WORLDS.getByName(await worldName(turn.ownerId));
    const status = await world.forkStatus(turn.workspaceForkId);
    let changedPaths: string[] = [];
    if (status.baseManifestId) {
      const baseEntries: WorldListingEntry[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await world.manifest(status.baseManifestId, {
          ...(cursor ? { cursor } : {}),
          limit: 10_000,
        });
        if (!page) break;
        baseEntries.push(...page.entries);
        if (!page.cursor) break;
        cursor = page.cursor;
      }
      const delta = await world.diff(baseEntries, {
        fork: turn.workspaceForkId,
      });
      changedPaths = [...new Set([...delta.changed, ...delta.deleted])]
        .sort()
        .slice(0, 50);
    } else {
      changedPaths = (
        await world.list("", { fork: turn.workspaceForkId, limit: 50 })
      ).entries.map((entry) => entry.path);
    }
    forkText = `\n\nforkStatus: ${JSON.stringify({
      forkId: turn.workspaceForkId,
      changedSinceBase: status.changedSinceBase,
      changedPaths,
    })}`;
  }
  const heading = `${label} ${description} (thread ${turn.threadId})\n\n`;
  const bodyLimit = Math.max(
    0,
    TURN_PROMPT_MAX_CHARS - heading.length - forkText.length,
  );
  return `${heading}${(resultText || "No result was reported.").slice(0, bodyLimit)}${forkText}`;
};

export const wakeParentAgentOrConversation = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  completion: {
    status: "completed" | "failed" | "canceled";
    threadUpdatedAt: number;
    resultJson?: string;
    errorMessage?: string;
  },
): Promise<void> => {
  if (turn.parentThreadId && turn.threadId) {
    const steered = await steerCloudAgent({
      env: host.env,
      threadId: turn.parentThreadId,
      message: {
        id: `wake:${turn.threadId}:${turn.attemptGeneration ?? 1}`.slice(
          0,
          256,
        ),
        kind:
          completion.status === "completed"
            ? "child_completed"
            : completion.status === "canceled"
              ? "child_canceled"
              : "child_failed",
        text: await agentCompletionText(host, turn, completion),
        threadId: turn.threadId,
        attemptGeneration: turn.attemptGeneration ?? 1,
        createdAt: completion.threadUpdatedAt,
      },
    });
    if (steered.accepted) return;
  }
  await host.wakeParentConversation(turn, completion);
};

/**
 * Wake the conversation that spawned this thread with the agent's report.
 *
 * This is the one delivery a projection cannot do: the parent needs a turn,
 * not a row. It used to be a Convex mutation reached through the thread
 * completion callback, which meant the report's latency was the control
 * plane's and a lost callback lost the wake. The parent's Durable Object is
 * one hop away, so it is called directly with exactly the trusted headers
 * the public turn-start route stamps after it verifies a service caller.
 *
 * `clientMsgId` is derived from the thread and its attempt, and every field
 * the parent fingerprints (prompt, lane, source, hiddenMessage, control
 * receipt) is fixed with the terminal decision — so a redelivery is admitted
 * as a replay rather than refused as a different message under the same id.
 *
 * Desktop-origin threads are delivered by the originating device's own
 * subscription to Convex's projection; waking here as well would put the
 * same report in two orchestrators. The dispatcher always sets
 * `originConversationId` alongside `originDeviceId`.
 */
export const wakeParentConversation = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  completion: {
    status: "completed" | "failed" | "canceled";
    threadUpdatedAt: number;
    resultJson?: string;
    errorMessage?: string;
  },
): Promise<void> => {
  const conversationId = turn.conversationId?.trim() ?? "";
  if (turn.kind !== "agent" || !turn.threadId || !conversationId) return;
  if (turn.originDeviceId) {
    log("info", "thread_wake_skipped_desktop_origin", {
      threadId: turn.threadId,
      turnId: turn.turnId,
    });
    return;
  }
  const body: CloudTurnStartRequest = {
    protocol: TURN_PLANE_PROTOCOL,
    clientMsgId: `wake:${turn.threadId}:${turn.attemptGeneration ?? 1}`.slice(
      0,
      64,
    ),
    prompt: await agentCompletionText(host, turn, completion),
    lane: "wake",
    source: "agent-thread",
    hiddenMessage: true,
    agentThreadControl: {
      threadId: turn.threadId,
      attemptGeneration: turn.attemptGeneration ?? 1,
      threadUpdatedAt: completion.threadUpdatedAt,
      status: completion.status,
    },
  };
  const response = await host.env.ORCHESTRATOR_SESSIONS.getByName(
    conversationId,
  ).fetch(`${ORCHESTRATOR_INTERNAL_ORIGIN}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HEADER_OWNER]: turn.ownerId,
      [HEADER_TURN_AUTH_KIND]: "service",
      [HEADER_CONVERSATION_ID]: conversationId,
      [TURN_OWNER_GENERATION_HEADER]: turn.ownerGeneration,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Agent completion wake was refused (${response.status}).`);
  }
  await response.body?.cancel().catch(() => undefined);
};

/** Project a nonterminal human wait without keeping an executor alive. */
export const deliverBrowserSuspension = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  pending: PendingBrowserSuspension,
): Promise<boolean> => {
  if (
    pending.turnId !== turn.turnId ||
    pending.attemptGeneration !== turn.attemptGeneration ||
    !isCloudBrowserSuspension(pending.suspension)
  ) {
    return false;
  }
  try {
    await host.event(turn, "auto", "waiting_for_user", pending.payload, false);
    return true;
  } catch (error) {
    log("error", "browser_suspension_delivery_failed", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      interactionId: pending.suspension.interactionId,
      message: errorMessage(error),
    });
    await host.setExactTurnAlarm(turn, Date.now() + 30_000);
    return false;
  }
};

/**
 * Fail a turn whose executor was lost and whose report cannot be recovered.
 * The exact terminal decision is claimed first, then the container is torn
 * down, then the terminal is delivered; a step that cannot complete re-arms
 * the alarm instead of leaving the thread without a terminal.
 */
export const deliverExecutorLossTerminal = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  text: { message: string; threadError: string },
): Promise<void> => {
  const recoveredPending: PendingTerminal = {
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    kind: "failed",
    payload: { message: text.message, reason: "executor_recovered" },
    threadError: text.threadError,
    terminateSandbox: true,
  };
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
  try {
    await host.terminateCurrentAgentSession(turn);
  } catch (error) {
    if (!(error instanceof SandboxLifecycleDeferredError)) {
      log("error", "recovered_agent_sandbox_termination_deferred", {
        turnId: turn.turnId,
        threadId: turn.threadId,
        message: errorMessage(error),
      });
      return;
    }
    log("error", "recovered_agent_sandbox_termination_deferred", {
      turnId: turn.turnId,
      threadId: turn.threadId,
      ...sandboxLifecycleFailureFields(error),
    });
  }
  const delivered = await host.deliverTerminal(turn, {
    ...recoveredPending,
    terminateSandbox: false,
  });
  if (delivered && (await host.ownsExactTurn(turn))) {
    if (await host.settleAgentTransientBackup(turn)) {
      await host.deleteTurnStoragePreservingExactCancellations(turn, true);
    } else {
      await host.setExactTurnAlarm(turn, Date.now() + 30_000);
    }
  }
};

export const handleSteer = async (
  host: TerminalDeliveryHost,
  request: Request,
): Promise<Response> => {
  const message = parseSteerMessage(await request.json().catch(() => null));
  if (!message) return json({ error: "Invalid steer message." }, 400);
  return await host.ctx.blockConcurrencyWhile(async () => {
    const [turn, terminal] = await Promise.all([
      host.ctx.storage.get<TurnRequest>("turn"),
      host.ctx.storage.get<boolean>("terminal"),
    ]);
    if (
      !turn ||
      turn.kind !== "agent" ||
      !turn.threadId ||
      terminal !== false ||
      !Number.isSafeInteger(turn.attemptGeneration)
    ) {
      return json({ accepted: false, reason: "not_running" }, 409);
    }
    const mailbox = SteerMailbox.open(host.ctx.storage.sql);
    const result = mailbox.append(
      {
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration!,
      },
      message,
    );
    if (result === "conflict") {
      return json({ accepted: false, reason: "idempotency_conflict" }, 409);
    }
    if (result === "full") {
      return json({ accepted: false, reason: "mailbox_full" }, 503);
    }
    if (message.kind !== "input") {
      await rememberCloudAgentControlReceipt(host.ctx.storage, {
        threadId: message.threadId,
        attemptGeneration: message.attemptGeneration,
        threadUpdatedAt: message.createdAt,
        status:
          message.kind === "child_completed"
            ? "completed"
            : message.kind === "child_canceled"
              ? "canceled"
              : "failed",
      });
    }
    return json({
      accepted: true,
      turnId: turn.turnId,
      attemptGeneration: turn.attemptGeneration,
    });
  });
};

/**
 * Operator-only: expire the current agent turn now instead of at its
 * watchdog. Nothing here delivers a terminal directly. The watchdog deadline
 * is moved to now, a hung local fiber gets the bounded interrupt a Stop
 * would, and the alarm is re-armed so
 * the ordinary timeout path (which tolerates a container that will not die)
 * fails the thread. The optional body names the exact turn the operator
 * looked at, so a stale request cannot expire a successor.
 */
export const expireCurrentAgentTurn = async (
  host: TerminalDeliveryHost,
  request: Request,
): Promise<Response> => {
  const raw = (await request.json().catch(() => null)) as unknown;
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const turn = await host.ctx.storage.get<TurnRequest>("turn");
  if (
    !turn ||
    turn.kind !== "agent" ||
    !Number.isSafeInteger(turn.attemptGeneration) ||
    turn.attemptGeneration! < 1
  ) {
    return json({ expired: false, reason: "no_agent_turn" }, 404);
  }
  if (
    (body.turnId !== undefined && body.turnId !== turn.turnId) ||
    (body.attemptGeneration !== undefined &&
      body.attemptGeneration !== turn.attemptGeneration)
  ) {
    return json(
      {
        expired: false,
        reason: "stale_turn",
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration,
      },
      409,
    );
  }
  if (await host.ctx.storage.get<boolean>("terminalDelivered")) {
    return json(
      {
        expired: false,
        reason: "already_terminal",
        turnId: turn.turnId,
        attemptGeneration: turn.attemptGeneration,
      },
      409,
    );
  }
  const now = Date.now();
  await host.ctx.storage.put(AGENT_WATCHDOG_DEADLINE_KEY, now);
  const running = host.agentTurnExecutions.get(turn.turnId);
  if (running) {
    await running
      .interrupt(new Error("The agent turn was expired by an operator."))
      .catch((error) => {
        log("error", "agent_turn_expire_interrupt_failed", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
      });
    if (host.agentTurnExecutions.get(turn.turnId) === running) {
      host.agentTurnExecutions.delete(turn.turnId);
    }
  }
  await host.setExactTurnAlarm(turn, now);
  log("info", "agent_turn_expired_by_operator", {
    turnId: turn.turnId,
    threadId: turn.threadId,
    attemptGeneration: turn.attemptGeneration,
    interruptedLocalExecution: Boolean(running),
  });
  return json({
    expired: true,
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration,
    interruptedLocalExecution: Boolean(running),
  });
};

/**
 * Placement and manual-pause cancellation share this exact boundary. A
 * request that has not reached the DO gets a durable pre-admission
 * tombstone; a current turn is acknowledged only after its sandbox is gone
 * and every in-isolate promise for that exact turn has joined.
 */
export const cancelExactAgentTurn = async (
  host: TerminalDeliveryHost,
  request: ExactTurnCancellationRequest,
  reason: string,
): Promise<Response> => {
  type Admission =
    | { response: Response }
    | {
        cancellation: ExactTurnCancellation;
        turn: TurnRequest;
        pending?: PendingTerminal;
      };
  const admission = await host.ctx.blockConcurrencyWhile(
    async (): Promise<Admission> => {
      const stored = await host.ctx.storage.get<TurnRequest>("turn");
      const exact = stored?.turnId === request.turnId ? stored : undefined;
      if (
        exact &&
        (exact.ownerId !== request.ownerId ||
          exact.ownerGeneration !== request.ownerGeneration ||
          exact.attemptGeneration !== request.attemptGeneration)
      ) {
        return {
          response: json(
            {
              canceled: false,
              reason: "stale_owner_generation",
              turnId: request.turnId,
            },
            409,
          ),
        };
      }
      const existing = await host.exactTurnCancellations.matching({
        turnId: request.turnId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        attemptGeneration: request.attemptGeneration,
      });
      if (existing && existing.cancelRequestId !== request.cancelRequestId) {
        return {
          response: json(
            {
              canceled: false,
              reason: "cancellation_identity_conflict",
              turnId: request.turnId,
            },
            409,
          ),
        };
      }
      if (existing?.state === "acknowledged") {
        return {
          response: json({
            canceled: true,
            turnId: request.turnId,
            replayed: true,
          }),
        };
      }
      let pending: PendingTerminal | undefined;
      if (exact && (await host.ctx.storage.get<boolean>("terminal"))) {
        pending =
          await host.ctx.storage.get<PendingTerminal>("pendingTerminal");
        if (
          !pending ||
          pending.turnId !== request.turnId ||
          pending.kind !== "canceled"
        ) {
          // The outcome is immutable, but its callback may only be waiting
          // on a distant watchdog after an isolate/process failure. A Pause
          // cannot replace that decision; it can safely wake its idempotent
          // delivery so the thread converges instead of appearing live.
          await host.ctx.storage.setAlarm(Date.now());
          return {
            response: json(
              {
                canceled: false,
                reason: "terminal_already_decided",
                turnId: request.turnId,
              },
              409,
            ),
          };
        }
      }
      const staged = await host.exactTurnCancellations.stage(request);
      if (staged.status === "conflict") {
        return {
          response: json(
            {
              canceled: false,
              reason: "cancellation_identity_conflict",
              turnId: request.turnId,
            },
            409,
          ),
        };
      }
      if (staged.status === "saturated") {
        return {
          response: json(
            {
              canceled: false,
              reason: "cancellation_ledger_saturated",
              turnId: request.turnId,
            },
            503,
          ),
        };
      }
      if (!("cancellation" in staged)) {
        return {
          response: json(
            { canceled: false, reason: "cancellation_not_staged" },
            503,
          ),
        };
      }
      if (staged.cancellation.state === "acknowledged") {
        return {
          response: json({
            canceled: true,
            turnId: request.turnId,
            replayed: true,
          }),
        };
      }
      if (!exact) {
        return {
          response: json(
            {
              canceled: true,
              turnId: request.turnId,
              pending: true,
              durable: true,
            },
            202,
          ),
        };
      }
      return { cancellation: staged.cancellation, turn: exact, pending };
    },
  );
  if ("response" in admission) return admission.response;

  const turn = { ...admission.turn };
  let pending = admission.pending ?? {
    turnId: turn.turnId,
    attemptGeneration: turn.attemptGeneration!,
    kind: "canceled" as const,
    payload: { message: "Stopped. Nothing was changed." },
    threadError:
      reason === "Paused by orchestrator." ? reason : "The agent was stopped.",
    terminateSandbox: true,
  };
  if (!admission.pending) {
    if (!(await host.claimTerminalDecision(turn, pending))) {
      const decided =
        await host.ctx.storage.get<PendingTerminal>("pendingTerminal");
      if (
        !decided ||
        decided.turnId !== turn.turnId ||
        decided.kind !== "canceled"
      ) {
        return json(
          {
            canceled: false,
            reason: "stale_turn",
            turnId: request.turnId,
          },
          409,
        );
      }
      pending = decided;
    }
  }

  const agentExecution = host.agentTurnExecutions.get(turn.turnId);
  try {
    // Interrupt first: this closes the exact turn's local admission latch
    // before sandbox teardown starts, so setup cannot recreate a session
    // after Stop destroyed the pre-existing/current container.
    if (agentExecution) {
      await agentExecution.interrupt(
        new Error(
          reason === "Paused by orchestrator."
            ? reason
            : "The agent turn was stopped.",
        ),
      );
    }
    if (pending.terminateSandbox) {
      // A restarted isolate has no live Effect fiber/finalizer, but may still
      // own the durable sandbox id. Teardown remains mandatory in that case.
      if (!agentExecution) {
        await host.terminateCurrentAgentSession(turn);
      }
      pending = { ...pending, terminateSandbox: false };
      if (
        !(await host.mutateExactTurn(turn, async (txn) => {
          await txn.put("pendingTerminal", pending);
        }))
      ) {
        return json(
          { canceled: false, reason: "stale_turn", turnId: turn.turnId },
          409,
        );
      }
    }
  } catch (error) {
    log("error", "cancel_sandbox_termination_failed", {
      turnId: turn.turnId,
      ...sandboxLifecycleFailureFields(error),
    });
    await host.setExactTurnAlarm(turn, Date.now() + 30_000);
    return json(
      {
        canceled: false,
        reason: "sandbox_termination_failed",
        turnId: turn.turnId,
      },
      502,
    );
  }

  let auxiliaryLeaseId: string | undefined;
  let auxiliaryGeneration: string | undefined;
  let terminalDelivered = false;
  try {
    turn.ownerPurgeGeneration = await host.registerTurn(turn, true);
    auxiliaryLeaseId = turn.ownerPurgeLeaseId;
    auxiliaryGeneration = turn.ownerPurgeGeneration;
    await host.assertTurnWritable(turn);
    log("info", "turn_canceled", {
      turnId: turn.turnId,
      appId: turn.appId,
    });
    terminalDelivered = await host.deliverTerminal(turn, pending, {
      preservePendingTerminal: true,
    });
  } catch (error) {
    if (!(error instanceof OwnerPurgeFenceError)) throw error;
  } finally {
    if (auxiliaryLeaseId && auxiliaryGeneration) {
      await host.unregisterTurnLease(
        turn,
        auxiliaryLeaseId,
        auxiliaryGeneration,
      );
    }
  }

  if (agentExecution) await agentExecution.join();
  if (!(await host.acknowledgeExactAgentTurnCancellation(request))) {
    return json(
      {
        canceled: false,
        reason: "cancellation_acknowledgement_lost",
        turnId: turn.turnId,
      },
      503,
    );
  }
  if (terminalDelivered) {
    const cleanupTurn = await host.ctx.storage.get<TurnRequest>("turn");
    if (cleanupTurn && exactTurnIdentityMatches(cleanupTurn, turn)) {
      try {
        // The joined executor can no longer produce a checkpoint. Reuse the
        // normal terminal-alarm retirement path immediately so its durable
        // execution marker does not survive until the old watchdog.
        await host.runAlarmWithLease({ ...cleanupTurn });
      } catch (error) {
        log("error", "cancel_terminal_cleanup_deferred", {
          turnId: turn.turnId,
          message: errorMessage(error),
        });
        await host.setExactTurnAlarm(cleanupTurn, Date.now() + 30_000);
      }
    }
  }
  return json({
    canceled: true,
    turnId: turn.turnId,
    joined: true,
  });
};

export const cancelForOwnerPurge = async (
  host: TerminalDeliveryHost,
  request: Request,
): Promise<Response> => {
  const body = (await request.json().catch(() => ({}))) as {
    ownerId?: string;
    turnId?: string;
    generation?: string;
    leaseId?: string;
    ownerGeneration?: string;
  };
  const stored = await host.ctx.storage.get<TurnRequest>("turn");
  const turnId = body.turnId;
  const ownerId = body.ownerId;
  const generation = body.generation;
  const leaseId = body.leaseId;
  const ownerGeneration = body.ownerGeneration;
  if (!turnId || !ownerId || !generation || !leaseId || !ownerGeneration) {
    return json({ error: "Owner purge lease identity required." }, 400);
  }
  const leaseTurn: TurnRequest = {
    kind: "agent",
    ownerId,
    ownerGeneration,
    ownerPurgeGeneration: generation,
    ownerPurgeLeaseId: leaseId,
    appId: "agent",
    turnId,
    agentDepth: 1,
    prompt: "",
    audience: "free",
    budgetMicroCents: 0,
  };
  if (
    stored &&
    (stored.turnId !== turnId ||
      stored.ownerId !== ownerId ||
      stored.ownerGeneration !== ownerGeneration ||
      stored.ownerPurgeGeneration !== generation ||
      stored.ownerPurgeLeaseId !== leaseId)
  ) {
    // A delayed generation-N purge callback must never terminalize, destroy,
    // or erase a generation-N+1 attempt that reused this Durable Object. It
    // may still retire its own exact stale lease; leaving that lease active
    // would make the owner-purge coordinator retry this harmless callback
    // forever while the successor remains present.
    if (!(await host.unregisterTurnLease(leaseTurn, leaseId, generation))) {
      return json(
        { canceled: false, reason: "stale_owner_purge_identity", turnId },
        409,
      );
    }
    return json({
      canceled: false,
      reason: "stale_owner_purge_identity",
      turnId,
      unregistered: true,
    });
  }
  if (!stored) {
    // Registration can win and the isolate can die before a turn is durably
    // admitted. In that case there is no execution or transient state to
    // destroy; remove only the exact orphaned owner-fence lease. Never run
    // deleteAll() against a DO that may later admit a successor.
    const retired = await host.unregisterTurnLease(
      leaseTurn,
      leaseId,
      generation,
    );
    return retired
      ? json({ canceled: true, turnId, unregistered: true, orphan: true })
      : json({ error: "Owner lease retirement is pending." }, 409);
  }
  const turn = stored;

  await host.ctx.storage.put("terminal", true);
  await host.ctx.storage.deleteAlarm().catch(() => undefined);
  const turnExecution =
    host.agentTurnExecutions.get(turnId) ?? host.appTurnExecutions.get(turnId);
  if (turnExecution) {
    try {
      // Close the local admission latch before teardown. Destroying only the
      // currently visible container is insufficient when createSession() is
      // still pending: that promise could resolve after destroy and recreate
      // executable work. interrupt() also boundedly joins that underlying
      // promise-native setup before purge can acknowledge the lease.
      await turnExecution.interrupt(
        new Error("Owner cloud activity is being purged."),
      );
    } catch {
      return json({ error: "Owner turn is still unwinding." }, 409);
    }
  } else {
    const target = await host.currentSandboxTarget();
    if (target) {
      try {
        if (turn.kind === "agent") {
          await host.terminateCurrentAgentSession(turn);
        } else {
          await host.destroySandboxDurably(target, "owner_purge");
        }
      } catch {
        return json({ error: "Owner turn is still unwinding." }, 409);
      }
    }
  }

  const running = [...(host.runningTurns.get(turnId) ?? [])];
  if (running.length > 0) {
    const settled = await Promise.race([
      Promise.allSettled(running).then(() => true),
      runToolEffect(
        Effect.sleep(OWNER_PURGE_STALE_LEASE_GRACE_MS).pipe(Effect.as(false)),
      ),
    ]);
    if (!settled) {
      return json({ error: "Owner turn is still unwinding." }, 409);
    }
  } else if (!turnExecution) {
    // No promise means this lease was recovered after isolate loss (or the
    // turn ended before clearing its durable registration). An outbound
    // callback dispatched by the old isolate may still be completing.
    const key = `ownerPurgeCancelAt:${leaseId}`;
    const startedAt = (await host.ctx.storage.get<number>(key)) ?? Date.now();
    await host.ctx.storage.put(key, startedAt);
    if (Date.now() - startedAt < OWNER_PURGE_STALE_LEASE_GRACE_MS) {
      return json({ error: "Reconciling stale owner turn lease." }, 409);
    }
    await host.ctx.storage.delete(key);
  }

  await host.cleanupTransientWrites(turn);
  if (turn.workspaceForkId) {
    await host.env.WORLDS.getByName(await worldName(turn.ownerId)).dropFork(
      turn.workspaceForkId,
    );
  }
  await host.deleteTurnStoragePreservingExactCancellations(turn, true);
  // The thread transcript is this owner's private job state and lives in
  // SQL tables the key-value sweep above cannot see.
  purgeThreadTranscript(host.ctx.storage.sql);
  await host.releaseOwnerGate(turn);
  // Do not depend on a vanished run's `finally`: remove the exact durable
  // lease idempotently from the owner fence here.
  return (await host.unregisterTurnLease(turn, leaseId, generation))
    ? json({ canceled: true, turnId, unregistered: true })
    : json({ error: "Owner lease retirement is pending." }, 409);
};

export const acknowledgeExactAgentTurnCancellation = async (
  host: TerminalDeliveryHost,
  request: ExactTurnCancellationRequest,
): Promise<boolean> => {
  return await host.ctx.blockConcurrencyWhile(
    async () => await host.exactTurnCancellations.acknowledge(request),
  );
};

/**
 * An alarm is itself tracked under the turn id. More than one tracked
 * promise therefore proves the original run (or another exact lifecycle
 * task) has not joined yet. A replacement isolate has no such promise and
 * may durably acknowledge the already-stopped cancellation after delivery.
 */
export const acknowledgeExactCancellationFromAlarm = async (
  host: TerminalDeliveryHost,
  turn: TurnRequest,
  cancellation: ExactTurnCancellation,
): Promise<boolean> => {
  if (cancellation.state === "acknowledged") return true;
  const active = host.runningTurns.get(cancellation.turnId)?.size ?? 0;
  if (active > 1) {
    await host.setExactTurnAlarm(turn, Date.now() + 30_000);
    return false;
  }
  if (await host.acknowledgeExactAgentTurnCancellation(cancellation)) {
    return true;
  }
  await host.setExactTurnAlarm(turn, Date.now() + 30_000);
  return false;
};
