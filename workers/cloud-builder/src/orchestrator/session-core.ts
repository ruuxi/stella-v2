import type { DevicesResponse } from "@stella/contracts/turn-plane/placement";
import * as Deferred from "effect/Deferred";
import { DurableObject } from "cloudflare:workers";
import type {
  TurnExecution,
  TurnRetryCancellation,
} from "../turn-cancellation.js";
import { LocalOwnerModelGrants } from "../local-owner-model-grants.js";
import { verifyUserToken } from "../auth-jwt.js";
import type { OwnerModelGrant } from "../owner-model-grants.js";
import type { OwnerEvent } from "@stella/contracts/turn-plane/owner-events";
import "../conversation-hub.js";
import {
  BACKFILL_BATCH_RECORDS,
  CLOSE_DELETED,
  type ConversationHub,
  type ConversationOwnerRecord,
  createConversationHub,
  INITIAL_WINDOW_RECORDS,
  type JournalHead,
  type JournalRange,
  type JournalReader,
  type JournalRecord,
  type LiveTurnSnapshot,
} from "../conversation-types.js";
import { Journal } from "../journal.js";
import { ConversationArchive } from "../archive.js";
import { ConversationIndex } from "../index-flush.js";
import type {
  CloudCliTurnTerminal,
  CloudOrchestratorToolCallResponse,
} from "@stella/contracts/cloud-orchestrator-cli";
import { ExactTurnCancellationLedger } from "../execution-placement-turn-cancellation.js";
import type {
  Env,
  ChatTurnRequest,
  OwnerFencedTurn,
  LocalTurnLease,
  AgentsView,
  CliTurnRuntime,
} from "./types.js";
import {
  AGENT_RUNTIME_KEY,
  AGENTS_VIEW_KEY,
  LOCAL_TURN_LEASE_KEY,
} from "./constants.js";
import { listedAgents, errorMessage, log } from "./support.js";
import type { OrchestratorOwner } from "./owner.js";

/**
 * The conversation Durable Object (`OrchestratorSessionObject`, see
 * `../orchestrator-session-object.ts`) is one class split by concern into a
 * chain of layers, each extending the one below it:
 *
 *   session-core → owner → turn-lifecycle → turn-queue → dev-acceptance →
 *   cloud-agents → pi → tools → cli-turn → run-turn → journal-writes →
 *   local-turn → turn-start → OrchestratorSessionObject
 *
 * This bottom layer holds every field and the constructor, so fields are
 * initialized exactly once and in their original order. A layer calls only
 * down the chain, except for the few methods declared abstract where a lower
 * layer needs one implemented above it.
 */
export abstract class OrchestratorSessionCore extends DurableObject<Env> {
  protected firstChatInIsolate = true;
  protected gatewayPreparedInInstance = false;
  protected readonly isolateId = crypto.randomUUID();
  protected readerReady?: Promise<void>;
  protected readonly localOwnerModelGrants = new LocalOwnerModelGrants(
    this.isolateId,
  );
  protected readonly admittedOwnerModelGrants = new Map<
    string,
    OwnerModelGrant
  >();
  protected wakeTiming?: {
    bootstrapMs: number;
    restoreMs: number;
    totalMs: number;
  };
  // Serializes turns: the owner can dispatch a wake turn while a user turn is
  // still streaming; the second waits its turn instead of interleaving.
  protected queue: Promise<unknown> = Promise.resolve();
  /** Exact promises let Stop join only its target, never a newer queued turn. */
  protected readonly turnExecutions = new Map<
    string,
    TurnExecution<Response>
  >();
  /** Fresh voice writes hold an owner fence and are joined by owner purge. */
  protected readonly ownerFencedAppends = new Map<
    string,
    { lease: OwnerFencedTurn; settled: Promise<void> }
  >();

  protected readonly journal: Journal;
  protected readonly archive: ConversationArchive;
  protected readonly index: ConversationIndex;
  protected readonly hub: ConversationHub;
  protected readonly exactTurnCancellations: ExactTurnCancellationLedger;
  /** Isolate identity only; the raw value is never persisted or returned. */
  protected readonly devAcceptanceBootId = crypto.randomUUID();

  /**
   * Work that must finish before a turn is called terminal but that cannot run
   * on the Agent's synchronous event sink — today, promoting an oversize row's
   * payload into R2.
   */
  protected background: Promise<unknown> = Promise.resolve();

  /** In-memory only. Rebuilt every turn; nothing durable depends on it. */
  protected live: LiveTurnSnapshot | null = null;

