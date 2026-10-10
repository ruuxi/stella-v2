import {
  parsePiBrainHost,
  type PiBrainRecord,
  type PiBrainResponse,
} from "@stella/contracts/turn-plane/pi-brain";
import type { AgentMessage } from "@stella/runtime/kernel/agent-core/types.js";
import { OwnerGateSnapshotError } from "../owner-gate.js";
import { CLOUD_HISTORY_TOKEN_BUDGET } from "@stella/executor-cloud/prune-history";
import {
  JOURNAL_CHECKPOINT_SUMMARY_MAX_BYTES,
  type JournalCheckpointPublish,
  parseJournalCheckpointFirstKept,
} from "@stella/contracts/journal-checkpoint";
import { sha256Hex } from "../hash.js";
import { runHistoryQuery } from "../history-sql.js";
import {
  APPEND_WINDOW_MAX_BYTES,
  APPEND_WINDOW_MAX_REQUESTS,
  APPEND_WINDOW_MS,
  BACKFILL_BATCH_RECORDS,
  CONVERSATION_MAX_STORED_BYTES,
  parseSocketIdentity,
  utf8Length,
} from "../conversation-types.js";
import { stampUserMessageSequences } from "../journal.js";
import {
  classifyLocalClientMessageReplay,
  LOCAL_CLIENT_MSG_ID_PATTERN,
  LOCAL_DEVICE_ID_PATTERN,
  LOCAL_TURN_ID_PATTERN,
  localClientMessageFingerprintSource,
  type LocalClientMessageReceipt,
  localTurnLeaseAllowsIdentityTransition,
  localTurnId as makeLocalTurnId,
  type ParsedLocalTurnRenewal,
  parseExpectedOwnerGeneration,
  parseLocalFinishRecords,
  parseLocalTerminalPhase,
  parseLocalTurnRenewal,
} from "../local-turn-protocol.js";
import type {
  ChatTurnRequest,
  LocalTurnLease,
  LocalTurnFinishReceipt,
} from "./types.js";
import {
  PI_BRAIN_KEY,
  LOCAL_TURN_LEASE_MS,
  LOCAL_TURN_BEGIN_MAX_BYTES,
  LOCAL_TURN_FINISH_MAX_ROWS,
  LOCAL_TURN_FINISH_MAX_BYTES,
  LOCAL_TURN_LEASE_KEY,
  localTurnReceiptKey,
  localClientMessageKey,
} from "./constants.js";
import {
  OwnerPurgeFenceError,
  OwnerFenceLeaseConflictError,
  OwnerFenceRegistrationUncertainError,
  localTurnRetirementDeadline,
  json,
  staleOwnerGenerationResponse,
  errorMessage,
  log,
} from "./support.js";
import { OrchestratorJournalWrites } from "./journal-writes.js";

/**
 * Desktop-local turns (begin, renew, finish), history reads, and the pi
 * workspace and brain routes.
 */
export abstract class OrchestratorLocalTurn extends OrchestratorJournalWrites {
  /**
   * The local half of localTurnOwner for a new admission: who is calling and
   * which owner this conversation is bound to, with no gate round trip. The
   * gate snapshot (write fence, current generation) is applied by the caller
   * once it arrives together with the fence registration.
   */
  protected localTurnCaller(request: Request): { ownerId: string } | Response {
    const identity = parseSocketIdentity(request);
    if (!identity) return json({ error: "Unauthorized." }, 401);
    if (this.purged()) {
      return json(
        { code: "deleted", message: "This conversation was deleted." },
        410,
      );
    }
    const bound = this.journal.ownerId() || identity.ownerId;
    if (
      !localTurnLeaseAllowsIdentityTransition({
        boundOwnerId: bound,
        callerOwnerId: identity.ownerId,
      })
    ) {
      return json({ error: "Conversation not found." }, 404);
    }
    return { ownerId: bound };
  }

  protected async localTurnOwner(
    request: Request,
    suppliedLeaseToken?: string,
    expectedOwnerGeneration?: string,
  ): Promise<{ ownerId: string; ownerGeneration: string } | Response> {
    const identity = parseSocketIdentity(request);
    if (!identity) return json({ error: "Unauthorized." }, 401);
    if (this.purged()) {
      return json(
        { code: "deleted", message: "This conversation was deleted." },
        410,
      );
    }
    // A new local turn is a new write capability, so it must refresh the
    // owner generation even when this DO already has one cached. Renewal of
    // an admitted exact lease keeps the generation that lease was fenced with.
    const isNewAdmission = suppliedLeaseToken === undefined;
    const ownerRecord = await this.resolveOwnerForCaller(identity, {
      refreshGeneration: isNewAdmission,
    });
    // A refused resolution (not the owner, owner not writable) must never be
    // turned into a new write capability by cached DO fields. Exact renewals
    // instead remain bound to their admitted lease.
    if (isNewAdmission && !ownerRecord) {
      return json({ error: "Conversation not found." }, 404);
    }
    const bound = this.journal.ownerId() || ownerRecord?.ownerId;
    const activeLease = suppliedLeaseToken
      ? await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY)
      : undefined;
    const ownerGeneration =
      activeLease?.ownerGeneration ??
      ownerRecord?.ownerGeneration ??
      this.ownerGeneration;
    if (
      !bound ||
      !ownerGeneration ||
      !localTurnLeaseAllowsIdentityTransition({
        boundOwnerId: bound,
        callerOwnerId: identity.ownerId,
        suppliedLeaseToken,
        activeLease,
      })
    ) {
      return json({ error: "Conversation not found." }, 404);
    }
    if (
      expectedOwnerGeneration !== undefined &&
      expectedOwnerGeneration !== ownerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    return { ownerId: bound, ownerGeneration };
  }

