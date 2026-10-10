import { JournalHeadConflictError, type JournalRow } from "../journal.js";
import {
  CONVERSATION_EDIT_LEASE_MS,
  CONVERSATION_EDIT_LOCK_KEY,
  CONVERSATION_EDIT_PAGE_BYTES,
  CONVERSATION_EDIT_PAGE_ROWS,
  CONVERSATION_FORK_TARGET_KEY,
  type ConversationEditLock,
  type ConversationEditRequest,
  conversationRewindHeadMatches,
  type ForkConversationEditRequest,
  type ForkTargetState,
  parseConversationEditRequest,
  type RewindConversationEditRequest,
  type RewindConversationEditResult,
  rewindRuntimeAdmission,
  sameConversationEditLock,
} from "../conversation-edit-protocol.js";
import type { ChatTurnRequest, LocalTurnLease } from "./types.js";
import { LOCAL_TURN_LEASE_KEY } from "./constants.js";
import { json, errorMessage, log } from "./support.js";
import { OrchestratorTurnQueue } from "./turn-queue.js";

/** Conversation edits: the edit lock, fork source/target, and rewind. */
export abstract class OrchestratorConversationEdit extends OrchestratorTurnQueue {
  protected async bindConversationEditOwner(
    request: ConversationEditRequest,
    createdAt: number,
    title: string,
  ): Promise<Response | null> {
    const meta = this.journal.meta();
    if (meta.owner_id && meta.owner_id !== request.ownerId) {
      return json(
        { code: "not_found", message: "Conversation not found." },
        404,
      );
    }
    if (!meta.owner_id) {
      if (meta.next_seq !== 0) {
        return json(
          {
            code: "owner_missing",
            message: "Conversation ownership is unavailable.",
          },
          409,
        );
      }
      this.journal.bindOwner({
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        createdAt,
        title,
        conversationId: this.conversationId(),
      });
    }
    this.ownerGeneration = request.ownerGeneration;
    await this.ctx.storage.put("ownerDataGeneration", request.ownerGeneration);
    return null;
  }