  /**
   * The turn whose `runTurn` body is executing in THIS isolate, and the last
   * turn whose post-terminal work ran.
   *
   * Together they route `afterTerminal` to exactly one caller. `/cancel` and
   * the watchdog can mark a turn terminal from outside the loop, and the
   * post-terminal work — the search excerpt, the card-inbox drain, rollover —
   * must run for those turns too. But it must never run while the loop is
   * still unwinding: a drain there could splice a foreign row between a tool
   * call and its result, and rollover mid-turn is forbidden outright. So the
   * loop finalizes its own turn whenever it is alive to do it, and those two
   * paths only step in for a turn no loop will return to (an eviction, or a
   * cancel that arrived after the isolate lost the run).
   */
  protected activeTurnId: string | null = null;
  protected finalizedTurnId: string | null = null;

  /**
   * This object has been purged, whatever its journal now says.
   *
   * `handlePurge` ends in `deleteAll()` plus a fresh `bootstrap()`, so the
   * durable tombstone is gone and `journal.isDeleted()` reads false again the
   * moment it returns. Any request that checked the tombstone before the purge
   * and was still awaiting something when it landed would otherwise resume
   * against that empty journal and write rows — and R2 objects — into a
   * conversation the owner has already recorded as deleted, where no purge, sweep
   * or manifest will ever name them again. The durable tombstone fences the
   * window before `deleteAll()`; this fences the window after it.
   */
  protected sealed = false;

  /** Serializes `/turn` admission through durable replay classification. */
  protected turnAdmissionTail: Promise<void> = Promise.resolve();
  /** Serializes per-turn event ordinal allocation (a get+put pair). */
  protected eventSeqTail: Promise<unknown> = Promise.resolve();
  /** Persisted with accepted turns so cold-start index flushes stay fenced. */
  protected ownerGeneration?: string;

  /**
   * The Claude Code turn running in this isolate (`runCliTurn`), keyed by
   * turn id: the tools its forwarded calls run against. In memory only; a
   * resumed turn rebuilds it before it waits.
   */
  protected readonly cliRuntimes = new Map<string, CliTurnRuntime>();
  /** Tool forwards that arrived before a resumed turn rebuilt its tools. */
  protected readonly cliRuntimeWaiters = new Map<
    string,
    Array<Deferred.Deferred<void>>
  >();
  /** Wakes the waiting `runCliTurn` when its terminal frame lands. */
  protected readonly cliTerminalWaiters = new Map<string, () => void>();
  /** Terminal frames, full text, for the turn waiting in this isolate. */
  protected readonly cliTerminals = new Map<string, CloudCliTurnTerminal>();
  /** In-flight CLI tool calls, so a replayed forward joins the first one. */
  protected readonly cliToolCalls = new Map<
    string,
    Promise<CloudOrchestratorToolCallResponse>
  >();

  // Aborts the live turn's retry ladder:
  // classification reads it to refuse retries after a cancel/timeout, and an
  // abort during retry backoff wakes the sleep instead of waiting it out.
  protected currentTurnCancellation?: TurnRetryCancellation;
  /** The pi-durable run of the live turn, for the same Stop and watchdog paths. */
  protected currentPiRun?: { abort(): void };
  /** This conversation's pi-durable harness, opened once per isolate. */
  protected piRuntime?: Promise<
    import("../pi-runtime.js").PiConversationRuntime
  >;
  protected piClientsAttaching = false;

  protected readonly cloudHomePreparations = new Map<
    string,
    {
      home: ReturnType<OrchestratorOwner["prepareCloudHomeContext"]>;
      destinations: Promise<DevicesResponse | null>;
    }
  >();

  /** When this object last checked its running agents against their owners. */
  protected agentsReconciledAt = 0;

