import {
  compactCloudHistory,
  CONTEXT_CHECKPOINT_KEY,
  type ContextCheckpoint,
} from "../context-compaction.js";
import {
  materializeProviderContext,
  preparePromptContext,
  PROMPT_CONTEXT_KEY,
  type PromptContext,
  promptContextBoundary,
  promptContextCheckpointChanged,
  promptContextHistoryStartAfterSeq,
  providerHistory,
  resumePromptContext,
  reusablePromptContext,
  sentResidentPrompts,
} from "../prompt-context.js";
import { LIFE_USER_PROFILE_DISPLAY_PATH } from "@stella/runtime/kernel/agent-runtime/resident-context.js";
import type { ExplicitModelAgent as RuntimeAgent } from "@stella/runtime/kernel/agent-core/explicit-model-agent.js";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  AGENT_RUN_MAX_ATTEMPTS,
  executeAgentRunWithRetry,
  prepareTransientResumeTail,
} from "@stella/runtime/kernel/agent-runtime/run-retry.js";
import {
  assertTurnExecutionActive,
  type TurnRetryCancellation,
} from "../turn-cancellation.js";
import {
  buildDefaultTransformContext,
  getAgentCompletion,
} from "@stella/runtime/kernel/agent-runtime/run-shared.js";
import { guardedModelFetch } from "../guarded-model-fetch.js";
import {
  fetchWithManagedCancellation,
  type ModelGatewayControl,
} from "../managed-request-cancellation.js";
import {
  type LocalOwnerModelGrantExpectation,
  releaseOwnerModelGrantAfterBody,
} from "../local-owner-model-grants.js";
import {
  GATEWAY_PREPARE_PATH,
  GATEWAY_RESOLVE_PATH,
  GATEWAY_SUBSCRIPTION_LIMIT_HEADER,
  nativeSubscriptionLimitNotice,
} from "@stella/contracts/gateway/api";
import { createCloudRelaySession } from "@stella/executor-cloud/relay-model";
import {
  withOrchestratorCacheRetention,
  withoutPromptCache,
} from "../orchestrator-cache-retention.js";
import { loadRuntimeAgent } from "../runtime-agent.js";
import { CLOUD_HISTORY_TOKEN_BUDGET } from "@stella/executor-cloud/prune-history";
import {
  buildCloudSystemPromptSections,
  cloudResidentContext,
} from "../cloud-prompt.js";
import { resolveOpenToolCall } from "../tool-replay.js";
import { stampUserMessageSequences } from "../journal.js";
import type { ExactTurnCancellation } from "../execution-placement-turn-cancellation.js";
import type {
  SteerableTurn,
  ChatTurnRequest,
  LocalTurnLease,
  PersistedChatTurnModelCapability,
  OwedTerminal,
} from "./types.js";
import {
  CHAT_WATCHDOG_MS,
  CHAT_TURN_HEARTBEAT_MS,
  CHAT_TURN_RESUME_KEY,
  CHAT_TURN_STARTED_AT_KEY,
  CHAT_TURN_MODEL_CAPABILITY_KEY,
  LOCAL_TURN_LEASE_KEY,
  TERMINAL_NOTICE,
  CLOUD_CONTEXT_NOTICE,
} from "./constants.js";
import {
  OwnerPurgeFenceError,
  mintOrchestratorTurnCapability,
  CliTurnFailedError,
  cloudExecutionContext,
  ChatTurnNotResumableError,
  measureInto,
  localTurnRetirementDeadline,
  json,
  errorMessage,
  log,
  requireCloudContext,
  cloudContextFailure,
} from "./support.js";
import { OrchestratorCliTurn } from "./cli-turn.js";

