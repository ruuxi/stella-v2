import type { DevicesResponse } from "@stella/contracts/turn-plane/placement";
import { attachedFilesText } from "../prompt-context.js";
import { formatMessageRefTag } from "@stella/contracts/reply-refs";
import { buildCloudSkillsBlock } from "../cloud-skills.js";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import {
  assertTurnExecutionActive,
  type TurnRetryCancellation,
} from "../turn-cancellation.js";
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
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import type { CanonicalPrompts } from "../cloud-prompt.js";
import type { ExactTurnCancellation } from "../execution-placement-turn-cancellation.js";
import type {
  ChatTurnRequest,
  LocalTurnLease,
  PersistedChatTurnModelCapability,
  OwedTerminal,
} from "./types.js";
import {
  CHAT_WATCHDOG_MS,
  PI_JOURNAL_IMPORT_BATCH,
  PI_MIRRORED_KEY,
  CHECKPOINT_TURN_SCAN,
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
  piModelSpec,
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
import type { OrchestratorOwner } from "./owner.js";

/** One admitted chat turn, start to terminal, on Stella's loop or on pi. */
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
    // A turn already terminal in the journal.
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
      // container (`runCliTurn`); Stella-model and ChatGPT-plan turns run on
      // pi-durable (`runPiTurn`).
      const harnessExecution =
        turn.execution.engine === "anthropic" ? undefined : turn.execution;
      if (turn.piAgent && harnessExecution?.engine !== "stella") {
        throw new Error(
          "A computer's cloud agents run on Stella's models; this conversation's cloud turns use another engine.",
        );
      }
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
      const acquireModelGrant = (expected: LocalOwnerModelGrantExpectation) =>
        this.acquireOwnerModelGrant(expected);
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
      // The turn's one transport to the model gateway: owner fence, model
      // grant and managed cancellation on every physical request.
      const relayFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
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
                        .get(relayOwners.idFromName(turnCapability.claims.sub))
                        .fetch(value)
                    : modelGateway.fetch(value),
                mode: activeGrant ? "authorize-before-fetch" : "gate-body",
                authorize: async () => {
                  await assertExactTurnActive();
                  const { memoryPreference } = await measuredHomePreparation;
                  if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
                    throw new OwnerPurgeFenceError();
                  }
                  assertTurnExecutionActive(turnCancellation, executionSignal);
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
                  assertTurnExecutionActive(turnCancellation, executionSignal);
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
              ? releaseOwnerModelGrantAfterBody(response, activeGrant.release)
              : response;
          } catch (error) {
            activeGrant?.release();
            throw error;
          }
        };
        return execute(request);
      };
      return await this.runPiTurn({
        turn,
        turnCancellation,
        executionSignal,
        resumeTurn,
        started,
        execution: harnessExecution,
        capability: turnCapability.token,
        relayFetch,
        gatewayOrigin: modelGatewayOrigin,
        homeWork: measuredHomePreparation,
        canonicalPromptsWork,
        destinationsWork,
        measurePreparation,
        preparationTimings,
        assertExactTurnActive,
      });
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

  /**
   * One chat turn on the Claude Code CLI. Same claim, preparation, prompt
   * row, terminal ladder and post-terminal work as Stella's own loop; what
   * differs is who runs the model. No model capability is minted here, no
   * relay session or summarizer exists (Claude Code compacts its own
   * session), and the turn is dispatched once: a resumed turn that finds its
   * dispatch record waits for that exact attempt's terminal instead.
   */
  /**
   * A Stella-model turn of a conversation that runs on pi-durable. The turn
   * plane around it is unchanged: admission, owner fence, the turn's model
   * capability and guarded transport, watchdog, terminal delivery. pi owns
   * the run: the prompt goes to its root conversation under the turn id, so
   * a turn resumed after an eviction finds the same submission, and pi's
   * committed messages are mirrored into the journal for `/history`, the
   * socket and the existing clients.
   */
  protected async runPiTurn(args: {
    turn: ChatTurnRequest;
    turnCancellation: TurnRetryCancellation;
    executionSignal: AbortSignal;
    resumeTurn: boolean;
    started: number;
    execution: import("../pi-runtime.js").PiExecution;
    capability: string;
    relayFetch: typeof fetch;
    gatewayOrigin: string;
    homeWork: ReturnType<OrchestratorOwner["prepareCloudHomeContext"]>;
    canonicalPromptsWork: Promise<CanonicalPrompts>;
    destinationsWork: Promise<DevicesResponse | null>;
    measurePreparation: <T>(name: string, work: () => Promise<T>) => Promise<T>;
    preparationTimings: Record<string, number>;
    assertExactTurnActive: () => Promise<void>;
  }): Promise<Response> {
    const { turn, turnCancellation, executionSignal, assertExactTurnActive } =
      args;
    const [home, canonicalPrompts, destinations, pi] = await Promise.all([
      args.homeWork,
      args.canonicalPromptsWork,
      args.destinationsWork,
      import("../pi-runtime.js"),
    ]);
    await assertExactTurnActive();
    const executionContext = cloudExecutionContext(turn, destinations);
    const modelSpec = (
      agentType: "orchestrator" | "general",
      execution: Extract<CloudExecutionSelection, { engine: "stella" }>,
    ) => piModelSpec(agentType, execution, turn.audience);
    const binding: import("../pi-runtime.js").PiTurnBinding = {
      turnId: turn.turnId,
      capability: args.capability,
      fetch: args.relayFetch,
      // Agents this turn starts run on this owner's authority after it ends.
      authority: {
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        conversationId: turn.conversationId,
        audience: turn.audience,
        budgetMicroCents: turn.budgetMicroCents,
        execution: args.execution,
      },
      // A ChatGPT plan turn runs on the plan's model, which the gateway does not resolve.
      ...(args.execution.engine === "stella"
        ? {
            stellaModels: {
              model: modelSpec("orchestrator", args.execution),
              agentModel: modelSpec("general", args.execution),
            },
          }
        : {}),
      thinkingLevel: pi.thinkingLevelFor(
        args.execution.reasoningEffort,
        args.execution.engine,
      ),
      tools: async () =>
        (
          await this.createTools(
            turn,
            this.cloudAgentHome(turn),
            home.skillCatalog,
            home.memoryPreference.memoryEnabled,
            "pi",
          )
        ).catalog,
      sources: {
        orchestratorPrompt: canonicalPrompts.orchestratorBody,
        personality:
          home.personalityOverride ?? canonicalPrompts.personalityBody,
        memory: pi.memoryFromDocuments(
          home.memoryPreference.memoryEnabled,
          home.memoryDocuments,
        ),
        skillsCatalog: buildCloudSkillsBlock(home.skillCatalog) || undefined,
        executionContext,
        locale: await this.resolveTurnLocale(turn),
      },
    };
    const runtime = await this.openPiRuntime(args.gatewayOrigin);
    const unbind = await runtime.bind(binding);
    const context = pi.contextFor(executionSignal);
    let stream: Awaited<ReturnType<typeof runtime.follow>> | undefined;
    let mirrored = (await this.ctx.storage.get<number>(PI_MIRRORED_KEY)) ?? 0;
    try {
      const report = await this.wakeReport(turn);
      const promptKey = `turn:${turn.turnId}:prompt`;
      const promptSeq =
        args.resumeTurn && this.journal.hasRow(promptKey)
          ? this.journal.selectTurnMessages(turn.turnId).rows[0]?.seq
          : await this.journalCliPrompt(turn, executionContext, report, "pi");
      if (promptSeq === undefined) {
        throw new ChatTurnNotResumableError("prompt_row");
      }
      this.live = {
        turnId: turn.turnId,
        streamId: null,
        partialText: "",
        tools: [],
      };
      void this.index
        .flush({ activity: "running", updatedAt: Date.now() })
        .catch(() => undefined);
      await runtime.configureRoot(binding, context);
      // A reply the journal could not take fails the turn, as the loop's
      // does: what the user is shown and what Stella read must not diverge.
      // The entry stays unmirrored, so the next turn writes it again.
      let persistError: string | undefined;
      stream = await runtime.follow(
        mirrored,
        (entry) => {
          if (persistError !== undefined) return;
          const message = entry.model?.[0];
          if (
            message &&
            (entry.kind === "pi.assistant" ||
              entry.kind === "pi.tool-result") &&
            // Written from the journal: another writer's, already there.
            pi.journalSeqOf(entry) === undefined
          ) {
            try {
              const appended = this.appendProduced(
                turn,
                message as unknown as AgentMessage,
                {
                  writer: "orchestrator",
                  writerKey: `pi:${entry.id}`,
                  streamId: null,
                },
              );
              if (appended) this.publish(appended.record);
            } catch (error) {
              persistError = errorMessage(error);
              this.currentPiRun?.abort();
              return;
            }
          }
          mirrored = Math.max(mirrored, entry.id);
        },
        context,
        // Every client shows a turn's tools as they run, as the loop's.
        (tool) =>
          this.noteTurnTool(
            turn,
            { toolCallId: tool.toolCallId, name: tool.name, args: tool.args },
            tool.phase,
            tool.isError,
          ),
      );
      await assertExactTurnActive();
      if (turn.piAgent) {
        await runtime.originAgent(
          turn.piAgent,
          turn.prompt,
          turn.turnId,
          context,
        );
        log("info", "pi_origin_agent_op", {
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          op: turn.piAgent.op,
          threadId: turn.piAgent.threadId,
        });
        return await this.completeChatTurn(turn, "", args.started);
      }
      // What other writers journaled since (a computer's turns, another
      // engine's) is part of the conversation this turn answers.
      const [, images] = await Promise.all([
        // Rows already rolled over to R2 are read from there.
        runtime.importJournal(
          (afterSeq) =>
            this.archive.readRange(
              afterSeq + 1,
              Number.MAX_SAFE_INTEGER,
              PI_JOURNAL_IMPORT_BATCH,
            ),
          turn.turnId,
          context,
        ),
        this.loadChatAttachmentImages(turn, executionSignal),
      ]);
      const { root } = await runtime.open();
      const clock = new Date().toISOString();
      const text = turn.hiddenMessage
        ? report.prompt
        : `${report.prompt.replace(/\s+$/u, "")}\n\n${formatMessageRefTag(promptSeq)}`;
      // Marked as the journal row is: the clock is context, and a prompt the
      // user did not write (a wake, an agent's note) is read, not shown.
      const hidden = { stella: { hidden: true as const } };
      const submission = await root.submit(
        {
          type: "input",
          requestId: `turn:${turn.turnId}`,
          whenBusy: "followUp",
          content: [
            {
              type: "text",
              text: `<current-time>${clock}</current-time>`,
              ...hidden,
            },
            { type: "text", text, ...(turn.hiddenMessage ? hidden : {}) },
            ...(turn.attachments?.length
              ? [
                  {
                    type: "text" as const,
                    text: attachedFilesText(turn.attachments, {
                      readableHere: true,
                    }),
                  },
                ]
              : []),
            ...images,
          ],
        },
        context,
      );
      log("info", "pi_turn_submitted", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        submissionId: submission.id,
        resumed: args.resumeTurn,
        preparationMs: Math.round(performance.now() - args.started),
        ...args.preparationTimings,
      });
      this.currentPiRun = {
        abort: () => {
          void root.abort(pi.contextFor()).catch((error: unknown) => {
            log("error", "pi_turn_abort_failed", {
              turnId: turn.turnId,
              message: errorMessage(error),
            });
          });
        },
      };
      if (executionSignal.aborted || turnCancellation.aborted) {
        this.currentPiRun.abort();
      }
      let settled: Awaited<ReturnType<typeof submission.wait>>;
      try {
        settled = await submission.wait(context);
      } catch (error) {
        if (
          turnCancellation.aborted ||
          executionSignal.aborted ||
          (await this.getTurnState<boolean>("terminal"))
        ) {
          // Stop or the watchdog wrote the terminal; pi was aborted with it.
          this.currentPiRun?.abort();
          await this.afterTerminal(turn);
          return json({ ok: false, canceled: true });
        }
        if (persistError !== undefined) {
          throw new Error(`Persisting the reply failed: ${persistError}`);
        }
        throw error;
      }
      if (persistError !== undefined) {
        throw new Error(`Persisting the reply failed: ${persistError}`);
      }
      if (await this.getTurnState<boolean>("terminal")) {
        await this.afterTerminal(turn);
        return json({ ok: false, canceled: true });
      }
      if (settled.status !== "done") {
        throw new Error(
          `Stella could not answer this turn (${settled.reason}).`,
        );
      }
      const finalText = (await runtime.answer(settled, context)).trim();
      log("info", "pi_turn_answered", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        wallClockMs: Math.round(performance.now() - args.started),
      });
      return await this.completeChatTurn(turn, finalText, args.started);
    } finally {
      this.currentPiRun = undefined;
      unbind();
      await stream?.stop().catch(() => undefined);
      await this.ctx.storage
        .put(PI_MIRRORED_KEY, mirrored)
        .catch(() => undefined);
      // Agents this turn started keep running after it.
      await this.piHeartbeat().catch(() => undefined);
      // A compaction this turn (or one since the last) is every host's checkpoint.
      await runtime
        .publishCheckpoint(
          () =>
            this.journal.recentTurnIds("orchestrator", CHECKPOINT_TURN_SCAN),
          (summary, firstKept) =>
            this.storeJournalCheckpoint(summary, firstKept),
          pi.contextFor(),
        )
        .catch((error: unknown) =>
          log("error", "journal_checkpoint_publish_failed", {
            message: errorMessage(error),
          }),
        );
      await this.placeBrainHandoff(
        turn.turnId,
        turnCancellation.aborted || executionSignal.aborted,
      );
    }
  }
}
