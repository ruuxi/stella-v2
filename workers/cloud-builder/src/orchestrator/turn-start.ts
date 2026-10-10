import {
  type AdmittedCloudChat,
  chatTurnFingerprintSource,
  type CloudChatPreparation,
} from "../cloud-chat-admission.js";
import type {
  ConversationCreatedEvent,
  OwnerEvent,
  TurnStartedEvent,
} from "@stella/contracts/turn-plane/owner-events";
import {
  type CloudTurnLane,
  type CloudTurnStartResponse,
  TURN_OWNER_GENERATION_HEADER,
  TURN_PLANE_PROTOCOL,
  TURN_PROMPT_MAX_CHARS,
} from "@stella/contracts/turn-plane/turn-start";
import { CLOUD_SANDBOX_SUBSCRIPTION_REQUIRED_MESSAGE } from "@stella/contracts/backend/billing";
import {
  type OwnerGateAdmission,
  type OwnerGateAdmissionWithLease,
  type OwnerGateAdmitInput,
  snapshotAllowsCloudSandbox,
  snapshotAllowsExecutionEngine,
} from "../owner-gate.js";
import {
  conversationTitleFor,
  HEADER_TURN_AUTH_KIND,
  parseCloudTurnStartRequest,
  serviceOnlyTurnFields,
  turnStartErrorResponse,
} from "../turn-start-request.js";
import { sha256Hex } from "../hash.js";
import { HEADER_OWNER } from "../conversation-types.js";
import { normalizeOwnerGeneration } from "../owner-generation.js";
import type {
  ChatTurnRequest,
  ChatTurnAdmissionReceipt,
  OwnerFencedTurn,
  OwnerFenceLeaseReceipt,
  LocalTurnLease,
} from "./types.js";
import {
  CHAT_WATCHDOG_MS,
  LOCAL_TURN_LEASE_KEY,
  chatTurnAdmissionKey,
  CONVERSATION_PROJECTED_KEY,
  ownerPurgeImportedLeaseKey,
  orchestratorFenceLeaseReceiptKey,
} from "./constants.js";
import {
  OwnerPurgeFenceError,
  OwnerFenceLeaseConflictError,
  OwnerFenceRegistrationUncertainError,
  mintOrchestratorTurnCapability,
  isDurableChatTurnAdmissionIntent,
  localTurnRetirementDeadline,
  json,
  log,
} from "./support.js";
import { OrchestratorLocalTurn } from "./local-turn.js";