/** Stella's own loop: one admitted chat turn, start to terminal. */
export abstract class OrchestratorRunTurn extends OrchestratorCliTurn {
  protected async finishPreCanceledTurn(
    turn: ChatTurnRequest,
    cancellation: ExactTurnCancellation,
  ): Promise<Response> {
    try {
      const now = Date.now();
      const report = await this.wakeReport(turn);
      const promptMessage = {
        role: "user",
        content: [{ type: "text", text: report.prompt }],
        timestamp: now,
        ...(turn.source ? { source: turn.source } : {}),
      } as AgentMessage;
      const promptPayload = await this.spillOversizePrompt(
        turn.turnId,
        promptMessage,
      );
      const owed: OwedTerminal = {
        kind: "canceled",
        message: TERMINAL_NOTICE.canceled,
        eventSeq: await this.nextTurnEventSeq(turn.turnId),
      };
      await this.ctx.storage.put({
        turn,
        terminal: true,
        terminalDelivered: false,
        terminalOwed: owed,
        alarmAttempts: 0,
      });
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      this.ownerGeneration = turn.ownerGeneration;
      this.bindConversation(turn);
      this.journal.upsertTurn({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        ownerId: turn.ownerId,
        lane: turn.lane,
        source: turn.source,
        clientMsgId: turn.clientMsgId,
        state: "running",
        now,
      });
      const prompt = this.journal.appendMessage({
        turnId: turn.turnId,
        writer: "orchestrator",
        writerKey: `turn:${turn.turnId}:prompt`,
        role: "user",
        hidden: turn.hiddenMessage === true,
        clientMsgId: turn.clientMsgId,
        createdAt: now,
        message: promptMessage,
        ...promptPayload,
      });
      this.journal.setTurnSpan(turn.turnId, prompt.seq);
      this.publish(prompt.record);
      this.publishAgentTerminal(turn, report);
      this.recordTerminal(turn, "canceled", TERMINAL_NOTICE.canceled);
      try {
        await this.emitTurnEvent(
          turn,
          "canceled",
          { message: TERMINAL_NOTICE.canceled },
          {
            terminal: true,
            eventSeq: owed.eventSeq,
            errorMessage: TERMINAL_NOTICE.canceled,
          },
        );
        await this.ctx.storage.put("terminalDelivered", true);
      } catch {
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
      }
      await this.afterTerminal(turn);
      if (!(await this.acknowledgeExactTurnCancellation(cancellation))) {
        throw new Error("Pre-admission cancellation acknowledgement was lost.");
      }
      log("info", "chat_turn_pre_admission_canceled", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
      });
      return json({ ok: false, canceled: true, preAdmission: true });
    } finally {
      await this.unregisterOwnerTurn(turn);
      await this.releaseOwnerGate(turn);
    }
  }

  protected async runTurn(
    turn: ChatTurnRequest,
    turnCancellation: TurnRetryCancellation,
    executionSignal: AbortSignal,
    enqueuedAt = performance.now(),
    admission?: {
      leaseId: string | undefined;
      generation: string | undefined;
      at: number;
    },
    resumeTurn = false,
  ): Promise<Response> {
    const enteredAt = performance.now();
    const startupTimings: Record<string, number> = {
      queueWaitMs: Math.round(enteredAt - enqueuedAt),
    };
    // A hidden wake the running turn already took in (`absorbSteeredWake`),
    // which also retired its lease and gate slot.
    if (this.journal.turnState(turn.turnId)?.state === "terminal") {
      log("info", "chat_turn_duplicate_ignored", { turnId: turn.turnId });
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      return json({ ok: false, duplicate: true });
    }
    const localLease =
      await this.getTurnState<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) {
      const retirementAt = localTurnRetirementDeadline(localLease);
      if (retirementAt <= Date.now()) {
        if (localLease.cancelRequested) {
          await this.cancelLocalTurn(localLease, true);
        } else {
          await this.expireLocalLease(localLease, false);
        }
      } else {
        await this.armLocalLeaseAlarm(retirementAt);
        log("info", "chat_turn_waiting_for_local_turn", {
          turnId: turn.turnId,
          localTurnId: localLease.turnId,
          conversationId: turn.conversationId,
        });
        return json({ ok: false, queued: true }, 202);
      }
    }
    // Queued turns survive DO eviction and may predate the worker generation
    // that introduced owner leases. Acquire (or re-acquire) before touching
    // the journal; a blocked owner drops the queued turn without callbacks,
    // because the reset/account purge is about to delete its owner row too.
    try {
      const registrationAt = performance.now();
      turn.ownerPurgeGeneration = await this.registerOwnerTurn(turn);
      startupTimings.registrationMs = Math.round(
        performance.now() - registrationAt,
      );
      const assertionAt = performance.now();
      if (
        admission?.leaseId &&
        admission.generation &&
        admission.leaseId === turn.ownerPurgeLeaseId &&
        admission.generation === turn.ownerPurgeGeneration &&
        performance.now() - admission.at < 1_000
      ) {
        assertTurnExecutionActive(turnCancellation, executionSignal);
        // Retirement/purge can race admission even in this isolate. The exact
        // durable receipt must still be live; provider dispatch also checks the
        // remote fence together with the current memory permission.
        await this.assertOwnerFenceLeaseReceiptActive(turn);
        startupTimings.admissionReused = 1;
      } else {
        await this.assertOwnerTurn(turn);
      }
      startupTimings.ownerAssertionMs = Math.round(
        performance.now() - assertionAt,
      );
      if (turn.agentThreadControl) {
        await this.rememberCloudAgentControlReceipt(turn.agentThreadControl);
      }
    } catch (error) {
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      await this.unregisterOwnerTurn(turn);
      await this.releaseOwnerGate(turn);
      if (error instanceof OwnerPurgeFenceError) {
        log("info", "chat_turn_dropped_owner_purge", {
          turnId: turn.turnId,
          ownerId: turn.ownerId,
        });
        return json({ ok: false, purging: true });
      }
      throw error;
    }
    // A turn that raced the deletion of its own conversation. Running it
    // would rebuild the transcript the purge just destroyed, in an object no
    // later purge will visit.
    if (this.purged()) {
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      await this.unregisterOwnerTurn(turn);
      await this.releaseOwnerGate(turn);
      log("info", "chat_turn_dropped_deleted", { turnId: turn.turnId });
      return json({ ok: false, deleted: true });
    }
    // Exactly-once, defensively. The queued key below closes the restart path;
    // this closes the remaining one — a duplicated dispatch of the same
    // turnId, which would otherwise replay the whole loop and burn a second
    // turn's tokens against one accepted turn. The dequeue happens here too:
    // a turn nothing will ever run again must not be re-enqueued by every
    // future cold start.
    if (this.journal.turnState(turn.turnId)?.state === "terminal") {
      log("info", "chat_turn_duplicate_ignored", { turnId: turn.turnId });
      await this.ctx.storage.delete(`queued:${turn.turnId}`);
      await this.unregisterOwnerTurn(turn);
      await this.releaseOwnerGate(turn);
      return json({ ok: false, duplicate: true });
    }
    // A prior turn that never delivered its terminal event (isolate restart
    // mid-run) would otherwise stay "running" in the owner forever.
    const stale = await this.getTurnState<ChatTurnRequest>("turn");
    if (
      stale &&
      stale.turnId !== turn.turnId &&
      !(await this.getTurnState<boolean>("terminalDelivered"))
    ) {
      const interrupted = "Stella was interrupted answering this. Try again.";
      await this.emitTurnEvent(
        stale,
        "failed",
        { message: interrupted },
        { terminal: true, errorMessage: interrupted },
      ).catch(() => undefined);
      await this.releaseOwnerGate(stale);
      // Additive: the same terminal fact, in the transcript the clients read.
      this.recordTerminal(stale, "failed", interrupted);
      // Flush, inbox drain, and rollover belong to the turn boundary that is
      // about to reopen below.
    }
    // Claim first, dequeue second, and never the other way round. Between the
    // two writes is the only moment a restart can see this turn twice; before
    // the swap it saw it not at all, which is unrecoverable — an accepted turn
    // in neither durable record is a user message that never reaches the
    // transcript and a owner row stuck "running" forever. Seeing it twice
    // costs a re-run of a turn that has produced nothing yet.
    //
    // The stale-turn recovery above deliberately sits outside the window: it
    // yields on the owner delivery, and it needs the previous turn to still be
    // under `turn` in order to recover it at all.
    // The same turn claimed again (a resume, or a restart that lost it
    // before its prompt was journaled) keeps its original watchdog and start:
    // neither the deadline nor the resume age bound is reset by a loss.
    const reclaimed = stale?.turnId === turn.turnId;
    const [storedWatchdogAt, storedStartedAt] = reclaimed
      ? await Promise.all([
          this.getTurnState<number>("turnWatchdogAt"),
          this.getTurnState<number>(CHAT_TURN_STARTED_AT_KEY),
        ])
      : [undefined, undefined];
    const watchdogAt =
      reclaimed && typeof storedWatchdogAt === "number"
        ? storedWatchdogAt
        : Date.now() + Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS);
    let preCanceled: ExactTurnCancellation | null = null;
    const claimAt = performance.now();
    await this.ctx.blockConcurrencyWhile(async () => {
      // This check and the queued -> current swap share the same critical
      // section as `/cancel`'s durable tombstone. Either Stop wins and this turn
      // never launches, or the turn becomes the exact current owner Stop joins.
      preCanceled = await this.exactTurnCancellations.matching({
        turnId: turn.turnId,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
      });
      if (preCanceled) return;
      // The heartbeat, not the watchdog: it is what wakes a replaced object
      // in time to resume this turn.
      await this.armAlarmNoLaterThan(
        Math.min(watchdogAt, Date.now() + CHAT_TURN_HEARTBEAT_MS),
      );
      await this.putTurnState({
        turn,
        turnWatchdogAt: watchdogAt,
        [CHAT_TURN_STARTED_AT_KEY]:
          reclaimed && typeof storedStartedAt === "number"
            ? storedStartedAt
            : Date.now(),
        ...(reclaimed
          ? {}
          : {
              [CHAT_TURN_RESUME_KEY]: null,
              [CHAT_TURN_MODEL_CAPABILITY_KEY]: null,
            }),
        terminal: false,
        terminalDelivered: false,
        terminalOwed: null,
        alarmAttempts: 0,
      });
      if (this.ctx.storage.kv)
        this.ctx.storage.kv.delete(`queued:${turn.turnId}`);
      else await this.ctx.storage.delete(`queued:${turn.turnId}`);
    });
    if (preCanceled) {
      return await this.finishPreCanceledTurn(turn, preCanceled);
    }
    startupTimings.claimMs = Math.round(performance.now() - claimAt);
    this.ownerGeneration = turn.ownerGeneration;
    this.journal.upsertTurn({
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      ownerId: turn.ownerId,
      lane: turn.lane,
      source: turn.source,
      clientMsgId: turn.clientMsgId,
      state: "running",
      now: Date.now(),
    });
    const started = performance.now();
    const preparationTimings: Record<string, number> = {};
    const measurePreparation = measureInto(preparationTimings);
    log("info", "chat_turn_started", {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      sessionId: turn.sessionId,
      startupMs: Math.round(performance.now() - enteredAt),
      startupTimings,
      firstChatInIsolate: this.firstChatInIsolate,
      isolateId: this.isolateId,
      ...(this.firstChatInIsolate ? { wakeTiming: this.wakeTiming } : {}),
    });
    this.firstChatInIsolate = false;
    // Claimed inside the try so the matching `finally` always releases it: a
    // turn id stuck here would stop the watchdog from ever finalizing a turn.
    const assertExactTurnActive = async (): Promise<void> => {
      assertTurnExecutionActive(turnCancellation, executionSignal);
      const [stored, terminal] = await Promise.all([
        this.getTurnState<ChatTurnRequest>("turn"),
        this.getTurnState<boolean>("terminal"),
      ]);
      assertTurnExecutionActive(turnCancellation, executionSignal);
      if (
        terminal ||
        stored?.turnId !== turn.turnId ||
        stored.ownerId !== turn.ownerId ||
        stored.ownerGeneration !== turn.ownerGeneration
      ) {
        throw new Error("The chat turn is no longer active.");
      }
    };
    this.currentTurnCancellation = turnCancellation;
    let subscriptionLimitNotice: string | undefined;
    try {
      // The queue boundary checked the live owner lease. The provider guard
      // checks it again with memory policy after read-only preparation.
      await assertExactTurnActive();
      this.activeTurnId = turn.turnId;
      // An `anthropic` turn runs on the Claude Code CLI in the orchestrator
      // container (`runCliTurn`); only the other engines run this loop.
      const harnessExecution =
        turn.execution.engine === "anthropic" ? undefined : turn.execution;
      // The durable turn is claimed before the heavy loop implementation is
      // evaluated. Load it alongside read-only preparation on actual turns;
      // object wake, admission, status, and cancellation stay on the lean path.
      const agentRuntimeWork = harnessExecution
        ? loadRuntimeAgent()
        : undefined;
      void agentRuntimeWork?.catch(() => undefined);
      // Admission already bound the owner; this only re-asserts it and sets
      // the title on a turn that carried one.
      this.bindConversation(turn);
      // A resumed turn already projected its start.
      if (!resumeTurn) {
        await this.emitTurnEvent(turn, "started", {}, { deferred: true });
      }
      await assertExactTurnActive();

      const canonicalPromptsWork = measurePreparation(
        "canonicalPromptsMs",
        () =>
          requireCloudContext(
            "canonical_prompt",
            this.loadCanonicalPromptsForTurn(executionSignal),
          ),
      );
      // This work can reject before the other preparation joins it. Preserve
      // that rejection for the await below without an unhandled rejection.
      void canonicalPromptsWork.catch(() => undefined);
      // The model capability is the only credential the model gateway ever
      // sees.
      const destinationsWork = measurePreparation(
        "devicesMs",
        () =>
          this.cloudHomePreparations.get(turn.turnId)?.destinations ??
          this.ownerGate(turn.ownerId)
            .devices()
            .catch(() => null),
      );
      const agentHome = this.cloudAgentHome(turn);
      if (!harnessExecution) {
        return await this.runCliTurn({
          turn,
          turnCancellation,
          executionSignal,
          resumeTurn,
          started,
          agentHome,
          preparationTimings,
          measurePreparation,
          canonicalPromptsWork,
          destinationsWork,
          assertExactTurnActive,
        });
      }
      const minted = await measurePreparation("capabilitiesMs", () =>
        mintOrchestratorTurnCapability(this.env, turn, harnessExecution),
      );
      // A resumed turn keeps presenting the capability its first isolate
      // minted while it outlives the watchdog: a fresh one is a fresh ledger,
      // which would hand the same turn its whole budget a second time.
      const persistedModel = resumeTurn
        ? await this.getTurnState<PersistedChatTurnModelCapability>(
            CHAT_TURN_MODEL_CAPABILITY_KEY,
          )
        : undefined;
      const reusedModel =
        persistedModel?.turnId === turn.turnId &&
        persistedModel.capability.expiresAt > watchdogAt + 60_000
          ? persistedModel.capability
          : undefined;
      const turnCapability = reusedModel ?? minted;
      if (!reusedModel) {
        await this.putTurnState({
          [CHAT_TURN_MODEL_CAPABILITY_KEY]: {
            turnId: turn.turnId,
            capability: minted,
          } satisfies PersistedChatTurnModelCapability,
        });
      }
      if (resumeTurn) {
        log("info", "chat_turn_resume_capability", {
          turnId: turn.turnId,
          modelCapabilityReused: Boolean(reusedModel),
        });
      }
      await assertExactTurnActive();

      // Resolve the owner's control-plane preference before any Agent Home
      // content. Disabled means no resident-memory/personality read and no
      // memory tools; unavailable or corrupt authoritative context blocks the
      // turn instead of producing a normal-looking memoryless reply.
      const executionSelection = harnessExecution;
      const modelGatewayOrigin = this.env.MODEL_GATEWAY_URL?.trim() ?? "";
      const modelGateway = this.env.MODEL_GATEWAY;
      if (!modelGatewayOrigin || !modelGateway) {
        throw new Error("Model gateway is not configured.");
      }

      if (
        executionSelection.engine === "stella" &&
        !this.gatewayPreparedInInstance &&
        !this.admittedOwnerModelGrants.has(turn.turnId)
      ) {
        this.gatewayPreparedInInstance = true;
        // Owner-admitted turns already start this preparation at ingress.
        // Prepare the owner executor and pricing while local adapters/context
        // initialize. Discard the descriptor: inference still validates the
        // current model and privacy state. This never starts a provider call.
        const gatewayPreparationStartedAt = performance.now();
        this.ctx.waitUntil(
          modelGateway
            .fetch(
              new Request(new URL(GATEWAY_PREPARE_PATH, modelGatewayOrigin), {
                method: "POST",
                headers: {
                  authorization: `Bearer ${turnCapability.token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  model: executionSelection.model,
                  agentType: "orchestrator",
                }),
                signal: AbortSignal.any([
                  executionSignal,
                  AbortSignal.timeout(10_000),
                ]),
              }),
            )
            .then(async (response) => {
              await response.arrayBuffer();
              log("info", "chat_gateway_prepared", {
                turnId: turn.turnId,
                status: response.status,
                totalMs: Math.round(
                  performance.now() - gatewayPreparationStartedAt,
                ),
              });
            })
            .catch((error: unknown) => {
              log("info", "chat_gateway_preparation_failed", {
                turnId: turn.turnId,
                message: errorMessage(error),
              });
            }),
        );
      }
      const prefetchedHome = this.cloudHomePreparations.get(turn.turnId)?.home;
      const loadHome = () => this.prepareCloudHomeContext(turn);
      const homePreparation = prefetchedHome
        ? prefetchedHome.catch(loadHome)
        : loadHome();
      this.cloudHomePreparations.delete(turn.turnId);
      const measuredHomePreparation = homePreparation.then((context) => {
        Object.assign(preparationTimings, context.timings);
        return context;
      });
      void measuredHomePreparation.catch(() => undefined);
      const acquireModelGrant = async (
        expected: LocalOwnerModelGrantExpectation,
      ) => {
        const freezeEpoch = this.localOwnerModelGrants.freezeEpoch(expected);
        const issued = await this.ownerGate(turn.ownerId).acquireModelGrant({
          ownerId: expected.ownerId,
          ownerGeneration: expected.ownerGeneration,
          conversationId: expected.conversationId,
          readerId: this.isolateId,
          turnId: expected.turnId,
          leaseId: expected.leaseId,
          fenceGeneration: expected.fenceGeneration,
          policy: expected.memoryPolicy,
        });
        const grant = this.localOwnerModelGrants.validAfter(
          issued,
          expected,
          freezeEpoch,
        );
        if (!grant) throw new OwnerPurgeFenceError();
        return { grant, expected };
      };
      let modelGrantWork =
        executionSelection.engine === "stella"
          ? measuredHomePreparation.then(async ({ memoryPreference }) => {
              const grantPreparationStartedAt = performance.now();
              if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId)
                throw new OwnerPurgeFenceError();
              const expected: LocalOwnerModelGrantExpectation = {
                ownerId: turn.ownerId,
                ownerGeneration: turn.ownerGeneration,
                conversationId: turn.conversationId,
                turnId: turn.turnId,
                leaseId: turn.ownerPurgeLeaseId,
                fenceGeneration: turn.ownerPurgeGeneration,
                memoryPolicy: memoryPreference,
              };
              const admitted = this.admittedOwnerModelGrants.get(turn.turnId);
              this.admittedOwnerModelGrants.delete(turn.turnId);
              const local = this.localOwnerModelGrants.valid(
                admitted,
                expected,
              );
              if (local) {
                log("info", "chat_model_grant_prepared", {
                  turnId: turn.turnId,
                  source: "admitted",
                  elapsedMs: Math.round(
                    performance.now() - grantPreparationStartedAt,
                  ),
                });
                return { grant: local, expected };
              }
              const acquired = await acquireModelGrant(expected);
              log("info", "chat_model_grant_prepared", {
                turnId: turn.turnId,
                source: "owner_rpc",
                elapsedMs: Math.round(
                  performance.now() - grantPreparationStartedAt,
                ),
              });
              return acquired;
            })
          : undefined;
      void modelGrantWork?.catch(() => undefined);
      const modelGrantForPhysicalRequest = async () => {
        if (!modelGrantWork) return undefined;
        const current = await modelGrantWork;
        if (
          !this.localOwnerModelGrants.valid(current.grant, current.expected)
        ) {
          // Revocation is terminal for this grant. Never turn it into a fresh
          // OwnerGate request that could race the freeze acknowledgement.
          throw new OwnerPurgeFenceError();
        }
        if (current.grant.expiresAt - Date.now() > 60_000) return current;
        modelGrantWork = acquireModelGrant(current.expected);
        void modelGrantWork.catch(() => undefined);
        return await modelGrantWork;
      };
      // Only memory reads depend on memory policy. Model resolution and other
      // context can run alongside that chain; no provider call starts here.
      const preparationWork = Promise.all([
        measuredHomePreparation,
        canonicalPromptsWork,
        measurePreparation("localeMs", () =>
          this.resolveTurnLocale(turn, () =>
            assertTurnExecutionActive(turnCancellation, executionSignal),
          ),
        ),
        measurePreparation("attachmentsMs", () =>
          this.loadChatAttachmentImages(turn, executionSignal),
        ),
        measuredHomePreparation.then((context) => context.skillCatalog),
        measurePreparation("modelResolutionMs", () =>
          createCloudRelaySession({
            audience: turn.audience,
            gatewayOrigin: modelGatewayOrigin,
            capability: turnCapability.token,
            agentType: "orchestrator",
            execution: executionSelection,
            signal: executionSignal,
            fetch: async (input, init) => {
              const request = new Request(input, init);
              // Resolution contains no prompt and can overlap home loading.
              if (new URL(request.url).pathname === GATEWAY_RESOLVE_PATH) {
                return measurePreparation("modelResolutionTransportMs", () =>
                  modelGateway.fetch(request),
                );
              }
              const execute = async (physicalRequest: Request) => {
                const localGrant = await modelGrantForPhysicalRequest();
                const activeGrant = localGrant
                  ? this.localOwnerModelGrants.begin(
                      localGrant.grant,
                      localGrant.expected,
                      physicalRequest.signal,
                    )
                  : undefined;
                const guardedRequest = activeGrant
                  ? new Request(physicalRequest, {
                      signal: activeGrant.requestSignal,
                    })
                  : physicalRequest;
                try {
                  // An eligible signed request goes straight to its owner
                  // DO; the DO retains every check.
                  const relayOwners =
                    executionSelection.engine === "stella" &&
                    turnCapability.claims.ledgerScope === "owner-relay-v2"
                      ? this.env.MODEL_GATEWAY_OWNERS
                      : undefined;
                  const guard = (requestToGuard: Request) =>
                    guardedModelFetch({
                      request: requestToGuard,
                      fetch: (value) =>
                        relayOwners
                          ? relayOwners
                              .get(
                                relayOwners.idFromName(
                                  turnCapability.claims.sub,
                                ),
                              )
                              .fetch(value)
                          : modelGateway.fetch(value),
                      mode: activeGrant
                        ? "authorize-before-fetch"
                        : "gate-body",
                      authorize: async () => {
                        await assertExactTurnActive();
                        const { memoryPreference } =
                          await measuredHomePreparation;
                        if (
                          !turn.ownerPurgeGeneration ||
                          !turn.ownerPurgeLeaseId
                        ) {
                          throw new OwnerPurgeFenceError();
                        }
                        assertTurnExecutionActive(
                          turnCancellation,
                          executionSignal,
                        );
                        if (activeGrant) activeGrant.assertValid();
                        else {
                          const policyStartedAt = performance.now();
                          await requireCloudContext(
                            "agent_home_memory",
                            this.ownerGate(turn.ownerId).assertMemoryPolicy(
                              memoryPreference,
                              turn.ownerPurgeGeneration,
                              turn.ownerPurgeLeaseId,
                              turn.turnId,
                            ),
                          );
                          log("info", "chat_model_dispatch_prepared", {
                            turnId: turn.turnId,
                            memoryRevalidationMs: Math.round(
                              performance.now() - policyStartedAt,
                            ),
                          });
                        }
                        // Count physical requests after privacy validation, including
                        // compaction and tool continuations, rather than Agent invocations.
                        await this.noteDevAcceptanceProviderDispatch();
                        assertTurnExecutionActive(
                          turnCancellation,
                          executionSignal,
                        );
                        // The dev counter is an asynchronous boundary. Freeze may
                        // arrive while it is pending, so check the local grant again
                        // at the last point before the request body is released.
                        activeGrant?.assertValid();
                      },
                    });
                  const response =
                    executionSelection.engine === "stella"
                      ? await (() => {
                          const control = this.env.MODEL_GATEWAY_CONTROL;
                          if (!control)
                            throw new Error(
                              "Model gateway cancellation is not configured.",
                            );
                          return fetchWithManagedCancellation({
                            request: guardedRequest,
                            capability: turnCapability.token,
                            control: control as ModelGatewayControl & Fetcher,
                            waitUntil: (work) => this.ctx.waitUntil(work),
                            fetch: guard,
                          });
                        })()
                      : await guard(guardedRequest);
                  if (!response.ok) {
                    subscriptionLimitNotice = nativeSubscriptionLimitNotice(
                      response.headers.get(GATEWAY_SUBSCRIPTION_LIMIT_HEADER),
                    );
                  }
                  return activeGrant
                    ? releaseOwnerModelGrantAfterBody(
                        response,
                        activeGrant.release,
                      )
                    : response;
                } catch (error) {
                  activeGrant?.release();
                  throw error;
                }
              };
              return execute(request);
            },
          }),
        ),
      ]);
      void preparationWork.catch(() => undefined);
      const destinations = await destinationsWork;
      await assertExactTurnActive();

      // Filled by exactly one of the two branches below: a fresh turn
      // prepares its window and journals its prompt; a resumed turn rebuilds
      // both from what its lost isolate already made durable.
      let turnContext!: { state: PromptContext; tools: AgentTool[] };
      let turnRelaySession!: Awaited<typeof preparationWork>[5];
      let turnHistory!: AgentMessage[];
      let turnCurrentPrompt!: AgentMessage[];
      let turnProduced: AgentMessage[] = [];
      let producedIndexBase = 0;
      if (!resumeTurn) {
        // Repair BEFORE the prompt row exists. An eviction, a cancel or a
        // watchdog abort can leave the tail as an assistant message with
        // unanswered tool calls, which the provider rejects on the next
        // request — a permanently bricked conversation. Closing it after the
        // prompt row would put a user message between the call and its result,
        // which is exactly as poisonous.
        const now = Date.now();
        for (const repaired of this.journal.repairTail(now)) {
          this.publish(repaired.record);
        }
        // Foreign rows that arrived while the previous turn was running land at
        // this clean boundary rather than splicing into a tool-call pair.
        this.drainInbox();

        // The window is chosen from resident rows only, and rollover guarantees
        // the resident floor sits below the last turn's context start — so a
        // normal turn never touches R2.
        const storedContext =
          await this.getTurnState<PromptContext>(PROMPT_CONTEXT_KEY);
        const journalEpoch = this.journal.meta().epoch;
        const previousContext = reusablePromptContext({
          storedContext,
          journalEpoch,
          ownerGeneration: turn.ownerGeneration,
        });
        const storedCheckpoint =
          previousContext || storedContext
            ? await this.getTurnState<ContextCheckpoint>(CONTEXT_CHECKPOINT_KEY)
            : undefined;
        const previousCheckpoint = previousContext
          ? storedCheckpoint
          : undefined;
        const selection = this.journal.selectWindow(
          turn.turnId,
          previousContext
            ? Number.MAX_SAFE_INTEGER
            : CLOUD_HISTORY_TOKEN_BUDGET,
          promptContextHistoryStartAfterSeq({
            previousContext,
            previousCheckpoint,
          }),
        );
        this.journal.setTurnContext(
          turn.turnId,
          selection.startSeq,
          selection.endSeq,
        );
        let journalHistory = stampUserMessageSequences(
          await this.hydrateWindow(selection),
          selection.rows,
        );
        const [
          { memoryPreference, memoryDocuments, personalityOverride },
          canonicalPrompts,
          locale,
          attachmentImages,
          skillCatalog,
          relaySession,
        ] = await preparationWork;
        turnRelaySession = relaySession;
        const memoryEnabled = memoryPreference.memoryEnabled;
        log("info", "cloud_memory_preference_loaded", {
          turnId: turn.turnId,
          ownerGeneration: memoryPreference.ownerGeneration,
          memoryEnabled,
          revision: memoryPreference.revision,
        });
        const turnTools = await this.createTools(
          turn,
          agentHome,
          skillCatalog,
          memoryEnabled,
        );
        const sections = buildCloudSystemPromptSections({
          canonicalBody: canonicalPrompts.orchestratorBody,
          tools: turnTools.promptTools,
          locale,
          threadId: turn.conversationId,
        });
        const compaction = await compactCloudHistory({
          messages: journalHistory,
          rows: selection.rows,
          checkpoint: previousCheckpoint,
          contextWindow: relaySession.model.contextWindow,
          modelMaxTokens: relaySession.model.maxTokens,
          systemPrompt: canonicalPrompts.compactionSystemPrompt,
          profile: memoryDocuments.find(
            (document) =>
              document.displayPath === LIFE_USER_PROFILE_DISPLAY_PATH,
          )?.content,
          beforeRetry: async (attempt, error) => {
            log("info", "chat_compaction_summary_failed", {
              turnId: turn.turnId,
              attempt,
              error: error instanceof Error ? error.message : String(error),
            });
            await assertExactTurnActive();
            assertTurnExecutionActive(turnCancellation, executionSignal);
          },
          summarize: async ({ systemPrompt, prompt, maxTokens }) => {
            await assertExactTurnActive();
            const Agent = await agentRuntimeWork!;
            const summaryStream = withoutPromptCache(
              relaySession.createStreamFn({ reasoningEffort: "none" }),
            );
            const summarizer = new Agent({
              initialState: {
                model: relaySession.model,
                systemPrompt,
                tools: [],
                thinkingLevel: "off",
              },
              getApiKey: () => turnCapability.token,
              sessionId: turn.conversationId,
              degenerateResponseRetries: 0,
              providerRequestLimit: 1,
              streamFn: (model, context, options) =>
                summaryStream(model, context, { ...options, maxTokens }),
            });
            this.currentAgent = summarizer;
            try {
              assertTurnExecutionActive(turnCancellation, executionSignal);
              await summarizer.prompt(prompt);
              const result = getAgentCompletion(summarizer);
              if (result.errorMessage) throw new Error(result.errorMessage);
              // As on the desktop, a summary cut off at the output cap is
              // not a summary.
              const last = summarizer.state.messages.at(-1);
              if (last?.role === "assistant" && last.stopReason !== "stop")
                throw new Error(`summary ended with ${last.stopReason}`);
              return result.finalText;
            } finally {
              this.currentAgent = undefined;
            }
          },
        });
        await assertExactTurnActive();
        journalHistory = compaction.messages;
        const contextStartSeq =
          compaction.rows[0]?.seq ?? this.journal.meta().next_seq;
        const executionContext = cloudExecutionContext(turn, destinations);
        const agentRoster = promptContextBoundary({
          previous: previousContext,
          policy: memoryPreference,
          startSeq: contextStartSeq,
          journalEpoch,
        })
          ? await this.agentRoster(turn)
          : undefined;
        const context = preparePromptContext({
          previous: previousContext,
          policy: memoryPreference,
          sections,
          tools: turnTools.tools,
          resident: cloudResidentContext({
            personality:
              personalityOverride ?? canonicalPrompts.personalityBody,
            memoryDocuments,
            skillCatalog,
            executionContext,
            agentRoster,
          }),
          sent: previousContext
            ? sentResidentPrompts(journalHistory, previousContext.epoch)
            : [],
          startSeq: contextStartSeq,
          journalEpoch,
        });
        turnContext = context;
        const prepend = context.prepend;
        const report = await this.wakeReport(turn);
        await assertExactTurnActive();
        const durablePrompt = {
          role: "user",
          content: [{ type: "text", text: report.prompt }],
          timestamp: now,
          executionContext,
          ...(turn.originUserMessageId
            ? { originUserMessageId: turn.originUserMessageId }
            : {}),
          providerContext: {
            version: 2,
            epoch: context.state.epoch,
            prepend,
            clock: new Date(now).toISOString(),
            ...(turn.attachments?.length
              ? { attachments: [...turn.attachments] }
              : {}),
          },
          ...(turn.source ? { source: turn.source } : {}),
        } as AgentMessage;
        const promptPayload = await this.spillOversizePrompt(
          turn.turnId,
          durablePrompt,
        );
        if (promptPayload.spillKey) await assertExactTurnActive();
        // The prompt, its hidden updates, and the adopted checkpoint commit
        // together. A restart cannot remember an update that was never appended.
        const contextStateChanged = context.state !== previousContext;
        const checkpointChanged = promptContextCheckpointChanged({
          storedContext,
          previousContext,
          storedCheckpoint,
          nextCheckpoint: compaction.checkpoint,
        });
        const promptRow = this.ctx.storage.transactionSync(() => {
          const row = this.journal.appendMessage({
            turnId: turn.turnId,
            writer: "orchestrator",
            writerKey: `turn:${turn.turnId}:prompt`,
            role: "user",
            hidden: turn.hiddenMessage === true,
            clientMsgId: turn.clientMsgId,
            createdAt: now,
            message: durablePrompt,
            ...promptPayload,
          });
          if (contextStateChanged)
            this.ctx.storage.kv.put(PROMPT_CONTEXT_KEY, context.state);
          if (checkpointChanged) {
            if (compaction.checkpoint)
              this.ctx.storage.kv.put(
                CONTEXT_CHECKPOINT_KEY,
                compaction.checkpoint,
              );
            else this.ctx.storage.kv.delete(CONTEXT_CHECKPOINT_KEY);
          }
          return row;
        });
        this.journal.setTurnSpan(turn.turnId, promptRow.seq);
        this.publish(promptRow.record);
        this.publishAgentTerminal(turn, report);

        const startedRow = this.journal.appendTurn({
          turnId: turn.turnId,
          writer: "orchestrator",
          writerKey: `turn:${turn.turnId}:phase:started`,
          phase: "started",
          lane: turn.lane ?? "chat",
          source: turn.source,
          promptSeq: promptRow.seq,
          createdAt: now,
        });
        this.journal.setTurnSpan(turn.turnId, startedRow.seq);
        this.publish(startedRow.record);
        this.live = {
          turnId: turn.turnId,
          streamId: null,
          partialText: "",
          tools: [],
        };

        const currentMessage = stampUserMessageSequences(
          [durablePrompt],
          [
            {
              seq: promptRow.seq,
              role: "user",
              hidden: turn.hiddenMessage === true,
            },
          ],
        )[0]!;
        turnHistory = providerHistory({
          context: context.state,
          checkpoint: compaction.checkpoint,
          messages: journalHistory,
        });
        const currentPrompt = materializeProviderContext(
          [currentMessage],
          context.state.epoch,
        );
        if (attachmentImages.length > 0) {
          const user = currentPrompt.at(-1);
          if (user?.role === "user" && Array.isArray(user.content))
            user.content.push(...attachmentImages);
        }
        turnCurrentPrompt = currentPrompt;
        this.journal.setTurnContext(
          turn.turnId,
          contextStartSeq,
          selection.endSeq,
        );
        void this.index
          .flush({ activity: "running", updatedAt: now })
          .catch(() => undefined);
        log("info", "chat_prompt_context", {
          turnId: turn.turnId,
          boundary: context.boundary,
          updates: prepend.length,
          compacted: compaction.compacted,
          startSeq: contextStartSeq,
        });
      } else {
        // Resume: the prompt row, the prompt context it adopted and the
        // history window it recorded are all durable, so rebuild exactly the
        // request the lost isolate was sending instead of preparing a new one.
        // Nothing is appended before the open calls are answered: an inbox
        // row or a repair landing between a tool call and its result would
        // poison the provider request.
        const [
          { memoryPreference, memoryDocuments, personalityOverride },
          canonicalPrompts,
          locale,
          attachmentImages,
          skillCatalog,
          relaySession,
        ] = await preparationWork;
        turnRelaySession = relaySession;
        const journalEpoch = this.journal.meta().epoch;
        const previousContext = reusablePromptContext({
          storedContext:
            await this.getTurnState<PromptContext>(PROMPT_CONTEXT_KEY),
          journalEpoch,
          ownerGeneration: turn.ownerGeneration,
        });
        const range = this.journal.turnContextRange(turn.turnId);
        if (!previousContext) {
          throw new ChatTurnNotResumableError("prompt_context");
        }
        if (!range || previousContext.startSeq !== range.startSeq) {
          throw new ChatTurnNotResumableError("context_range");
        }
        const turnTools = await this.createTools(
          turn,
          agentHome,
          skillCatalog,
          memoryPreference.memoryEnabled,
        );
        const context = resumePromptContext({
          previous: previousContext,
          policy: memoryPreference,
          tools: turnTools.tools,
          startSeq: range.startSeq,
          journalEpoch,
        });
        // A boundary (memory disabled or erased, an owner reset) means the
        // frozen context the lost isolate sent may carry context that must
        // not be sent again. Fail rather than resume across it.
        if (!context) {
          throw new ChatTurnNotResumableError("context_boundary");
        }
        turnContext = context;
        const checkpoint = await this.getTurnState<ContextCheckpoint>(
          CONTEXT_CHECKPOINT_KEY,
        );
        const selection = this.journal.selectRange(
          turn.turnId,
          range.startSeq,
          range.endSeq,
        );
        const journalHistory = stampUserMessageSequences(
          await this.hydrateWindow(selection),
          selection.rows,
        );
        turnHistory = providerHistory({
          context: context.state,
          checkpoint,
          messages: journalHistory,
        });
        const own = this.journal.selectTurnMessages(turn.turnId);
        const ownMessages = await this.hydrateWindow(own);
        if (own.rows[0]?.role !== "user" || !ownMessages[0]) {
          throw new ChatTurnNotResumableError("prompt_row");
        }
        const promptMessage = stampUserMessageSequences(
          [ownMessages[0]],
          [own.rows[0]],
        )[0]!;
        const currentPrompt = materializeProviderContext(
          [promptMessage],
          context.state.epoch,
        );
        if (attachmentImages.length > 0) {
          const user = currentPrompt.at(-1);
          if (user?.role === "user" && Array.isArray(user.content))
            user.content.push(...attachmentImages);
        }
        turnCurrentPrompt = currentPrompt;
        const produced = ownMessages.slice(1);
        const counts = { rerun: 0, interrupted: 0, notStarted: 0 };
        const open = this.journal
          .openTailCalls()
          .filter((call) => call.turnId === turn.turnId);
        for (let index = 0; index < open.length; index += 1) {
          await assertExactTurnActive();
          const call = open[index]!;
          const resolved = await resolveOpenToolCall({
            tools: context.tools,
            call,
            started: index === 0,
            signal: executionSignal,
            now: () => Date.now(),
          });
          await assertExactTurnActive();
          const appended = this.journal.appendRepairedResult(
            turn.turnId,
            resolved.message,
            Date.now(),
          );
          this.journal.setTurnSpan(turn.turnId, appended.seq);
          this.publish(appended.record);
          produced.push(resolved.message);
          if (resolved.disposition === "rerun") counts.rerun += 1;
          else if (resolved.disposition === "interrupted")
            counts.interrupted += 1;
          else counts.notStarted += 1;
        }
        turnProduced = produced;
        producedIndexBase = this.journal.maxProducedIndex(turn.turnId) + 1;
        this.live = {
          turnId: turn.turnId,
          streamId: null,
          partialText: "",
          tools: [],
        };
        void this.index
          .flush({ activity: "running", updatedAt: Date.now() })
          .catch(() => undefined);
        log("info", "chat_turn_resume_context", {
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          historyRows: selection.rows.length,
          producedRows: produced.length,
          summarized: Boolean(checkpoint),
          finishedBeforeLoss: produced.at(-1)?.role === "assistant",
          ...counts,
        });
      }
      // Revalidate at the provider boundary below, including retries. Agent
      // construction does not send context, so a second check here only adds
      // a control-plane round trip before the same mandatory validation.

      // The watchdog (or /cancel) may have fired during the setup awaits
      // above, before currentAgent exists for abort() to reach — re-check so
      // an already-terminal turn never starts the loop at all.
      try {
        await assertExactTurnActive();
      } catch (error) {
        if (
          turnCancellation.aborted ||
          (await this.getTurnState<boolean>("terminal"))
        ) {
          // The prompt row is already committed, so this turn has content
          // worth indexing even though the loop never ran. Returning without
          // this is how a canceled turn used to vanish from the search index permanently.
          await this.afterTerminal(turn);
          return json({ ok: false, canceled: true });
        }
        throw error;
      }

      await assertExactTurnActive();
      const Agent = await agentRuntimeWork!;
      // No await is allowed between this local latch and constructing the
      // Agent. The next async admission boundary repeats the same check.
      assertTurnExecutionActive(turnCancellation, executionSignal);
      const steerable: SteerableTurn = {
        turn,
        watchdogAt,
        waiting: [],
        injected: new Map(),
      };
      const agent: RuntimeAgent = new Agent({
        initialState: {
          systemPrompt: turnContext.state.frozen.systemPrompt,
          model: turnRelaySession.model,
          tools: turnContext.tools,
          messages: resumeTurn
            ? [...turnHistory, ...turnCurrentPrompt, ...turnProduced]
            : turnHistory,
        },
        sessionId: turn.conversationId,
        getApiKey: () => turnCapability.token,
        toolExecution: "sequential",
        toolInactivityTimeoutMs: 60_000,
        // Re-prune and strip stale images before EVERY provider call, exactly
        // as the desktop loop does. The journal window selected above is the
        // turn's base; without this per-call guard a tool-heavy turn (web
        // results at ~20KB each) grows unchecked toward the model's declared
        // window with only the pre-turn budget as slack. First-party
        // Anthropic routes use the 1h cache tier so an agent completion
        // wakes this conversation on a warm prefix; resumed turns derive the
        // same tier from the same route (orchestrator-cache-retention.ts).
        streamFn: withOrchestratorCacheRetention(
          turnRelaySession.createStreamFn({
            reasoningEffort: executionSelection.reasoningEffort,
            transformContext: async (resolvedModel, rawContext, signal) => {
              const messages = await buildDefaultTransformContext({
                model: resolvedModel,
              })(rawContext.messages, signal);
              return {
                ...rawContext,
                messages: messages.filter(
                  (message) =>
                    message.role === "user" ||
                    message.role === "assistant" ||
                    message.role === "toolResult",
                ),
              };
            },
          }),
          () => turnRelaySession.model,
        ),
        // The outer ladder below owns empty completions and physical request
        // attempts — the same division of labor as the desktop runtime
        // (`createRuntimeAgent`), which disables the loop's built-in
        // double-call for the same reason.
        degenerateResponseRetries: 0,
        providerRequestLimit: AGENT_RUN_MAX_ATTEMPTS,
        getSteeringMessages: () => this.takeSteeredWakes(steerable),
      });

      // Incremental persistence: every produced message is committed as it is
      // produced. A DO eviction at minute four of a five-minute turn used to
      // discard everything the turn had done; now it loses at most the message
      // still streaming. This is only safe because repairTail() above closes
      // whatever tool calls such an eviction leaves open.
      //
      // The handler is synchronous on purpose. The Agent's event sink is
      // fire-and-forget — a returned promise is dropped — so an `await` here
      // would silently lose rows. SQLite in a DO is synchronous, which is what
      // makes that constraint costless.
      let producedIndex = producedIndexBase;
      let streamId: string | null = null;
      let persistError: string | undefined;
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        // Agent.abort() can race one last provider callback. The subscriber is
        // synchronous, so this in-memory latch is the only check that can sit
        // directly in front of every journal append/broadcast without opening
        // another await-sized TOCTOU window.
        if (turnCancellation.aborted || executionSignal.aborted) return;
        try {
          if (event.type === "message_end" && event.message.role === "user") {
            // Submitted user blocks already exist as durable prompt metadata.
            if (turnCurrentPrompt.includes(event.message)) return;
            const steered = steerable.injected.get(event.message);
            if (steered) {
              steerable.injected.delete(event.message);
              this.absorbSteeredWake(turn, steered);
              return;
            }
          }
          this.onAgentEvent(turn, event, {
            nextIndex: () => producedIndex++,
            streamId: () => streamId,
            setStreamId: (value) => {
              streamId = value;
            },
          });
        } catch (error) {
          // A failed transcript write must fail the turn: the model's
          // in-memory history would otherwise diverge from what the user is
          // shown, and the next turn would read a history the user never saw.
          persistError ??= errorMessage(error);
          agent.abort();
        }
      });

      // The desktop runtime's transient ladder, verbatim: resume the same
      // in-memory context after a retryable provider/transport failure
      // instead of failing the whole turn on one blip. The Effect cancellation
      // latch is wired to the cancel/watchdog paths so an aborted turn classifies as
      // canceled (never retried) and a cancel during backoff wakes the sleep.
      const retryState = { attemptsUsed: 0, retriesUsed: 0 };
      this.currentAgent = agent;
      this.steerableTurn = steerable;
      let execution: { finalText: string; errorMessage?: string };
      try {
        execution = await executeAgentRunWithRetry({
          state: retryState,
          isCanceled: () => turnCancellation.aborted,
          sleep: (milliseconds) => turnCancellation.sleep(milliseconds),
          execute: async (resume) => {
            await assertExactTurnActive();
            // The model transport checks memory policy and the exact lease
            // before every physical request, including tools and compaction.
            log("info", "chat_turn_prepared", {
              turnId: turn.turnId,
              conversationId: turn.conversationId,
              admissionMs: turn.queuedAt
                ? Math.round(
                    Date.now() - turn.queuedAt - (performance.now() - started),
                  )
                : undefined,
              totalPreparationMs: Math.round(performance.now() - started),
              ...preparationTimings,
            });

            // Stop cannot interleave between this synchronous latch and
            // Agent.prompt/continue entering _runLoop and creating its own
            // provider/tool controller.
            assertTurnExecutionActive(turnCancellation, executionSignal);
            if (resume) {
              await agent.continue();
            } else if (resumeTurn) {
              // A reply journaled before the loss only lacks its terminal;
              // asking the model again would bill and possibly change it.
              if (agent.state.messages.at(-1)?.role !== "assistant") {
                await agent.continue();
              }
            } else {
              await agent.prompt(turnCurrentPrompt);
            }
            const completion = getAgentCompletion(agent);
            return { ...completion, finalText: completion.finalText.trim() };
          },
          prepareResume: (reason, classification) => {
            // A subscription reset is minutes or hours away; retrying this
            // turn hides the actionable notice behind minute-long backoffs.
            if (subscriptionLimitNotice) return false;
            const prepared = prepareTransientResumeTail(
              agent.state.messages,
              classification,
            );
            if (prepared) {
              log("info", "chat_turn_transient_retry", {
                turnId: turn.turnId,
                conversationId: turn.conversationId,
                category: classification.category,
                message: reason,
              });
            }
            return prepared;
          },
          onRetry: (info) => {
            log("info", "chat_turn_retry_scheduled", {
              turnId: turn.turnId,
              conversationId: turn.conversationId,
              category: info.category,
              retryNumber: info.retryNumber,
              nextAttempt: info.nextAttempt,
              delayMs: info.delayMs,
            });
          },
        });
      } finally {
        this.currentAgent = undefined;
        if (this.steerableTurn === steerable) this.steerableTurn = undefined;
      }
      unsubscribe();
      // Oversize-row promotion, the only work the sync handler defers.
      await this.background.catch(() => undefined);
      if (persistError) {
        throw new Error(`Persisting the reply failed: ${persistError}`);
      }

      if (await this.getTurnState<boolean>("terminal")) {
        // Canceled or timed out mid-loop; the terminal event and its journal
        // record are already written by whichever path marked it terminal.
        // The post-terminal work is not: that path deliberately leaves it to
        // the loop, which is the only caller that knows the loop has stopped
        // and that a drain or a rollover is therefore safe.
        await this.afterTerminal(turn);
        return json({ ok: false, canceled: true });
      }

      // Everything the loop produced is already committed, row by row, above.
      const finalText = execution.finalText;
      if (execution.errorMessage) {
        throw new Error(execution.errorMessage);
      }
      return await this.completeChatTurn(turn, finalText, started);
    } catch (error) {
      const message = errorMessage(error);
      const contextFailure = cloudContextFailure(error);
      const terminalNotice = contextFailure
        ? CLOUD_CONTEXT_NOTICE
        : error instanceof CliTurnFailedError && error.userMessage
          ? error.userMessage
          : (subscriptionLimitNotice ?? TERMINAL_NOTICE.failed);
      const terminalPayload = contextFailure
        ? {
            message: terminalNotice,
            code: contextFailure.code,
            component: contextFailure.component,
          }
        : { message: terminalNotice };
      log("error", "chat_turn_failed", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        message,
      });
      if (contextFailure) {
        log("error", "cloud_context_blocked", {
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          code: contextFailure.code,
          component: contextFailure.component,
          ...(contextFailure.repairSeq !== undefined
            ? { corruptSeq: contextFailure.repairSeq }
            : {}),
        });
      }
      if (!(await this.getTurnState<boolean>("terminal"))) {
        // Same pairing as `/cancel`: the alarm retries what is owed, so what
        // is owed becomes durable in the same write that says a terminal was
        // reached at all.
        const failedOwed: OwedTerminal = {
          kind: "failed",
          message: terminalNotice,
          payload: terminalPayload,
          eventSeq: await this.nextTurnEventSeq(turn.turnId),
        };
        await this.ctx.storage.put({
          terminal: true,
          terminalOwed: failedOwed,
        });
        // The raw message is often a provider error blob or infrastructure
        // detail; it belongs in logs, never in the user's chat bubble — and
        // never in a frame either. `ref` in the socket's error frame is the
        // correlation key back to this log line.
        this.recordTerminal(turn, "failed", terminalNotice);
        try {
          await this.emitTurnEvent(turn, "failed", terminalPayload, {
            terminal: true,
            eventSeq: failedOwed.eventSeq,
            errorMessage: terminalNotice,
          });
          await this.ctx.storage.put("terminalDelivered", true);
        } catch {
          // Delivery failed; the re-armed alarm retries so the turn cannot
          // stay "running" forever.
          await this.ctx.storage.setAlarm(Date.now() + 30_000);
        }
      }
      await this.observeDevAcceptanceContextFailure(contextFailure).catch(
        (probeError) => {
          log("error", "dev_acceptance_context_fault_repair_failed", {
            message: errorMessage(probeError),
          });
        },
      );
      await this.afterTerminal(turn);
      return json(
        contextFailure
          ? {
              error: "Cloud chat turn failed.",
              code: contextFailure.code,
              component: contextFailure.component,
            }
          : { error: "Cloud chat turn failed.", detail: message },
        502,
      );
    } finally {
      this.live = null;
      this.hub.endTurn(turn.turnId);
      if (this.activeTurnId === turn.turnId) this.activeTurnId = null;
      if (this.currentTurnCancellation === turnCancellation) {
        this.currentTurnCancellation = undefined;
      }
      const unregisterAt = performance.now();
      await this.unregisterOwnerTurn(turn);
      const releaseAt = performance.now();
      await this.releaseOwnerGate(turn);
      log("info", "chat_turn_released", {
        turnId: turn.turnId,
        unregisterMs: Math.round(releaseAt - unregisterAt),
        releaseGateMs: Math.round(performance.now() - releaseAt),
      });
    }
  }
}
