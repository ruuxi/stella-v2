/**
 * LocalAgentManager
 *
 * Two layers stacked on top of each other for every subagent thread, easy to
 * conflate:
 *
 *   1. Conversation layer — `subagentSession`, keyed by durable `threadId`,
 *      holds the long-lived `Agent` + message array. Lives across many
 *      runs and is only disposed when the task reaches a real terminal
 *      state (see end of `executeTask`) or `cancelAgent` is called.
 *
 *   2. Run-loop layer — `executeTask` / `runSubagent`. Each call to
 *      `runSubagent` is one user-turn → assistant-resolution cycle: a
 *      user message goes in, the assistant streams + uses tools until it
 *      decides to stop, then `runSubagent` returns.
 *
 * What this file historically called a "restart" only happens at layer 2.
 * Layer 1 is untouched: the session's message array is preserved across
 * the re-entry, so the LLM sees `[system, original user, prior turns,
 * follow-up user]` — i.e. the same conversation continuing with a new
 * user turn. The cached prefix doesn't change, prompt cache is preserved.
 *
 * `send_input` steers a live native Pi agent at its next safe boundary. The
 * current provider response and any issued tools finish first, then the new
 * user message is appended and the same loop continues. If input lands before
 * a live Pi agent exists, it remains queued for the next natural turn.
 */
/**
 * Transitional type surface for TS importers of this evolved JS module.
 * @typedef {any} LocalAgentContext
 * @typedef {any} AgentLifecycleEvent
 */
import path from "path";
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime, Scope, } from "effect";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { AGENT_ORCHESTRATION_TOOL_NAMES } from "../tools/defs/task.js";
import { sanitizeForLogs, truncate } from "../tools/utils.js";
import { getOrCreateSubagentSession } from "../agent-runtime/subagent-session.js";
import { isCloudAgentStartAdmissionError } from "../runner/computer-agent-cloud-records.js";
const formatTaskUpdateStatusText = (text) => truncate(text.replace(/\s+/g, " ").trim(), 200);
const ENV_ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/g;
const SECRET_FLAG_RE =
    /(\s--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;
const TOOL_ACTIVITY_HINT_CHARS = 320;
const redactEnvironmentValues = (value) => {
    if (Array.isArray(value)) {
        return value.map(redactEnvironmentValues);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (/^(?:env|environment)$/i.test(key) && entry && typeof entry === "object") {
            output[key] = Object.fromEntries(Object.keys(entry).map((envKey) => [envKey, "[REDACTED]"]));
            continue;
        }
        output[key] = redactEnvironmentValues(entry);
    }
    return output;
};
export const sanitizeTaskToolArgsHint = (value) => {
    let serialized = "";
    try {
        const json = JSON.stringify(redactEnvironmentValues(sanitizeForLogs(value)));
        serialized = typeof json === "string" ? json : "";
    } catch {
        return "";
    }
    return truncate(
        serialized.replace(ENV_ASSIGNMENT_RE, "$1=[REDACTED]").replace(SECRET_FLAG_RE, "$1 [REDACTED]"),
        TOOL_ACTIVITY_HINT_CHARS,
    );
};
const exitCodeFromToolEnd = (event) => {
    const details = event.details && typeof event.details === "object" ? event.details : null;
    const value = details?.exitCode ?? details?.exit_code;
    return typeof value === "number" ? value : undefined;
};
const taskToolActivityFromStart = (event) => {
    const argsHint = sanitizeTaskToolArgsHint(event.args);
    return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        label: event.statusText ?? `Running ${event.toolName}`,
        ...(argsHint ? { argsHint } : {}),
        state: "started",
    };
};
const taskToolActivityFromEnd = (event) => {
    const exitCode = exitCodeFromToolEnd(event);
    const argsHint = sanitizeTaskToolArgsHint(event.details);
    return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        label: exitCode === undefined ? `Finished ${event.toolName}` : `${event.toolName} exited ${exitCode}`,
        ...(argsHint ? { argsHint } : {}),
        state: "completed",
        ...(exitCode !== undefined ? { exitCode } : {}),
    };
};
const normalizeString = (value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};
const normalizeFsPathKey = (candidate, cwd) => {
    const resolved = path.resolve(cwd ?? process.cwd(), candidate);
    const normalized = path.normalize(resolved);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};
