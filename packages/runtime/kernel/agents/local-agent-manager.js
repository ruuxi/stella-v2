import path from "path";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { AGENT_ORCHESTRATION_TOOL_NAMES } from "../tools/defs/task.js";
import { sanitizeForLogs, truncate } from "../tools/utils.js";
import { getOrCreateSubagentSession } from "../agent-runtime/subagent-session.js";
const formatTaskUpdateStatusText = (text) => truncate(text.replace(/\s+/g, " ").trim(), 200);
const fileRecordKey = (record) => `${record.kind.type}:${record.path}:${record.kind.type === "update" ? (record.kind.move_path ?? "") : ""}`;
const mergeUniqueFileRecords = (existing, incoming) => {
    if (!incoming?.length) return existing;
    if (!existing?.length) return [...incoming];
    const out = [];
    const seen = new Set();
    for (const record of [...existing, ...incoming]) {
        const key = fileRecordKey(record);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(record);
    }
    return out;
};
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

export const AGENT_PAUSE_CANCEL_REASON = "Paused by orchestrator.";
export const DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS = 5_000;
export class LocalAgentManager {
    defaultMaxConcurrent;
    opts;
    tasks = new Map();
    pendingQueue = [];
    runningCount = 0;
    inFlightAttempts = new Map();
    attemptTakeoverTimers = new Map();
    cancelCascadeInProgress = new Set();
    activeFsLocks = [];
    fsLockWaiters = [];

    subagentSessions = new Map();
    static MAX_QUEUE_MESSAGES = 32;
    static MAX_LOG_MESSAGES = 80;
    nextId = 0;

    bootInterruptedThreads = [];
    bootInterruptionEpisodeId = null;
    constructor(opts) {
        this.opts = opts;
        this.defaultMaxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
        this.recoverOrCancelOrphanedPersistedAgents();
    }

    getBootInterruptedThreads() {
        return [...this.bootInterruptedThreads];
    }