  /** What `agentsView` read last is in storage. */
  protected agentsViewStored = false;
  /**
   * The running agents of a conversation pi has run in (`refreshAgents`),
   * which `ready` and `agents` frames list; null where they are folded
   * from the journal's agent cards.
   */
  protected agentsView: AgentsView | null = null;
  protected agentsRefresh: Promise<void> | null = null;
  protected agentsRefreshAgain = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.exactTurnCancellations = new ExactTurnCancellationLedger(ctx.storage);
    this.journal = new Journal(ctx, log);
    this.archive = new ConversationArchive(
      env.CONVERSATION_ARCHIVE,
      this.journal,
      log,
    );
    this.index = new ConversationIndex(
      this.journal,
      log,
      () => this.indexIdentity(),
      {
        enqueue: (events) => this.deferOwnerEvents(events),
        purged: () => this.purged(),
      },
    );
    this.hub = createConversationHub({
      ctx,
      reader: this.reader(),
      lookupOwner: (identity) => this.resolveOwnerForCaller(identity),
      cancelTurn: (turnId) => this.cancelTurn(turnId),
      onConnect: () => {
        this.flushIndexIfLagging();
        this.reconcileRunningAgentsSoon();
      },
      conversationId: () => this.conversationId(),
      log,
      verifyToken: (token) =>
        verifyUserToken(token, this.env as unknown as Cloudflare.Env),
      pi: {
        enabled: async () =>
          (await this.ctx.storage.get<string>(AGENT_RUNTIME_KEY)) === "pi",
        attach: () => this.attachPiClients(),
        older: async (beforeEntryId) => {
          const runtime = await this.openPiRuntime(this.piGatewayOrigin());
          const { contextFor } = await import("../pi-runtime.js");
          return await runtime.olderForClients(beforeEntryId, contextFor());
        },
        detach: () => {
          void this.piRuntime
            ?.then((runtime) => runtime.stopWatchingForClients())
            .catch(() => undefined);
        },
      },
    });
    // Set in the constructor rather than at accept time: whether an
    // auto-response survives DO eviction is not something the docs settle, and
    // setting it on every cold start makes the question moot. This is what
    // keeps an idle conversation free — a JSON heartbeat would wake the object
    // on every beat and bill the incoming frame at 20:1.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    // Accepted turns are persisted under queued:* before the 202 goes out;
    // an isolate restart wipes the in-memory queue, so re-enqueue whatever
    // survived — otherwise an accepted turn (and its owner "running" row)
    // would be silently lost forever.
    const wake = this.ctx.blockConcurrencyWhile(async () => {
      const wakeStartedAt = performance.now();
      // The schema has to exist before anything can read or write a turn.
      await this.journal.bootstrap();
      const bootstrapMs = Math.round(performance.now() - wakeStartedAt);
      const restoreStartedAt = performance.now();
      this.ownerGeneration = await this.ctx.storage.get<string>(
        "ownerDataGeneration",
      );
      if (this.journal.meta().conversation_id === "" && this.ctx.id.name) {
        this.journal.setConversationId(this.ctx.id.name);
      }
      // A conversation on pi lists its running agents from their owners from
      // the first connect on, even before it has read them.
      const agentsView =
        await this.ctx.storage.get<AgentsView>(AGENTS_VIEW_KEY);
      this.agentsViewStored = agentsView !== undefined;
      this.agentsView =
        agentsView ??
        ((await this.ctx.storage.get<string>(AGENT_RUNTIME_KEY)) === "pi"
          ? { pi: [], owner: [] }
          : null);
      const localLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (localLease) {
        await this.restoreLocalLease(localLease);
      } else {
        // The turn a replaced isolate was running goes first, ahead of
        // everything queued behind it, exactly where it stood.
        const orphan = await this.claimOrphanedTurnResume();
        if (orphan) this.enqueue(orphan.turn, false, { resume: orphan.resume });
        for (const turn of await this.queuedTurns()) this.enqueue(turn);
      }
      this.wakeTiming = {
        bootstrapMs,
        restoreMs: Math.round(performance.now() - restoreStartedAt),
        totalMs: Math.round(performance.now() - wakeStartedAt),
      };
      log("info", "conversation_wake_timing", this.wakeTiming);
    });
    this.readerReady = wake;
    // Registration must follow durable identity restore, but must not be
    // awaited inside blockConcurrencyWhile: OwnerGate may synchronously call
    // this reader during freeze and would otherwise deadlock the object.
    ctx.waitUntil(
      wake.then(async () => {
        const identity = this.indexIdentity();
        const conversationId = this.conversationId();
        if (!identity || !conversationId) return;
        try {
          await this.ownerGate(identity.ownerId).registerConversationReader({
            ...identity,
            conversationId,
            readerId: this.isolateId,
          });
        } catch (error) {
          log("info", "conversation_model_reader_registration_failed", {
            conversationId,
            message: errorMessage(error),
          });
        }
      }),
    );
  }

  protected conversationId(): string {
    return this.journal.meta().conversation_id || this.ctx.id.name || "";
  }

  protected async getTurnState<T>(key: string): Promise<T | undefined> {
    return this.ctx.storage.kv
      ? this.ctx.storage.kv.get<T>(key)
      : await this.ctx.storage.get<T>(key);
  }

  /**
   * SQLite writes batch until the next I/O boundary. Cloudflare's output gate
   * still holds external requests/responses until the writes are durable.
   * The async fallback supports storage implementations without synchronous KV.
   */
  protected async putTurnState(
    entries: Record<string, unknown>,
  ): Promise<void> {
    const { storage } = this.ctx;
    if (storage.kv) {
      storage.transactionSync(() => {
        for (const [key, value] of Object.entries(entries))
          storage.kv.put(key, value);
      });
    } else {
      await storage.put(entries);
    }
  }

  /** Pull the alarm forward to `at` unless one already fires sooner. */
  protected async armAlarmNoLaterThan(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /** Who the projection belongs to; null until the conversation is bound. */
  protected indexIdentity(): {
    ownerId: string;
    ownerGeneration: string;
  } | null {
    const ownerId = this.journal.meta().owner_id;
    if (!ownerId || !this.ownerGeneration) return null;
    return { ownerId, ownerGeneration: this.ownerGeneration };
  }

  protected ownerGate(ownerId: string) {
    const gates = this.env.OWNER_GATES;
    if (!gates) throw new Error("Owner gate namespace is not bound.");
    return gates.getByName(ownerId);
  }

  protected reader(): JournalReader {
    return {
      head: (): JournalHead =>
        this.journal.head(this.live ? "running" : "idle"),
      ownerId: () => this.journal.ownerId(),
      bindOwner: (record) =>
        this.journal.bindOwner({
          ...record,
          conversationId: this.conversationId(),
        }),
      readRange: (fromSeq, toSeq, limit): Promise<JournalRange> =>
        this.archive.readRange(
          fromSeq,
          toSeq,
          Math.min(limit, BACKFILL_BATCH_RECORDS),
        ),
      newest: (limit): JournalRecord[] =>
        this.journal.newest(Math.min(limit, INITIAL_WINDOW_RECORDS)),
      liveTurn: () => this.live,
      runningAgents: (limit) =>
        this.agentsView
          ? listedAgents(this.agentsView, limit)
          : this.journal.runningAgents(limit),
    };
  }

  protected flushIndexIfLagging(): void {
    if (!this.index.lagging()) return;
    void this.index
      .flush({
        activity: this.live ? "running" : "idle",
        updatedAt: Date.now(),
      })
      .catch(() => undefined);
  }

  /**
   * Publishes a committed row. Broadcast is best-effort by construction: the
   * row is durable first, the frame is sent second, and a crash in between
   * costs a frame, not a fact. The client's gap detection closes it.
   */
  protected publish(record: JournalRecord | null | undefined): void {
    if (!record) return;
    try {
      this.hub.broadcastRecord(record);
    } catch (error) {
      log("error", "conversation_broadcast_failed", {
        seq: record.seq,
        message: errorMessage(error),
      });
    }
  }

  /**
   * Deleted, by either fence: the durable tombstone, or the in-memory seal that
   * outlives the `deleteAll()` which destroys it. Every write path asks this
   * rather than the journal directly.
   */
  protected purged(): boolean {
    return this.sealed || this.journal.isDeleted();
  }

  /**
   * Raise the in-memory seal from outside `handlePurge`.
   *
   * The only caller is the index flush learning from the owner that this
   * conversation id is fenced as purged — which is the one fact this isolate
   * cannot derive for itself. A DO restarted after its purge has an empty
   * journal and a false `sealed`, and there is no request that would ever tell
   * it otherwise. This is a stop, not a delete: no storage is touched, because
   * an object in this state has none of the user's data left to remove.
   */
  protected sealPurged(reason: string): void {
    if (this.sealed) return;
    this.sealed = true;
    log("error", "conversation_sealed_after_purge", {
      conversationId: this.conversationId(),
      reason,
    });
    // Called from inside a flush's retry ladder, where a throw would be caught
    // as a transport failure and retried. The seal is the point; disconnecting
    // stale tabs is a courtesy.
    try {
      this.hub.closeAll(CLOSE_DELETED);
    } catch (error) {
      log("error", "conversation_seal_close_failed", {
        message: errorMessage(error),
      });
    }
  }

  // Implemented further up the chain; the constructor and the conversation
  // hub wiring above need them.
  protected abstract cancelTurn(turnId: string): Promise<void>;
  protected abstract claimOrphanedTurnResume(): Promise<{
    turn: ChatTurnRequest;
    resume: boolean;
  } | null>;
  protected abstract deferOwnerEvents(events: OwnerEvent[]): Promise<void>;
  protected abstract enqueue(
    turn: ChatTurnRequest,
    freshAdmission?: boolean,
    options?: { resume?: boolean },
  ): void;
  protected abstract queuedTurns(): Promise<ChatTurnRequest[]>;
  protected abstract resolveOwnerForCaller(
    caller: { ownerId: string },
    options?: { refreshGeneration?: boolean },
  ): Promise<ConversationOwnerRecord | null>;
  protected abstract restoreLocalLease(lease: LocalTurnLease): Promise<void>;
  protected abstract attachPiClients(): Promise<{
    snapshot: unknown;
    hasOlder: boolean;
  }>;
  protected abstract openPiRuntime(
    gatewayOrigin: string,
  ): Promise<import("../pi-runtime.js").PiConversationRuntime>;
  protected abstract piGatewayOrigin(): string;
  protected abstract reconcileRunningAgentsSoon(): void;
}