const pathsOverlap = (a, b) => {
    if (a === "*" || b === "*") return true;
    if (a === b) return true;
    const sep = path.sep;
    return a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
};
const BASH_PATH_PATTERN = String.raw`(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])`;
const extractBashPath = (command) => {
    const match = command.match(
        new RegExp(
            String.raw`(?:^|\s)(?:"(${BASH_PATH_PATTERN}[^"]+)"|'(${BASH_PATH_PATTERN}[^']+)'|(${BASH_PATH_PATTERN}[^\s"'` +
                "`" +
                String.raw`]+))`,
        ),
    );
    return match?.[1] ?? match?.[2] ?? match?.[3];
};
const READ_ONLY_EXEC_TOOLS = new Set([
    "read_file",
    "search",
    "glob",
    "web_fetch",
    "web_search",
    "heartbeat_get",
    "cron_list",
    "describe",
]);
const EXEC_MUTATION_PATTERNS = [
    /\btools\s*\.\s*write_file\s*\(/,
    /\btools\s*\.\s*apply_patch\s*\(/,
    /\btools\s*\.\s*shell\s*\(/,
    /\btools\s*\.\s*display\s*\(/,
    /\btools\s*\.\s*memory\s*\(/,
    /\btools\s*\.\s*spawn_agent\s*\(/,
    /\btools\s*\.\s*send_input\s*\(/,
    /\btools\s*\.\s*pause_agent\s*\(/,
    /\btools\s*\.\s*cron_(?:add|update|remove|run)\s*\(/,
    /\btools\s*\.\s*heartbeat_(?:upsert|run)\s*\(/,
    /\btools\s*\.\s*schedule\s*\(/,
    /\bfs(?:\.promises)?\.(?:writeFile|appendFile|cp|copyFile|rename|rm|rmdir|unlink|mkdir|mkdtemp|truncate|chmod|chown|utimes)\s*\(/,
    /\bchild_process\s*\.\s*(?:exec|execFile|spawn|fork)\s*\(/,
    /\bprocess\s*\.\s*chdir\s*\(/,
];
const isClearlyReadOnlyExecProgram = (source) => {
    for (const pattern of EXEC_MUTATION_PATTERNS) {
        if (pattern.test(source)) {
            return false;
        }
    }
    const toolCalls = source.matchAll(/\btools\s*\.\s*(\w+)\s*\(/g);
    for (const match of toolCalls) {
        const method = match[1];
        if (!method || !READ_ONLY_EXEC_TOOLS.has(method)) {
            return false;
        }
    }
    return true;
};
const getFsLockKey = (toolName, args, context) => {
    if (toolName === "Write" || toolName === "Edit") {
        const filePath = normalizeString(args.file_path ?? args.path ?? args.target_path);
        if (!filePath) return "*";
        return normalizeFsPathKey(
            filePath,
            normalizeString(args.working_directory ?? args.cwd ?? context?.stellaAppDir),
        );
    }
    if (toolName === "Bash") {
        const command = normalizeString(args.command);
        if (!command) return "*";
        const pathFromCommand = extractBashPath(command);
        if (!pathFromCommand) return "*";
        return normalizeFsPathKey(
            pathFromCommand,
            normalizeString(args.working_directory ?? args.cwd ?? context?.stellaAppDir),
        );
    }
    if (toolName === "Exec") {
        const source = normalizeString(args.source ?? args.code);
        if (!source) return "*";
        return isClearlyReadOnlyExecProgram(source) ? null : "*";
    }
    return null;
};
const isSpawnAgentTool = (toolName) => toolName === "spawn_agent";
export const AGENT_SHUTDOWN_CANCEL_REASON = "Canceled because Stella closed or restarted.";
export const AGENT_ORPHANED_RESTART_CANCEL_REASON = "Canceled because Stella restarted before the agent finished.";
// Sentinel set by the orchestrator's pause_agent tool so the runner
// can suppress the hidden `[Task canceled]` follow-up turn that would
// otherwise replace the user-facing reply with an empty silence.
export const AGENT_PAUSE_CANCEL_REASON = "Paused by orchestrator.";
export const DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS = 5_000;
/**
 * Requirements-free runtime for the manager's supervisory fibers (house
 * convention: ONE module-level ManagedRuntime, context rides in closures —
 * never a per-call `Effect.runPromise`). Same fence as
 * `shared/supervised-scope.ts`: Effect types cross the class surface only on
 * the explicitly Effect-native `*Effect` methods consumed inside
 * `packages/runtime`.
 */
const managerRuntime = ManagedRuntime.make(Layer.empty);
const isTerminalSnapshotStatus = (status) => status === "completed" || status === "error" || status === "canceled";
export class LocalAgentManager {
    defaultMaxConcurrent;
    opts;
    tasks = new Map();
    pendingQueue = [];
    runningCount = 0;
    inFlightAttempts = new Map();
    /**
     * Supervisory scope for the manager's own fibers: per-attempt supervision
     * fibers (`attemptFibers`) and stale-attempt takeover deadline fibers
     * (`attemptTakeoverDeadlines`). Closed at the end of `shutdown()`, which
     * interrupts every remaining supervisory fiber. Run-loop work is NEVER
     * forked in here — cancellation of a run stays cooperative via its
     * `AbortController` so the agent loop always settles through its terminal
     * events.
     */
    supervisoryScope = Scope.makeUnsafe();
    supervisoryScopeClosed = false;
    supervisoryScopeClosePromise = null;
    /**
     * FiberMap-style keyed attempt supervision: one fiber per in-flight
     * `executeTask` attempt, keyed by durable threadId, forked into the
     * supervisory scope. The fiber joins the attempt promise and owns the
     * slot-release bookkeeping that used to hang off `execution.finally`.
     * Identity fences (generation + promise) — not fiber identity — guard
     * every mutation, so a late-settling superseded attempt can never release
     * a successor's slot.
     */
    attemptFibers = new Map();
    /**
     * Stale-attempt takeover deadlines as sleeping fibers (formerly unref'd
     * `setTimeout`s). Interrupted by `clearAttemptTakeoverTimer` or by scope
     * close; the deadline body re-validates map/generation/promise identity,
     * so an interrupt racing an already-started body is harmless.
     */
    attemptTakeoverDeadlines = new Map();
    cancelCascadeInProgress = new Set();
    activeFsLocks = [];
    fsLockWaiters = [];
    /**
     * Long-lived per-task subagent sessions keyed by durable threadId (E2).
     * Created lazily on first `executeTask` for a thread, reused across
     * restart-on-input attempts within the same thread, disposed when the
     * task reaches a terminal status. Paused tasks keep their session.
     */
    subagentSessions = new Map();
    static MAX_QUEUE_MESSAGES = 32;
    static MAX_LOG_MESSAGES = 80;
    nextId = 0;
    /**
     * Threads whose durable rows were still `running` when this manager booted
     * — i.e. the agent work interrupted by the previous shutdown/restart. The
     * boot sweep below flips those rows, so this snapshot (captured before the
     * flip) is the only surviving record of "what was in flight at shutdown".
     * Consumed by the restart-with-continuation boot conversion.
     */
    bootInterruptedThreads = [];
    /** Episode id the boot capture was authorized under (see opts). */
    bootInterruptionEpisodeId = null;
    /** Owned restart replays from terminal runtime rows into the cloud outbox. */
    terminalReceiptRecoveries = new Set();
    /** Concurrent lifecycle deliveries keyed by their stable durable identity. */
    lifecycleEventDeliveries = new Map();
    /**
     * Small process-local bridge between a successful callback and the caller
     * stamping its durable receipt. Without it, cancelAgent and executeTask can
     * both observe terminalEventEmitted=false around the same awaited callback.
     */
    deliveredLifecycleEventIds = new Set();
    constructor(opts) {
        this.opts = opts;
        this.defaultMaxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
        const orphanedRecords = this.recoverOrCancelOrphanedPersistedAgents();
        this.recoverPersistedCloudTerminalReceipts(orphanedRecords);
        this.recoverPersistedLocalTerminalLifecycleReceipts(orphanedRecords);
    }
    /** Threads that were running at the previous shutdown (pre-sweep snapshot). */
    getBootInterruptedThreads() {
        return [...this.bootInterruptedThreads];
    }
    /**
     * Episode id the pre-flip capture was authorized under; null when the
     * capture is unauthorized (no shutdown record / retained attempted one).
     */
    getBootInterruptionEpisodeId() {
        return this.bootInterruptionEpisodeId;
    }
    recoverOrCancelOrphanedPersistedAgents() {
        const now = Date.now();
        const runningRecords = this.opts.listAgentRecordsByStatus?.("running") ?? [];
        const orphanedRecords = [];
        for (const record of runningRecords) {
            this.bootInterruptedThreads.push({
                threadId: record.threadId,
                conversationId: record.conversationId,
            });
        }
        if (this.bootInterruptedThreads.length > 0) {
            // Persist the snapshot BEFORE any row below is flipped: after the
            // flip, this in-memory capture is the only remaining evidence of the
            // interruption, and it dies with this process. The returned episode
            // id binds the capture to the shutdown record present right now;
            // conversion refuses the capture if the record changes underneath it.
            // Best-effort — on failure the continuation degrades to requiring a
            // successful interruption-state write on this same boot.
            try {
                this.bootInterruptionEpisodeId =
                    this.opts.persistBootInterruptionSnapshot?.(this.getBootInterruptedThreads()) ?? null;
            } catch {
                // Never let continuation bookkeeping break the boot sweep.
            }
        }
        for (const record of runningRecords) {
            const error = AGENT_ORPHANED_RESTART_CANCEL_REASON;
            // Pre-generation local rows are still safe to retire as generation
            // one: their lifecycle event is display-only and never authorizes a
            // provider or remote mutation. Unknown cloud generations stay
            // unknown and are deliberately excluded from remote recovery.
            const attemptGeneration = Number.isInteger(record.attemptGeneration) && record.attemptGeneration > 0
                ? record.attemptGeneration
                : (record.storageMode ?? "local") === "local"
                    ? 1
                    : record.attemptGeneration;
            const orphaned = {
                ...record,
                status: "canceled",
                ...(attemptGeneration ? { attemptGeneration } : {}),
                completedAt: now,
                error,
                updatedAt: now,
            };
            this.opts.saveAgentRecord?.(orphaned);
            orphanedRecords.push(orphaned);
        }
        return orphanedRecords;
    }
    recoverPersistedCloudTerminalReceipts(additionalRecords = []) {
        if (!this.opts.completeCloudAgentRecord)
            return;
        const terminalRecords = [
            ...additionalRecords,
            ...["completed", "error", "canceled"].flatMap((status) => this.opts.listAgentRecordsByStatus?.(status) ?? []),
        ];
        const seen = new Set();
        for (const record of terminalRecords) {
            const generation = record.attemptGeneration ?? 0;
            const recoveryKey = `${record.threadId}:${generation}:${record.status}`;
            if (record.storageMode !== "cloud" ||
                generation < 1 ||
                !record.ownerGeneration ||
                (record.terminalLifecycleReceiptGeneration === generation &&
                    record.cloudTerminalReceiptGeneration !== generation) ||
                record.cloudTerminalReceiptGeneration === generation ||
                seen.has(recoveryKey)) {
                continue;
            }
            seen.add(recoveryKey);
            const status = record.status === "completed"
                ? "completed"
                : record.status === "canceled"
                    ? "canceled"
                    : "error";
            const recovery = Promise.resolve()
                .then(async () => {
                // Re-admit the deterministic start before its terminal. A crash
                // during the original start write must never leave a terminal-only
                // poison row that Convex can never apply.
                if (this.opts.createCloudAgentRecord) {
                    await this.opts.createCloudAgentRecord({
                        agentId: record.threadId,
                        conversationId: record.conversationId,
                        description: record.description,
                        prompt: record.prompt ?? record.description,
                        agentType: record.agentType,
                        attemptGeneration: generation,
                        ownerGeneration: record.ownerGeneration,
                        ...(record.parentAgentId ? { parentAgentId: record.parentAgentId } : {}),
                    });
                }
                await this.opts.completeCloudAgentRecord({
                    agentId: record.threadId,
                    attemptGeneration: generation,
                    ownerGeneration: record.ownerGeneration,
                    status,
                    result: record.result ? truncate(record.result, 30_000) : undefined,
                    error: record.error ? truncate(record.error, 10_000) : undefined,
                });
            })
                .then(() => {
                const current = this.opts.getAgentRecord?.(record.threadId);
                if (!current ||
                    current.attemptGeneration !== generation ||
                    current.status !== record.status) {
                    return;
                }
                this.opts.saveAgentRecord?.({
                    ...current,
                    cloudTerminalReceiptGeneration: generation,
                });
            })
                .catch((error) => {
                // The terminal runtime row remains the restart receipt. A later
                // boot retries the same generation without fabricating an ACK.
                console.warn("[runtime] cloud terminal receipt recovery failed", error instanceof Error ? error.message : error);
            })
                .finally(() => {
                this.terminalReceiptRecoveries.delete(recovery);
            });
            this.terminalReceiptRecoveries.add(recovery);
        }
    }
    recoverPersistedLocalTerminalLifecycleReceipts(additionalRecords = []) {
        const terminalRecords = [
            ...additionalRecords,
            ...["completed", "error", "canceled"].flatMap((status) => this.opts.listAgentRecordsByStatus?.(status) ?? []),
        ];
        const seen = new Set();
        for (const record of terminalRecords) {
            const generation = record.attemptGeneration ?? 0;
            const recoveryKey = `${record.threadId}:${generation}:${record.status}`;
            if (record.storageMode === "cloud" ||
                generation < 1 ||
                record.terminalLifecycleReceiptGeneration === generation ||
                seen.has(recoveryKey)) {
                continue;
            }
            seen.add(recoveryKey);
            const type = record.status === "completed"
                ? "agent-completed"
                : record.status === "canceled"
                    ? "agent-canceled"
                    : "agent-failed";
            const event = {
                type,
                conversationId: record.conversationId,
                eventId: `${record.threadId}:${generation}:${type}`,
                rootRunId: record.rootRunId,
                agentId: record.threadId,
                agentType: record.agentType,
                description: record.description,
                parentAgentId: record.parentAgentId,
                attemptGeneration: generation,
                ...(record.status === "completed" ? { result: record.result } : { error: record.error }),
                ...(record.status === "canceled" && record.error === AGENT_ORPHANED_RESTART_CANCEL_REASON
                    ? { audience: "display-only" }
                    : {}),
            };
            // Begin delivery immediately. The callback itself therefore runs in
            // this constructor turn (matching the historical boot-sweep
            // contract), while its durable receipt remains asynchronously owned
            // and joined during shutdown.
            const recovery = this.emitAgentLifecycleEventOnce(event)
                .then(() => {
                const current = this.opts.getAgentRecord?.(record.threadId);
                if (!current ||
                    current.storageMode === "cloud" ||
                    current.attemptGeneration !== generation ||
                    current.status !== record.status) {
                    return;
                }
                this.opts.saveAgentRecord?.({
                    ...current,
                    terminalLifecycleReceiptGeneration: generation,
                });
            })
                .catch((error) => {
                // The terminal runtime row remains the restart receipt. The next
                // boot replays this same stable event id.
                console.warn("[runtime] local terminal lifecycle recovery failed", error instanceof Error ? error.message : error);
            })
                .finally(() => {
                this.terminalReceiptRecoveries.delete(recovery);
            });
            this.terminalReceiptRecoveries.add(recovery);
        }
    }
    /**
     * Persist active thread identities before a restart-related sweep changes
     * their durable status. The returned episode id binds the capture to the
     * shutdown record that authorized it; boot conversion rejects every other
     * episode.
     */
    persistInterruptionSnapshot(threads) {
        if (threads.length === 0)
            return null;
        try {
            return this.opts.persistBootInterruptionSnapshot?.(threads) ?? null;
        }
        catch {
            // Continuation bookkeeping must never prevent boot or shutdown. The
            // live capture can still convert on this boot; otherwise recovery fails
            // closed instead of attributing rows to the wrong restart.
            return null;
        }
    }
    consumeTaskMessages(task, recipient) {
        const queue = recipient === "subagent" ? task.toSubagentQueue : task.toOrchestratorQueue;
        if (queue.length === 0) return [];
        const out = [...queue];
        queue.length = 0;
        return out;
    }
    formatTaskPrompt(task, updates, delivery) {
        if (updates.length === 0) {
            return task.prompt;
        }
        const updateBlock = updates.map((text, index) => `${index + 1}. ${text}`).join("\n");
        const updateInstruction =
            "Apply each update per its intent: answer a question or status request and stop; apply new or changed instructions and continue the task. Newer updates override earlier ones.";
        if (task.turnCount === 0) {
            return [task.prompt, "Task updates:", updateBlock, updateInstruction].join("\n\n");
        }
        return [
            "Task update:",
            updateBlock,
            delivery === "steering"
                ? updateInstruction
                : `Your previous turn finished before this queued update was delivered. ${updateInstruction}`,
        ].join("\n\n");
    }
    buildTaskPrompt(task) {
        return this.formatTaskPrompt(task, this.consumeTaskMessages(task, "subagent"), "next-turn");
    }
    /**
     * Wake-up seam for blocking waiters. Purely a notification: waiters
     * re-read the durable record and decide for themselves, so SQLite stays
     * the only truth and a missed wakeup (e.g. a record rehydrated by
     * another writer) is covered by the caller's fallback timeout. One shared
     * per-thread Deferred; completed + replaced on every persisted transition.
     */
    updateLatches = new Map();
    /**
     * Per-thread settlement latches, completed exactly when a terminal
     * transition (completed/error/canceled) is persisted for the thread. A
     * `send_input` resurrection re-arms naturally: the next waiter creates a
     * fresh latch that the next terminal transition completes.
     */
    settlementLatches = new Map();
    latchFor(latches, threadId) {
        const existing = latches.get(threadId);
        if (existing)
            return existing;
        const latch = Deferred.makeUnsafe();
        latches.set(threadId, latch);
        return latch;
    }
    openLatch(latches, threadId) {
        const latch = latches.get(threadId);
        if (!latch)
            return;
        latches.delete(threadId);
        Deferred.doneUnsafe(latch, Effect.void);
    }
    notifyAgentUpdated(threadId) {
        this.openLatch(this.updateLatches, threadId);
    }
    settleAgentThread(threadId) {
        this.openLatch(this.settlementLatches, threadId);
    }
    /**
     * Effect variant of `waitForAgentUpdate`: resolves on the next persisted
     * update for `threadId`, or after `timeoutMs` as a rehydration-safe
     * fallback (a non-finite/non-positive `timeoutMs` waits unbounded, as
     * before). Never fails.
     */
    waitForAgentUpdateEffect(threadId, timeoutMs = 2_000) {
        return Effect.suspend(() => {
            const wait = Deferred.await(this.latchFor(this.updateLatches, threadId));
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                return wait;
            }
            // raceFirst interrupts the losing arm, so a woken waiter tears down
            // its fallback sleep (the Effect replacement for `clearTimeout`).
            return Effect.raceFirst(wait, Effect.sleep(timeoutMs));
        });
    }
    /**
     * Resolve on the next persisted update for `threadId`, or after
     * `timeoutMs` as a rehydration-safe fallback. Replaces fixed-interval
     * completion polling: terminal transitions wake blocking callers
     * immediately instead of on the next poll tick.
     */
    waitForAgentUpdate(threadId, timeoutMs = 2_000) {
        return managerRuntime.runPromise(this.waitForAgentUpdateEffect(threadId, timeoutMs));
    }
    /**
     * Await the thread's terminal settlement (completed/error/canceled) and
     * return the terminal snapshot fields, or `null` when no record exists
     * anywhere (the caller's "record disappeared" case). Completion detection
     * is Deferred-driven — a terminal transition wakes the waiter immediately —
     * with a bounded fallback re-read (`fallbackRecheckMs`) so records mutated
     * by out-of-band writers still settle; SQLite remains the only truth (the
     * latch is only ever a wakeup, every pass re-reads the snapshot).
     *
     * This is the Effect-native replacement for polling `getAgent` until a
     * terminal status appears (`runBlockingLocalAgent`'s historical 250ms
     * loop). Cancellation note: interrupting THIS effect abandons the wait
     * only — it never cancels the underlying run.
     */
    awaitAgentSettledEffect(threadId, fallbackRecheckMs = 2_000) {
        const manager = this;
        return Effect.gen(function* () {
            for (;;) {
                // Latch first, snapshot second: a terminal transition landing
                // between the two completes the latch we already hold, so the
                // wakeup cannot be missed.
                const settled = Deferred.await(manager.latchFor(manager.settlementLatches, threadId));
                const snapshot = yield* Effect.promise(() => manager.getAgent(threadId));
                if (!snapshot)
                    return null;
                if (isTerminalSnapshotStatus(snapshot.status)) {
                    return {
                        threadId,
                        status: snapshot.status,
                        ...(typeof snapshot.result === "string"
                            ? { result: snapshot.result }
                            : {}),
                        ...(typeof snapshot.error === "string"
                            ? { error: snapshot.error }
                            : {}),
                    };
                }
                yield* Number.isFinite(fallbackRecheckMs) && fallbackRecheckMs > 0
                    ? Effect.raceFirst(settled, Effect.sleep(fallbackRecheckMs))
                    : settled;
            }
        });
    }
    /** Promise facade over `awaitAgentSettledEffect`. */
    awaitAgentSettled(threadId, fallbackRecheckMs = 2_000) {
        return managerRuntime.runPromise(this.awaitAgentSettledEffect(threadId, fallbackRecheckMs));
    }
    rememberDeliveryEventId(task, eventId) {
        if (!eventId || task.consumedDescendantEventIds.includes(eventId))
            return;
        task.consumedDescendantEventIds.push(eventId);
        if (task.consumedDescendantEventIds.length > 256) {
            task.consumedDescendantEventIds.splice(0, task.consumedDescendantEventIds.length - 256);
        }
    }
    persistTask(task) {
        this.notifyAgentUpdated(task.threadId);
        if (task.status === "completed" ||
            task.status === "error" ||
            task.status === "canceled") {
            this.settleAgentThread(task.threadId);
        }
        const isParked = task.status === "completed" && task.descendantFinalParked;
        const boundaryState =
            task.consumedDescendantEventIds.length > 0 || task.descendantWakePending || isParked
                ? {
                      consumedEventIds: task.consumedDescendantEventIds.slice(-256),
                      wakePending: task.descendantWakePending,
                      ...(isParked ? { finalParked: true } : {}),
                  }
                : undefined;
        this.opts.saveAgentRecord?.({
            threadId: task.threadId,
            conversationId: task.conversationId,
            storageMode: task.storageMode,
            ...(task.ownerGeneration ? { ownerGeneration: task.ownerGeneration } : {}),
            agentType: task.agentType,
            description: task.description,
            ...(task.initialPrompt
                ? {
                      prompt: task.initialPrompt,
                      promptCreatedAt: task.promptCreatedAt,
                  }
                : {}),
            agentDepth: task.agentDepth,
            ...(typeof task.maxAgentDepth === "number" ? { maxAgentDepth: task.maxAgentDepth } : {}),
            ...(task.parentAgentId ? { parentAgentId: task.parentAgentId } : {}),
            ...(boundaryState ? { descendantBoundaryState: boundaryState } : {}),
            ...(task.modelConfigSnapshot ? { modelConfigSnapshot: task.modelConfigSnapshot } : {}),
            ...(task.toolWorkspaceRoot ? { toolWorkspaceRoot: task.toolWorkspaceRoot } : {}),
            status: task.status === "pending" || isParked ? "running" : task.status,
            attemptGeneration: task.attemptGeneration,
            ...(task.rootRunId ? { rootRunId: task.rootRunId } : {}),
            ...(typeof task.cloudTerminalReceiptGeneration === "number"
                ? { cloudTerminalReceiptGeneration: task.cloudTerminalReceiptGeneration }
                : {}),
            ...(typeof task.terminalLifecycleReceiptGeneration === "number"
                ? { terminalLifecycleReceiptGeneration: task.terminalLifecycleReceiptGeneration }
                : {}),
            startedAt: task.startedAt,
            completedAt: isParked ? null : task.completedAt,
            ...(typeof task.result === "string" ? { result: task.result } : {}),
            ...(typeof task.error === "string" ? { error: task.error } : {}),
            updatedAt: Date.now(),
        });
    }
    buildTaskSnapshot(task) {
        const isParked = task.status === "completed" && task.descendantFinalParked;
        const isActive = isParked || task.status === "running" || task.status === "pending";
        return {
            id: task.threadId,
            description: task.description,
            status: isActive || task.status === "pending" ? "running" : task.status,
            startedAt: task.startedAt,
            completedAt: isParked ? null : task.completedAt,
            result: isParked ? undefined : task.result,
            error: task.error,
            recentActivity: isActive ? task.recentActivity : undefined,
            lastActivityAt: task.lastActivityAt,
            activeToolCount: isActive ? task.activeToolCount : 0,
            messages: task.messageLog.slice(-10),
        };
    }
    buildPersistedSnapshot(record) {
        return {
            id: record.threadId,
            description: record.description,
            status: record.status,
            startedAt: record.startedAt,
            completedAt: record.completedAt,
            ...(record.result ? { result: record.result } : {}),
            ...(record.error ? { error: record.error } : {}),
        };
    }
    isDescendantOf(threadId, ancestorThreadId) {
        const visited = new Set();
        let cursor = this.getAgentState(threadId)?.parentAgentId;
        while (cursor) {
            if (cursor === ancestorThreadId) return true;
            if (visited.has(cursor)) return false;
            visited.add(cursor);
            cursor = this.getAgentState(cursor)?.parentAgentId;
        }
        return false;
    }
    hasActiveDescendants(parentThreadId) {
        for (const task of this.tasks.values()) {
            if (
                task.threadId !== parentThreadId &&
                this.isActiveAgentState(task) &&
                this.isDescendantOf(task.threadId, parentThreadId)
            ) {
                return true;
            }
        }
        for (const record of this.opts.listAgentRecordsByStatus?.("running") ?? []) {
            if (!this.tasks.has(record.threadId) && this.isDescendantOf(record.threadId, parentThreadId)) {
                return true;
            }
        }
        return false;
    }
    shouldParkFinalForDescendants(task) {
        // Stella, Claude Code, and ChatGPT/Codex share this manager boundary: a
        // General's natural final is not root-facing until every descendant has
        // reached a terminal state.
        return (
            task.status === "completed" &&
            task.agentType === AGENT_IDS.GENERAL &&
            this.hasActiveDescendants(task.threadId)
        );
    }
    /**
     * Resolve the thread that owns a subagent's completion routing: its direct
     * parent agent thread, or undefined when the agent was spawned by the root
     * orchestrator (the only case that reaches root chat and notifies the user).
     * Missing links and legacy cycles return null so an unattributable thread is
     * never guessed into root chat.
     */
    resolveOwningParentThread(threadId, parentAgentId) {
        const parent = parentAgentId ?? this.getAgentState(threadId)?.parentAgentId;
        if (!parent) return undefined;
        // The direct parent owns routing, but the whole ancestry still has to be
        // sane: legacy rows can contain multi-node cycles, and attributing a
        // report inside one would route it to a thread that is also its own
        // descendant. Walk to the root once and refuse anything that doesn't
        // terminate.
        const visited = new Set([threadId]);
        let cursor = parent;
        while (cursor) {
            if (visited.has(cursor)) return null;
            visited.add(cursor);
            const state = this.getAgentState(cursor);
            if (!state) return null;
            cursor = state.parentAgentId;
        }
        return parent;
    }
    getAgentState(threadId) {
        return this.tasks.get(threadId) ?? this.opts.getAgentRecord?.(threadId) ?? null;
    }
    evictTerminalTaskIfDurable(task) {
        if (
            task.descendantFinalParked ||
            (task.status !== "completed" && task.status !== "error" && task.status !== "canceled")
        ) {
            return;
        }
        const persisted = this.opts.getAgentRecord?.(task.threadId);
        if (
            !persisted ||
            persisted.status !== task.status ||
            (persisted.attemptGeneration ?? 0) < task.attemptGeneration
        ) {
            return;
        }
        const hasDurableTerminalReceipt = task.storageMode === "cloud"
            ? persisted.cloudTerminalReceiptGeneration === task.attemptGeneration ||
                (task.cloudStartAdmissionRejectedGeneration === task.attemptGeneration &&
                    persisted.terminalLifecycleReceiptGeneration === task.attemptGeneration)
            : persisted.terminalLifecycleReceiptGeneration === task.attemptGeneration;
        if (!hasDurableTerminalReceipt) {
            // A terminal SQLite row is the restart receipt, but the in-memory
            // owner must stay resident until that exact generation has reached
            // either the cloud outbox or the local lifecycle transcript.
            return;
        }
        // The authoritative record, queues, and thread transcript now live in
        // SQLite. Keeping the terminal task object would retain result/file
        // payloads forever and makes this map grow with the lifetime chat.
        this.tasks.delete(task.threadId);
    }
    isActiveAgentState(task) {
        return (
            task?.status === "pending" ||
            task?.status === "running" ||
            (task?.status === "completed" && "descendantFinalParked" in task && task.descendantFinalParked)
        );
    }
    lifecycleEventId(task, type) {
        return task.storageMode === "cloud" && task.ownerGeneration
            ? `${task.threadId}:${task.ownerGeneration}:${task.attemptGeneration}:${type}`
            : `${task.threadId}:${task.attemptGeneration}:${type}`;
    }
    async emitAgentLifecycleEventOnce(event) {
        const eventId = event.eventId?.trim();
        if (eventId && this.opts.hasAgentLifecycleEvent?.(event.conversationId, eventId, event.type)) {
            return;
        }
        if (!eventId) {
            await this.opts.onAgentEvent?.(event);
            return;
        }
        const deliveryKey = `${event.conversationId}\u0000${event.type}\u0000${eventId}`;
        if (this.deliveredLifecycleEventIds.has(deliveryKey)) {
            return;
        }
        const existing = this.lifecycleEventDeliveries.get(deliveryKey);
        if (existing) {
            await existing;
            return;
        }
        let resolveDelivery;
        let rejectDelivery;
        const delivery = new Promise((resolve, reject) => {
            resolveDelivery = resolve;
            rejectDelivery = reject;
        });
        // Publish the reservation before invoking user code so even a
        // synchronous/re-entrant terminal callback observes the same delivery.
        this.lifecycleEventDeliveries.set(deliveryKey, delivery);
        try {
            try {
                Promise.resolve(this.opts.onAgentEvent?.(event)).then(resolveDelivery, rejectDelivery);
            }
            catch (error) {
                rejectDelivery(error);
            }
            await delivery;
            this.deliveredLifecycleEventIds.add(deliveryKey);
            // Bound the volatile bridge; the durable hasAgentLifecycleEvent
            // check is authoritative after the receipt is stamped.
            if (this.deliveredLifecycleEventIds.size > 4_096) {
                const oldest = this.deliveredLifecycleEventIds.values().next().value;
                if (oldest)
                    this.deliveredLifecycleEventIds.delete(oldest);
            }
        }
        finally {
            if (this.lifecycleEventDeliveries.get(deliveryKey) === delivery) {
                this.lifecycleEventDeliveries.delete(deliveryKey);
            }
        }
    }
    assertActiveParentChain(request) {
        if (!request.parentAgentId) return;
        const visited = new Set();
        let cursor = request.parentAgentId;
        while (cursor) {
            if (visited.has(cursor)) {
                throw new Error("Cannot create a child under a cyclic parent chain.");
            }
            visited.add(cursor);
            const parent = this.getAgentState(cursor);
            if (!parent) {
                throw new Error(`Parent thread not found: ${cursor}`);
            }
            if (parent.conversationId !== request.conversationId) {
                throw new Error("Cannot create a child in another conversation.");
            }
            if (!this.isActiveAgentState(parent)) {
                throw new Error(`Cannot create a child because parent thread ${cursor} is paused or finished.`);
            }
            cursor = parent.parentAgentId;
        }
    }
    resetTaskForNextAttempt(task, prompt) {
        // Invalidate any older executeTask still unwinding after an abort. It may
        // finish later, but it no longer owns this thread's mutable state.
        task.attemptGeneration += 1;
        task.prompt = prompt;
        task.status = "pending";
        task.startedAt = Date.now();
        task.completedAt = null;
        task.result = undefined;
        task.error = undefined;
        task.descendantFinalParked = false;
        task.progressBuffer = "";
        task.recentActivity = [`Continuing thread: ${truncate(prompt, 200)}`];
        task.lastActivityAt = Date.now();
        task.activeToolCount = 0;
        task.toSubagentQueue.length = 0;
        task.toOrchestratorQueue.length = 0;
        // Effect-ratchet pin: `task.controller` is the subagent attempt's
        // cooperative cancellation seam — a REAL AbortSignal threaded through
        // the plain-TS agent session/tools; each new attempt gets a fresh one.
        task.controller = new AbortController();
        task.terminalEventEmitted = false;
        task.cloudTerminalReceiptGeneration = undefined;
        task.terminalLifecycleReceiptGeneration = undefined;
        task.cloudStartReceiptGeneration = undefined;
        task.cloudStartAdmissionRejectedGeneration = undefined;
        task.cloudStartAdmissionPendingGeneration = undefined;
        task.pendingStartStatusText = undefined;
        task.pendingStartAudience = undefined;
        // Cleared here so a bare reset reads as a spawn; the follow-up callers
        // (`sendAgentMessage` / `deliverFollowUpAsNextTurn`) re-set it right after.
        task.pendingStartIsFollowUp = undefined;
    }
    hydrateTaskFromRecord(record, prompt, statusText = prompt) {
        const task = {
            threadId: record.threadId,
            conversationId: record.conversationId,
            description: record.description,
            prompt,
            agentType: record.agentType,
            agentDepth: record.agentDepth,
            maxAgentDepth: record.maxAgentDepth,
            status: "pending",
            startedAt: Date.now(),
            completedAt: null,
            // Effect-ratchet pin: fresh attempt seam controller (see
            // resetTaskForNextAttempt above).
            controller: new AbortController(),
            storageMode: record.storageMode ?? "local",
            ...(record.ownerGeneration ? { ownerGeneration: record.ownerGeneration } : {}),
            parentAgentId: record.parentAgentId,
            descendantFinalParked: false,
            consumedDescendantEventIds: [...(record.descendantBoundaryState?.consumedEventIds ?? [])],
            descendantWakePending: record.descendantBoundaryState?.wakePending ?? false,
            modelConfigSnapshot: record.modelConfigSnapshot,
            ...(record.toolWorkspaceRoot ? { toolWorkspaceRoot: record.toolWorkspaceRoot } : {}),
            recentActivity: [`Continuing thread: ${truncate(prompt, 200)}`],
            lastActivityAt: Date.now(),
            activeToolCount: 0,
            progressBuffer: "",
            toSubagentQueue: [],
            toOrchestratorQueue: [],
            messageLog: [],
            turnCount: 0,
            terminalEventEmitted: false,
            pendingStartStatusText: formatTaskUpdateStatusText(statusText),
            // Resuming an evicted/persisted thread is always a `send_input`
            // follow-up (this helper is only reached from that path).
            pendingStartIsFollowUp: true,
            // A terminal record can be evicted while its canceled execution is
            // still unwinding (or ignoring abort entirely). Rehydration is a new
            // attempt boundary, just like resetTaskForNextAttempt: advance here
            // so stale ownership is fenced before enqueueTask observes it.
            attemptGeneration: Number.isFinite(record.attemptGeneration)
                ? Math.max(0, Math.floor(record.attemptGeneration)) + 1
                : 1,
        };
        if (record.prompt) {
            task.initialPrompt = record.prompt;
            task.promptCreatedAt = record.promptCreatedAt;
        }
        return task;
    }
    enqueueTask(task, prioritize = false) {
        this.tasks.set(task.threadId, task);
        if (prioritize) {
            this.pendingQueue.unshift(task.threadId);
        } else {
            this.pendingQueue.push(task.threadId);
        }
        this.persistTask(task);
        this.tryStartNext();
    }
    /**
     * Re-enter the run-loop layer with the queued follow-up as the next
     * user turn on the existing long-lived `subagentSession`. Despite
     * being implemented as "reset + re-enqueue", this is NOT a fresh run
     * of the task — the session's accumulated message array (system +
     * original user prompt + prior assistant/tool turns) is preserved,
     * and the synthesized "Task update: …" string is
     * just the next user message that gets appended on top.
     *
     * Reached when input could not be steered into a live native Pi loop and
     * remained queued until the current run finished naturally.
     */
    deliverFollowUpAsNextTurn(task) {
        const pendingStartStatusText = task.pendingStartStatusText;
        const pendingStartAudience = task.pendingStartAudience;
        const prompt = this.buildTaskPrompt(task);
        this.resetTaskForNextAttempt(task, prompt);
        // The superseded turn's boundary emitted no completion event (the
        // dispatch short-circuits into this delivery before the lifecycle
        // emit) — an interjection extends ongoing work, so only the continued
        // turn's eventual real finish surfaces a completion card.
        task.pendingStartStatusText = pendingStartStatusText;
        task.pendingStartAudience = pendingStartAudience;
        // Interjected in-flight work is a `send_input` follow-up, not a spawn.
        task.pendingStartIsFollowUp = true;
        task.recentActivity = [pendingStartStatusText ?? "Applying task update."];
        this.pendingQueue.unshift(task.threadId);
        this.persistTask(task);
    }
    clearAttemptTakeoverTimer(threadId, generation, promise) {
        const pending = this.attemptTakeoverDeadlines.get(threadId);
        if (!pending)
            return;
        if (generation !== undefined && pending.generation !== generation)
            return;
        if (promise !== undefined && pending.promise !== promise)
            return;
        // The synchronous map delete is the real fence (the deadline body
        // re-validates against the map); the interrupt just reclaims the
        // sleeping fiber, replacing `clearTimeout`.
        this.attemptTakeoverDeadlines.delete(threadId);
        pending.fiber.interruptUnsafe();
    }
    scheduleAttemptTakeover(task, activeAttempt) {
        if (activeAttempt.slotReleased)
            return;
        const existing = this.attemptTakeoverDeadlines.get(task.threadId);
        if (existing?.generation === activeAttempt.generation &&
            existing.promise === activeAttempt.promise) {
            return;
        }
        this.clearAttemptTakeoverTimer(task.threadId);
        if (this.supervisoryScopeClosed) {
            // Shutdown already interrupted the supervisory scope; a takeover
            // deadline after that point has nothing left to arbitrate (shutdown
            // cancels every pending/running task).
            return;
        }
        const timeoutMs = Math.max(1, this.opts.attemptTeardownTimeoutMs ??
            DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS);
        const deadlineBody = Effect.sync(() => {
            const inFlight = this.inFlightAttempts.get(task.threadId);
            const takeover = this.attemptTakeoverDeadlines.get(task.threadId);
            if (inFlight?.generation !== activeAttempt.generation ||
                inFlight.promise !== activeAttempt.promise ||
                takeover?.generation !== activeAttempt.generation ||
                takeover.promise !== activeAttempt.promise ||
                task.status !== "pending" ||
                task.attemptGeneration === activeAttempt.generation
            ) {
                this.clearAttemptTakeoverTimer(task.threadId, activeAttempt.generation, activeAttempt.promise);
                return;
            }
            // The old promise may never settle (for example a bridge/tool that
            // ignored abort). Release only its global scheduler slot so unrelated
            // work can proceed. Keep exact physical ownership until the promise
            // settles: a same-thread successor and a placement cancellation ACK
            // must never treat generation fencing as provider/tool quiescence.
            this.attemptTakeoverDeadlines.delete(task.threadId);
            inFlight.slotReleased = true;
            this.runningCount = Math.max(0, this.runningCount - 1);
            this.tryStartNext();
        });
        const fiber = managerRuntime.runSync(Effect.forkIn(Effect.andThen(Effect.sleep(timeoutMs), deadlineBody), this.supervisoryScope, { startImmediately: true }));
        this.attemptTakeoverDeadlines.set(task.threadId, {
            generation: activeAttempt.generation,
            promise: activeAttempt.promise,
            fiber,
        });
    }
    scheduleCanceledAttemptRelease(task, activeAttempt) {
        if (activeAttempt.slotReleased)
            return;
        this.clearAttemptTakeoverTimer(task.threadId);
        if (this.supervisoryScopeClosed) {
            return;
        }
        const timeoutMs = Math.max(1, this.opts.attemptTeardownTimeoutMs ??
            DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS);
        const deadlineBody = Effect.sync(() => {
            const inFlight = this.inFlightAttempts.get(task.threadId);
            const pending = this.attemptTakeoverDeadlines.get(task.threadId);
            if (inFlight?.generation !== activeAttempt.generation ||
                inFlight.promise !== activeAttempt.promise ||
                pending?.generation !== activeAttempt.generation ||
                pending.promise !== activeAttempt.promise
            ) {
                this.clearAttemptTakeoverTimer(task.threadId, activeAttempt.generation, activeAttempt.promise);
                return;
            }
            // Cancellation has disposed the live Pi session and fenced durable
            // writes, but that is not physical quiescence. Release only the
            // global slot; retain this exact attempt as the same-thread and
            // placement-ACK barrier until its provider/tool promise settles.
            this.attemptTakeoverDeadlines.delete(task.threadId);
            inFlight.slotReleased = true;
            this.runningCount = Math.max(0, this.runningCount - 1);
            this.tryStartNext();
        });
        const fiber = managerRuntime.runSync(Effect.forkIn(Effect.andThen(Effect.sleep(timeoutMs), deadlineBody), this.supervisoryScope, { startImmediately: true }));
        this.attemptTakeoverDeadlines.set(task.threadId, {
            generation: activeAttempt.generation,
            promise: activeAttempt.promise,
            fiber,
        });
    }
    tryStartNext() {
        const maxConcurrent = Math.max(
            1,
            optsValueOrDefault(this.opts.getMaxConcurrent?.(), this.defaultMaxConcurrent),
        );
        // Schedule stale-attempt takeover independently of free global slots.
        // With max concurrency 1, the hung predecessor itself occupies the only
        // slot; waiting until the start loop runs would therefore deadlock before
        // the teardown deadline was ever armed.
        for (const threadId of this.pendingQueue) {
            const task = this.tasks.get(threadId);
            const activeAttempt = this.inFlightAttempts.get(threadId);
            if (task?.status === "pending" && activeAttempt) {
                this.scheduleAttemptTakeover(task, activeAttempt);
            }
        }
        let remainingCandidates = this.pendingQueue.length;
        while (this.runningCount < maxConcurrent && this.pendingQueue.length > 0 && remainingCandidates > 0) {
            const threadId = this.pendingQueue.shift();
            if (!threadId) break;
            remainingCandidates -= 1;
            const task = this.tasks.get(threadId);
            if (!task || task.status !== "pending") {
                continue;
            }
            const activeAttempt = this.inFlightAttempts.get(threadId);
            if (activeAttempt) {
                // A canceled/interrupted attempt still owns teardown for this thread.
                // Keep the resume queued, but bound that ownership: an abort-ignoring
                // promise is fenced and replaced after the teardown lease expires.
                this.pendingQueue.push(threadId);
                this.scheduleAttemptTakeover(task, activeAttempt);
                continue;
            }
            this.runningCount += 1;
            task.status = "running";
            const generation = ++task.attemptGeneration;
            const controller = task.controller;
            const startStatusText = task.pendingStartStatusText ?? task.description;
            const startIsFollowUp = task.pendingStartIsFollowUp ?? false;
            const startAudience = task.pendingStartAudience;
            task.pendingStartStatusText = undefined;
            task.pendingStartIsFollowUp = undefined;
            task.pendingStartAudience = undefined;
            this.persistTask(task);
            let cloudStartAdmission = null;
            if (task.storageMode === "cloud") {
                // The local thread id is also the canonical cloud Activity id. Publish
                // every attempt (including send_input continuations) with its
                // generation so a late terminal from the prior attempt cannot close
                // the newly-running row.
                task.cloudAgentId = task.threadId;
                task.cloudCreatePromise = Promise.resolve()
                    .then(() => {
                    if (!this.opts.createCloudAgentRecord) {
                        throw new Error("Cloud agent start admission is unavailable.");
                    }
                    return this.opts.createCloudAgentRecord({
                    agentId: task.threadId,
                    conversationId: task.conversationId,
                    description: task.description,
                    prompt: task.prompt,
                    agentType: task.agentType,
                    attemptGeneration: generation,
                    ownerGeneration: task.ownerGeneration,
                    ...(task.parentAgentId
                        ? { parentAgentId: task.parentAgentId }
                        : {}),
                    ...(typeof task.maxAgentDepth === "number"
                        ? { maxAgentDepth: task.maxAgentDepth }
                        : {}),
                    });
                })
                    .then((created) => {
                    return { generation, admitted: true, agentId: created.agentId };
                })
                    .catch((error) => {
                    // Keep the rejection owned and observable by the terminal path.
                    // That path must re-admit this start before it may publish a
                    // terminal row or evict the local task.
                    return { generation, admitted: false, error };
                });
                // Capture the exact promise on the physical attempt. A later
                // send_input generation replaces task.cloudCreatePromise, but it
                // must never let this generation adopt the successor's admission.
                cloudStartAdmission = task.cloudCreatePromise;
            }
            this.opts.onAgentEvent?.({
                type: "agent-started",
                conversationId: task.conversationId,
                rootRunId: task.rootRunId,
                agentId: task.threadId,
                agentType: task.agentType,
                description: task.description,
                parentAgentId: task.parentAgentId,
                attemptGeneration: generation,
                ...(startStatusText ? { statusText: startStatusText } : {}),
                ...(startIsFollowUp ? { isFollowUp: true } : {}),
                ...(startAudience ? { audience: startAudience } : {}),
            });
            const execution = this.executeTask(task, {
                generation,
                controller,
                cloudStartAdmission,
            }).catch(() => undefined);
            this.inFlightAttempts.set(threadId, {
                generation,
                promise: execution,
                slotReleased: false,
            });
            this.opts.superviseAttempt?.({
                threadId,
                ...(task.rootRunId ? { rootRunId: task.rootRunId } : {}),
                abort: (reason) => {
                    void this.cancelAgent(threadId, typeof reason === "string"
                        ? reason
                        : reason instanceof Error
                            ? reason.message
                            : undefined);
                },
                settled: execution.then(() => undefined),
            });
            const settleAttempt = () => {
                const fiberEntry = this.attemptFibers.get(threadId);
                if (fiberEntry?.generation === generation &&
                    fiberEntry.promise === execution) {
                    this.attemptFibers.delete(threadId);
                }
                const activeAttempt = this.inFlightAttempts.get(threadId);
                if (activeAttempt?.generation === generation && activeAttempt.promise === execution) {
                    this.clearAttemptTakeoverTimer(threadId, generation, execution);
                    this.inFlightAttempts.delete(threadId);
                    if (!activeAttempt.slotReleased) {
                        this.runningCount = Math.max(0, this.runningCount - 1);
                    }
                    this.tryStartNext();
                }
            };
            if (this.supervisoryScopeClosed) {
                // Post-shutdown resurrection path: no supervisory scope remains, so
                // fall back to a plain promise join for the bookkeeping.
                void execution.finally(settleAttempt);
            }
            else {
                // The attempt's supervision fiber: joins the (already-started,
                // never-rejecting) execution promise and releases the scheduler
                // slot. Interrupting this fiber (scope close at shutdown) runs the
                // same bookkeeping via `ensuring` but NEVER cancels the run itself —
                // run cancellation is only ever the cooperative `cancelAgent` path.
                const fiber = managerRuntime.runSync(Effect.forkIn(Effect.asVoid(Effect.promise(() => execution)).pipe(Effect.ensuring(Effect.sync(settleAttempt))), this.supervisoryScope, { startImmediately: true }));
                this.attemptFibers.set(threadId, {
                    generation,
                    promise: execution,
                    fiber,
                });
            }
        }
    }
    acquireFsLock(threadId, key) {
        return new Promise((resolve) => {
            const attempt = () => {
                const conflicting = this.activeFsLocks.some(
                    (lock) => lock.threadId !== threadId && pathsOverlap(lock.key, key),
                );
                if (conflicting) {
                    this.fsLockWaiters.push(attempt);
                    return;
                }
                const lock = {
                    id: `${threadId}:${++this.nextId}`,
                    threadId,
                    key,
                };
                this.activeFsLocks.push(lock);
                resolve(() => {
                    const index = this.activeFsLocks.findIndex((entry) => entry.id === lock.id);
                    if (index >= 0) {
                        this.activeFsLocks.splice(index, 1);
                    }
                    const waiters = this.fsLockWaiters.splice(0, this.fsLockWaiters.length);
                    for (const waiter of waiters) {
                        queueMicrotask(waiter);
                    }
                });
            };
            attempt();
        });
    }
    async executeTask(task, attempt) {
        const isCurrentAttempt = () =>
            this.tasks.get(task.threadId) === task &&
            task.attemptGeneration === attempt.generation &&
            task.controller === attempt.controller;
        try {
            if (task.storageMode === "cloud") {
                const admission = await attempt.cloudStartAdmission;
                if (!isCurrentAttempt())
                    return;
                if (admission?.generation !== attempt.generation || !admission.admitted) {
                    const error = admission?.error;
                    throw error instanceof Error
                        ? error
                        : new Error("Cloud agent start admission was rejected.");
                }
                task.cloudAgentId = admission.agentId;
                task.cloudStartReceiptGeneration = attempt.generation;
                this.persistTask(task);
            }
            const runId = `run:${task.threadId}:${++this.nextId}`;
            // Create the session before the context load. A managed-child report
            // can persist while that async load (or prompt hooks) is in flight;
            // the session then retains `notifyHistoryChanged()` even before its Pi
            // Agent exists and reloads SQLite immediately after creation.
            const subagentSession = getOrCreateSubagentSession(
                this.subagentSessions,
                task.threadId,
                task.conversationId,
                task.agentType,
            );
            const context = await this.opts.fetchAgentContext({
                conversationId: task.conversationId,
                agentType: task.agentType,
                runId,
                threadId: task.threadId,
                ...(task.model ? { model: task.model } : {}),
                ...(task.spawnEngine ? { spawnEngine: task.spawnEngine } : {}),
                ...(task.spawnReasoningEffort ? { spawnReasoningEffort: task.spawnReasoningEffort } : {}),
                ...(task.modelConfigSnapshot ? { modelConfigSnapshot: task.modelConfigSnapshot } : {}),
                ...(task.toolWorkspaceRoot ? { toolWorkspaceRoot: task.toolWorkspaceRoot } : {}),
            });
            if (!isCurrentAttempt()) return;
            if (context.modelConfigSnapshot) {
                task.modelConfigSnapshot = context.modelConfigSnapshot;
                // Persist the exact resolved engine/model after context loading. The
                // Activity projection exposes this for provider icons and tooltips,
                // and a resumed thread keeps the same effective route.
                this.persistTask(task);
            }
            context.maxAgentDepth =
                typeof task.maxAgentDepth === "number"
                    ? Math.min(context.maxAgentDepth, task.maxAgentDepth)
                    : context.maxAgentDepth;
            context.agentDepth = task.agentDepth;
            context.parentAgentId = task.parentAgentId;
            if (task.parentAgentId && context.toolsAllowlist) {
                // A parent-owned agent runs a top-level agent's toolset minus the
                // orchestration tools. Pruned from the allowlist, not just from the
                // catalog: the allowlist is the authoritative activation list, and a
                // name on it that is missing from the catalog is still registered
                // against synthesized metadata rather than dropped.
                context.toolsAllowlist = context.toolsAllowlist.filter(
                    (toolName) => !AGENT_ORCHESTRATION_TOOL_NAMES.includes(toolName),
                );
            }
            context.attemptGeneration = attempt.generation;
            const taskPrompt = this.buildTaskPrompt(task);
            task.turnCount += 1;
            const runSubagentArgs = {
                conversationId: task.conversationId,
                userMessageId: runId,
                agentType: task.agentType,
                agentId: task.threadId,
                rootRunId: task.rootRunId,
                ...(task.toolWorkspaceRoot ? { toolWorkspaceRoot: task.toolWorkspaceRoot } : {}),
                taskDescription: task.description,
                taskPrompt,
                agentContext: context,
                subagentSession,
                persistToConvex: task.storageMode === "cloud",
                ownerGeneration: task.ownerGeneration,
                enableRemoteTools: true,
                abortSignal: attempt.controller.signal,
                onProgress: (chunk) => {
                    if (!isCurrentAttempt() || attempt.controller.signal.aborted || task.status === "canceled") return;
                    if (typeof chunk !== "string" || !chunk) return;
                    task.progressBuffer += chunk;
                    if (task.progressBuffer.length > 4_000) {
                        task.progressBuffer = task.progressBuffer.slice(task.progressBuffer.length - 4_000);
                    }
                    const compact = task.progressBuffer.replace(/\s+/g, " ").trim();
                    if (!compact) return;
                    task.recentActivity = [truncate(compact, 500)];
                    task.lastActivityAt = Date.now();
                },
                onStatus: (event) => {
                    if (event.statusState !== "provider-retry") return;
                    if (!isCurrentAttempt() || attempt.controller.signal.aborted || task.status === "canceled") {
                        return;
                    }
                    const statusText = event.statusText;
                    if (typeof statusText !== "string")
                        return;
                    const compact = truncate(statusText.replace(/\s+/g, " ").trim(), 500);
                    if (!compact)
                        return;
                    task.recentActivity = [compact];
                    task.lastActivityAt = Date.now();
                    this.opts.onAgentEvent?.({
                        type: "agent-progress",
                        conversationId: task.conversationId,
                        rootRunId: task.rootRunId,
                        agentId: task.threadId,
                        agentType: task.agentType,
                        description: task.description,
                        parentAgentId: task.parentAgentId,
                        attemptGeneration: attempt.generation,
                        ownerGeneration: task.ownerGeneration,
                        statusText: compact,
                    });
                },
                onToolStart: (ev) => {
                    // Once cancelAgent has marked this task canceled, suppress any
                    // in-flight `tool_execution_start` events from the agent loop —
                    // those would otherwise leak `agent-progress` lifecycle events
                    // after `agent-canceled`, leaving a phantom "Working … Task" chip
                    // in the footer that re-adds the task to the live UI state.
                    if (!isCurrentAttempt() || attempt.controller.signal.aborted || task.status === "canceled") {
                        return;
                    }
                    const statusText = ev.statusText ?? `Running ${ev.toolName}`;
                    const toolActivity = taskToolActivityFromStart({
                        ...ev,
                        statusText,
                    });
                    // Tool lifecycle is a liveness signal too: without this, a single
                    // long tool call looks idle to snapshot pollers even though the
                    // agent is working.
                    task.recentActivity = [truncate(statusText, 500)];
                    task.lastActivityAt = Date.now();
                    task.activeToolCount += 1;
                    this.opts.onAgentEvent?.({
                        type: "agent-progress",
                        conversationId: task.conversationId,
                        rootRunId: task.rootRunId,
                        agentId: task.threadId,
                        agentType: task.agentType,
                        description: task.description,
                        parentAgentId: task.parentAgentId,
                        attemptGeneration: attempt.generation,
                        statusText,
                        toolActivity,
                    });
                },
                onToolEnd: (ev) => {
                    if (!isCurrentAttempt() || attempt.controller.signal.aborted || task.status === "canceled") {
                        return;
                    }
                    task.lastActivityAt = Date.now();
                    task.activeToolCount = Math.max(0, task.activeToolCount - 1);
                    const toolActivity = taskToolActivityFromEnd(ev);
                    task.recentActivity = [truncate(toolActivity.label, 500)];
                    this.opts.onAgentEvent?.({
                        type: "agent-progress",
                        conversationId: task.conversationId,
                        rootRunId: task.rootRunId,
                        agentId: task.threadId,
                        agentType: task.agentType,
                        description: task.description,
                        parentAgentId: task.parentAgentId,
                        attemptGeneration: attempt.generation,
                        statusText: toolActivity.label,
                        toolActivity,
                    });
                },
                toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
                    if (!isCurrentAttempt() || attempt.controller.signal.aborted) {
                        return { error: "Agent attempt was superseded." };
                    }
                    const scopedContext = {
                        ...toolContext,
                        agentId: task.threadId,
                        agentDepth: task.agentDepth,
                        maxAgentDepth: context.maxAgentDepth,
                    };
                    const lockKey = getFsLockKey(toolName, toolArgs, scopedContext);
                    if (!lockKey) {
                        return await this.opts.toolExecutor(toolName, toolArgs, scopedContext, signal);
                    }
                    const release = await this.acquireFsLock(task.threadId, lockKey);
                    try {
                        if (!isCurrentAttempt() || attempt.controller.signal.aborted) {
                            return { error: "Agent attempt was superseded." };
                        }
                        return await this.opts.toolExecutor(toolName, toolArgs, scopedContext, signal);
                    } finally {
                        release();
                    }
                },
            };
            let result;
            // Turn boundary: whatever the run reports, no tool is in flight once
            // `runSubagent` returns (or throws). Clearing here — not just in
            // onToolEnd — keeps the in-flight signal honest for runs that die
            // mid-tool without ever emitting a tool-end event.
            try {
                result = await this.opts.runSubagent(runSubagentArgs);
            } finally {
                if (isCurrentAttempt()) {
                    task.activeToolCount = 0;
                }
            }
            if (!isCurrentAttempt()) return;
            task.completedAt = Date.now();
            if (attempt.controller.signal.aborted || task.status === "canceled") {
                task.status = "canceled";
                task.error = task.error ?? "Canceled";
            } else if (result.interrupted) {
                task.status = "canceled";
                task.error = "Canceled";
            } else if (result.error) {
                task.status = "error";
                task.error = result.error;
            } else {
                task.status = "completed";
                task.result = result.result;
            }
        } catch (error) {
            if (!isCurrentAttempt()) return;
            task.completedAt = Date.now();
            if (attempt.controller.signal.aborted) {
                task.status = "canceled";
                task.error = task.error ?? "Canceled";
            } else {
                task.status = "error";
                if (task.storageMode === "cloud" && isCloudAgentStartAdmissionError(error)) {
                    if (error.retryable) {
                        // The durable start row remains the recovery owner. Do
                        // not fabricate a terminal or a local lifecycle event:
                        // this process never received authority to run.
                        task.cloudStartAdmissionPendingGeneration = attempt.generation;
                        task.error = "Waiting for cloud start acknowledgement.";
                    }
                    else {
                        // Canonical rejection means no remote attempt exists.
                        // Retire only the local started card below; never create
                        // or complete a replacement cloud row.
                        task.cloudStartAdmissionRejectedGeneration = attempt.generation;
                        task.error = "Cloud agent start was rejected.";
                    }
                }
                else {
                    task.error = error.message ?? "Task failed";
                }
            }
        }
        if (!isCurrentAttempt()) return;
        const cloudStartAdmissionRejected =
            task.cloudStartAdmissionRejectedGeneration === attempt.generation;
        const cloudStartAdmissionPending =
            task.cloudStartAdmissionPendingGeneration === attempt.generation;
        if (!cloudStartAdmissionRejected && !cloudStartAdmissionPending && this.shouldParkFinalForDescendants(task)) {
            // The model is allowed to yield while background descendants continue,
            // but that text is not a root completion. A child terminal report will
            // resume this same thread; its next natural final becomes root-facing
            // once no descendants remain.
            task.descendantFinalParked = true;
            task.result = undefined;
        }
        if (task.toSubagentQueue.length > 0 && task.status === "completed") {
            this.deliverFollowUpAsNextTurn(task);
            return;
        }
        // Task has reached a terminal status (completed/error/canceled). Drop
        // the long-lived SubagentSession so its Agent + message array can be
        // reclaimed; future tasks for this threadId would build a fresh
        // session if the runtime ever re-enqueues this thread (rare — terminal
        // is sticky). Done before persistTask + lifecycle emit so any
        // listener-triggered work (e.g. cloud sync) doesn't see stale state.
        const session = this.subagentSessions.get(task.threadId);
        if (session && !task.descendantFinalParked) {
            this.subagentSessions.delete(task.threadId);
            try {
                session.dispose();
            } catch {
                // Best-effort: dispose just aborts the agent and frees the ref.
            }
        }
        this.persistTask(task);
        if (cloudStartAdmissionPending) {
            // A later resume/restart retries the exact durable start. Provider,
            // tools, remote terminal, and lifecycle delivery all remain zero.
            return;
        }
        // The cloud terminal row is the restart-safe delivery receipt. Admit it
        // to the local SQLite outbox before the in-memory task can be evicted or
        // the direct orchestrator wake is attempted. The outbox preserves start
        // -> terminal order and the device monitor ACKs only after the exact
        // generation/revision is durable in the orchestrator transcript.
        if (task.storageMode === "cloud" && !task.descendantFinalParked && !cloudStartAdmissionRejected) {
            if (!this.opts.createCloudAgentRecord || !this.opts.completeCloudAgentRecord) {
                return;
            }
            let startReceipt = null;
            if (task.cloudCreatePromise) {
                startReceipt = await task.cloudCreatePromise;
            }
            if (startReceipt?.generation !== attempt.generation || !startReceipt.admitted) {
                try {
                    const created = await this.opts.createCloudAgentRecord({
                        agentId: task.threadId,
                        conversationId: task.conversationId,
                        description: task.description,
                        prompt: task.prompt,
                        agentType: task.agentType,
                        attemptGeneration: attempt.generation,
                        ownerGeneration: task.ownerGeneration,
                        ...(task.parentAgentId ? { parentAgentId: task.parentAgentId } : {}),
                    });
                    if (!isCurrentAttempt()) return;
                    task.cloudAgentId = created.agentId;
                    task.cloudStartReceiptGeneration = attempt.generation;
                    startReceipt = {
                        generation: attempt.generation,
                        admitted: true,
                        agentId: created.agentId,
                    };
                }
                catch {
                    // The terminal runtime row remains the restart receipt. Never
                    // enqueue a terminal transition without its deterministic start.
                    return;
                }
            }
            const status = task.status === "completed"
                ? "completed"
                : task.status === "canceled"
                    ? "canceled"
                    : "error";
            try {
                await this.opts.completeCloudAgentRecord({
                    agentId: task.cloudAgentId ?? task.threadId,
                    attemptGeneration: attempt.generation,
                    ownerGeneration: task.ownerGeneration,
                    status,
                    result: task.result ? truncate(task.result, 30_000) : undefined,
                    error: task.error ? truncate(task.error, 10_000) : undefined,
                });
                task.cloudTerminalReceiptGeneration = attempt.generation;
                this.persistTask(task);
            }
            catch {
                // `runtime_agents` remains the terminal receipt and the task stays
                // resident. Never evict across a failed local-outbox admission.
                return;
            }
        }
        // Emit task lifecycle event
        if (!task.terminalEventEmitted) {
            if (task.status === "completed") {
                if (!task.descendantFinalParked) {
                    const completionEventId = this.lifecycleEventId(task, "agent-completed");
                    const completedEvent = {
                        type: "agent-completed",
                        conversationId: task.conversationId,
                        eventId: completionEventId,
                        rootRunId: task.rootRunId,
                        agentId: task.threadId,
                        agentType: task.agentType,
                        description: task.description,
                        parentAgentId: task.parentAgentId,
                        attemptGeneration: task.attemptGeneration,
                        ...(task.ownerGeneration ? { ownerGeneration: task.ownerGeneration } : {}),
                        result: task.result,
                    };
                    try {
                        await this.emitAgentLifecycleEventOnce(completedEvent);
                        if (!isCurrentAttempt()) return;
                        task.terminalEventEmitted = true;
                        task.terminalLifecycleReceiptGeneration = attempt.generation;
                    }
                    catch (error) {
                        if (task.storageMode !== "cloud")
                            throw error;
                        // The unacknowledged cloud terminal receipt is now the
                        // delivery owner. Its monitor retries this same event id.
                    }
                    task.descendantWakePending = false;
                    this.persistTask(task);
                }
            } else if (task.status === "error") {
                const failedEvent = {
                    type: "agent-failed",
                    conversationId: task.conversationId,
                    eventId: this.lifecycleEventId(task, "agent-failed"),
                    rootRunId: task.rootRunId,
                    agentId: task.threadId,
                    agentType: task.agentType,
                    description: task.description,
                    parentAgentId: task.parentAgentId,
                    attemptGeneration: task.attemptGeneration,
                    ...(task.ownerGeneration ? { ownerGeneration: task.ownerGeneration } : {}),
                    ...(cloudStartAdmissionRejected ? { audience: "display-only" } : {}),
                    error: task.error,
                };
                try {
                    await this.emitAgentLifecycleEventOnce(failedEvent);
                    if (!isCurrentAttempt()) return;
                    task.terminalEventEmitted = true;
                    task.terminalLifecycleReceiptGeneration = attempt.generation;
                    this.persistTask(task);
                }
                catch (error) {
                    if (task.storageMode !== "cloud")
                        throw error;
                }
            } else if (task.status === "canceled") {
                const canceledEvent = {
                    type: "agent-canceled",
                    conversationId: task.conversationId,
                    eventId: this.lifecycleEventId(task, "agent-canceled"),
                    rootRunId: task.rootRunId,
                    agentId: task.threadId,
                    agentType: task.agentType,
                    description: task.description,
                    parentAgentId: task.parentAgentId,
                    attemptGeneration: task.attemptGeneration,
                    ...(task.ownerGeneration ? { ownerGeneration: task.ownerGeneration } : {}),
                    error: task.error,
                };
                try {
                    await this.emitAgentLifecycleEventOnce(canceledEvent);
                    if (!isCurrentAttempt()) return;
                    task.terminalEventEmitted = true;
                    task.terminalLifecycleReceiptGeneration = attempt.generation;
                    this.persistTask(task);
                }
                catch (error) {
                    if (task.storageMode !== "cloud")
                        throw error;
                }
            }
        }
        this.evictTerminalTaskIfDurable(task);
    }
    async createAgent(request) {
        this.assertActiveParentChain(request);
        // Effect-ratchet pin: the new agent's cooperative cancellation seam
        // (see resetTaskForNextAttempt) — created before the task record so the
        // spawn window is already cancellable.
        const controller = new AbortController();
        const resolvedThread =
            this.opts.resolveTaskThread?.({
                conversationId: request.conversationId,
                agentType: request.agentType,
                threadId: request.threadId,
                nameHint: request.description,
            }) ?? null;
        const threadId = resolvedThread?.threadId ?? request.threadId ?? `thread-${++this.nextId}`;
        const storageMode = request.storageMode ?? "local";
        const ownerGeneration = request.ownerGeneration?.trim();
        if (storageMode === "cloud" && !ownerGeneration) {
            throw new Error("Cloud computer-agent creation requires an owner generation.");
        }
        const createdAt = Date.now();
        const task = {
            threadId,
            conversationId: request.conversationId,
            rootRunId: request.rootRunId,
            description: request.description,
            prompt: request.prompt,
            initialPrompt: request.prompt,
            promptCreatedAt: createdAt,
            agentType: request.agentType,
            ...(request.model ? { model: request.model } : {}),
            ...(request.spawnEngine ? { spawnEngine: request.spawnEngine } : {}),
            ...(request.spawnReasoningEffort ? { spawnReasoningEffort: request.spawnReasoningEffort } : {}),
            ...(request.modelConfigSnapshot ? { modelConfigSnapshot: request.modelConfigSnapshot } : {}),
            ...(request.toolWorkspaceRoot ? { toolWorkspaceRoot: request.toolWorkspaceRoot } : {}),
            agentDepth: Math.max(1, request.agentDepth ?? 1),
            maxAgentDepth:
                typeof request.maxAgentDepth === "number" ? Math.max(1, Math.floor(request.maxAgentDepth)) : undefined,
            status: "pending",
            startedAt: createdAt,
            completedAt: null,
            controller,
            storageMode,
            ...(ownerGeneration ? { ownerGeneration } : {}),
            parentAgentId: request.parentAgentId,
            descendantFinalParked: false,
            consumedDescendantEventIds: [],
            descendantWakePending: false,
            recentActivity: [],
            lastActivityAt: Date.now(),
            activeToolCount: 0,
            progressBuffer: "",
            toSubagentQueue: [],
            toOrchestratorQueue: [],
            messageLog: [],
            turnCount: 0,
            terminalEventEmitted: false,
            attemptGeneration: 0,
        };
        // Re-check immediately before publication. Today the setup above is
        // synchronous, but keeping the invariant at the commit point closes the
        // spawn-during-pause race if thread/cloud setup later gains an await.
        this.assertActiveParentChain(request);
        this.enqueueTask(task);
        return {
            threadId: task.threadId,
            activeThreads: this.opts.listActiveThreads?.(request.conversationId),
        };
    }
    /**
     * Run a single agent turn OUTSIDE the durable task surface: no thread
     * row, no work slot, no lifecycle events, no persisted agent record.
     * This is the execution primitive for workflow scripts — their agents
     * report to the script, not to the orchestrator. The agentId should
     * use the `<conversationId>::subagent::<type>::…` shape so any
     * incidental thread-storage writes derive the right conversation.
     */
    async runEphemeralAgent(args) {
        const agentType = "general";
        const agentContext = await this.opts.fetchAgentContext({
            conversationId: args.conversationId,
            agentType,
            runId: args.agentId,
            threadId: args.agentId,
        });
        const session = getOrCreateSubagentSession(this.subagentSessions, args.agentId, args.conversationId, agentType);
        try {
            const outcome = await this.opts.runSubagent({
                conversationId: args.conversationId,
                userMessageId: args.agentId,
                agentType,
                agentId: args.agentId,
                ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
                taskDescription: args.description,
                taskPrompt: args.prompt,
                agentContext,
                subagentSession: session,
                persistToConvex: false,
                enableRemoteTools: true,
                abortSignal: args.signal,
                toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
                    const scopedContext = {
                        ...toolContext,
                        agentId: args.agentId,
                        agentDepth: 1,
                        maxAgentDepth: agentContext.maxAgentDepth,
                    };
                    const lockKey = getFsLockKey(toolName, toolArgs, scopedContext);
                    if (!lockKey) {
                        return await this.opts.toolExecutor(toolName, toolArgs, scopedContext, signal);
                    }
                    const release = await this.acquireFsLock(args.agentId, lockKey);
                    try {
                        return await this.opts.toolExecutor(toolName, toolArgs, scopedContext, signal);
                    } finally {
                        release();
                    }
                },
            });
            return {
                result: outcome.result,
                ...(outcome.error ? { error: outcome.error } : {}),
                ...(outcome.interrupted ? { interrupted: true } : {}),
            };
        } finally {
            const liveSession = this.subagentSessions.get(args.agentId);
            if (liveSession) {
                this.subagentSessions.delete(args.agentId);
                try {
                    liveSession.dispose();
                } catch {
                    // Best-effort.
                }
            }
        }
    }
    /**
     * Cancel every descendant thread of a parent. Member discovery comes
     * from the durable thread registry (not the in-memory task map) so
     * already-persisted members are covered too; cancelAgent is a no-op
     * for members that already reached a terminal status.
     */
    listActiveDescendantThreadIds(parentThreadId) {
        const threadIds = new Set();
        for (const task of this.tasks.values()) {
            if (
                task.threadId !== parentThreadId &&
                this.isDescendantOf(task.threadId, parentThreadId) &&
                this.isActiveAgentState(task)
            ) {
                threadIds.add(task.threadId);
            }
        }
        for (const record of this.opts.listAgentRecordsByStatus?.("running") ?? []) {
            if (record.threadId !== parentThreadId && this.isDescendantOf(record.threadId, parentThreadId)) {
                threadIds.add(record.threadId);
            }
        }
        return [...threadIds];
    }
    async cascadeCancelChildren(parentThreadId, reason) {
        // Old persisted data may contain parent cycles from before ownership was
        // guarded. Keep pause durable without recursively walking such a cycle.
        if (this.cancelCascadeInProgress.has(parentThreadId)) return;
        this.cancelCascadeInProgress.add(parentThreadId);
        try {
            for (const childThreadId of this.listActiveDescendantThreadIds(parentThreadId)) {
                await this.cancelAgent(childThreadId, reason);
            }
        } finally {
            this.cancelCascadeInProgress.delete(parentThreadId);
        }
    }
    async getAgent(agentId) {
        const local = this.tasks.get(agentId);
        if (local) {
            return this.buildTaskSnapshot(local);
        }
        const persisted = this.opts.getAgentRecord?.(agentId);
        if (persisted) {
            return this.buildPersistedSnapshot(persisted);
        }
        // Cloud-owned threads with no local footprint (spawned before this
        // worker took over, or already pruned locally) still resolve through
        // the canonical cloud record.
        return (await this.opts.getCloudAgentRecord?.(agentId)) ?? null;
    }
    getActiveAgentCount() {
        let count = 0;
        for (const task of this.tasks.values()) {
            if (!this.isActiveAgentState(task)) continue;
            count++;
        }
        return count;
    }
    listActiveAgentRuns() {
        const byRunId = new Map();
        for (const task of this.tasks.values()) {
            if (!this.isActiveAgentState(task)) continue;
            const runId = task.rootRunId ?? task.threadId;
            if (!runId) continue;
            byRunId.set(runId, {
                runId,
                conversationId: task.conversationId,
            });
        }
        return [...byRunId.values()];
    }
    /**
     * Cancel every pending/running task and await the cancellation cascades
     * (descendant fan-out, cloud record updates, session disposal). Joining
     * the in-flight attempt promises themselves is the kernel supervisor's job
     * (`superviseAttempt`), which interrupts and joins them at shutdown.
     */
    async shutdown(reason = AGENT_SHUTDOWN_CANCEL_REASON) {
        for (const pending of this.attemptTakeoverDeadlines.values()) {
            pending.fiber.interruptUnsafe();
        }
        this.attemptTakeoverDeadlines.clear();
        // v1 could snapshot still-running rows on the replacement worker's boot.
        // v2 performs a graceful Effect shutdown first, which durably cancels
        // those rows. Capture every resumable task before that cancellation so the
        // episode-stamped sidecar remains the authoritative recovery evidence.
        this.persistInterruptionSnapshot([...this.tasks.values()]
            .filter((task) => task.status === "pending" || task.status === "running")
            .map(({ threadId, conversationId }) => ({
            threadId,
            conversationId,
        })));
        const cancels = [];
        for (const task of this.tasks.values()) {
            if (!this.isActiveAgentState(task))
                continue;
            cancels.push(this.cancelAgent(task.threadId, reason).catch(() => undefined));
        }
        await Promise.allSettled(cancels);
        await Promise.allSettled([...this.terminalReceiptRecoveries]);
        // Close the supervisory scope last: every remaining supervision fiber
        // (attempt joins whose underlying promise ignored abort, stray
        // deadlines) is interrupted, and their `ensuring` bookkeeping runs.
        // This never touches the run loops themselves — those were cancelled
        // cooperatively above and are joined by the kernel run supervisor.
        await this.closeSupervisoryScope();
    }
    /** Effect facade over `shutdown` for Effect-native callers. */
    shutdownEffect(reason = AGENT_SHUTDOWN_CANCEL_REASON) {
        return Effect.promise(() => this.shutdown(reason));
    }
    closeSupervisoryScope() {
        if (this.supervisoryScopeClosePromise) {
            return this.supervisoryScopeClosePromise;
        }
        this.supervisoryScopeClosed = true;
        this.supervisoryScopeClosePromise = managerRuntime
            .runPromise(Scope.close(this.supervisoryScope, Exit.failCause(Cause.interrupt())))
            .catch(() => undefined)
            .then(() => undefined);
        return this.supervisoryScopeClosePromise;
    }
    async cancelAgent(agentId, reason) {
        const local = this.tasks.get(agentId);
        if (local) {
            const wasParked = local.status === "completed" && local.descendantFinalParked;
            if (
                (local.status === "completed" && !wasParked) ||
                local.status === "error" ||
                local.status === "canceled"
            ) {
                await this.cascadeCancelChildren(agentId, reason);
                return { canceled: true };
            }
            const previousStatus = local.status;
            const canceledGeneration = local.attemptGeneration;
            const canceledError = reason ?? "Canceled";
            const canceledCloudCreatePromise = local.cloudCreatePromise;
            const canceledCloudAgentId = local.cloudAgentId ?? local.threadId;
            const canceledCloudStart = {
                agentId: local.threadId,
                conversationId: local.conversationId,
                description: local.description,
                prompt: local.prompt,
                agentType: local.agentType,
                attemptGeneration: canceledGeneration,
                ownerGeneration: local.ownerGeneration,
                ...(local.parentAgentId ? { parentAgentId: local.parentAgentId } : {}),
            };
            local.error = canceledError;
            local.status = "canceled";
            local.descendantFinalParked = false;
            local.descendantWakePending = false;
            local.completedAt = Date.now();
            local.pendingStartStatusText = undefined;
            local.pendingStartIsFollowUp = undefined;
            local.pendingStartAudience = undefined;
            this.opts.onAgentEvent?.({
                type: "agent-progress",
                conversationId: local.conversationId,
                rootRunId: local.rootRunId,
                agentId: local.threadId,
                agentType: local.agentType,
                description: local.description,
                parentAgentId: local.parentAgentId,
                attemptGeneration: canceledGeneration,
                statusText: "Pausing",
            });
            local.controller.abort(new Error(local.error));
            const activeAttempt = this.inFlightAttempts.get(agentId);
            if (activeAttempt) {
                this.scheduleCanceledAttemptRelease(local, activeAttempt);
            }
            // Dispose the long-lived `SubagentSession` eagerly here too.
            // `executeTask` disposes at the end of the run, which is the
            // happy path for normal cancellation (abort propagates into
            // `runTurn`, the interrupted finalize fires, executeTask
            // reaches its dispose block). But if the abort gets swallowed
            // mid-flight (e.g. a tool executor doesn't honor the signal,
            // or executeTask isn't running yet because the task was still
            // pending), the session's Pi `Agent` would stay allocated
            // forever — the canceled task never re-enters `executeTask`.
            // `PiSessionCore.dispose` is idempotent and guarded against
            // already-null state, so calling it from both paths is safe;
            // the second call is a no-op.
            const session = this.subagentSessions.get(agentId);
            if (session) {
                this.subagentSessions.delete(agentId);
                try {
                    session.dispose();
                } catch {
                    // Best-effort.
                }
            }
            let cancellationEvent;
            if (
                (!local.terminalEventEmitted || wasParked) &&
                (previousStatus === "pending" || previousStatus === "running" || wasParked)
            ) {
                const cancellationEventId = this.lifecycleEventId(local, "agent-canceled");
                this.persistTask(local);
                cancellationEvent = {
                    type: "agent-canceled",
                    conversationId: local.conversationId,
                    eventId: cancellationEventId,
                    rootRunId: local.rootRunId,
                    agentId: local.threadId,
                    agentType: local.agentType,
                    description: local.description,
                    parentAgentId: local.parentAgentId,
                    attemptGeneration: canceledGeneration,
                    ...(local.ownerGeneration ? { ownerGeneration: local.ownerGeneration } : {}),
                    error: canceledError,
                };
            }
            this.persistTask(local);
            await this.cascadeCancelChildren(agentId, canceledError);
            if (local.storageMode === "cloud") {
                // Never mirror a cancel before the running row is published: the
                // start enqueue and this cancel share the attempt generation, so
                // ordering is what keeps the canonical row from resurrecting.
                let startReceipt = canceledCloudCreatePromise
                    ? await canceledCloudCreatePromise
                    : null;
                if (startReceipt?.generation !== canceledGeneration || !startReceipt.admitted) {
                    if (!this.opts.createCloudAgentRecord) {
                        throw new Error("Cloud agent start receipt is unavailable.");
                    }
                    await this.opts.createCloudAgentRecord(canceledCloudStart);
                    startReceipt = {
                        generation: canceledGeneration,
                        admitted: true,
                        agentId: canceledCloudAgentId,
                    };
                }
                if (!this.opts.cancelCloudAgentRecord) {
                    throw new Error("Cloud agent cancel receipt is unavailable.");
                }
                await this.opts.cancelCloudAgentRecord(canceledCloudAgentId, canceledError, canceledGeneration, local.ownerGeneration);
                if (local.attemptGeneration === canceledGeneration && local.status === "canceled") {
                    local.cloudStartReceiptGeneration = canceledGeneration;
                    local.cloudTerminalReceiptGeneration = canceledGeneration;
                    this.persistTask(local);
                }
            }
            if (cancellationEvent) {
                try {
                    await this.emitAgentLifecycleEventOnce(cancellationEvent);
                    if (local.attemptGeneration === canceledGeneration && local.status === "canceled") {
                        local.terminalEventEmitted = true;
                        local.terminalLifecycleReceiptGeneration = canceledGeneration;
                        this.persistTask(local);
                    }
                }
                catch (error) {
                    if (local.storageMode !== "cloud")
                        throw error;
                    // The unacknowledged cloud terminal row remains the retry
                    // owner when the direct lifecycle wake cannot be admitted.
                }
            }
            this.evictTerminalTaskIfDurable(local);
            return { canceled: true };
        }
        const persisted = this.opts.getAgentRecord?.(agentId);
        if (persisted) {
            if (persisted.storageMode === "cloud" && !persisted.ownerGeneration) {
                this.opts.saveAgentRecord?.({
                    ...persisted,
                    status: "canceled",
                    completedAt: persisted.completedAt ?? Date.now(),
                    error: "Cloud task retired because its owner generation is unavailable.",
                    updatedAt: Date.now(),
                });
                this.settleAgentThread(agentId);
                return { canceled: true };
            }
            const wasActive = persisted.status === "running";
            if (wasActive) {
                const consumedEventIds = persisted.descendantBoundaryState?.consumedEventIds ?? [];
                this.opts.saveAgentRecord?.({
                    ...persisted,
                    status: "canceled",
                    completedAt: Date.now(),
                    error: reason ?? "Canceled",
                    descendantBoundaryState:
                        consumedEventIds.length > 0 ? { consumedEventIds, wakePending: false } : undefined,
                    updatedAt: Date.now(),
                });
                // Terminal transition outside `persistTask`: wake settlement
                // waiters directly (they re-read the durable record).
                this.settleAgentThread(agentId);
            }
            await this.cascadeCancelChildren(agentId, reason ?? "Canceled");
            if (persisted.storageMode !== "cloud" && wasActive) {
                const generation = persisted.attemptGeneration;
                await this.emitAgentLifecycleEventOnce({
                    type: "agent-canceled",
                    conversationId: persisted.conversationId,
                    eventId: `${persisted.threadId}:${generation}:agent-canceled`,
                    rootRunId: persisted.rootRunId,
                    agentId: persisted.threadId,
                    agentType: persisted.agentType,
                    description: persisted.description,
                    parentAgentId: persisted.parentAgentId,
                    attemptGeneration: generation,
                    error: reason ?? "Canceled",
                });
                const current = this.opts.getAgentRecord?.(persisted.threadId);
                if (current &&
                    current.attemptGeneration === generation &&
                    current.status === "canceled") {
                    this.opts.saveAgentRecord?.({
                        ...current,
                        terminalLifecycleReceiptGeneration: generation,
                    });
                }
            }
            if (persisted.storageMode === "cloud" && wasActive) {
                if (this.opts.createCloudAgentRecord) {
                    await this.opts.createCloudAgentRecord({
                        agentId: persisted.threadId,
                        conversationId: persisted.conversationId,
                        description: persisted.description,
                        prompt: persisted.prompt ?? persisted.description,
                        agentType: persisted.agentType,
                        attemptGeneration: persisted.attemptGeneration,
                        ownerGeneration: persisted.ownerGeneration,
                        ...(persisted.parentAgentId ? { parentAgentId: persisted.parentAgentId } : {}),
                    });
                }
                await this.opts.cancelCloudAgentRecord?.(persisted.threadId, reason ?? "Canceled", persisted.attemptGeneration, persisted.ownerGeneration);
                const current = this.opts.getAgentRecord?.(persisted.threadId);
                if (current &&
                    current.attemptGeneration === persisted.attemptGeneration &&
                    current.status === "canceled") {
                    this.opts.saveAgentRecord?.({
                        ...current,
                        cloudTerminalReceiptGeneration: persisted.attemptGeneration,
                    });
                }
            }
            return { canceled: true };
        }
        // No local or durable row means there is no exact physical attempt
        // generation to cancel. Never let an unversioned Stop adopt whichever
        // cloud attempt currently owns a reused thread id.
        return { canceled: false };
    }
    /**
     * Placement-only exact cancel barrier. Capture the physical attempt before
     * the durable terminal transition, then wait until it physically settles.
     * The bounded scheduler release can admit unrelated work, but it is
     * deliberately not a placement/quiescence acknowledgement.
     */
    async cancelAgentAndJoin(agentId, reason) {
        const ownedAttempt = this.inFlightAttempts.get(agentId);
        const result = await this.cancelAgent(agentId, reason);
        if (!ownedAttempt) {
            return result;
        }
        const timeoutMs = Math.max(1, this.opts.attemptTeardownTimeoutMs ??
            DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS);
        const settled = await Promise.race([
            ownedAttempt.promise.then(() => true),
            managerRuntime
                .runPromise(Effect.sleep(timeoutMs + 50))
                .then(() => false),
        ]);
        if (!settled) {
            throw new Error(`Local agent ${agentId} did not reach its bounded cancellation barrier.`);
        }
        return result;
    }
    async sendAgentMessage(agentId, message, from, options) {
        const text = message.trim();
        if (!text) return { delivered: false };
        // A child report is already persisted into this thread by the
        // orchestration layer, so the delivered turn input is a pointer rather
        // than a second copy of the report.
        const isChildReport = options?.deliveryKind === "child-report";
        // Every retryable orchestrator delivery may carry a stable receipt id.
        // Child reports and background-exit wakes share the same bounded,
        // durable ledger so an acknowledgement lost after enqueue/resume does
        // not inject the same input twice.
        const deliveryEventId = options?.deliveryEventId?.trim() || undefined;
        const task = this.tasks.get(agentId);
        const persisted = task ? undefined : this.opts.getAgentRecord?.(agentId);
        // The parent can be root-spawned, so keep even its internal task status
        // free of child-report contents. The wake lifecycle is hidden from root
        // chat below, while Activity/thread inspection may still read this safe
        // boundary label from the durable task row.
        //
        // A follow-up no longer re-tasks the thread name: the thread keeps the
        // domain it was spawned under, so the status falls back to the durable
        // description before the follow-up text.
        const updateStatusSource = isChildReport
            ? "Reviewing a subagent's report"
            : task?.description ?? persisted?.description ?? text;
        const updateStatusText = formatTaskUpdateStatusText(updateStatusSource);
        const rootRunId = options?.rootRunId?.trim() || undefined;
        const deliveredInput = isChildReport
            ? "A subagent you started has finished. Review its newly persisted report in this thread and continue your task."
            : text;
        if (!task) {
            if (from !== "orchestrator") {
                return { delivered: false };
            }
            if (!persisted) {
                return { delivered: false };
            }
            if (persisted.storageMode === "cloud" && !persisted.ownerGeneration) {
                // A pre-generation cloud row has no authority that can be
                // safely rebound after reset/sign-in. Quarantine it locally;
                // never replay or resume it under the current account epoch.
                this.opts.saveAgentRecord?.({
                    ...persisted,
                    status: "canceled",
                    completedAt: persisted.completedAt ?? Date.now(),
                    error: "Cloud task retired because its owner generation is unavailable.",
                    updatedAt: Date.now(),
                });
                return { delivered: false };
            }
            if (deliveryEventId && persisted.descendantBoundaryState?.consumedEventIds.includes(deliveryEventId)) {
                return { delivered: true };
            }
            if (isChildReport && (persisted.status === "error" || persisted.status === "canceled")) {
                // A child report wakes an idle parent, but must never resurrect one
                // the user paused or that failed. The report is already durable in
                // the thread, so a later explicit send_input still picks it up.
                if (deliveryEventId) {
                    const consumedEventIds = [
                        ...(persisted.descendantBoundaryState?.consumedEventIds ?? []),
                        deliveryEventId,
                    ].slice(-256);
                    this.opts.saveAgentRecord?.({
                        ...persisted,
                        descendantBoundaryState: {
                            consumedEventIds,
                            wakePending: false,
                        },
                        updatedAt: Date.now(),
                    });
                }
                return { delivered: true };
            }
            // Re-activate the durable thread row (and its whole group) so the
            // resumed work re-enters the active slot budget and reappears under
            // "Other Threads" — without this, an evicted thread keeps running
            // with status 'evicted' and stays invisible to the orchestrator.
            this.opts.resolveTaskThread?.({
                conversationId: persisted.conversationId,
                agentType: persisted.agentType,
                threadId: persisted.threadId,
            });
            const resumedTask = this.hydrateTaskFromRecord(persisted, text, updateStatusText);
            if (rootRunId) {
                resumedTask.rootRunId = rootRunId;
            }
            if (options?.parentAgentId) {
                resumedTask.parentAgentId = options.parentAgentId;
            }
            if (deliveryEventId) {
                this.rememberDeliveryEventId(resumedTask, deliveryEventId);
                resumedTask.descendantWakePending = true;
            }
            if (isChildReport) {
                resumedTask.pendingStartAudience = "orchestrator-only";
            }
            resumedTask.messageLog.push({
                from,
                text: truncate(text, 500),
                timestamp: Date.now(),
            });
            this.enqueueTask(resumedTask);
            return { delivered: true };
        }
        if (isChildReport) {
            // The orchestration layer persisted the report before calling us. Make
            // that durable row the only report source; a live session refreshes it
            // at the next turn instead of receiving a duplicate prompt copy.
            this.subagentSessions.get(agentId)?.notifyHistoryChanged();
        }
        if (deliveryEventId && task.consumedDescendantEventIds.includes(deliveryEventId)) {
            return { delivered: true };
        }
        if (isChildReport) {
            if (task.status === "error" || task.status === "canceled") {
                // Same rule as the persisted-record path: never resurrect a parent
                // the user paused or that failed.
                if (deliveryEventId) {
                    this.rememberDeliveryEventId(task, deliveryEventId);
                    task.descendantWakePending = false;
                    this.persistTask(task);
                }
                return { delivered: true };
            }
        }
        if (options?.parentAgentId) {
            task.parentAgentId = options.parentAgentId;
        }
        if (task.status === "completed" || task.status === "error" || task.status === "canceled") {
            if (from !== "orchestrator") {
                return { delivered: false };
            }
            task.messageLog.push({
                from,
                text: truncate(text, 500),
                timestamp: Date.now(),
            });
            if (task.messageLog.length > LocalAgentManager.MAX_LOG_MESSAGES) {
                task.messageLog.splice(0, task.messageLog.length - LocalAgentManager.MAX_LOG_MESSAGES);
            }
            if (rootRunId) {
                task.rootRunId = rootRunId;
            }
            if (deliveryEventId) {
                this.rememberDeliveryEventId(task, deliveryEventId);
                task.descendantWakePending = true;
            }
            // Same re-activation as the persisted-record path above: the thread
            // row may have been evicted while this task sat terminal in memory.
            this.opts.resolveTaskThread?.({
                conversationId: task.conversationId,
                agentType: task.agentType,
                threadId: task.threadId,
            });
            // `deliveredInput` (not `text`) so a child report resumes the parent
            // with the pointer; the report itself is already durable in the thread
            // and would otherwise be replayed twice.
            this.resetTaskForNextAttempt(task, deliveredInput);
            task.pendingStartStatusText = updateStatusText;
            task.pendingStartAudience = isChildReport ? "orchestrator-only" : undefined;
            // Re-activating a terminal thread is a `send_input` follow-up.
            task.pendingStartIsFollowUp = true;
            task.recentActivity = [updateStatusText];
            this.opts.onAgentEvent?.({
                type: "agent-progress",
                conversationId: task.conversationId,
                rootRunId: task.rootRunId,
                agentId: task.threadId,
                agentType: task.agentType,
                description: task.description,
                parentAgentId: task.parentAgentId,
                attemptGeneration: task.attemptGeneration,
                statusText: updateStatusText,
                ...(isChildReport ? { audience: "orchestrator-only" } : {}),
            });
            this.enqueueTask(task);
            return { delivered: true };
        }
        const targetQueue = from === "orchestrator" ? task.toSubagentQueue : task.toOrchestratorQueue;
        if (deliveryEventId) {
            this.rememberDeliveryEventId(task, deliveryEventId);
            task.descendantWakePending = true;
        }
        targetQueue.push(deliveredInput);
        if (targetQueue.length > LocalAgentManager.MAX_QUEUE_MESSAGES) {
            targetQueue.splice(0, targetQueue.length - LocalAgentManager.MAX_QUEUE_MESSAGES);
        }
        task.messageLog.push({
            from,
            text: truncate(text, 500),
            timestamp: Date.now(),
        });
        if (task.messageLog.length > LocalAgentManager.MAX_LOG_MESSAGES) {
            task.messageLog.splice(0, task.messageLog.length - LocalAgentManager.MAX_LOG_MESSAGES);
        }
        if (from === "orchestrator") {
            if (rootRunId) {
                task.rootRunId = rootRunId;
            }
            task.pendingStartStatusText = updateStatusText;
            task.pendingStartAudience = isChildReport ? "orchestrator-only" : undefined;
            task.recentActivity = [updateStatusText];
            this.opts.onAgentEvent?.({
                type: "agent-progress",
                conversationId: task.conversationId,
                rootRunId: task.rootRunId,
                agentId: task.threadId,
                agentType: task.agentType,
                description: task.description,
                parentAgentId: task.parentAgentId,
                attemptGeneration: task.attemptGeneration,
                statusText: updateStatusText,
                ...(isChildReport ? { audience: "orchestrator-only" } : {}),
            });
            if (task.status === "running" && !task.controller.signal.aborted) {
                const session = this.subagentSessions.get(task.threadId);
                if (session?.canSteer) {
                    const updates = [...task.toSubagentQueue];
                    const steeringPrompt = this.formatTaskPrompt(task, updates, "steering");
                    if (session.steer(steeringPrompt)) {
                        task.toSubagentQueue.splice(0, updates.length);
                        task.pendingStartStatusText = undefined;
                        task.pendingStartAudience = undefined;
                        this.opts.onAgentEvent?.({
                            type: "agent-started",
                            conversationId: task.conversationId,
                            rootRunId: task.rootRunId,
                            agentId: task.threadId,
                            agentType: task.agentType,
                            description: task.description,
                            parentAgentId: task.parentAgentId,
                            attemptGeneration: task.attemptGeneration,
                            statusText: updateStatusText,
                            isFollowUp: true,
                            ...(isChildReport ? { audience: "orchestrator-only" } : {}),
                        });
                    }
                }
            }
        }
        this.persistTask(task);
        return { delivered: true };
    }
    async drainAgentMessages(agentId, recipient) {
        const task = this.tasks.get(agentId);
        if (!task) return [];
        return this.consumeTaskMessages(task, recipient);
    }
}
const optsValueOrDefault = (value, fallback) => (Number.isFinite(value) ? Math.floor(value) : fallback);