/** Turn start: admission, idempotency, ownership, and the owner gate. */
export abstract class OrchestratorTurnStart extends OrchestratorLocalTurn {
  protected async handleTurnStart(
    request: Request,
    handoff?: {
      authority: AdmittedCloudChat;
      preparation: CloudChatPreparation;
    },
  ): Promise<Response> {
    // These headers are trustable because a Durable Object namespace is not
    // publicly addressable: only the Worker can produce this request, and it
    // strips any client-supplied x-stella-* before forwarding.
    const ownerId = request.headers.get(HEADER_OWNER)?.trim() ?? "";
    const authKind = request.headers.get(HEADER_TURN_AUTH_KIND)?.trim() ?? "";
    if (!ownerId || (authKind !== "user" && authKind !== "service")) {
      return turnStartErrorResponse(
        "unauthorized",
        "Sign in to send messages.",
        false,
      );
    }
    const expectedGeneration =
      authKind === "service"
        ? normalizeOwnerGeneration(
            request.headers.get(TURN_OWNER_GENERATION_HEADER),
          )
        : null;
    if (authKind === "service" && !expectedGeneration) {
      return turnStartErrorResponse(
        "bad_request",
        `Service callers must send ${TURN_OWNER_GENERATION_HEADER}.`,
        false,
      );
    }
    const parsed = parseCloudTurnStartRequest(
      await request.json().catch(() => null),
    );
    if (!parsed.ok) {
      return turnStartErrorResponse("bad_request", parsed.message, false);
    }
    const start = parsed.request;
    if (authKind === "user") {
      const restricted = serviceOnlyTurnFields(start);
      if (restricted.length > 0) {
        return turnStartErrorResponse(
          "forbidden",
          `${restricted.join(", ")} require service authentication.`,
          false,
        );
      }
    }
    const lane: CloudTurnLane = start.lane ?? "chat";
    // A wake is an agent's report (with agentThreadControl) or an agent's
    // message to this Stella (without); no other lane carries a control.
    if (lane !== "wake" && start.agentThreadControl !== undefined) {
      return turnStartErrorResponse(
        "bad_request",
        "Only wake turns carry agentThreadControl.",
        false,
      );
    }
    if (this.purged()) {
      return turnStartErrorResponse(
        "owner_purged",
        "This conversation was deleted.",
        false,
      );
    }
    const wakeReportSpillKey = await this.spillLargeWakeReport(start);
    if (wakeReportSpillKey === null) {
      return turnStartErrorResponse(
        "internal",
        "The agent report could not be stored yet.",
        true,
        5_000,
      );
    }
    const conversationId = this.conversationId();
    const admissionFingerprint = await sha256Hex(
      chatTurnFingerprintSource(ownerId, conversationId, start),
    );
    const imported = handoff?.authority;
    if (
      imported &&
      (imported.version !== 1 ||
        imported.ownerId !== ownerId ||
        imported.conversationId !== conversationId ||
        imported.clientMsgId !== start.clientMsgId ||
        imported.ownerGeneration !== expectedGeneration ||
        imported.snapshot.ownerGeneration !== expectedGeneration ||
        imported.fingerprint !== admissionFingerprint ||
        !imported.turnId ||
        !imported.leaseId ||
        !imported.fenceGeneration)
    ) {
      return turnStartErrorResponse(
        "idempotency_conflict",
        "Invalid cloud admission identity.",
        false,
      );
    }
    return await this.withTurnAdmissionLock(async () => {
      const boundOwner = this.journal.meta().owner_id;
      if (boundOwner && boundOwner !== ownerId) {
        return turnStartErrorResponse(
          "owner_mismatch",
          "That conversation belongs to another account.",
          false,
        );
      }
      const receiptKey = chatTurnAdmissionKey(start.clientMsgId);
      const stored =
        await this.ctx.storage.get<Partial<ChatTurnAdmissionReceipt>>(
          receiptKey,
        );
      let receipt: ChatTurnAdmissionReceipt | undefined;
      if (stored) {
        if (
          imported &&
          (stored.turnId !== imported.turnId ||
            stored.leaseId !== imported.leaseId ||
            stored.ownerGeneration !== imported.ownerGeneration)
        ) {
          return turnStartErrorResponse(
            "idempotency_conflict",
            "Cloud admission identity changed.",
            false,
          );
        }
        if (stored.fingerprint !== admissionFingerprint) {
          return turnStartErrorResponse(
            "idempotency_conflict",
            "That message id was already used for a different message.",
            false,
          );
        }
        if (
          !isDurableChatTurnAdmissionIntent(stored) ||
          stored.ownerId !== ownerId
        ) {
          return turnStartErrorResponse(
            "idempotency_conflict",
            "That message id has malformed admission authority.",
            false,
          );
        }
        if (stored.phase === "accepted") {
          return json(
            {
              protocol: TURN_PLANE_PROTOCOL,
              conversationId,
              turnId: stored.turnId,
              accepted: true,
              replayed: true,
              createdConversation: stored.createdConversation,
            } satisfies CloudTurnStartResponse,
            202,
          );
        }
        // The intent is keyed by clientMsgId, so a retry after a lost
        // response reaches this exact identity before it can mint a second
        // turn id or owner-fence lease.
        receipt = stored;
      }
      const turnId = receipt?.turnId ?? imported?.turnId ?? crypto.randomUUID();
      const leaseId =
        receipt?.leaseId ?? imported?.leaseId ?? crypto.randomUUID();
      const queuedAt = receipt?.queuedAt ?? Date.now();

      const admittedAt = performance.now();
      const admissionInput: OwnerGateAdmitInput = {
        lane: "chat",
        turnId,
        conversationId,
        ...(expectedGeneration ? { expectedGeneration } : {}),
      };
      let admission: OwnerGateAdmission | undefined = imported
        ? { ok: true, snapshot: imported.snapshot, replayed: false }
        : undefined;
      let combinedGeneration: string | undefined;
      let admittedHomeContext = handoff?.preparation.homeContext;
      let admittedDestinations = handoff?.preparation.destinations;
      // Existing conversations know the generation needed to persist an exact
      // lease intent before the combined remote call. Cold starts and uncertain
      // receipt replays retain the discovery/reconciliation path below.
      if (
        !imported &&
        !receipt &&
        boundOwner === ownerId &&
        this.ownerGeneration
      ) {
        const intentAt = Date.now();
        receipt = {
          schemaVersion: 2,
          fingerprint: admissionFingerprint,
          ownerId,
          ownerGeneration: this.ownerGeneration,
          turnId,
          leaseId,
          phase: "registering",
          createdConversation: !(await this.ctx.storage.get<boolean>(
            CONVERSATION_PROJECTED_KEY,
          )),
          queuedAt,
          createdAt: intentAt,
          updatedAt: intentAt,
        };
        await this.putTurnState({ [receiptKey]: receipt });
        const leaseTurn: OwnerFencedTurn = {
          ownerId,
          ownerGeneration: receipt.ownerGeneration,
          turnId,
          ownerPurgeLeaseId: leaseId,
        };
        const observed: { result?: OwnerGateAdmissionWithLease } = {};
        try {
          combinedGeneration = await this.registerOwnerTurn(
            leaseTurn,
            false,
            admissionFingerprint,
            async (registeredOwnerId, lease) => {
              const result = await this.ownerGate(
                registeredOwnerId,
              ).admitWithFenceLease({
                admission: admissionInput,
                lease,
                includeHomeContext:
                  !this.activeTurnId && this.turnExecutions.size === 0,
              });
              observed.result = result;
              if (result.admission.ok && "homeContext" in result)
                admittedHomeContext = result.homeContext;
              if (result.admission.ok && "destinations" in result)
                admittedDestinations = result.destinations;
              return result.lease.status === "registered"
                ? { generation: result.lease.generation }
                : null;
            },
          );
          admission = observed.result?.admission;
        } catch (error) {
          const result = observed.result;
          if (result?.lease.status === "skipped") {
            // A definite refusal/skipped register created no external lease.
            // Remove only this fresh attempt's local intent. A lost response
            // must never take this branch: its original identity stays durable.
            await this.ctx.blockConcurrencyWhile(async () => {
              const key = orchestratorFenceLeaseReceiptKey(leaseId);
              const local =
                await this.getTurnState<OwnerFenceLeaseReceipt>(key);
              if (local?.phase === "registering" && local.turnId === turnId) {
                await this.ctx.storage.delete(key);
                if (local.runSlotKey)
                  await this.ctx.storage.delete(local.runSlotKey);
              }
              await this.ctx.storage.delete(receiptKey);
            });
            receipt = undefined;
            admission = result.admission;
            // A user may race a reset. The returned current snapshot resumes
            // ordinary registration under its new generation; service callers
            // still receive admit's expected-generation refusal.
          } else {
            await this.releaseOwnerGate({ ownerId, turnId });
            return turnStartErrorResponse(
              error instanceof OwnerFenceRegistrationUncertainError
                ? "internal"
                : "owner_purged",
              error instanceof OwnerFenceRegistrationUncertainError
                ? "Starting that turn is still being reconciled. Try again."
                : "This account's cloud data is being reset or deleted.",
              error instanceof OwnerFenceRegistrationUncertainError,
            );
          }
        }
      }
      admission ??= await this.ownerGateAdmit(ownerId, admissionInput);
      if (!admission.ok) {
        return turnStartErrorResponse(
          admission.code,
          admission.message,
          admission.retryable,
          admission.retryAfterMs,
        );
      }
      const ownerGateMs = Math.round(performance.now() - admittedAt);
      const snapshot = admission.snapshot;
      const refuse = async (
        code: Parameters<typeof turnStartErrorResponse>[0],
        message: string,
        retryable: boolean,
      ): Promise<Response> => {
        if (combinedGeneration && receipt) {
          await this.unregisterOwnerTurn({
            ownerId,
            ownerGeneration: receipt.ownerGeneration,
            turnId,
            ownerPurgeLeaseId: leaseId,
            ownerPurgeGeneration: combinedGeneration,
          });
        }
        await this.releaseOwnerGate({ ownerId, turnId });
        return turnStartErrorResponse(code, message, retryable);
      };
      const execution = start.execution ?? snapshot.execution;
      if (
        execution.engine === "anthropic" &&
        !snapshotAllowsCloudSandbox(snapshot)
      ) {
        return await refuse(
          "subscription_required",
          CLOUD_SANDBOX_SUBSCRIPTION_REQUIRED_MESSAGE,
          false,
        );
      }
      if (!snapshotAllowsExecutionEngine(snapshot, execution.engine)) {
        return await refuse(
          "execution_unavailable",
          execution.engine === "anthropic"
            ? "Connect Claude before using that cloud execution route."
            : "Connect ChatGPT before using that cloud execution route.",
          false,
        );
      }

      // Adoption. Conversation ids are client-minted UUIDs, so the first
      // verified caller is the client that minted the id. A socket connect
      // may already have bound the owner; the conversation is "created" for
      // the owner by whichever turn first projects it. Bound here, before the
      // fence, so a crash between the two leaves an owned conversation with a
      // `registering` intent rather than an unowned turn.
      const now = Date.now();
      const createdConversation =
        receipt?.createdConversation ??
        !(await this.ctx.storage.get<boolean>(CONVERSATION_PROJECTED_KEY));
      if (!this.journal.meta().owner_id) {
        this.journal.bindOwner({
          ownerId,
          ownerGeneration: snapshot.ownerGeneration,
          createdAt: now,
          title: conversationTitleFor(start),
          conversationId,
        });
        log("info", "conversation_adopted", { conversationId, via: "turn" });
      } else if (start.title || !this.journal.meta().title) {
        // `setTitle` only fills an empty title: a socket-adopted conversation
        // has none yet, and an explicit hint never overwrites a chosen one.
        this.journal.setTitle(conversationTitleFor(start));
      }
      if (this.ownerGeneration !== snapshot.ownerGeneration) {
        this.ownerGeneration = snapshot.ownerGeneration;
        await this.ctx.storage.put(
          "ownerDataGeneration",
          snapshot.ownerGeneration,
        );
      }

      const turn: ChatTurnRequest = {
        kind: "chat",
        ownerId,
        ownerGeneration: snapshot.ownerGeneration,
        conversationId,
        turnId,
        sessionId: `chat-${conversationId.slice(0, 8)}`,
        prompt: wakeReportSpillKey
          ? `${start.prompt.slice(0, TURN_PROMPT_MAX_CHARS)}\n\n[The full report is stored with this turn.]`
          : start.prompt,
        execution,
        audience: snapshot.allowance.audience,
        budgetMicroCents: snapshot.allowance.budgetMicroCents,
        lane,
        clientMsgId: start.clientMsgId,
        ...(start.originUserMessageId
          ? { originUserMessageId: start.originUserMessageId }
          : {}),
        ...(start.source ? { source: start.source } : {}),
        ...(start.title ? { title: start.title } : {}),
        ...(start.hiddenMessage ? { hiddenMessage: true } : {}),
        ...(start.locale ? { locale: start.locale } : {}),
        ...(start.attachments ? { attachments: start.attachments } : {}),
        ...(start.agentThreadControl
          ? {
              agentThreadControl: wakeReportSpillKey
                ? {
                    ...start.agentThreadControl,
                    ...(start.agentThreadControl.lifecycleReport !== undefined
                      ? {
                          lifecycleReport:
                            start.agentThreadControl.lifecycleReport.slice(
                              0,
                              TURN_PROMPT_MAX_CHARS + 1,
                            ),
                        }
                      : {}),
                  }
                : start.agentThreadControl,
            }
          : {}),
        ...(wakeReportSpillKey ? { wakeReportSpillKey } : {}),
        ownerPurgeLeaseId: leaseId,
        queuedAt,
      };

      if (!receipt) {
        receipt = {
          schemaVersion: 2,
          fingerprint: admissionFingerprint,
          ownerId,
          ownerGeneration: snapshot.ownerGeneration,
          turnId,
          leaseId,
          phase: "registering",
          createdConversation,
          queuedAt,
          createdAt: now,
          updatedAt: now,
        };
        // Persist the full request/owner/lease binding before the external
        // register boundary. A crash at any later prequeue point can only
        // resume this intent; a changed payload is a conflict.
        await this.putTurnState({ [receiptKey]: receipt });
      }

      // An idle conversation can prepare read-only context while its exact
      // admission receipt and owner lease commit. No provider call occurs.
      // Busy queues load context when dequeued instead, avoiding stale work.
      if (
        !this.activeTurnId &&
        this.turnExecutions.size === 0 &&
        this.ctx.storage.kv &&
        !this.ctx.storage.kv.get(LOCAL_TURN_LEASE_KEY) &&
        Array.from(this.ctx.storage.kv.list({ prefix: "queued:", limit: 1 }))
          .length === 0
      ) {
        const harnessExecution =
          turn.execution.engine === "anthropic" ? undefined : turn.execution;
        if (!harnessExecution) {
          // Claude Code runs this turn in the orchestrator container; wake it
          // while admission commits instead of minting a capability here.
          this.prewarmCliContainer(turn.ownerId, turn.conversationId);
        }
        const work = (
          harnessExecution
            ? mintOrchestratorTurnCapability(this.env, turn, harnessExecution)
            : Promise.resolve()
        ).then(() => this.prepareCloudHomeContext(turn, admittedHomeContext));
        void work.catch(() => undefined);
        this.cloudHomePreparations.set(turnId, {
          home: work,
          destinations: admittedDestinations
            ? Promise.resolve(admittedDestinations)
            : this.ownerGate(turn.ownerId)
                .devices()
                .catch(() => null),
        });
      }
      const registrationStarted = performance.now();
      let freshAdmission = false;
      try {
        let registeredNow = combinedGeneration !== undefined;
        turn.ownerPurgeGeneration =
          combinedGeneration ??
          (await this.registerOwnerTurn(
            turn,
            false,
            admissionFingerprint,
            async (registeredOwnerId, body) => {
              if (imported) {
                if (
                  registeredOwnerId !== imported.ownerId ||
                  body.turnId !== imported.turnId ||
                  body.leaseId !== imported.leaseId ||
                  body.ownerGeneration !== imported.ownerGeneration
                )
                  throw new OwnerPurgeFenceError();
                const canceled = await this.getTurnState(
                  ownerPurgeImportedLeaseKey(body.leaseId),
                );
                if (canceled) throw new OwnerPurgeFenceError();
                registeredNow = Date.now() - imported.admittedAt < 1_000;
                return { generation: imported.fenceGeneration };
              }
              const result = await this.registerOwnerFenceLease(
                registeredOwnerId,
                body,
              );
              registeredNow = result !== null;
              return result;
            },
          ));
        // A successful register already validated the exact live owner fence.
        // Replays only read a local receipt, so they still need a remote check.
        // The admission commit below rechecks local lease retirement, and
        // runTurn always checks the live fence again before touching history.
        if (!registeredNow) await this.assertOwnerTurn(turn);
        freshAdmission = registeredNow && admittedHomeContext !== undefined;
      } catch (error) {
        this.cloudHomePreparations.delete(turnId);
        if (error instanceof OwnerFenceLeaseConflictError) {
          return await refuse(
            "idempotency_conflict",
            "That message id was already used for a different message.",
            false,
          );
        }
        if (error instanceof OwnerFenceRegistrationUncertainError) {
          return await refuse(
            "internal",
            "Starting that turn is still being reconciled. Try again.",
            true,
          );
        }
        await this.unregisterOwnerTurn(turn);
        if (error instanceof OwnerPurgeFenceError) {
          return await refuse(
            "owner_purged",
            "This account's cloud data is being reset or deleted.",
            false,
          );
        }
        await this.releaseOwnerGate({ ownerId, turnId });
        throw error;
      }

      const registrationMs = Math.round(
        performance.now() - registrationStarted,
      );
      const commitStarted = performance.now();
      // Accept and run in the background. The exact request receipt, queued
      // turn, and owner generation commit together before the 202, so a lost
      // response/restart can replay without registering a new owner fence or
      // overwriting the original lease/payload.
      let heldForLocalTurn = false;
      let editConflict = false;
      await this.ctx.blockConcurrencyWhile(async () => {
        const editLock = await this.activeConversationEditLock();
        if (editLock) {
          editConflict = true;
          return;
        }
        // Owner-purge cancellation marks the durable lease receipt retiring in
        // this same DO. Recheck inside the admission critical section so a
        // register/assert winner cannot persist after its orphan was retired.
        await this.assertOwnerFenceLeaseReceiptActive(turn);
        if (turn.ownerPurgeLeaseId !== receipt!.leaseId) {
          throw new OwnerPurgeFenceError();
        }
        // A completion wake queues behind the currently executing model turn.
        // Publish its validated lifecycle fact now so that turn's agent_status
        // sees completion instead of polling a stale running receipt forever.
        // The shared receipt merge preserves attempt-generation monotonicity.
        if (turn.agentThreadControl) {
          await this.rememberCloudAgentControlReceipt(turn.agentThreadControl);
        }
        await this.putTurnState({
          [`queued:${turn.turnId}`]: turn,
          [receiptKey]: {
            ...receipt!,
            phase: "accepted",
            acceptedAt: turn.queuedAt!,
            updatedAt: Date.now(),
          } satisfies ChatTurnAdmissionReceipt,
          ownerDataGeneration: turn.ownerGeneration,
          [CONVERSATION_PROJECTED_KEY]: true,
        });
        const localLease =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        heldForLocalTurn = localLease !== undefined;
        if (localLease) {
          const retirementAt = localTurnRetirementDeadline(localLease);
          await this.armAlarmNoLaterThan(retirementAt);
        } else if ((await this.ctx.storage.getAlarm()) === null) {
          await this.ctx.storage.setAlarm(
            Date.now() + Math.max(1_000, turn.watchdogMs ?? CHAT_WATCHDOG_MS),
          );
        }
      });
      if (editConflict) {
        this.cloudHomePreparations.delete(turnId);
        await this.unregisterOwnerTurn(turn);
        await this.releaseOwnerGate(turn);
        return turnStartErrorResponse(
          "conversation_locked",
          "This conversation is being edited. Try again shortly.",
          true,
          1_000,
        );
      }

      const admissionCommitMs = Math.round(performance.now() - commitStarted);
      const projectionStarted = performance.now();
      // Projections, after the durable commit and before the 202: the queue
      // is durable, so once these are enqueued (or debted) the owner will learn
      // of the conversation and the turn no matter what this isolate does next.
      const projections: OwnerEvent[] = [];
      if (createdConversation) {
        const meta = this.journal.meta();
        projections.push({
          ...this.ownerEventBase(turn, conversationId),
          kind: "conversation.created",
          conversationId,
          createdAt: meta.created_at > 0 ? meta.created_at : now,
          title: meta.title,
          execution,
        } satisfies ConversationCreatedEvent);
      }
      projections.push({
        ...this.ownerEventBase(turn, turnId),
        kind: "turn.started",
        turnId,
        turnKind: "chat",
        conversationId,
        sessionId: turn.sessionId,
        lane,
        ...(turn.source ? { source: turn.source } : {}),
        clientMsgId: turn.clientMsgId,
        ...(turn.hiddenMessage ? { hidden: true } : {}),
        ...(turn.agentThreadControl
          ? {
              threadId: turn.agentThreadControl.threadId,
              attemptGeneration: turn.agentThreadControl.attemptGeneration,
            }
          : {}),
        agentType: "orchestrator",
        execution,
        prompt: turn.prompt,
        createdAt: queuedAt,
      } satisfies TurnStartedEvent);
      await this.deferOwnerEvents(projections);

      if (!heldForLocalTurn) {
        this.enqueue(turn, freshAdmission);
        void this.steerWakeIntoRunningTurn(turn);
      } else this.cloudHomePreparations.delete(turnId);
      log("info", "chat_turn_admitted", {
        turnId,
        conversationId,
        admissionTransport: imported
          ? "owner_handoff"
          : combinedGeneration
            ? "combined"
            : "separate",
        ownerGateMs,
        registrationMs,
        admissionCommitMs,
        projectionMs: Math.round(performance.now() - projectionStarted),
        totalMs: Math.round(performance.now() - admittedAt),
      });
      return json(
        {
          protocol: TURN_PLANE_PROTOCOL,
          conversationId,
          turnId,
          accepted: true,
          replayed: false,
          createdConversation,
        } satisfies CloudTurnStartResponse,
        202,
      );
    });
  }
}