  protected async conversationHasRuntimeWork(): Promise<boolean> {
    const [turn, terminal, localLease, queued] = await Promise.all([
      this.ctx.storage.get<ChatTurnRequest>("turn"),
      this.ctx.storage.get<boolean>("terminal"),
      this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY),
      this.ctx.storage.list({ prefix: "queued:", limit: 1 }),
    ]);
    return Boolean(
      (turn !== undefined && terminal !== true) ||
        localLease ||
        queued.size > 0 ||
        this.live ||
        this.activeTurnId ||
        this.currentAgent ||
        this.currentTurnCancellation ||
        this.journal.inboxSize().rows > 0,
    );
  }

  protected async validConversationEditBoundary(
    throughSeq: number,
    headSeq: number,
  ): Promise<boolean> {
    if (throughSeq < -1 || throughSeq > headSeq) return false;
    if (throughSeq === headSeq) return true;
    const next = await this.archive.exportRawPage(
      throughSeq + 1,
      throughSeq + 1,
      1,
      CONVERSATION_EDIT_PAGE_BYTES,
    );
    const row = next.rows[0];
    return Boolean(
      row &&
        row.seq === throughSeq + 1 &&
        row.kind === "message" &&
        row.role === "user" &&
        row.hidden === 0,
    );
  }

  protected async handleConversationEditRoute(
    path: string,
    request: Request,
  ): Promise<Response> {
    const raw = (await request.json().catch(() => null)) as
      | (Record<string, unknown> & {
          fromSeq?: unknown;
          rows?: unknown;
          nextSeq?: unknown;
        })
      | null;
    const parsed = parseConversationEditRequest(raw);
    if (!parsed) {
      return json(
        { code: "bad_request", message: "Malformed conversation edit." },
        400,
      );
    }
    if (path.includes("fork-") && parsed.kind !== "fork") {
      return json(
        { code: "bad_request", message: "Wrong edit operation." },
        400,
      );
    }
    if (path.endsWith("/rewind") && parsed.kind !== "rewind") {
      return json(
        { code: "bad_request", message: "Wrong edit operation." },
        400,
      );
    }
    try {
      switch (path) {
        case "/internal/edit/fork-source/acquire":
          return await this.acquireForkSource(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-source/export":
          return await this.exportForkSource(
            parsed as ForkConversationEditRequest,
            raw?.fromSeq,
          );
        case "/internal/edit/fork-source/release":
          return await this.releaseForkSource(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-target/begin":
          return await this.beginForkTarget(
            parsed as ForkConversationEditRequest,
            raw,
          );
        case "/internal/edit/fork-target/import":
          return await this.importForkTarget(
            parsed as ForkConversationEditRequest,
            raw,
          );
        case "/internal/edit/fork-target/status":
          return await this.forkTargetStatus(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-target/complete":
          return await this.completeForkTarget(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/fork-target/release":
          return await this.releaseForkTarget(
            parsed as ForkConversationEditRequest,
          );
        case "/internal/edit/rewind":
          return await this.rewindConversation(
            parsed as RewindConversationEditRequest,
          );
        default:
          return json({ error: "Not found." }, 404);
      }
    } catch (error) {
      if (error instanceof JournalHeadConflictError) {
        return json(
          {
            code: "head_conflict",
            message: error.message,
            epoch: error.epoch,
            lastSeq: error.lastSeq,
          },
          409,
        );
      }
      log("error", "conversation_edit_failed", {
        path,
        operationId: parsed.operationId,
        message: errorMessage(error),
      });
      return json(
        { code: "conversation_edit_failed", message: errorMessage(error) },
        503,
      );
    }
  }

  protected async acquireForkSource(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    if (this.conversationId() !== request.sourceConversationId) {
      return json(
        { code: "not_found", message: "Conversation not found." },
        404,
      );
    }
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const ownerError = await this.bindConversationEditOwner(
        request,
        request.sourceCreatedAt,
        request.title,
      );
      if (ownerError) return ownerError;
      const existing = await this.activeConversationEditLock();
      if (
        existing &&
        (existing.kind !== "fork-source" ||
          !sameConversationEditLock(existing, request))
      ) {
        return json(
          {
            code: "conversation_edit_in_progress",
            message: "Another conversation edit is already running.",
          },
          409,
        );
      }
      if (!existing && (await this.conversationHasRuntimeWork())) {
        return json(
          {
            code: "turn_in_progress",
            message:
              "Wait for Stella to finish before forking this conversation.",
            retryAfterMs: 1_000,
          },
          409,
        );
      }
      const head = this.journal.head();
      if (
        head.epoch !== request.expectedEpoch ||
        head.headSeq !== request.expectedLastSeq
      ) {
        return json(
          {
            code: "head_conflict",
            message: "The conversation changed before it could be forked.",
            epoch: head.epoch,
            lastSeq: head.headSeq,
          },
          409,
        );
      }
      const lock: ConversationEditLock = {
        kind: "fork-source",
        operationId: request.operationId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        expectedEpoch: request.expectedEpoch,
        expectedLastSeq: request.expectedLastSeq,
        throughSeq: request.throughSeq,
        expiresAt: Date.now() + CONVERSATION_EDIT_LEASE_MS,
      };
      await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
      return null;
    });
    if (result) return result;
    await this.archive.prepareForEdit();
    if (
      !(await this.validConversationEditBoundary(
        request.throughSeq,
        request.expectedLastSeq,
      ))
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
      return json(
        {
          code: "invalid_boundary",
          message: "Fork at a user-message boundary.",
        },
        409,
      );
    }
    return json({
      acquired: true,
      sourceEpoch: request.expectedEpoch,
      sourceLastSeq: request.expectedLastSeq,
    });
  }

  protected async requireForkSourceLock(
    request: ForkConversationEditRequest,
  ): Promise<ConversationEditLock | Response> {
    const lock = await this.activeConversationEditLock();
    if (
      !lock ||
      lock.kind !== "fork-source" ||
      !sameConversationEditLock(lock, request)
    ) {
      return json(
        {
          code: "fork_lease_lost",
          message: "The fork snapshot lease expired.",
        },
        409,
      );
    }
    const head = this.journal.head();
    if (
      head.epoch !== request.expectedEpoch ||
      head.headSeq !== request.expectedLastSeq
    ) {
      return json(
        {
          code: "head_conflict",
          message: "The fork source changed.",
          epoch: head.epoch,
          lastSeq: head.headSeq,
        },
        409,
      );
    }
    lock.expiresAt = Date.now() + CONVERSATION_EDIT_LEASE_MS;
    await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
    return lock;
  }

  protected async exportForkSource(
    request: ForkConversationEditRequest,
    fromValue: unknown,
  ): Promise<Response> {
    const lock = await this.requireForkSourceLock(request);
    if (lock instanceof Response) return lock;
    const fromSeq =
      typeof fromValue === "number" && Number.isSafeInteger(fromValue)
        ? fromValue
        : -2;
    if (fromSeq < 0 || fromSeq > request.throughSeq) {
      return json(
        { code: "bad_request", message: "Invalid fork cursor." },
        400,
      );
    }
    const page = await this.archive.exportRawPage(
      fromSeq,
      request.throughSeq,
      CONVERSATION_EDIT_PAGE_ROWS,
      CONVERSATION_EDIT_PAGE_BYTES,
      async () => {
        const renewed = await this.requireForkSourceLock(request);
        if (renewed instanceof Response) {
          throw new Error("The fork source lease expired. Retry the request.");
        }
      },
    );
    return json(page);
  }

  protected async releaseForkSource(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.activeConversationEditLock();
    if (
      lock?.kind === "fork-source" &&
      sameConversationEditLock(lock, request)
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
    }
    return json({ released: true });
  }

  protected forkTargetMatches(
    state: ForkTargetState,
    request: ForkConversationEditRequest,
  ): boolean {
    return (
      state.operationId === request.operationId &&
      state.ownerId === request.ownerId &&
      state.ownerGeneration === request.ownerGeneration &&
      state.sourceConversationId === request.sourceConversationId &&
      state.targetConversationId === request.targetConversationId &&
      state.throughSeq === request.throughSeq &&
      state.sourceEpoch === request.expectedEpoch &&
      state.sourceLastSeq === request.expectedLastSeq
    );
  }

  protected forkTargetLock(
    request: ForkConversationEditRequest,
  ): ConversationEditLock {
    return {
      kind: "fork-target",
      operationId: request.operationId,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration,
      expectedEpoch: request.expectedEpoch,
      expectedLastSeq: request.expectedLastSeq,
      throughSeq: request.throughSeq,
      expiresAt: Date.now() + CONVERSATION_EDIT_LEASE_MS,
    };
  }

  protected async requireForkTargetLock(
    request: ForkConversationEditRequest,
  ): Promise<ConversationEditLock | Response> {
    const lock = await this.activeConversationEditLock();
    if (
      !lock ||
      lock.kind !== "fork-target" ||
      !sameConversationEditLock(lock, request)
    ) {
      return json(
        {
          code: "fork_lease_lost",
          message: "The fork target lease expired. Retry the same request.",
        },
        409,
      );
    }
    lock.expiresAt = Date.now() + CONVERSATION_EDIT_LEASE_MS;
    await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
    return lock;
  }

  protected async beginForkTarget(
    request: ForkConversationEditRequest,
    raw: Record<string, unknown> | null,
  ): Promise<Response> {
    if (this.conversationId() !== request.targetConversationId) {
      return json(
        { code: "not_found", message: "Fork target not found." },
        404,
      );
    }
    const sourceEpoch = raw?.sourceEpoch;
    const sourceLastSeq = raw?.sourceLastSeq;
    if (
      sourceEpoch !== request.expectedEpoch ||
      sourceLastSeq !== request.expectedLastSeq
    ) {
      return json(
        { code: "source_conflict", message: "Fork source changed." },
        409,
      );
    }
    return await this.ctx.blockConcurrencyWhile(async () => {
      const activeLock = await this.activeConversationEditLock();
      if (
        activeLock &&
        (activeLock.kind !== "fork-target" ||
          !sameConversationEditLock(activeLock, request))
      ) {
        return json(
          {
            code: "conversation_edit_in_progress",
            message: "Another conversation edit is already running.",
          },
          409,
        );
      }
      const existing = await this.ctx.storage.get<ForkTargetState>(
        CONVERSATION_FORK_TARGET_KEY,
      );
      if (existing) {
        if (!this.forkTargetMatches(existing, request)) {
          return json(
            {
              code: "target_conflict",
              message: "Fork target is already in use.",
            },
            409,
          );
        }
        await this.ctx.storage.put(
          CONVERSATION_EDIT_LOCK_KEY,
          this.forkTargetLock(request),
        );
        return json({ begun: true, replayed: true });
      }
      const meta = this.journal.meta();
      if (
        meta.next_seq !== 0 ||
        (meta.owner_id !== "" && meta.owner_id !== request.ownerId) ||
        (meta.conversation_id !== "" &&
          meta.conversation_id !== request.targetConversationId)
      ) {
        return json(
          { code: "target_conflict", message: "Fork target is not empty." },
          409,
        );
      }
      const ownerError = await this.bindConversationEditOwner(
        request,
        request.targetCreatedAt,
        request.title,
      );
      if (ownerError) return ownerError;
      const state: ForkTargetState = {
        operationId: request.operationId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        sourceConversationId: request.sourceConversationId,
        targetConversationId: request.targetConversationId,
        sourceEpoch: request.expectedEpoch,
        sourceLastSeq: request.expectedLastSeq,
        throughSeq: request.throughSeq,
        nextSeq: 0,
        title: request.title,
        createdAt: request.targetCreatedAt,
        state: "copying",
      };
      await this.ctx.storage.put({
        [CONVERSATION_FORK_TARGET_KEY]: state,
        [CONVERSATION_EDIT_LOCK_KEY]: this.forkTargetLock(request),
      });
      return json({ begun: true, replayed: false });
    });
  }

  protected parseForkRows(value: unknown): JournalRow[] | null {
    if (!Array.isArray(value) || value.length > CONVERSATION_EDIT_PAGE_ROWS) {
      return null;
    }
    const rows: JournalRow[] = [];
    for (const valueRow of value) {
      if (
        !valueRow ||
        typeof valueRow !== "object" ||
        Array.isArray(valueRow)
      ) {
        return null;
      }
      const row = valueRow as Partial<JournalRow>;
      if (
        !Number.isSafeInteger(row.seq) ||
        typeof row.kind !== "string" ||
        typeof row.turn_id !== "string" ||
        typeof row.writer !== "string" ||
        typeof row.writer_key !== "string" ||
        !Number.isSafeInteger(row.created_at) ||
        !Number.isSafeInteger(row.bytes) ||
        typeof row.payload_json !== "string" ||
        !Number.isSafeInteger(row.hidden) ||
        !Number.isSafeInteger(row.model_skip) ||
        !Number.isSafeInteger(row.open_calls) ||
        !Number.isSafeInteger(row.tokens)
      ) {
        return null;
      }
      rows.push(row as JournalRow);
    }
    return rows;
  }

  protected async importForkTarget(
    request: ForkConversationEditRequest,
    raw: Record<string, unknown> | null,
  ): Promise<Response> {
    const lock = await this.requireForkTargetLock(request);
    if (lock instanceof Response) return lock;
    const state = await this.ctx.storage.get<ForkTargetState>(
      CONVERSATION_FORK_TARGET_KEY,
    );
    if (!state || !this.forkTargetMatches(state, request)) {
      return json(
        { code: "target_conflict", message: "Fork target is unavailable." },
        409,
      );
    }
    if (state.state === "complete")
      return json({ imported: true, replayed: true });
    const rows = this.parseForkRows(raw?.rows);
    if (!rows || rows.length === 0) {
      return json({ code: "bad_request", message: "Fork page is empty." }, 400);
    }
    const firstSeq = rows[0]!.seq;
    const currentNext = this.journal.meta().next_seq;
    if (firstSeq !== currentNext) {
      return json(
        {
          code: "fork_cursor_conflict",
          message: "Fork page does not match the target cursor.",
          nextSeq: currentNext,
        },
        409,
      );
    }
    const mappedSpills = new Map<string, string>();
    for (const row of rows) {
      if (!row.spill_key) continue;
      let targetKey = mappedSpills.get(row.spill_key);
      if (!targetKey) {
        const beforeCopy = await this.requireForkTargetLock(request);
        if (beforeCopy instanceof Response) return beforeCopy;
        targetKey = await this.archive.copyForkSpill(
          row.spill_key,
          request.operationId,
        );
        const afterCopy = await this.requireForkTargetLock(request);
        if (afterCopy instanceof Response) return afterCopy;
        mappedSpills.set(row.spill_key, targetKey);
      }
      row.spill_key = targetKey;
    }
    const imported = this.journal.importForkRows(
      rows,
      request.operationId,
      request.ownerId,
    );
    if (!imported) {
      return json({ code: "bad_request", message: "Fork page is empty." }, 400);
    }
    const nextSeq = imported.lastSeq + 1;
    if (raw?.nextSeq !== nextSeq || nextSeq > request.throughSeq + 1) {
      throw new Error("Fork source and target cursors diverged.");
    }
    state.nextSeq = nextSeq;
    await this.ctx.storage.put(CONVERSATION_FORK_TARGET_KEY, state);
    return json({
      imported: true,
      nextSeq,
      complete: nextSeq > request.throughSeq,
    });
  }

  protected async forkTargetStatus(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.requireForkTargetLock(request);
    if (lock instanceof Response) return lock;
    const state = await this.ctx.storage.get<ForkTargetState>(
      CONVERSATION_FORK_TARGET_KEY,
    );
    if (!state || !this.forkTargetMatches(state, request)) {
      return json(
        { code: "target_conflict", message: "Fork target is unavailable." },
        409,
      );
    }
    const meta = this.journal.meta();
    const preview =
      state.state === "complete" ? this.journal.lastPreview(160) : null;
    return json({
      state: state.state,
      nextSeq: meta.next_seq,
      targetEpoch: meta.epoch,
      lastSeq: meta.next_seq - 1,
      ...(preview ? { lastPreview: preview.text, lastRole: preview.role } : {}),
    });
  }

  protected async completeForkTarget(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.requireForkTargetLock(request);
    if (lock instanceof Response) return lock;
    const state = await this.ctx.storage.get<ForkTargetState>(
      CONVERSATION_FORK_TARGET_KEY,
    );
    if (!state || !this.forkTargetMatches(state, request)) {
      return json(
        { code: "target_conflict", message: "Fork target is unavailable." },
        409,
      );
    }
    const meta = this.journal.meta();
    if (meta.next_seq !== request.throughSeq + 1) {
      return json(
        { code: "fork_incomplete", message: "Fork target is still copying." },
        409,
      );
    }
    // The source prefix may span many cold R2 segments. Import is deliberately
    // gapless into SQLite first; cut it back to the normal hot window before
    // the target becomes discoverable so a large fork does not stay resident.
    await this.archive.maybeRollover(Date.now());
    state.state = "complete";
    state.nextSeq = meta.next_seq;
    state.completedAt = Date.now();
    await this.ctx.storage.put(CONVERSATION_FORK_TARGET_KEY, state);
    return json({ complete: true });
  }

  protected async releaseForkTarget(
    request: ForkConversationEditRequest,
  ): Promise<Response> {
    const lock = await this.activeConversationEditLock();
    if (
      lock?.kind === "fork-target" &&
      sameConversationEditLock(lock, request)
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
      // Publish the copy to the owner's index now, not when a client first
      // connects: the index row is what an owner purge finds it by.
      await this.index
        .flush({ activity: "idle", updatedAt: Date.now() })
        .catch(() => undefined);
    }
    return json({ released: true });
  }

  protected async requestRewindCancellation(): Promise<void> {
    const queued = await this.ctx.storage.list({ prefix: "queued:", limit: 1 });
    if (queued.size > 0) {
      throw new Error("Queued turns must be canceled before rewinding.");
    }
    const localLease =
      await this.ctx.storage.get<LocalTurnLease>(LOCAL_TURN_LEASE_KEY);
    if (localLease) await this.cancelLocalTurn(localLease);
    const turn = await this.ctx.storage.get<ChatTurnRequest>("turn");
    if (turn && !(await this.ctx.storage.get<boolean>("terminal"))) {
      await this.cancelTurn(turn.turnId);
    }
  }

  protected async renewRewindLock(
    request: RewindConversationEditRequest,
  ): Promise<void> {
    const lock = await this.activeConversationEditLock();
    if (
      !lock ||
      lock.kind !== "rewind" ||
      !sameConversationEditLock(lock, request)
    ) {
      throw new Error("The rewind lease expired. Retry the same request.");
    }
    lock.expiresAt = Date.now() + CONVERSATION_EDIT_LEASE_MS;
    await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
  }

  protected async finalizeRewindSideEffects(
    request: RewindConversationEditRequest,
    now: number,
  ): Promise<void> {
    this.live = null;
    this.hub.closeAll(1012);
    const lock = await this.activeConversationEditLock();
    if (lock?.kind === "rewind" && sameConversationEditLock(lock, request)) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
    }
    await this.index
      .flush({ activity: "idle", updatedAt: now })
      .catch(() => undefined);
    await this.archive.drainPurge().catch((error) => {
      log("error", "conversation_rewind_cleanup_deferred", {
        operationId: request.operationId,
        message: errorMessage(error),
      });
    });
  }

  protected async rewindConversation(
    request: RewindConversationEditRequest,
  ): Promise<Response> {
    if (this.conversationId() !== request.conversationId) {
      return json(
        { code: "not_found", message: "Conversation not found." },
        404,
      );
    }
    const meta = this.journal.meta();
    const replay =
      this.journal.conversationEditReceipt<RewindConversationEditResult>(
        request.operationId,
        "rewind",
      );
    if (replay) {
      if (meta.owner_id !== request.ownerId) {
        return json(
          { code: "not_found", message: "Conversation not found." },
          404,
        );
      }
      await this.finalizeRewindSideEffects(request, Date.now());
      return json({ ...replay, replayed: true });
    }
    const admission = await this.ctx.blockConcurrencyWhile(async () => {
      const ownerError = await this.bindConversationEditOwner(
        request,
        meta.created_at,
        meta.title || "Conversation",
      );
      if (ownerError) return { ok: false, response: ownerError } as const;
      const head = this.journal.head();
      const existingLock = await this.activeConversationEditLock();
      if (
        !conversationRewindHeadMatches(
          request,
          { epoch: head.epoch, lastSeq: head.headSeq },
          existingLock,
        )
      ) {
        return {
          ok: false,
          response: json(
            {
              code: "head_conflict",
              message: "The conversation changed before it could be rewound.",
              epoch: head.epoch,
              lastSeq: head.headSeq,
            },
            409,
          ),
        } as const;
      }
      if (existingLock && !sameConversationEditLock(existingLock, request)) {
        return {
          ok: false,
          response: json(
            {
              code: "conversation_edit_in_progress",
              message: "Another edit is running.",
            },
            409,
          ),
        } as const;
      }
      const queued = await this.ctx.storage.list({
        prefix: "queued:",
        limit: 1,
      });
      const runtimeWork = await this.conversationHasRuntimeWork();
      const runtimeAdmission = rewindRuntimeAdmission(request, {
        runtimeWork,
        queuedTurn: queued.size > 0,
        continuingOperation: existingLock !== null,
      });
      if (runtimeAdmission === "turn-conflict") {
        return {
          ok: false,
          response: json(
            {
              code: "turn_in_progress",
              message: "Wait for Stella to finish before rewinding.",
              retryAfterMs: 1_000,
            },
            409,
          ),
        } as const;
      }
      if (runtimeAdmission === "queued-conflict") {
        return {
          ok: false,
          response: json(
            {
              code: "queued_turn_conflict",
              message: "Cancel queued turns before rewinding.",
            },
            409,
          ),
        } as const;
      }
      const lock: ConversationEditLock = {
        kind: "rewind",
        operationId: request.operationId,
        ownerId: request.ownerId,
        ownerGeneration: request.ownerGeneration,
        expectedEpoch: request.expectedEpoch,
        expectedLastSeq: request.expectedLastSeq,
        throughSeq: request.throughSeq,
        expiresAt: Date.now() + CONVERSATION_EDIT_LEASE_MS,
      };
      await this.ctx.storage.put(CONVERSATION_EDIT_LOCK_KEY, lock);
      return { ok: true, head, runtimeWork } as const;
    });
    if (!admission.ok) return admission.response;
    const { head, runtimeWork } = admission;
    if (runtimeWork) {
      await this.requestRewindCancellation();
      return json({
        complete: false,
        kind: "rewind",
        operationId: request.operationId,
        conversationId: request.conversationId,
        previousEpoch: request.expectedEpoch,
        nextEpoch: request.expectedEpoch,
        lastSeq: request.expectedLastSeq,
        cancelRequested: true,
      } satisfies RewindConversationEditResult);
    }
    if (
      !(await this.validConversationEditBoundary(
        request.throughSeq,
        head.headSeq,
      ))
    ) {
      await this.ctx.storage.delete(CONVERSATION_EDIT_LOCK_KEY);
      return json(
        {
          code: "invalid_boundary",
          message: "Rewind at a user-message boundary.",
        },
        409,
      );
    }

    const now = Date.now();
    const plan = await this.archive.prepareTruncate(
      request.throughSeq,
      request.expectedEpoch + 1,
      now,
      () => this.renewRewindLock(request),
    );
    const result: RewindConversationEditResult & { replayed: boolean } = {
      complete: true,
      kind: "rewind",
      operationId: request.operationId,
      conversationId: request.conversationId,
      previousEpoch: request.expectedEpoch,
      nextEpoch: request.expectedEpoch + 1,
      lastSeq: request.throughSeq,
      ...(plan.lastPreview
        ? {
            lastPreview: plan.lastPreview.text,
            lastRole: plan.lastPreview.role,
          }
        : {}),
      replayed: false,
    };
    await this.renewRewindLock(request);
    await this.journal.applyTruncate({
      operationId: request.operationId,
      throughSeq: request.throughSeq,
      expectedEpoch: request.expectedEpoch,
      expectedLastSeq: head.headSeq,
      replacementSegment: plan.replacementSegment,
      removedSegmentFirstSeqs: plan.removedSegmentFirstSeqs,
      purgeKeys: plan.purgeKeys,
      retiredWriterKeys: plan.retiredWriterKeys,
      retiredTurnIds: plan.removedTurnIds,
      retiredAt: now,
      resultJson: JSON.stringify(result),
    });
    await this.finalizeRewindSideEffects(request, now);
    return json(result);
  }
}
