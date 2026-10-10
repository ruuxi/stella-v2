import type { DevicesResponse } from "@stella/contracts/turn-plane/placement";
import {
  PROMPT_CONTEXT_KEY,
  type PromptContext,
  type ResidentPrompt,
  reusablePromptContext,
  sessionResidentPrompts,
} from "../prompt-context.js";
import type { ExecutionContextSnapshot } from "@stella/contracts/execution-context";
import { renderSystemPrompt } from "@stella/runtime/kernel/agent-runtime/frozen-context.js";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type {
  AgentMessage,
  AgentToolResult,
} from "@stella/runtime/kernel/agent-core/types.js";
import {
  assertTurnExecutionActive,
  type TurnRetryCancellation,
} from "../turn-cancellation.js";
import { AgentHome } from "../agent-home.js";
import { stableValueMarker } from "../hash.js";
import {
  buildCloudSystemPromptSections,
  type CanonicalPrompts,
  cloudResidentContext,
} from "../cloud-prompt.js";
import { resolveOpenToolCall } from "../tool-replay.js";
import { Journal } from "../journal.js";
import {
  type CloudCliTurnIdentity,
  type CloudCliTurnTerminal,
  type CloudOrchestratorToolCallResponse,
  orchestratorCliThreadId,
  parseCloudOrchestratorCliTurnSpec,
} from "@stella/contracts/cloud-orchestrator-cli";
import {
  cancelOrchestratorCliTurn,
  cliFinalReplyMessage,
  cliFinalReplyMissing,
  cliToolResultFromMessage,
  composeOrchestratorCliPrompt,
  dispatchOrchestratorCliTurn,
  ORCHESTRATOR_CLI_CONTEXT_MAX_CHARS,
  ORCHESTRATOR_CLI_DELIVERED_KEY,
  ORCHESTRATOR_CLI_TURN_KEY,
  ORCHESTRATOR_CLI_WRITER,
  type OrchestratorCliDelivered,
  orchestratorCliFinalWriterKey,
  OrchestratorCliPreviousTurnBusy,
  orchestratorCliToolCallKey,
  type OrchestratorCliToolCallRecord,
  orchestratorCliToolCatalog,
  orchestratorCliToolResultWriterKey,
  type OrchestratorCliTurnRecord,
  parseCliTurnEventsForward,
  parseCliTurnTerminal,
  parseCliTurnToolForward,
  pollOrchestratorCliTurn,
  prewarmOrchestratorCli,
  renderOrchestratorCliContextBlock,
  sameCliTurnIdentity,
  serializeCliToolResult,
} from "../orchestrator-cli-turn.js";
import type {
  WakeReport,
  ChatTurnRequest,
  CliTurnRuntime,
  OwedTerminal,
} from "./types.js";
import {
  CLI_TURN_POLL_MS,
  CLI_RUNTIME_WAIT_MS,
  CLI_DISPATCH_BUSY_RETRY_MS,
  CLI_DISPATCH_BUSY_RETRIES,
  CLI_CONTEXT_ROW_LIMIT,
  CLI_TERMINAL_DURABLE_TEXT_MAX,
  LIVE_TOOL_LIMIT,
  TERMINAL_NOTICE,
} from "./constants.js";
import {
  OwnerPurgeFenceError,
  CliTurnFailedError,
  cloudExecutionContext,
  ChatTurnNotResumableError,
  json,
  errorMessage,
  log,
  requireCloudContext,
  newStreamId,
  previewArgs,
} from "./support.js";
import { OrchestratorTools } from "./tools.js";

/**
 * Claude Code turns: dispatch to the BuildSession, forwarded tools, events, and
 * terminals.
 */