  protected async localTurnHistory(turnId: string): Promise<{
    history: string[];
    contextStartSeq: number;
    contextEndSeq: number;
  }> {
    const selection = this.journal.selectWindow(
      turnId,
      CLOUD_HISTORY_TOKEN_BUDGET,
    );
    const messages = stampUserMessageSequences(
      await this.hydrateWindow(selection),
      selection.rows,
    );
    return {
      history: messages.map((message) => JSON.stringify(message)),
      contextStartSeq: selection.startSeq,
      contextEndSeq: selection.endSeq,
    };
  }

  protected async handleCanonicalHistory(request: Request): Promise<Response> {
    const owner = await this.localTurnOwner(request);
    if (owner instanceof Response) return owner;
    // No lease is acquired and no journal state is mutated. The empty
    // exclusion key cannot match a real turn id, so this is the same bounded,
    // spill-hydrated canonical window used to seed a local cloud turn.
    const checkpoint = await this.journalCheckpoint();
    return json({
      ...(await this.localTurnHistory("")),
      ...(checkpoint ? { checkpoint } : {}),
    });
  }

  protected async handleJournalCheckpoint(request: Request): Promise<Response> {
    const body = (await request
      .json()
      .catch(() => null)) as Partial<JournalCheckpointPublish> | null;
    const expectedOwnerGeneration = parseExpectedOwnerGeneration(
      body?.expectedOwnerGeneration,
    );
    const firstKept = parseJournalCheckpointFirstKept(body?.firstKept);
    const deviceId =
      typeof body?.deviceId === "string" ? body.deviceId.trim() : undefined;
    if (
      !expectedOwnerGeneration ||
      !firstKept ||
      typeof body?.summary !== "string" ||
      !body.summary ||
      utf8Length(body.summary) > JOURNAL_CHECKPOINT_SUMMARY_MAX_BYTES ||
      (deviceId !== undefined && !LOCAL_DEVICE_ID_PATTERN.test(deviceId)) ||
      ("localTurnId" in firstKept && !deviceId)
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const owner = await this.localTurnOwner(
      request,
      undefined,
      expectedOwnerGeneration,
    );
    if (owner instanceof Response) return owner;
    const throughSeq = await this.storeJournalCheckpoint(
      body.summary,
      firstKept,
      deviceId,
    );
    if (throughSeq === undefined) {
      return json(
        {
          code: "not_found",
          message: "That checkpoint's messages are not in the journal.",
        },
        404,
      );
    }
    return json({ ok: true, throughSeq });
  }

  /**
   * The desktop code tool's `history.sql` / `history.read`, answered with
   * exactly what the cloud code tool's history client runs.
   */
  /**
   * A call from one of the owner's computers for its own copy of this
   * conversation, whose tools it moved to the cloud: run in a container this
   * object holds for it, as its cloud agents' are (`PiConversationRuntime.workspace`).
   */
  protected async handlePiWorkspace(request: Request): Promise<Response> {
    const owner = await this.localTurnOwner(request);
    if (owner instanceof Response) return owner;
    const body = await request.json().catch(() => null);
    try {
      const runtime = await this.openPiRuntime(this.piGatewayOrigin());
      return json(
        await runtime.workspace(
          {
            ownerId: owner.ownerId,
            ownerGeneration: owner.ownerGeneration,
            conversationId: this.conversationId(),
          },
          body,
        ),
      );
    } catch (error) {
      log("info", "pi_workspace_failed", { message: errorMessage(error) });
      return json({ error: errorMessage(error) }, 400);
    }
  }

  /**
   * Where this conversation's Stella runs: `GET` reads the record, `POST`
   * moves her (a computer's user flipping it, or her own `switch_destination`
   * there). From then on that host takes the conversation's turns, while
   * it can.
   */
  protected async handlePiBrain(request: Request): Promise<Response> {
    const owner = await this.localTurnOwner(request);
    if (owner instanceof Response) return owner;
    if (request.method === "GET") {
      return json({
        record:
          (await this.ctx.storage.get<PiBrainRecord>(PI_BRAIN_KEY)) ?? null,
      } satisfies PiBrainResponse);
    }
    const host = parsePiBrainHost(await request.json().catch(() => null));
    if (!host) return json({ error: "Name the cloud or a device." }, 400);
    const record = await this.setPiBrain(host);
    return json({ record } satisfies PiBrainResponse);
  }

  protected async handleHistoryQuery(request: Request): Promise<Response> {
    const owner = await this.localTurnOwner(request);
    if (owner instanceof Response) return owner;
    const body = await request.json().catch(() => null);
    try {
      return json(await this.runHistoryOp(body));
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  protected async runHistoryOp(request: unknown): Promise<unknown> {
    const body = (request ?? null) as {
      op?: unknown;
      query?: unknown;
      params?: unknown;
      fromSeq?: unknown;
      toSeq?: unknown;
    } | null;
    if (body?.op === "sql") {
      if (typeof body.query !== "string" || !body.query.trim()) {
        throw new Error("history.sql requires a non-empty query string.");
      }
      const params = (Array.isArray(body.params) ? body.params : []).filter(
        (value): value is string | number | null =>
          value === null ||
          typeof value === "string" ||
          typeof value === "number",
      );
      return runHistoryQuery(this.ctx.storage, body.query, params);
    }
    if (body?.op === "read") {
      if (
        !Number.isSafeInteger(body.fromSeq) ||
        !Number.isSafeInteger(body.toSeq)
      ) {
        throw new Error("history.read requires integer fromSeq and toSeq.");
      }
      return await this.archive.readRange(
        Math.max(0, body.fromSeq as number),
        body.toSeq as number,
        BACKFILL_BATCH_RECORDS,
      );
    }
    throw new Error('history query op must be "sql" or "read".');
  }

  /**
   * Completes the durable half of begin. Every writer key is stable, so a
   * retry after an isolate died between storing the lease and returning the
   * response repairs the same rows instead of creating another prompt.
   */
  protected async initializeLocalTurn(
    lease: LocalTurnLease,
    userMessage: AgentMessage,
    userMessageJson: string,
    options?: { hidden?: boolean },
  ): Promise<{
    history: string[];
    contextStartSeq: number;
    contextEndSeq: number;
  }> {
    for (const repaired of this.journal.repairTail(Date.now())) {
      this.publish(repaired.record);
    }
    this.drainInbox();
    const context = await this.localTurnHistory(lease.turnId);
    const current =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !current ||
      current.turnId !== lease.turnId ||
      current.leaseToken !== lease.leaseToken ||
      current.cancelRequested ||
      this.journal.turnState(lease.turnId)?.state === "terminal"
    ) {
      throw new Error("Local turn lease is no longer active.");
    }
    const now = Date.now();
    this.journal.upsertTurn({
      turnId: lease.turnId,
      sessionId: `desktop-${lease.deviceId}`.slice(0, 64),
      ownerId: lease.ownerId,
      lane: "chat",
      source: "desktop",
      ...(lease.clientMsgId ? { clientMsgId: lease.clientMsgId } : {}),
      state: "running",
      now,
    });
    this.journal.setTurnContext(
      lease.turnId,
      context.contextStartSeq,
      context.contextEndSeq,
    );
    const sizedPrompt = await this.prepareOversize(
      "user",
      userMessage,
      userMessageJson,
      `turn:${lease.turnId}:prompt`,
    );
    // The prompt spill above may have yielded to an owner-purge cancel; the
    // durable lease records it, so no remote fence assert is needed.
    const admitted =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !admitted ||
      admitted.turnId !== lease.turnId ||
      admitted.leaseToken !== lease.leaseToken ||
      admitted.ownerGeneration !== lease.ownerGeneration ||
      admitted.cancelRequested
    ) {
      throw new OwnerPurgeFenceError();
    }
    const promptRow = this.journal.appendMessage({
      turnId: lease.turnId,
      writer: `desktop:${lease.deviceId}`,
      writerKey: `turn:${lease.turnId}:prompt`,
      role: "user",
      message: sizedPrompt.message,
      payloadJson: sizedPrompt.payloadJson,
      // A desktop-run lifecycle wake (`[Agent completed]` and friends) is a
      // hidden prompt on every client, exactly like a cloud-run wake.
      ...(options?.hidden ? { hidden: true } : {}),
      ...(sizedPrompt.spillKey ? { spillKey: sizedPrompt.spillKey } : {}),
      ...(lease.clientMsgId ? { clientMsgId: lease.clientMsgId } : {}),
      createdAt: now,
    });
    this.journal.setTurnSpan(lease.turnId, promptRow.seq);
    if (promptRow.inserted) this.publish(promptRow.record);
    const startedRow = this.journal.appendTurn({
      turnId: lease.turnId,
      writer: `desktop:${lease.deviceId}`,
      writerKey: `turn:${lease.turnId}:phase:started`,
      phase: "started",
      lane: "chat",
      source: "desktop",
      promptSeq: promptRow.seq,
      createdAt: now,
    });
    this.journal.setTurnSpan(lease.turnId, startedRow.seq);
    if (startedRow.inserted) this.publish(startedRow.record);
    if (this.journal.meta().title.trim() === "") {
      const text = (
        (userMessage as { content?: Array<{ type?: string; text?: string }> })
          .content ?? []
      )
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join(" ")
        .trim();
      if (text) {
        this.journal.setTitle(
          text.length > 56 ? `${text.slice(0, 53)}…` : text,
        );
      }
    }
    this.live = {
      turnId: lease.turnId,
      streamId: null,
      partialText: "",
      tools: [],
    };
    void this.index
      .flush({ activity: "running", updatedAt: now })
      .catch(() => undefined);
    return context;
  }

  protected async handleLocalTurnRenewal(
    renewal: ParsedLocalTurnRenewal,
    ownerId: string,
  ): Promise<Response> {
    const { deviceId, expectedOwnerGeneration, localTurnId, leaseToken } =
      renewal;
    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const previous = await this.ctx.storage.get<LocalTurnFinishReceipt>(
      localTurnReceiptKey(turnId),
    );
    if (
      previous?.turnId === turnId &&
      previous.ownerGeneration !== expectedOwnerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    if (previous?.turnId === turnId) {
      return json(
        {
          code: "turn_finished",
          message: "That local turn has already finished.",
          turnId,
          phase: previous.phase,
        },
        409,
      );
    }

    const existing =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (!existing) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }
    if (existing.ownerGeneration !== expectedOwnerGeneration) {
      return staleOwnerGenerationResponse();
    }
    if (localTurnRetirementDeadline(existing) <= Date.now()) {
      if (existing.cancelRequested) {
        await this.cancelLocalTurn(existing, true);
      } else {
        await this.expireLocalLease(existing, true);
      }
      return json(
        {
          code: existing.cancelRequested ? "turn_finished" : "turn_expired",
          message: existing.cancelRequested
            ? "That local turn was canceled."
            : "That local turn lease expired.",
          turnId: existing.turnId,
        },
        409,
      );
    }
    if (
      existing.turnId !== turnId ||
      existing.deviceId !== deviceId ||
      existing.localTurnId !== localTurnId ||
      existing.ownerId !== ownerId ||
      existing.leaseToken !== leaseToken
    ) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }

    let renewed: LocalTurnLease | undefined;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.turnId !== turnId ||
        current.deviceId !== deviceId ||
        current.localTurnId !== localTurnId ||
        current.ownerId !== ownerId ||
        current.ownerGeneration !== expectedOwnerGeneration ||
        current.leaseToken !== leaseToken ||
        current.cancelRequested ||
        current.expiresAt <= Date.now() ||
        this.journal.turnState(turnId)?.state === "terminal"
      ) {
        return;
      }
      current.expiresAt = Date.now() + LOCAL_TURN_LEASE_MS;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
      await this.armAlarmNoLaterThan(current.expiresAt);
      renewed = current;
    });
    if (!renewed) {
      return json(
        {
          code: "turn_finished",
          message: "That local turn is no longer running.",
          turnId,
        },
        409,
      );
    }
    await this.armLocalLeaseAlarm(renewed.expiresAt);
    try {
      await this.assertOwnerTurn(renewed);
    } catch {
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }
    return json({
      turnId,
      leaseToken: renewed.leaseToken,
      expiresAt: renewed.expiresAt,
      replayed: true,
      renewed: true,
      history: [],
    });
  }

  protected async handleLocalTurnBegin(request: Request): Promise<Response> {
    const timingStartedAt = performance.now();
    let timingCheckpointAt = timingStartedAt;
    const timings: Record<string, number> = {};
    const markTiming = (phase: string): void => {
      const now = performance.now();
      timings[phase] = Math.round(now - timingCheckpointAt);
      timingCheckpointAt = now;
    };
    let body: {
      deviceId?: string;
      expectedOwnerGeneration?: string;
      localTurnId?: string;
      userMessageJson?: string;
      clientMsgId?: string;
      leaseToken?: string;
      renewOnly?: boolean;
      /** The prompt is a lifecycle wake the clients never show. */
      hidden?: boolean;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    markTiming("parseMs");
    if (body.renewOnly === true) {
      const renewal = parseLocalTurnRenewal(body);
      if (!renewal) {
        return json(
          { code: "bad_request", message: "Malformed request." },
          400,
        );
      }
      const owner = await this.localTurnOwner(
        request,
        renewal.leaseToken,
        renewal.expectedOwnerGeneration,
      );
      if (owner instanceof Response) return owner;
      return this.handleLocalTurnRenewal(renewal, owner.ownerId);
    }
    const deviceId = body.deviceId?.trim() ?? "";
    const expectedOwnerGeneration = parseExpectedOwnerGeneration(
      body.expectedOwnerGeneration,
    );
    const localTurnId = body.localTurnId?.trim() ?? "";
    const clientMsgId = body.clientMsgId?.trim();
    if (
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !expectedOwnerGeneration ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      (body.renewOnly !== undefined && typeof body.renewOnly !== "boolean") ||
      (body.hidden !== undefined && typeof body.hidden !== "boolean") ||
      (clientMsgId !== undefined &&
        !LOCAL_CLIENT_MSG_ID_PATTERN.test(clientMsgId))
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const promptHidden = body.hidden === true;
    // The gate snapshot that used to be read here now arrives with the fence
    // registration below, in one gate round trip. Only the local half of the
    // owner check runs before the request is validated.
    const caller = this.localTurnCaller(request);
    if (caller instanceof Response) return caller;
    markTiming("ownerLookupMs");
    const userMessageJson = body.userMessageJson ?? "";
    if (
      !userMessageJson ||
      utf8Length(userMessageJson) > LOCAL_TURN_BEGIN_MAX_BYTES
    ) {
      return json(
        { code: "too_large", message: "That message is too large." },
        413,
      );
    }
    let userMessage: AgentMessage;
    try {
      userMessage = JSON.parse(userMessageJson) as AgentMessage;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    if (
      (userMessage as { role?: unknown }).role !== "user" ||
      !Array.isArray((userMessage as { content?: unknown }).content)
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }

    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const beginFingerprint = await sha256Hex(
      localClientMessageFingerprintSource(clientMsgId ?? "", userMessage),
    );
    const clientReceipt = clientMsgId
      ? await this.ctx.storage.get<LocalClientMessageReceipt>(
          localClientMessageKey(clientMsgId),
        )
      : undefined;
    const clientReplay = clientMsgId
      ? classifyLocalClientMessageReplay(clientReceipt, {
          ownerGeneration: expectedOwnerGeneration,
          clientMsgId,
          beginFingerprint,
          turnId,
        })
      : "new";
    if (clientReplay === "conflict") {
      return json(
        {
          code: "idempotency_conflict",
          message:
            "That client message id was already used for a different message.",
        },
        409,
      );
    }
    if (clientReplay === "duplicate") {
      return json(
        {
          code: "turn_finished",
          message: "That client message was already admitted.",
          turnId: clientReceipt?.turnId,
          ...(clientReceipt?.phase ? { phase: clientReceipt.phase } : {}),
        },
        409,
      );
    }
    const previous = await this.ctx.storage.get<LocalTurnFinishReceipt>(
      localTurnReceiptKey(turnId),
    );
    if (
      previous?.turnId === turnId &&
      previous.ownerGeneration !== expectedOwnerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    if (previous?.turnId === turnId) {
      return json(
        {
          code: "turn_finished",
          message: "That local turn has already finished.",
          turnId,
          phase: previous.phase,
        },
        409,
      );
    }

    const existing =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    markTiming("preflightMs");
    if (existing) {
      // A replay is rare and renews a lease an earlier register fenced, so it
      // keeps the separate snapshot refresh.
      const replayOwner = await this.localTurnOwner(
        request,
        undefined,
        expectedOwnerGeneration,
      );
      if (replayOwner instanceof Response) return replayOwner;
      if (existing.ownerGeneration !== expectedOwnerGeneration) {
        return staleOwnerGenerationResponse();
      }
      if (localTurnRetirementDeadline(existing) <= Date.now()) {
        if (existing.cancelRequested) {
          await this.cancelLocalTurn(existing, true);
        } else {
          await this.expireLocalLease(existing, true);
        }
        return json(
          {
            code: existing.cancelRequested ? "turn_finished" : "turn_expired",
            message: existing.cancelRequested
              ? "That local turn was canceled."
              : "That local turn lease expired.",
            turnId: existing.turnId,
          },
          409,
        );
      }
      if (
        existing.turnId !== turnId ||
        existing.deviceId !== deviceId ||
        existing.localTurnId !== localTurnId
      ) {
        return json(
          {
            code: "turn_in_progress",
            message: "Another turn is already running in this conversation.",
            retryAfterMs: 3_000,
          },
          409,
        );
      }
      if (existing.beginFingerprint !== beginFingerprint) {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That local turn id was already used for a different message.",
          },
          409,
        );
      }
      let renewed: LocalTurnLease | undefined;
      await this.ctx.blockConcurrencyWhile(async () => {
        const current =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        if (
          !current ||
          current.turnId !== turnId ||
          current.ownerGeneration !== expectedOwnerGeneration ||
          current.leaseToken !== existing.leaseToken ||
          current.beginFingerprint !== beginFingerprint ||
          current.cancelRequested ||
          current.expiresAt <= Date.now() ||
          this.journal.turnState(turnId)?.state === "terminal"
        ) {
          return;
        }
        current.expiresAt = Date.now() + LOCAL_TURN_LEASE_MS;
        await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
        await this.armAlarmNoLaterThan(current.expiresAt);
        renewed = current;
      });
      if (!renewed) {
        return json(
          {
            code: "turn_finished",
            message: "That local turn is no longer running.",
            turnId,
          },
          409,
        );
      }
      await this.armLocalLeaseAlarm(renewed.expiresAt);
      try {
        await this.assertOwnerTurn(renewed);
      } catch {
        return json(
          { code: "owner_purge", message: "Cloud activity is being reset." },
          409,
        );
      }
      try {
        const context = await this.initializeLocalTurn(
          renewed,
          userMessage,
          userMessageJson,
          { hidden: promptHidden },
        );
        await this.assertOwnerTurn(renewed);
        const finalLease =
          await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
        if (
          !finalLease ||
          finalLease.turnId !== renewed.turnId ||
          finalLease.leaseToken !== renewed.leaseToken ||
          finalLease.ownerGeneration !== expectedOwnerGeneration ||
          finalLease.cancelRequested
        ) {
          throw new OwnerPurgeFenceError();
        }
        return json({
          turnId,
          leaseToken: renewed.leaseToken,
          expiresAt: renewed.expiresAt,
          replayed: true,
          ...context,
        });
      } catch (error) {
        if (error instanceof OwnerPurgeFenceError) {
          return json(
            { code: "owner_purge", message: "Cloud activity is being reset." },
            409,
          );
        }
        log("error", "conversation_local_turn_begin_replay_failed", {
          turnId,
          message: errorMessage(error),
        });
        return json(
          {
            code: "begin_failed",
            message: "Starting that local turn failed. Try again.",
          },
          503,
        );
      }
    }

    if (
      this.journal.storedBytes() + utf8Length(userMessageJson) >
      CONVERSATION_MAX_STORED_BYTES
    ) {
      return json(
        {
          code: "conversation_full",
          message:
            "This conversation has reached its size limit. Start a new conversation to keep going.",
        },
        413,
      );
    }

    const lease: LocalTurnLease = {
      ownerId: caller.ownerId,
      ownerGeneration: expectedOwnerGeneration,
      turnId,
      deviceId,
      localTurnId,
      leaseToken:
        crypto.randomUUID().replaceAll("-", "") +
        crypto.randomUUID().replaceAll("-", ""),
      expiresAt: Date.now() + LOCAL_TURN_LEASE_MS,
      beginFingerprint,
      ...(clientMsgId ? { clientMsgId } : {}),
    };
    try {
      const registration = await this.registerOwnerTurnWithSnapshot(
        lease,
        beginFingerprint,
      );
      // The checks localTurnOwner made before the gate read moved here: the
      // write fence and adoption first, then the generation the desktop
      // expects. The gate registers nothing for a snapshot that refuses the
      // caller; a replayed registration that no longer qualifies is released.
      const owner = await this.adoptOwnerSnapshot(
        caller.ownerId,
        registration.snapshot,
      );
      if (!owner) {
        if (registration.registered) await this.unregisterOwnerTurn(lease);
        return json({ error: "Conversation not found." }, 404);
      }
      if (
        owner.ownerGeneration !== expectedOwnerGeneration ||
        !registration.registered
      ) {
        if (registration.registered) await this.unregisterOwnerTurn(lease);
        return staleOwnerGenerationResponse();
      }
      lease.ownerPurgeGeneration = registration.generation;
      markTiming("ownerFenceRegisterMs");
    } catch (error) {
      // A snapshot the gate could not obtain propagates as the separate
      // snapshot read used to.
      if (error instanceof OwnerGateSnapshotError) throw error;
      if (error instanceof OwnerFenceLeaseConflictError) {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That local turn id was already used for a different message.",
          },
          409,
        );
      }
      if (error instanceof OwnerFenceRegistrationUncertainError) {
        return json(
          {
            code: "owner_fence_registration_uncertain",
            message: "Starting that turn is still being reconciled. Try again.",
          },
          503,
        );
      }
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }

    let acquired = false;
    let racedClientReplay: "duplicate" | "conflict" | null = null;
    await this.ctx.blockConcurrencyWhile(async () => {
      const [
        local,
        concurrentClientReceipt,
        cloudTurn,
        terminal,
        terminalDelivered,
        queued,
      ] = await Promise.all([
        this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY),
        clientMsgId
          ? this.ctx.storage.get<LocalClientMessageReceipt>(
              localClientMessageKey(clientMsgId),
            )
          : Promise.resolve(undefined),
        this.ctx.storage.get<ChatTurnRequest>("turn"),
        this.ctx.storage.get<boolean>("terminal"),
        this.ctx.storage.get<boolean>("terminalDelivered"),
        this.ctx.storage.list<ChatTurnRequest>({
          prefix: "queued:",
          limit: 1,
        }),
      ]);
      const cloudBusy =
        Boolean(cloudTurn && terminal !== true) ||
        Boolean(cloudTurn && terminalDelivered !== true) ||
        queued.size > 0;
      if (local || cloudBusy || this.purged()) return;
      if (clientMsgId) {
        const replay = classifyLocalClientMessageReplay(
          concurrentClientReceipt,
          {
            ownerGeneration: expectedOwnerGeneration,
            clientMsgId,
            beginFingerprint,
            turnId,
          },
        );
        if (replay === "conflict") {
          racedClientReplay = "conflict";
          return;
        }
        if (replay !== "new") {
          racedClientReplay = "duplicate";
          return;
        }
      }
      await this.assertOwnerFenceLeaseReceiptActive(lease);
      const records: Record<string, unknown> = {
        [LOCAL_TURN_LEASE_KEY]: lease,
      };
      if (clientMsgId) {
        records[localClientMessageKey(clientMsgId)] = {
          ownerGeneration: expectedOwnerGeneration,
          clientMsgId,
          beginFingerprint,
          turnId,
        } satisfies LocalClientMessageReceipt;
      }
      await this.ctx.storage.put(records);
      await this.armAlarmNoLaterThan(lease.expiresAt);
      acquired = true;
    });
    markTiming("leaseAcquireMs");
    if (!acquired) {
      await this.unregisterOwnerTurn(lease);
      if (racedClientReplay === "conflict") {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That client message id was already used for a different message.",
          },
          409,
        );
      }
      if (racedClientReplay === "duplicate") {
        return json(
          {
            code: "turn_finished",
            message: "That client message was already admitted.",
          },
          409,
        );
      }
      return json(
        {
          code: "turn_in_progress",
          message: "Another turn is already running in this conversation.",
          retryAfterMs: 3_000,
        },
        409,
      );
    }

    try {
      const context = await this.initializeLocalTurn(
        lease,
        userMessage,
        userMessageJson,
        { hidden: promptHidden },
      );
      markTiming("initializeMs");
      // No remote fence assert here. An owner purge that began after the
      // register above reaches this object through `/owner-purge-cancel`,
      // which cancels the exact local lease before the purge can report
      // quiescence, so the durable lease below is the fence. The phase keeps
      // its `finalFenceMs` name so existing dashboards still line up.
      const finalLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !finalLease ||
        finalLease.turnId !== lease.turnId ||
        finalLease.leaseToken !== lease.leaseToken ||
        finalLease.ownerGeneration !== expectedOwnerGeneration ||
        finalLease.cancelRequested
      ) {
        throw new OwnerPurgeFenceError();
      }
      markTiming("finalFenceMs");
      log("info", "conversation_local_turn_begin_timing", {
        turnId,
        replayed: false,
        ...timings,
        totalMs: Math.round(performance.now() - timingStartedAt),
      });
      return json({
        turnId,
        leaseToken: lease.leaseToken,
        expiresAt: lease.expiresAt,
        replayed: false,
        ...context,
      });
    } catch (error) {
      if (error instanceof OwnerPurgeFenceError) {
        return json(
          { code: "owner_purge", message: "Cloud activity is being reset." },
          409,
        );
      }
      log("error", "conversation_local_turn_begin_failed", {
        turnId,
        message: errorMessage(error),
      });
      return json(
        {
          code: "begin_failed",
          message: "Starting that local turn failed. Try again.",
        },
        503,
      );
    }
  }

  protected async handleLocalTurnFinish(request: Request): Promise<Response> {
    let body: {
      deviceId?: string;
      expectedOwnerGeneration?: string;
      localTurnId?: string;
      leaseToken?: string;
      records?: Array<{
        ordinal?: number;
        role?: string;
        payloadJson?: string;
      }>;
      phase?: string;
      notice?: string;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const deviceId = body.deviceId?.trim() ?? "";
    const expectedOwnerGeneration = parseExpectedOwnerGeneration(
      body.expectedOwnerGeneration,
    );
    const localTurnId = body.localTurnId?.trim() ?? "";
    const leaseToken = body.leaseToken?.trim() ?? "";
    const terminalPhase = parseLocalTerminalPhase(body.phase);
    const parsedRecords = parseLocalFinishRecords(
      body.records ?? [],
      LOCAL_TURN_FINISH_MAX_ROWS,
    );
    if (
      !LOCAL_DEVICE_ID_PATTERN.test(deviceId) ||
      !expectedOwnerGeneration ||
      !LOCAL_TURN_ID_PATTERN.test(localTurnId) ||
      !/^[a-f0-9]{64}$/.test(leaseToken) ||
      !terminalPhase ||
      !parsedRecords
    ) {
      return json({ code: "bad_request", message: "Malformed request." }, 400);
    }
    const owner = await this.localTurnOwner(
      request,
      leaseToken,
      expectedOwnerGeneration,
    );
    if (owner instanceof Response) return owner;
    const turnId = makeLocalTurnId(deviceId, localTurnId);
    const { records: parsed, totalBytes } = parsedRecords;
    const finishFingerprint = await sha256Hex(
      JSON.stringify({
        expectedOwnerGeneration,
        phase: terminalPhase,
        notice: body.notice?.trim() ?? "",
        records: parsed.map(({ ordinal, role, payloadJson }) => ({
          ordinal,
          role,
          payloadJson,
        })),
      }),
    );
    const previous = await this.ctx.storage.get<LocalTurnFinishReceipt>(
      localTurnReceiptKey(turnId),
    );
    if (
      previous?.turnId === turnId &&
      previous.ownerGeneration !== expectedOwnerGeneration
    ) {
      return staleOwnerGenerationResponse();
    }
    if (
      previous?.turnId === turnId &&
      previous.deviceId === deviceId &&
      previous.localTurnId === localTurnId &&
      previous.leaseToken === leaseToken
    ) {
      if (previous.externallyCanceled) {
        if (terminalPhase !== "canceled") {
          return json(
            {
              code: "turn_canceled",
              message: "That local turn was already canceled.",
              turnId,
            },
            409,
          );
        }
      } else if (!previous.finishFingerprint) {
        return json(
          {
            code: "turn_expired",
            message: "That local turn lease expired.",
            turnId,
          },
          409,
        );
      } else if (previous.finishFingerprint !== finishFingerprint) {
        return json(
          {
            code: "idempotency_conflict",
            message:
              "That local turn was already finished with different records.",
          },
          409,
        );
      }
      const replayLease =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        replayLease?.turnId === turnId &&
        replayLease.leaseToken === leaseToken
      ) {
        this.live = null;
        this.hub.endTurn(turnId);
        await this.unregisterOwnerTurn(replayLease);
        await this.releaseLocalLeaseAndResume(replayLease);
      }
      return json({ ...previous, replayed: true });
    }

    if (totalBytes > LOCAL_TURN_FINISH_MAX_BYTES) {
      return json(
        {
          code: "too_large",
          message: "That's more history than one request can carry.",
        },
        413,
      );
    }
    if (
      this.journal.storedBytes() + totalBytes >
      CONVERSATION_MAX_STORED_BYTES
    ) {
      return json(
        {
          code: "conversation_full",
          message:
            "This conversation has reached its size limit. Start a new conversation to keep going.",
        },
        413,
      );
    }

    let lease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      !lease ||
      lease.ownerId !== owner.ownerId ||
      lease.ownerGeneration !== expectedOwnerGeneration ||
      lease.turnId !== turnId ||
      lease.deviceId !== deviceId ||
      lease.localTurnId !== localTurnId ||
      lease.leaseToken !== leaseToken
    ) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }
    if (localTurnRetirementDeadline(lease) <= Date.now()) {
      if (lease.cancelRequested) {
        await this.cancelLocalTurn(lease, true);
      } else {
        await this.expireLocalLease(lease, true);
      }
      return json(
        {
          code: lease.cancelRequested ? "turn_finished" : "turn_expired",
          message: lease.cancelRequested
            ? "That local turn was canceled."
            : "That local turn lease expired.",
          turnId,
        },
        409,
      );
    }
    let claimedLease: LocalTurnLease | undefined;
    let idempotencyConflict = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const current =
        await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
      if (
        !current ||
        current.ownerId !== owner.ownerId ||
        current.ownerGeneration !== expectedOwnerGeneration ||
        current.turnId !== turnId ||
        current.deviceId !== deviceId ||
        current.localTurnId !== localTurnId ||
        current.leaseToken !== leaseToken ||
        current.expiresAt <= Date.now() ||
        current.cancelRequested
      ) {
        return;
      }
      if (
        current.finishFingerprint &&
        current.finishFingerprint !== finishFingerprint
      ) {
        idempotencyConflict = true;
        return;
      }
      current.finishFingerprint = finishFingerprint;
      current.expiresAt = Date.now() + LOCAL_TURN_LEASE_MS;
      await this.ctx.storage.put(LOCAL_TURN_LEASE_KEY, current);
      await this.armAlarmNoLaterThan(current.expiresAt);
      claimedLease = current;
    });
    if (idempotencyConflict) {
      return json(
        {
          code: "idempotency_conflict",
          message:
            "That local turn was already finished with different records.",
        },
        409,
      );
    }
    if (!claimedLease) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }
    lease = claimedLease;
    try {
      await this.assertOwnerTurn(lease);
    } catch {
      return json(
        { code: "owner_purge", message: "Cloud activity is being reset." },
        409,
      );
    }

    const prepared: Array<{
      ordinal: number;
      role: "assistant" | "toolResult";
      message: AgentMessage;
      payloadJson: string;
      spillKey?: string;
    }> = [];
    for (const record of parsed) {
      const sized = await this.prepareOversize(
        record.role,
        record.message,
        record.payloadJson,
        `turn:${turnId}:msg:${record.ordinal}`,
      );
      prepared.push({
        ...record,
        message: sized.message,
        payloadJson: sized.payloadJson,
        ...(sized.spillKey ? { spillKey: sized.spillKey } : {}),
      });
    }

    const current =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (
      this.purged() ||
      !current ||
      current.turnId !== turnId ||
      current.leaseToken !== leaseToken ||
      current.ownerGeneration !== expectedOwnerGeneration ||
      current.cancelRequested ||
      current.finishFingerprint !== finishFingerprint
    ) {
      return json(
        {
          code: "lease_mismatch",
          message: "That local turn no longer owns this conversation.",
        },
        409,
      );
    }

    const budgetArgs = {
      bytes: totalBytes,
      windowMs: APPEND_WINDOW_MS,
      maxRequests: APPEND_WINDOW_MAX_REQUESTS,
      maxBytes: APPEND_WINDOW_MAX_BYTES,
    };
    const budget = this.journal.appendBudget({
      ...budgetArgs,
      now: Date.now(),
      commit: false,
    });
    if (!budget.allowed) {
      return json(
        {
          code: "rate_limited",
          message:
            "That's more history than this conversation can take right now.",
          retryAfterMs: budget.retryAfterMs,
        },
        429,
      );
    }

    let firstSeq: number | null = null;
    let lastSeq = -1;
    const terminalAt = Date.now();
    try {
      this.journal.appendBudget({
        ...budgetArgs,
        now: terminalAt,
        commit: true,
      });
      for (const record of prepared) {
        const row = this.journal.appendMessage({
          turnId,
          writer: `desktop:${deviceId}`,
          writerKey: `turn:${turnId}:msg:${record.ordinal}`,
          role: record.role,
          message: record.message,
          payloadJson: record.payloadJson,
          ...(record.spillKey ? { spillKey: record.spillKey } : {}),
          createdAt: terminalAt,
        });
        if (firstSeq === null) firstSeq = row.seq;
        lastSeq = row.seq;
        this.journal.setTurnSpan(turnId, row.seq);
        if (row.inserted) this.publish(row.record);
      }
      const terminal = this.journal.appendTurn({
        turnId,
        writer: `desktop:${deviceId}`,
        writerKey: `turn:${turnId}:phase:${terminalPhase}`,
        phase: terminalPhase,
        lane: "chat",
        source: "desktop",
        ...(body.notice?.trim()
          ? { notice: body.notice.trim().slice(0, 500) }
          : {}),
        createdAt: terminalAt,
      });
      if (firstSeq === null) firstSeq = terminal.seq;
      lastSeq = terminal.seq;
      this.journal.setTurnSpan(turnId, terminal.seq);
      this.journal.setTurnTerminal(turnId, terminalPhase, terminalAt);
      if (terminal.inserted) this.publish(terminal.record);
    } catch (error) {
      log("error", "conversation_local_turn_finish_failed", {
        turnId,
        message: errorMessage(error),
      });
      return json(
        {
          code: "finish_failed",
          message: "Saving that local turn failed. Try again.",
        },
        503,
      );
    }

    const receipt: LocalTurnFinishReceipt = {
      ownerGeneration: lease.ownerGeneration,
      turnId,
      deviceId,
      localTurnId,
      leaseToken,
      phase: terminalPhase,
      firstSeq: firstSeq ?? lastSeq,
      lastSeq,
      epoch: this.journal.meta().epoch,
      finishFingerprint,
    };
    await this.storeLocalTurnReceipt(lease, receipt);
    this.live = null;
    this.hub.endTurn(turnId);
    await this.unregisterOwnerTurn(lease);
    await this.releaseLocalLeaseAndResume(lease);
    await this.index
      .flush({ activity: "idle", updatedAt: terminalAt })
      .catch(() => undefined);
    try {
      this.drainInbox();
    } catch (error) {
      log("error", "conversation_local_turn_finish_drain_failed", {
        turnId,
        message: errorMessage(error),
      });
    }
    await this.archive.maybeRollover(terminalAt).catch((error) => {
      log("error", "conversation_local_turn_finish_rollover_failed", {
        turnId,
        message: errorMessage(error),
      });
    });
    return json({ ...receipt, replayed: false });
  }
}