    getBootInterruptionEpisodeId() {
        return this.bootInterruptionEpisodeId;
    }
    recoverOrCancelOrphanedPersistedAgents() {
        const now = Date.now();
        const runningRecords = this.opts.listAgentRecordsByStatus?.("running") ?? [];
        for (const record of runningRecords) {
            this.bootInterruptedThreads.push({
                threadId: record.threadId,
                conversationId: record.conversationId,
            });
        }
        if (this.bootInterruptedThreads.length > 0) {

            try {
                this.bootInterruptionEpisodeId =
                    this.opts.persistBootInterruptionSnapshot?.(this.getBootInterruptedThreads()) ?? null;
            }
            catch {

            }
        }
        for (const record of runningRecords) {
            const error = AGENT_ORPHANED_RESTART_CANCEL_REASON;
            const cancellationEventId = `${record.threadId}:${record.attemptGeneration}:agent-canceled`;
            this.opts.saveAgentRecord?.({
                ...record,
                status: "canceled",
                completedAt: now,
                error,
                updatedAt: now,
            });

            this.opts.onAgentEvent?.({
                type: "agent-canceled",
                conversationId: record.conversationId,
                eventId: cancellationEventId,
                agentId: record.threadId,
                agentType: record.agentType,
                description: record.description,
                parentAgentId: record.parentAgentId,
                attemptGeneration: record.attemptGeneration,
                error,
                audience: "display-only",
            });
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

    updateWaiters = new Map();
    notifyAgentUpdated(threadId) {
        const waiters = this.updateWaiters.get(threadId);
        if (!waiters?.size) return;
        this.updateWaiters.delete(threadId);
        for (const wake of waiters) wake();
    }

    waitForAgentUpdate(threadId, timeoutMs = 2_000) {
        return new Promise((resolve) => {
            let timer = null;
            const wake = () => {
                if (timer) clearTimeout(timer);
                resolve();
            };
            const waiters = this.updateWaiters.get(threadId) ?? new Set();
            waiters.add(wake);
            this.updateWaiters.set(threadId, waiters);
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                timer = setTimeout(() => {
                    const current = this.updateWaiters.get(threadId);
                    current?.delete(wake);
                    if (current && current.size === 0) {
                        this.updateWaiters.delete(threadId);
                    }
                    resolve();
                }, timeoutMs);
                timer.unref?.();
            }
        });
    }
    persistTask(task) {
        this.notifyAgentUpdated(task.threadId);
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
        return (task.status === "completed" &&
            task.agentType === AGENT_IDS.GENERAL &&
            (task.modelConfigSnapshot?.engine !== "codex_cli" ||
                task.modelConfigSnapshot.subscriptionHarnessEnabled === true) &&
            this.hasActiveDescendants(task.threadId)
        );
    }

    resolveOwningParentThread(threadId, parentAgentId) {
        const parent = parentAgentId ?? this.getAgentState(threadId)?.parentAgentId;
        if (!parent)
            return undefined;
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
        return `${task.threadId}:${task.attemptGeneration}:${type}`;
    }
    emitAgentLifecycleEventOnce(event) {
        const eventId = event.eventId?.trim();
        if (eventId && this.opts.hasAgentLifecycleEvent?.(event.conversationId, eventId, event.type)) {
            return;
        }
        this.opts.onAgentEvent?.(event);
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
        task.controller = new AbortController();
        task.terminalEventEmitted = false;
        task.pendingStartStatusText = undefined;
        task.pendingStartAudience = undefined;

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
            controller: new AbortController(),
            storageMode: "local",
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

            pendingStartIsFollowUp: true,

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

    deliverFollowUpAsNextTurn(task) {
        const pendingStartStatusText = task.pendingStartStatusText;
        const pendingStartAudience = task.pendingStartAudience;
        const prompt = this.buildTaskPrompt(task);
        this.resetTaskForNextAttempt(task, prompt);

        task.pendingStartStatusText = pendingStartStatusText;
        task.pendingStartAudience = pendingStartAudience;

        task.pendingStartIsFollowUp = true;
        task.recentActivity = [pendingStartStatusText ?? "Applying task update."];
        this.pendingQueue.unshift(task.threadId);
        this.persistTask(task);
    }
    clearAttemptTakeoverTimer(threadId, generation, promise) {
        const pending = this.attemptTakeoverTimers.get(threadId);
        if (!pending) return;
        if (generation !== undefined && pending.generation !== generation) return;
        if (promise !== undefined && pending.promise !== promise) return;
        clearTimeout(pending.timer);
        this.attemptTakeoverTimers.delete(threadId);
    }
    scheduleAttemptTakeover(task, activeAttempt) {
        const existing = this.attemptTakeoverTimers.get(task.threadId);
        if (existing?.generation === activeAttempt.generation && existing.promise === activeAttempt.promise) {
            return;
        }
        this.clearAttemptTakeoverTimer(task.threadId);
        const timeoutMs = Math.max(1, this.opts.attemptTeardownTimeoutMs ?? DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS);
        const timer = setTimeout(() => {
            const inFlight = this.inFlightAttempts.get(task.threadId);
            const takeover = this.attemptTakeoverTimers.get(task.threadId);
            if (
                inFlight?.generation !== activeAttempt.generation ||
                inFlight.promise !== activeAttempt.promise ||
                takeover?.generation !== activeAttempt.generation ||
                takeover.promise !== activeAttempt.promise ||
                task.status !== "pending" ||
                task.attemptGeneration === activeAttempt.generation
            ) {
                this.clearAttemptTakeoverTimer(task.threadId, activeAttempt.generation, activeAttempt.promise);
                return;
            }

            this.attemptTakeoverTimers.delete(task.threadId);
            this.inFlightAttempts.delete(task.threadId);
            this.runningCount = Math.max(0, this.runningCount - 1);
            this.tryStartNext();
        }, timeoutMs);
        timer.unref?.();
        this.attemptTakeoverTimers.set(task.threadId, {
            generation: activeAttempt.generation,
            promise: activeAttempt.promise,
            timer,
        });
    }
    scheduleCanceledAttemptRelease(task, activeAttempt) {
        this.clearAttemptTakeoverTimer(task.threadId);
        const timeoutMs = Math.max(1, this.opts.attemptTeardownTimeoutMs ?? DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS);
        const timer = setTimeout(() => {
            const inFlight = this.inFlightAttempts.get(task.threadId);
            const pending = this.attemptTakeoverTimers.get(task.threadId);
            if (
                inFlight?.generation !== activeAttempt.generation ||
                inFlight.promise !== activeAttempt.promise ||
                pending?.generation !== activeAttempt.generation ||
                pending.promise !== activeAttempt.promise
            ) {
                this.clearAttemptTakeoverTimer(task.threadId, activeAttempt.generation, activeAttempt.promise);
                return;
            }

            this.attemptTakeoverTimers.delete(task.threadId);
            this.inFlightAttempts.delete(task.threadId);
            this.runningCount = Math.max(0, this.runningCount - 1);
            this.tryStartNext();
        }, timeoutMs);
        timer.unref?.();
        this.attemptTakeoverTimers.set(task.threadId, {
            generation: activeAttempt.generation,
            promise: activeAttempt.promise,
            timer,
        });
    }
    tryStartNext() {
        const maxConcurrent = Math.max(1, optsValueOrDefault(this.opts.getMaxConcurrent?.(), this.defaultMaxConcurrent));
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
            }).catch(() => undefined);
            this.inFlightAttempts.set(threadId, { generation, promise: execution });
            void execution.finally(() => {
                const activeAttempt = this.inFlightAttempts.get(threadId);
                if (activeAttempt?.generation === generation && activeAttempt.promise === execution) {
                    this.clearAttemptTakeoverTimer(threadId, generation, execution);
                    this.inFlightAttempts.delete(threadId);
                    this.runningCount = Math.max(0, this.runningCount - 1);
                    this.tryStartNext();
                }
            });
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
            const runId = `run:${task.threadId}:${++this.nextId}`;
            const subagentSession = getOrCreateSubagentSession(this.subagentSessions, task.threadId, task.conversationId, task.agentType);
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

                this.persistTask(task);
            }
            context.maxAgentDepth =
                typeof task.maxAgentDepth === "number"
                    ? Math.min(context.maxAgentDepth, task.maxAgentDepth)
                    : context.maxAgentDepth;
            context.agentDepth = task.agentDepth;
            context.parentAgentId = task.parentAgentId;
            if (task.parentAgentId && context.toolsAllowlist) {
                context.toolsAllowlist = context.toolsAllowlist.filter((toolName) => !AGENT_ORCHESTRATION_TOOL_NAMES.includes(toolName));
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
                persistToConvex: false,
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
                    const statusText = truncate(event.statusText, 500);
                    task.recentActivity = [statusText];
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
                        statusText,
                    });
                },
                onToolStart: (ev) => {
                    if (!isCurrentAttempt() ||
                        attempt.controller.signal.aborted ||
                        task.status === "canceled") {
                        return;
                    }
                    const statusText = ev.statusText ?? `Running ${ev.toolName}`;
                    const toolActivity = taskToolActivityFromStart({
                        ...ev,
                        statusText,
                    });

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

            try {
                result = await this.opts.runSubagent(runSubagentArgs);
            } finally {
                if (isCurrentAttempt()) {
                    task.activeToolCount = 0;
                }
            }
            if (!isCurrentAttempt()) return;
            task.completedAt = Date.now();

            task.bankedFileChanges = mergeUniqueFileRecords(task.bankedFileChanges, result.fileChanges);
            task.bankedProducedFiles = mergeUniqueFileRecords(task.bankedProducedFiles, result.producedFiles);
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

                task.fileChanges = task.bankedFileChanges;
                task.producedFiles = task.bankedProducedFiles;
            }
        } catch (error) {
            if (!isCurrentAttempt()) return;
            task.completedAt = Date.now();
            if (attempt.controller.signal.aborted) {
                task.status = "canceled";
                task.error = task.error ?? "Canceled";
            } else {
                task.status = "error";
                task.error = error.message ?? "Task failed";
            }
        }
        if (!isCurrentAttempt()) return;
        if (this.shouldParkFinalForDescendants(task)) {

            task.descendantFinalParked = true;
            task.result = undefined;
        }
        if (task.toSubagentQueue.length > 0 && task.status === "completed") {
            this.deliverFollowUpAsNextTurn(task);
            return;
        }

        const session = this.subagentSessions.get(task.threadId);
        if (session && !task.descendantFinalParked) {
            this.subagentSessions.delete(task.threadId);
            try {
                session.dispose();
            }
            catch {

            }
        }
        this.persistTask(task);
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
                        result: task.result,
                        ...(task.fileChanges?.length ? { fileChanges: task.fileChanges } : {}),
                        ...(task.producedFiles?.length ? { producedFiles: task.producedFiles } : {}),
                    };
                    this.emitAgentLifecycleEventOnce(completedEvent);
                    task.bankedFileChanges = undefined;
                    task.bankedProducedFiles = undefined;
                    task.descendantWakePending = false;
                    this.persistTask(task);
                }
            } else if (task.status === "error") {
                this.opts.onAgentEvent?.({
                    type: "agent-failed",
                    conversationId: task.conversationId,
                    eventId: this.lifecycleEventId(task, "agent-failed"),
                    rootRunId: task.rootRunId,
                    agentId: task.threadId,
                    agentType: task.agentType,
                    description: task.description,
                    parentAgentId: task.parentAgentId,
                    attemptGeneration: task.attemptGeneration,
                    error: task.error,
                });
            } else if (task.status === "canceled") {
                this.opts.onAgentEvent?.({
                    type: "agent-canceled",
                    conversationId: task.conversationId,
                    eventId: this.lifecycleEventId(task, "agent-canceled"),
                    rootRunId: task.rootRunId,
                    agentId: task.threadId,
                    agentType: task.agentType,
                    description: task.description,
                    parentAgentId: task.parentAgentId,
                    attemptGeneration: task.attemptGeneration,
                    error: task.error,
                });
            }
            task.terminalEventEmitted = true;
        }
        this.evictTerminalTaskIfDurable(task);
    }
    async createAgent(request) {
        this.assertActiveParentChain(request);
        const controller = new AbortController();
        const resolvedThread =
            this.opts.resolveTaskThread?.({
                conversationId: request.conversationId,
                agentType: request.agentType,
                threadId: request.threadId,
                nameHint: request.description,
            }) ?? null;
        const threadId = resolvedThread?.threadId ?? request.threadId ?? `thread-${++this.nextId}`;
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
            storageMode: "local",
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

        this.assertActiveParentChain(request);
        this.enqueueTask(task);
        return {
            threadId: task.threadId,
            activeThreads: this.opts.listActiveThreads?.(request.conversationId),
        };
    }

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
                }
                catch {

                }
            }
        }
    }

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
        if (this.cancelCascadeInProgress.has(parentThreadId))
            return;
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
        return null;
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
    shutdown(reason = AGENT_SHUTDOWN_CANCEL_REASON) {
        for (const pending of this.attemptTakeoverTimers.values()) {
            clearTimeout(pending.timer);
        }
        this.attemptTakeoverTimers.clear();
        for (const task of this.tasks.values()) {
            if (!this.isActiveAgentState(task)) continue;
            void this.cancelAgent(task.threadId, reason);
        }
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
            local.error = reason ?? "Canceled";
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
                attemptGeneration: local.attemptGeneration,
                statusText: "Pausing",
            });
            local.controller.abort(new Error(local.error));
            const activeAttempt = this.inFlightAttempts.get(agentId);
            if (activeAttempt) {
                this.scheduleCanceledAttemptRelease(local, activeAttempt);
            }

            const session = this.subagentSessions.get(agentId);
            if (session) {
                this.subagentSessions.delete(agentId);
                try {
                    session.dispose();
                }
                catch {

                }
            }
            if (
                (!local.terminalEventEmitted || wasParked) &&
                (previousStatus === "pending" || previousStatus === "running" || wasParked)
            ) {
                const cancellationEventId = this.lifecycleEventId(local, "agent-canceled");
                this.persistTask(local);
                this.opts.onAgentEvent?.({
                    type: "agent-canceled",
                    conversationId: local.conversationId,
                    eventId: cancellationEventId,
                    rootRunId: local.rootRunId,
                    agentId: local.threadId,
                    agentType: local.agentType,
                    description: local.description,
                    parentAgentId: local.parentAgentId,
                    attemptGeneration: local.attemptGeneration,
                    error: local.error,
                });
                local.terminalEventEmitted = true;
            }
            this.persistTask(local);
            await this.cascadeCancelChildren(agentId, local.error);
            this.evictTerminalTaskIfDurable(local);
            return { canceled: true };
        }
        const persisted = this.opts.getAgentRecord?.(agentId);
        if (persisted) {
            if (persisted.status === "running") {
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
            }
            await this.cascadeCancelChildren(agentId, reason ?? "Canceled");
            return { canceled: true };
        }
        return { canceled: false };
    }
    async sendAgentMessage(agentId, message, from, options) {
        const text = message.trim();
        if (!text)
            return { delivered: false };

        const isChildReport = options?.deliveryKind === "child-report";
        const deliveryEventId = isChildReport
            ? options?.deliveryEventId?.trim() || undefined
            : undefined;
        const task = this.tasks.get(agentId);
        const persisted = task ? undefined : this.opts.getAgentRecord?.(agentId);

        const updateStatusSource = isChildReport
            ? "Reviewing a subagent's report"
            : options?.description?.trim() || task?.description || persisted?.description || text;
        const updateStatusText = formatTaskUpdateStatusText(updateStatusSource);
        const rootRunId = options?.rootRunId?.trim() || undefined;
        const followUpDescription = from === "orchestrator" ? options?.description?.trim() || undefined : undefined;
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
            if (deliveryEventId && persisted.descendantBoundaryState?.consumedEventIds.includes(deliveryEventId)) {
                return { delivered: true };
            }
            if (isChildReport &&
                (persisted.status === "error" || persisted.status === "canceled")) {
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
            if (followUpDescription) {
                resumedTask.description = followUpDescription;
            }
            if (deliveryEventId) {
                resumedTask.consumedDescendantEventIds.push(deliveryEventId);
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

            this.subagentSessions.get(agentId)?.notifyHistoryChanged();
            if (deliveryEventId && task.consumedDescendantEventIds.includes(deliveryEventId)) {
                return { delivered: true };
            }
            if (task.status === "error" || task.status === "canceled") {

                if (deliveryEventId) {
                    task.consumedDescendantEventIds.push(deliveryEventId);
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
            if (followUpDescription) {
                task.description = followUpDescription;
            }
            if (deliveryEventId) {
                task.consumedDescendantEventIds.push(deliveryEventId);
                task.descendantWakePending = true;
            }

            this.opts.resolveTaskThread?.({
                conversationId: task.conversationId,
                agentType: task.agentType,
                threadId: task.threadId,
            });

            this.resetTaskForNextAttempt(task, deliveredInput);
            task.pendingStartStatusText = updateStatusText;
            task.pendingStartAudience = isChildReport
                ? "orchestrator-only"
                : undefined;
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
            task.consumedDescendantEventIds.push(deliveryEventId);
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
            if (followUpDescription) {
                task.description = followUpDescription;
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