export abstract class OrchestratorCliTurn extends OrchestratorTools {
  /**
   * Wake the conversation's orchestrator container for a Claude Code turn that
   * is being admitted right now, so the turn does not pay a cold start. Fire
   * and forget. Only an admitted turn warms a container: a socket connect or
   * any other passive signal would hold an instance for its whole idle window
   * without a turn ever arriving.
   */
  protected prewarmCliContainer(ownerId: string, conversationId: string): void {
    if (!conversationId) return;
    const startedAt = performance.now();
    this.ctx.waitUntil(
      prewarmOrchestratorCli({
        env: this.env,
        ownerId,
        conversationId,
      }).then((result) => {
        log("info", "orchestrator_cli_prewarm", {
          conversationId,
          ok: result.ok,
          status: result.status ?? null,
          alreadyRunning: result.alreadyRunning ?? null,
          startMs: result.startMs ?? null,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      }),
    );
  }

  protected async runCliTurn(args: {
    turn: ChatTurnRequest;
    turnCancellation: TurnRetryCancellation;
    executionSignal: AbortSignal;
    resumeTurn: boolean;
    started: number;
    agentHome: AgentHome;
    preparationTimings: Record<string, number>;
    measurePreparation: <T>(name: string, work: () => Promise<T>) => Promise<T>;
    canonicalPromptsWork: Promise<CanonicalPrompts>;
    destinationsWork: Promise<DevicesResponse | null>;
    assertExactTurnActive: () => Promise<void>;
  }): Promise<Response> {
    const { turn, turnCancellation, executionSignal, assertExactTurnActive } =
      args;
    const execution = turn.execution;
    if (execution.engine !== "anthropic") {
      throw new Error("Only an anthropic execution runs on Claude Code.");
    }
    const stored = await this.getTurnState<OrchestratorCliTurnRecord>(
      ORCHESTRATOR_CLI_TURN_KEY,
    );
    // A record for this turn means its dispatch may already have left this
    // object. Never dispatch it again; wait for that attempt.
    const prior = stored?.turnId === turn.turnId ? stored : undefined;
    const identity: CloudCliTurnIdentity = prior
      ? {
          conversationId: prior.conversationId,
          threadId: prior.threadId,
          turnId: prior.turnId,
          attemptGeneration: prior.attemptGeneration,
        }
      : {
          conversationId: turn.conversationId,
          threadId: orchestratorCliThreadId(turn.conversationId),
          turnId: turn.turnId,
          attemptGeneration: (stored?.attemptGeneration ?? 0) + 1,
        };

    const prefetchedHome = this.cloudHomePreparations.get(turn.turnId)?.home;
    const loadHome = () => this.prepareCloudHomeContext(turn);
    const homeWork = prefetchedHome
      ? prefetchedHome.catch(loadHome)
      : loadHome();
    this.cloudHomePreparations.delete(turn.turnId);
    const [home, canonicalPrompts, locale, destinations] = await Promise.all([
      homeWork.then((context) => {
        Object.assign(args.preparationTimings, context.timings);
        return context;
      }),
      args.canonicalPromptsWork,
      args.measurePreparation("localeMs", () =>
        this.resolveTurnLocale(turn, () =>
          assertTurnExecutionActive(turnCancellation, executionSignal),
        ),
      ),
      args.destinationsWork,
    ]);
    await assertExactTurnActive();
    const {
      memoryPreference,
      memoryDocuments,
      personalityOverride,
      skillCatalog,
    } = home;
    const { tools, promptTools } = await args.measurePreparation(
      "toolsMs",
      () =>
        this.createTools(
          turn,
          args.agentHome,
          skillCatalog,
          memoryPreference.memoryEnabled,
        ),
    );
    const systemPrompt = renderSystemPrompt(
      buildCloudSystemPromptSections({
        canonicalBody: canonicalPrompts.orchestratorBody,
        tools: promptTools,
        locale,
        threadId: turn.conversationId,
      }),
    );
    const executionContext = cloudExecutionContext(turn, destinations);
    const resident = cloudResidentContext({
      personality: personalityOverride ?? canonicalPrompts.personalityBody,
      memoryDocuments,
      skillCatalog,
      executionContext,
    });
    const spec = parseCloudOrchestratorCliTurnSpec({
      systemPrompt,
      toolCatalog: orchestratorCliToolCatalog(tools),
    });
    if (!spec) {
      throw new Error(
        "The orchestrator prompt or tool catalog does not fit a Claude Code turn.",
      );
    }
    await assertExactTurnActive();

    // Forwarded tool calls run against exactly these tools from here on.
    this.cliRuntimes.set(turn.turnId, {
      identity,
      turn,
      tools,
      signal: executionSignal,
      toolChain: Promise.resolve(),
    });
    for (const waiter of this.cliRuntimeWaiters.get(turn.turnId) ?? []) {
      Deferred.doneUnsafe(waiter, Effect.void);
    }
    this.cliRuntimeWaiters.delete(turn.turnId);

    let dispatched = Boolean(prior);
    let completed = false;
    let deliveredThrough: number | undefined;
    try {
      if (!prior) {
        const report = await this.wakeReport(turn);
        const promptKey = `turn:${turn.turnId}:prompt`;
        const promptSeq =
          args.resumeTurn && this.journal.hasRow(promptKey)
            ? this.journal.selectTurnMessages(turn.turnId).rows[0]?.seq
            : await this.journalCliPrompt(turn, executionContext, report);
        if (promptSeq === undefined) {
          throw new ChatTurnNotResumableError("prompt_row");
        }
        const context = await this.cliPromptContext(promptSeq);
        this.journal.setTurnContext(turn.turnId, context.startSeq, promptSeq);
        // A seeded session starts with nothing; a continuing one has seen
        // what its last delivered turn carried.
        const agentRoster =
          context.kind === "history" ? await this.agentRoster(turn) : undefined;
        const residentPrompts = sessionResidentPrompts({
          resident: agentRoster ? { ...resident, agentRoster } : resident,
          seen: context.kind === "history" ? [] : context.residentSeen,
        });
        this.live = {
          turnId: turn.turnId,
          streamId: null,
          partialText: "",
          tools: [],
        };
        void this.index
          .flush({ activity: "running", updatedAt: Date.now() })
          .catch(() => undefined);
        // What the provider guard checks before every request of Stella's
        // own loop, checked once before the turn leaves this object: Claude
        // Code's requests never pass through here.
        if (!turn.ownerPurgeGeneration || !turn.ownerPurgeLeaseId) {
          throw new OwnerPurgeFenceError();
        }
        await requireCloudContext(
          "agent_home_memory",
          this.ownerGate(turn.ownerId).assertMemoryPolicy(
            memoryPreference,
            turn.ownerPurgeGeneration,
            turn.ownerPurgeLeaseId,
            turn.turnId,
          ),
        );
        const prompt = composeOrchestratorCliPrompt({
          context: context.block,
          resident: residentPrompts.prompts,
          text: report.prompt,
          promptSeq,
          hidden: turn.hiddenMessage === true,
          clock: new Date().toISOString(),
          ...(turn.attachments?.length
            ? { attachments: turn.attachments }
            : {}),
        });
        await assertExactTurnActive();
        await this.putTurnState({
          [ORCHESTRATOR_CLI_TURN_KEY]: {
            ...identity,
            promptSeq,
            appliedBatchSeq: 0,
            dispatchedAt: Date.now(),
            resident: residentPrompts.seen,
          } satisfies OrchestratorCliTurnRecord,
        });
        dispatched = true;
        assertTurnExecutionActive(turnCancellation, executionSignal);
        const dispatchStartedAt = performance.now();
        // The session refuses a new attempt while its previous one is still
        // unwinding (a just-stopped turn's kill ladder). Nothing was admitted
        // then, so the same dispatch is sent again, briefly.
        for (let busy = 0; ; busy += 1) {
          try {
            await dispatchOrchestratorCliTurn({
              env: this.env,
              ownerId: turn.ownerId,
              ownerGeneration: turn.ownerGeneration,
              audience: turn.audience,
              budgetMicroCents: turn.budgetMicroCents,
              identity,
              execution,
              prompt,
              spec,
              clientMsgId: turn.clientMsgId,
              signal: executionSignal,
            });
            break;
          } catch (error) {
            if (
              !(error instanceof OrchestratorCliPreviousTurnBusy) ||
              busy >= CLI_DISPATCH_BUSY_RETRIES
            ) {
              throw error;
            }
            await turnCancellation.sleep(CLI_DISPATCH_BUSY_RETRY_MS);
            await assertExactTurnActive();
          }
        }
        log("info", "orchestrator_cli_turn_dispatched", {
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          attemptGeneration: identity.attemptGeneration,
          context: context.kind,
          contextRows: context.rows,
          promptChars: prompt.length,
          systemPromptChars: spec.systemPrompt.length,
          tools: spec.toolCatalog.length,
          dispatchMs: Math.round(performance.now() - dispatchStartedAt),
          totalPreparationMs: Math.round(performance.now() - args.started),
          ...args.preparationTimings,
        });
      } else {
        this.live = {
          turnId: turn.turnId,
          streamId: null,
          partialText: "",
          tools: [],
        };
        log("info", "orchestrator_cli_turn_resumed", {
          turnId: turn.turnId,
          conversationId: turn.conversationId,
          attemptGeneration: identity.attemptGeneration,
          appliedBatchSeq: prior.appliedBatchSeq,
          terminalLanded: Boolean(prior.terminal),
        });
      }

      let terminal: CloudCliTurnTerminal;
      try {
        terminal = await this.awaitCliTerminal(
          turn,
          identity,
          turnCancellation,
          executionSignal,
        );
      } catch (error) {
        deliveredThrough = this.journal.meta().next_seq - 1;
        if (
          turnCancellation.aborted ||
          executionSignal.aborted ||
          (await this.getTurnState<boolean>("terminal"))
        ) {
          // Stop or the watchdog: whichever path marked the turn terminal
          // wrote its terminal; the container attempt still has to stop.
          this.cancelCliAttempt(turn, identity);
          await this.afterTerminal(turn);
          return json({ ok: false, canceled: true });
        }
        throw error;
      }
      deliveredThrough = this.journal.meta().next_seq - 1;
      log("info", "orchestrator_cli_turn_terminal", {
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        attemptGeneration: identity.attemptGeneration,
        outcome: terminal.outcome,
        inputTokens: terminal.usage.inputTokens,
        outputTokens: terminal.usage.outputTokens,
        llmCalls: terminal.usage.llmCalls,
        wallClockMs: Math.round(performance.now() - args.started),
      });
      if (await this.getTurnState<boolean>("terminal")) {
        await this.afterTerminal(turn);
        return json({ ok: false, canceled: true });
      }
      if (terminal.outcome === "failed") {
        throw new CliTurnFailedError(
          `Claude Code turn failed: ${terminal.error ?? "no detail"}`,
          terminal.error?.trim() || undefined,
        );
      }
      if (terminal.outcome === "canceled") {
        // Stopped from the session's side (an owner purge, a lost container).
        await this.finishCliTurnCanceled(turn);
        return json({ ok: false, canceled: true });
      }
      completed = true;
      const finalText = terminal.finalText.trim();
      this.repairCliFinalReply(turn, finalText);
      return await this.completeChatTurn(turn, finalText, args.started);
    } catch (error) {
      if (dispatched && !completed) this.cancelCliAttempt(turn, identity);
      throw error;
    } finally {
      this.cliRuntimes.delete(turn.turnId);
      for (const waiter of this.cliRuntimeWaiters.get(turn.turnId) ?? []) {
        Deferred.doneUnsafe(waiter, Effect.void);
      }
      this.cliRuntimeWaiters.delete(turn.turnId);
      if (dispatched) {
        await this.settleCliTurn(identity, completed, deliveredThrough).catch(
          (error: unknown) => {
            log("error", "orchestrator_cli_turn_settle_failed", {
              turnId: turn.turnId,
              message: errorMessage(error),
            });
          },
        );
      }
      await this.placeBrainHandoff(
        turn.turnId,
        turnCancellation.aborted || executionSignal.aborted,
      );
    }
  }

  /**
   * The CLI turn's prompt row and `started` phase, the same rows Stella's
   * own loop writes. Its provider context names an epoch no Stella prompt
   * context ever has, so a later Stella turn replays it with its clock and
   * attachments but no stale system reminders.
   */
  protected async journalCliPrompt(
    turn: ChatTurnRequest,
    executionContext: ExecutionContextSnapshot,
    report: WakeReport,
    engine: "claude-code" | "pi" = "claude-code",
  ): Promise<number> {
    const now = Date.now();
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
        epoch: `${engine}:${turn.turnId}`,
        prepend: [],
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
    for (const repaired of this.journal.repairTail(now)) {
      this.publish(repaired.record);
    }
    this.drainInbox();
    const promptRow = this.journal.appendMessage({
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
    return promptRow.seq;
  }

  /**
   * What the CLI session has not seen, ending just before this turn's
   * prompt: the model rows after the delivered seq that the CLI did not write
   * itself (other engines' turns, desktop turns, voice rows), or, for a
   * session that has never seen this conversation, a character-capped tail of
   * it. Desktop's `buildExternalThreadUpdatesDelta`, journal-shaped.
   */
  protected async cliPromptContext(promptSeq: number): Promise<{
    block: string | null;
    kind: "history" | "updates";
    /** The resident prompts the continuing session has already seen. */
    residentSeen: ResidentPrompt[];
    rows: number;
    /** Lowest seq the turn's context depends on; keeps rollover above it. */
    startSeq: number;
  }> {
    const journalEpoch = this.journal.meta().epoch;
    const [delivered, storedContext] = await Promise.all([
      this.getTurnState<OrchestratorCliDelivered>(
        ORCHESTRATOR_CLI_DELIVERED_KEY,
      ),
      this.getTurnState<PromptContext>(PROMPT_CONTEXT_KEY),
    ]);
    const seed =
      !delivered ||
      delivered.journalEpoch !== journalEpoch ||
      delivered.seq >= promptSeq;
    const selection = this.journal.cliContextRows({
      afterSeq: seed ? -1 : delivered.seq,
      beforeSeq: promptSeq,
      // A repair row only closes a dangling call of a turn that ended; a
      // seed keeps the CLI's own rows because its session state is gone.
      excludeWriters: seed ? ["repair"] : [ORCHESTRATOR_CLI_WRITER, "repair"],
      limit: CLI_CONTEXT_ROW_LIMIT,
    });
    const block = renderOrchestratorCliContextBlock({
      kind: seed ? "history" : "updates",
      rows: selection.rows,
      olderOmitted: selection.more,
      maxChars: ORCHESTRATOR_CLI_CONTEXT_MAX_CHARS,
    });
    // A later turn on another engine still finds its own window resident.
    const startSeq = Math.min(
      promptSeq,
      selection.rows[0]?.seq ?? promptSeq,
      reusablePromptContext({
        storedContext,
        journalEpoch,
        ownerGeneration: this.ownerGeneration ?? "",
      })?.startSeq ?? promptSeq,
    );
    return {
      block,
      kind: seed ? "history" : "updates",
      residentSeen: seed ? [] : (delivered.resident ?? []),
      rows: selection.rows.length,
      startSeq,
    };
  }

  /**
   * Wait for the attempt's terminal: the BuildSession's push (woken through
   * `cliTerminalWaiters`, durable in the record for a resumed turn), with a
   * poll as the fallback for a push lost to an eviction. Throws on Stop, the
   * watchdog, or an attempt the session no longer knows.
   */
  protected async awaitCliTerminal(
    turn: ChatTurnRequest,
    identity: CloudCliTurnIdentity,
    turnCancellation: TurnRetryCancellation,
    executionSignal: AbortSignal,
  ): Promise<CloudCliTurnTerminal> {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () =>
        reject(
          executionSignal.reason instanceof Error
            ? executionSignal.reason
            : new Error("The chat turn was stopped."),
        );
      if (executionSignal.aborted) onAbort();
      else executionSignal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    let nextPollAt = Date.now() + CLI_TURN_POLL_MS;
    try {
      for (;;) {
        assertTurnExecutionActive(turnCancellation, executionSignal);
        // Registered before the read, so a terminal landing in between
        // still wakes this wait.
        const landed = new Promise<void>((resolve) =>
          this.cliTerminalWaiters.set(identity.turnId, resolve),
        );
        const inMemory = this.cliTerminals.get(identity.turnId);
        if (inMemory && sameCliTurnIdentity(inMemory, identity))
          return inMemory;
        const record = await this.getTurnState<OrchestratorCliTurnRecord>(
          ORCHESTRATOR_CLI_TURN_KEY,
        );
        if (!record || !sameCliTurnIdentity(record, identity)) {
          throw new Error("The Claude Code turn record was replaced.");
        }
        if (record.terminal) return record.terminal;
        if (Date.now() >= nextPollAt) {
          const status = await pollOrchestratorCliTurn({
            env: this.env,
            identity,
            signal: executionSignal,
          });
          nextPollAt = Date.now() + CLI_TURN_POLL_MS;
          if (status.state === "terminal") return status.terminal;
          if (status.state === "unknown") {
            throw new Error(
              "The orchestrator session has no record of this Claude Code turn.",
            );
          }
          continue;
        }
        await Promise.race([
          landed,
          turnCancellation.sleep(Math.max(1, nextPollAt - Date.now())),
          aborted,
        ]);
      }
    } finally {
      this.cliTerminalWaiters.delete(identity.turnId);
      this.cliTerminals.delete(identity.turnId);
      if (onAbort) executionSignal.removeEventListener("abort", onAbort);
    }
  }

  /** Stop the container attempt through the BuildSession. Fire and forget. */
  protected cancelCliAttempt(
    turn: ChatTurnRequest,
    identity: CloudCliTurnIdentity,
  ): void {
    this.ctx.waitUntil(
      cancelOrchestratorCliTurn({
        env: this.env,
        ownerId: turn.ownerId,
        ownerGeneration: turn.ownerGeneration,
        identity,
        cancelRequestId: `chat:${identity.turnId}:${identity.attemptGeneration}`,
      })
        .then(({ status }) => {
          log("info", "orchestrator_cli_turn_cancel_sent", {
            turnId: identity.turnId,
            attemptGeneration: identity.attemptGeneration,
            status,
          });
        })
        .catch((error: unknown) => {
          log("error", "orchestrator_cli_turn_cancel_failed", {
            turnId: identity.turnId,
            attemptGeneration: identity.attemptGeneration,
            message: errorMessage(error),
          });
        }),
    );
  }

  /**
   * The CLI's reply when its last event batch never arrived: the terminal's
   * `finalText` as the turn's closing assistant row.
   */
  protected repairCliFinalReply(
    turn: ChatTurnRequest,
    finalText: string,
  ): void {
    const own = this.journal.selectTurnMessages(turn.turnId);
    if (!cliFinalReplyMissing(own.messages.at(-1), finalText)) return;
    const appended = this.appendProduced(
      turn,
      cliFinalReplyMessage({
        finalText,
        model: turn.execution.model,
        now: Date.now(),
      }) as AgentMessage,
      {
        writer: ORCHESTRATOR_CLI_WRITER,
        writerKey: orchestratorCliFinalWriterKey(turn.turnId),
        streamId: newStreamId(),
      },
    );
    if (appended) {
      this.publish(appended.record);
      log("info", "orchestrator_cli_final_reply_repaired", {
        turnId: turn.turnId,
        seq: appended.seq,
      });
    }
  }

  /** A canceled terminal the session decided; same writes as `/cancel`. */
  protected async finishCliTurnCanceled(turn: ChatTurnRequest): Promise<void> {
    const owed: OwedTerminal = {
      kind: "canceled",
      message: TERMINAL_NOTICE.canceled,
      eventSeq: await this.nextTurnEventSeq(turn.turnId),
    };
    await this.ctx.storage.put({ terminal: true, terminalOwed: owed });
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
  }

  /**
   * Close the attempt's record so no later frame is accepted for it, and
   * advance what the CLI session has seen: through this turn when the CLI
   * answered at all (a completed turn, or any applied event batch). A turn
   * that failed before the CLI produced anything leaves the mark, so its
   * prompt rides in the next turn's delta.
   */
  protected async settleCliTurn(
    identity: CloudCliTurnIdentity,
    completed: boolean,
    deliveredThrough: number | undefined,
  ): Promise<void> {
    const record = await this.getTurnState<OrchestratorCliTurnRecord>(
      ORCHESTRATOR_CLI_TURN_KEY,
    );
    if (!record || !sameCliTurnIdentity(record, identity)) return;
    const entries: Record<string, unknown> = {
      [ORCHESTRATOR_CLI_TURN_KEY]: {
        ...record,
        finished: true,
      } satisfies OrchestratorCliTurnRecord,
    };
    if (
      deliveredThrough !== undefined &&
      (completed || record.appliedBatchSeq > 0)
    ) {
      // Claude Code summarized its own transcript during the turn, so the
      // resident blocks it was given may be gone: the next turn sends them
      // all again, as the desktop does after the same event.
      entries[ORCHESTRATOR_CLI_DELIVERED_KEY] = {
        journalEpoch: this.journal.meta().epoch,
        seq: deliveredThrough,
        ...(record.resident && !record.compacted
          ? { resident: record.resident }
          : {}),
      } satisfies OrchestratorCliDelivered;
    }
    await this.putTurnState(entries);
  }

  /** Whether frames for this identity still belong to the running turn. */
  protected async cliTurnAccepting(
    identity: CloudCliTurnIdentity,
  ): Promise<OrchestratorCliTurnRecord | null> {
    if (this.purged()) return null;
    const [record, current, terminal] = await Promise.all([
      this.getTurnState<OrchestratorCliTurnRecord>(ORCHESTRATOR_CLI_TURN_KEY),
      this.getTurnState<ChatTurnRequest>("turn"),
      this.getTurnState<boolean>("terminal"),
    ]);
    if (
      !record ||
      record.finished ||
      !sameCliTurnIdentity(record, identity) ||
      current?.turnId !== identity.turnId ||
      current.conversationId !== identity.conversationId ||
      terminal
    ) {
      return null;
    }
    return record;
  }

  /**
   * The running turn's tools. A forward can wake an evicted object before
   * its resumed turn has rebuilt them; it waits (bounded) for that turn,
   * and only while one is actually queued or running here.
   */
  protected async waitForCliRuntime(
    identity: CloudCliTurnIdentity,
  ): Promise<CliTurnRuntime | null> {
    const deadline = Date.now() + CLI_RUNTIME_WAIT_MS;
    for (;;) {
      const runtime = this.cliRuntimes.get(identity.turnId);
      if (runtime) {
        return sameCliTurnIdentity(runtime.identity, identity) ? runtime : null;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !this.turnExecutions.has(identity.turnId)) {
        return null;
      }
      const woken = Deferred.makeUnsafe<void>();
      const waiters = this.cliRuntimeWaiters.get(identity.turnId) ?? [];
      waiters.push(woken);
      this.cliRuntimeWaiters.set(identity.turnId, waiters);
      // Whichever comes first: the turn publishing its runtime, or this slice
      // of the wait expiring so the deadline is re-checked.
      await Effect.runPromise(
        Effect.raceFirst(
          Deferred.await(woken),
          Effect.sleep(Math.min(remaining, 5_000)),
        ),
      );
    }
  }

  protected noteTurnTool(
    turn: ChatTurnRequest,
    call: { toolCallId: string; name: string; args: unknown },
    phase: "start" | "end",
    isError?: boolean,
  ): void {
    if (this.live?.turnId === turn.turnId) {
      if (phase === "start") {
        this.live.tools.push({
          toolCallId: call.toolCallId,
          name: call.name,
          phase: "start",
        });
        if (this.live.tools.length > LIVE_TOOL_LIMIT) this.live.tools.shift();
      } else {
        const entry = this.live.tools.find(
          (tool) => tool.toolCallId === call.toolCallId,
        );
        if (entry) {
          entry.phase = "end";
          entry.isError = isError === true;
        }
      }
    }
    this.hub.broadcastTool({
      turnId: turn.turnId,
      toolCallId: call.toolCallId,
      name: call.name,
      phase,
      ...(phase === "start"
        ? { argsPreview: previewArgs(call.args) }
        : { isError: isError === true }),
    });
    this.slack().tool(turn.turnId, call.toolCallId, call.name, phase, isError);
  }

  /**
   * `CLOUD_CLI_TURN_DO_PATHS.tool`: run one of this turn's tools for the
   * CLI. Exactly-once per tool call id: a replay with the same arguments
   * joins the call in flight or returns the journaled result; different
   * arguments are a conflict. A call whose first execution was lost to an
   * eviction is answered by its replay policy (`resolveOpenToolCall`).
   */
  protected async handleCliTurnTool(request: Request): Promise<Response> {
    const forward = parseCliTurnToolForward(
      await request.json().catch(() => null),
    );
    if (!forward) return json({ error: "Malformed CLI tool call." }, 400);
    const refuse = (
      code: "turn_inactive" | "unknown_tool" | "conflict",
      message: string,
    ): Response =>
      json({
        ok: false,
        error: { code, message },
      } satisfies CloudOrchestratorToolCallResponse);
    const inactive = () =>
      refuse("turn_inactive", "This chat turn is no longer running.");
    if (!(await this.cliTurnAccepting(forward))) return inactive();
    const runtime = await this.waitForCliRuntime(forward);
    if (!runtime) return inactive();
    const tool = runtime.tools.find(
      (candidate) => candidate.name === forward.name,
    );
    if (!tool) {
      return refuse(
        "unknown_tool",
        `${forward.name} is not one of this turn's tools.`,
      );
    }
    const key = orchestratorCliToolCallKey(forward.turnId, forward.toolCallId);
    const fingerprint = await stableValueMarker([
      "orchestrator-cli-tool/v1",
      forward.name,
      forward.args,
    ]);
    const recorded =
      await this.getTurnState<OrchestratorCliToolCallRecord>(key);
    if (recorded && recorded.fingerprint !== fingerprint) {
      return refuse(
        "conflict",
        "That tool call id was already used with different arguments.",
      );
    }
    const inflight = this.cliToolCalls.get(key);
    if (inflight) return json(await inflight);
    const journaled = this.journal.messageByWriterKey(
      orchestratorCliToolResultWriterKey(forward.turnId, forward.toolCallId),
    );
    const replayed = journaled ? cliToolResultFromMessage(journaled) : null;
    if (replayed) {
      return json({
        ok: true,
        result: replayed,
      } satisfies CloudOrchestratorToolCallResponse);
    }
    const work = this.runCliToolCall(runtime, forward, {
      key,
      fingerprint,
      lostExecution: Boolean(recorded),
    });
    this.cliToolCalls.set(key, work);
    try {
      return json(await work);
    } finally {
      if (this.cliToolCalls.get(key) === work) this.cliToolCalls.delete(key);
    }
  }

  protected runCliToolCall(
    runtime: CliTurnRuntime,
    forward: CloudCliTurnIdentity & {
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
    },
    call: { key: string; fingerprint: string; lostExecution: boolean },
  ): Promise<CloudOrchestratorToolCallResponse> {
    const inactive: CloudOrchestratorToolCallResponse = {
      ok: false,
      error: {
        code: "turn_inactive",
        message: "This chat turn is no longer running.",
      },
    };
    const { turn } = runtime;
    const run = runtime.toolChain.then(
      async (): Promise<CloudOrchestratorToolCallResponse> => {
        if (runtime.signal.aborted || !(await this.cliTurnAccepting(forward))) {
          return inactive;
        }
        await this.putTurnState({
          [call.key]: {
            fingerprint: call.fingerprint,
            startedAt: Date.now(),
          } satisfies OrchestratorCliToolCallRecord,
        });
        this.noteTurnTool(turn, forward, "start");
        let message: AgentMessage;
        if (call.lostExecution) {
          // Its first execution started in an isolate that is gone: rerun a
          // safe/keyed tool, or report an unsafe one as interrupted.
          const resolved = await resolveOpenToolCall({
            tools: runtime.tools,
            call: {
              toolCallId: forward.toolCallId,
              toolName: forward.name,
              params: forward.args,
            },
            started: true,
            signal: runtime.signal,
            now: () => Date.now(),
          });
          message = resolved.message;
        } else {
          const tool = runtime.tools.find(
            (candidate) => candidate.name === forward.name,
          )!;
          let result: Pick<
            AgentToolResult<unknown>,
            "content" | "details" | "isError"
          >;
          try {
            result = await tool.execute(
              forward.toolCallId,
              forward.args as never,
              runtime.signal,
            );
          } catch (error) {
            if (runtime.signal.aborted) return inactive;
            result = {
              content: [{ type: "text", text: errorMessage(error) }],
              details: null,
              isError: true,
            };
          }
          message = {
            role: "toolResult",
            toolCallId: forward.toolCallId,
            toolName: forward.name,
            content: result.content,
            details: result.details,
            isError: result.isError === true,
            timestamp: Date.now(),
          } as AgentMessage;
        }
        if (runtime.signal.aborted || !(await this.cliTurnAccepting(forward))) {
          return inactive;
        }
        const writerKey = orchestratorCliToolResultWriterKey(
          forward.turnId,
          forward.toolCallId,
        );
        const appended = this.appendProduced(turn, message, {
          writer: ORCHESTRATOR_CLI_WRITER,
          writerKey,
          streamId: null,
        });
        if (appended) this.publish(appended.record);
        const isError = (message as { isError?: boolean }).isError === true;
        this.noteTurnTool(turn, forward, "end", isError);
        const stored = this.journal.messageByWriterKey(writerKey) ?? message;
        return {
          ok: true,
          result:
            cliToolResultFromMessage(stored) ??
            serializeCliToolResult({
              content: [],
              details: null,
              isError,
            }),
        };
      },
    );
    runtime.toolChain = run.catch(() => undefined);
    return run;
  }

  /**
   * `CLOUD_CLI_TURN_DO_PATHS.events`: one ordered batch of the CLI's stream.
   * Finalized assistant messages are journaled and published exactly as
   * Stella's own loop does on `message_end` (writer `orchestrator-cli`), in
   * one transaction with the batch cursor, so a replayed batch is a no-op.
   *
   * `text_delta` is ignored: this object has never broadcast reply deltas
   * (assistant text is delivered whole, `LiveTurnSnapshot.partialText` stays
   * empty) and every client already renders cloud turns from committed rows.
   * `status` is logged; there is no client frame for it yet.
   */
  protected async handleCliTurnEvents(request: Request): Promise<Response> {
    const forward = parseCliTurnEventsForward(
      await request.json().catch(() => null),
    );
    if (!forward) return json({ error: "Malformed CLI event batch." }, 400);
    const record = await this.cliTurnAccepting(forward);
    if (!record) {
      return json(
        {
          ok: false,
          code: "turn_inactive",
          message: "This chat turn is no longer running.",
        },
        409,
      );
    }
    if (forward.batchSeq <= record.appliedBatchSeq) {
      return json({ ok: true, replayed: true });
    }
    if (forward.batchSeq !== record.appliedBatchSeq + 1) {
      return json(
        {
          ok: false,
          code: "batch_out_of_order",
          expectedBatchSeq: record.appliedBatchSeq + 1,
        },
        409,
      );
    }
    const turn = await this.getTurnState<ChatTurnRequest>("turn");
    if (!turn) {
      return json({ ok: false, code: "turn_inactive" }, 409);
    }
    let usage = record.usage;
    let compacted = record.compacted === true;
    for (const event of forward.events) {
      if (event.type === "usage") {
        usage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          llmCalls: event.llmCalls,
        };
      } else if (event.type === "status") {
        if (event.state === "compacting") compacted = true;
        log("info", "orchestrator_cli_turn_status", {
          turnId: turn.turnId,
          state: event.state,
        });
      }
    }
    let appended: Array<ReturnType<Journal["appendMessage"]>>;
    try {
      appended = this.ctx.storage.transactionSync(() => {
        const rows: Array<ReturnType<Journal["appendMessage"]>> = [];
        let index = this.journal.maxProducedIndex(turn.turnId) + 1;
        for (const event of forward.events) {
          if (event.type !== "assistant_message") continue;
          const row = this.appendProduced(
            turn,
            event.message as unknown as AgentMessage,
            {
              writer: ORCHESTRATOR_CLI_WRITER,
              writerKey: `turn:${turn.turnId}:msg:${index}`,
              streamId: newStreamId(),
            },
          );
          index += 1;
          if (row) rows.push(row);
        }
        this.ctx.storage.kv.put(ORCHESTRATOR_CLI_TURN_KEY, {
          ...record,
          appliedBatchSeq: forward.batchSeq,
          ...(usage ? { usage } : {}),
          ...(compacted ? { compacted: true } : {}),
        } satisfies OrchestratorCliTurnRecord);
        return rows;
      });
    } catch (error) {
      log("error", "orchestrator_cli_events_failed", {
        turnId: turn.turnId,
        batchSeq: forward.batchSeq,
        message: errorMessage(error),
      });
      return json({ ok: false, code: "persist_failed" }, 503);
    }
    for (const row of appended) this.publish(row.record);
    return json({ ok: true });
  }

  /**
   * `CLOUD_CLI_TURN_DO_PATHS.terminal`: the attempt is over. Durable in the
   * record before the waiting turn is woken, so a resumed turn finds it. A
   * repeat, or a terminal for an attempt this object no longer runs, is
   * acknowledged as a no-op so the BuildSession stops retrying.
   */
  protected async handleCliTurnTerminal(request: Request): Promise<Response> {
    const terminal = parseCliTurnTerminal(
      await request.json().catch(() => null),
    );
    if (!terminal) return json({ error: "Malformed CLI turn terminal." }, 400);
    const record = await this.getTurnState<OrchestratorCliTurnRecord>(
      ORCHESTRATOR_CLI_TURN_KEY,
    );
    if (!record || record.finished || !sameCliTurnIdentity(record, terminal)) {
      log("info", "orchestrator_cli_terminal_ignored", {
        turnId: terminal.turnId,
        attemptGeneration: terminal.attemptGeneration,
        outcome: terminal.outcome,
      });
      return json({ ok: true, ignored: true });
    }
    if (!record.terminal) {
      // The full reply stays in memory for the waiting turn; the durable
      // copy, read only after an eviction, is capped under the value limit.
      await this.putTurnState({
        [ORCHESTRATOR_CLI_TURN_KEY]: {
          ...record,
          terminal: {
            ...terminal,
            finalText: terminal.finalText.slice(
              0,
              CLI_TERMINAL_DURABLE_TEXT_MAX,
            ),
          },
        } satisfies OrchestratorCliTurnRecord,
      });
    }
    this.cliTerminals.set(terminal.turnId, terminal);
    this.cliTerminalWaiters.get(terminal.turnId)?.();
    return json({ ok: true });
  }
}
