/**
 * Automatic wake on background command exit.
 *
 * An agent's turn is the only place its own code runs. `exec_command`
 * sessions deliberately outlive the run that started them (see the
 * teardown comment in `tools/host.ts`), so a build, benchmark, or training
 * job the agent left running keeps running after the turn ends — but
 * nothing it prints can start a new turn. The thread just stops, and the
 * work finishes into a void. That is how a GPU pod once idle-billed for
 * hours against a monitor whose output nobody read.
 *
 * So the runtime watches instead of asking the agent to. When a run ends
 * with sessions it started still alive, we attach exit watchers here. When
 * they exit, the exits are coalesced into one message and delivered to the
 * owning thread through the same `send_input` path a human or the
 * orchestrator would use — which rehydrates an evicted or finished thread
 * with its full history. The agent picks up where it left off, holding the
 * command, its exit code, and its output.
 *
 * Borrowed from Codex's session model: a "durably asleep" thread is one
 * that ended with work outstanding, and only such a thread is woken by
 * incoming mail. Here the arm IS the sleep marker — it is set at teardown
 * and replaced or dropped whenever the thread runs again, so a thread that
 * has already moved on is never woken by a stale exit.
 */
/**
 * Transitional type surface for TS importers of this evolved JS module.
 * @typedef {any} BackgroundExitWake
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const EXIT_LOG_DIRNAME = "background-exits";
/** Spilled logs are a debugging aid for one wake, not an archive. */
const EXIT_LOG_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long to hold the first exit before delivering, waiting for siblings.
 * `make -j` style fan-out and `wait`-ed pipelines land within a few hundred
 * ms of each other; one wake carrying four results is worth far more than
 * four turns carrying one each.
 */
const COALESCE_WINDOW_MS = 2_000;
/**
 * Ceiling on the coalescing window. Without it a session exiting every
 * 1.9s could defer the wake indefinitely.
 */
const MAX_COALESCE_MS = 15_000;
/** Transient delivery failures retain the exit batch and retry out of band. */
const DELIVERY_RETRY_BASE_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 30_000;
/** Inline output budget per exited command, before the log file takes over. */
const INLINE_OUTPUT_CHARS = 2_000;
/**
 * Head/tail split for a command whose output exceeds the inline budget.
 * Weighted toward the tail — the failure is usually at the end — but the
 * head is kept because that is where the command says what it is doing.
 * Adopted from Codex's middle-truncation policy, which keeps both ends
 * rather than Stella's usual tail-only shell drain.
 */
const HEAD_SHARE = 0.3;
const formatDuration = (ms) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 90)
        return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90)
        return `${minutes}m`;
    return `${(minutes / 60).toFixed(1)}h`;
};
/**
 * Keep the head and the tail, drop the middle. A truncation notice sits at
 * the seam so the agent can tell missing output from short output.
 */
export const truncateMiddle = (value, max = INLINE_OUTPUT_CHARS) => {
    if (value.length <= max)
        return value;
    const headChars = Math.floor(max * HEAD_SHARE);
    const tailChars = max - headChars;
    const dropped = value.length - max;
    return [
        value.slice(0, headChars),
        `\n… [${dropped} characters omitted] …\n`,
        value.slice(value.length - tailChars),
    ].join("");
};
const describeExit = (exit, logPath) => {
    const outcome = exit.exitCode === 0
        ? "succeeded"
        : exit.exitCode === null
            ? "ended without an exit code"
            : `failed with exit code ${exit.exitCode}`;
    const lines = [
        `$ ${exit.command}`,
        `  ${outcome} after ${formatDuration(exit.completedAt - exit.startedAt)} (cwd: ${exit.cwd})`,
    ];
    const output = exit.output.trim();
    if (!output) {
        lines.push("  (no output captured)");
        return lines.join("\n");
    }
    lines.push("", truncateMiddle(output));
    if (output.length > INLINE_OUTPUT_CHARS && logPath) {
        lines.push("", `Full captured output: ${logPath}`);
    }
    return lines.join("\n");
};
const buildWakeText = (exits, logPaths) => {
    const header = exits.length === 1
        ? "[wake: a command you left running in the background has finished.]"
        : `[wake: ${exits.length} commands you left running in the background have finished.]`;
    return [
        header,
        "",
        ...exits.map((exit) => describeExit(exit, logPaths.get(exit.sessionId) ?? null)),
        "",
        "You were resumed for this. Continue the work that was waiting on it, or say what you found.",
    ].join("\n");
};
/**
 * Stable delivery identity for one exact exit batch. The hash keeps owner and
 * command/session metadata out of the durable receipt while making retries
 * after an ambiguous acknowledgement collapse at LocalAgentManager's durable
 * input boundary. Sorting makes callback arrival order irrelevant.
 */
const buildWakeEventId = (entry, exits) => {
    const completionIdentity = exits
        .map((exit) => [exit.sessionId, exit.completedAt, exit.exitCode])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const digest = createHash("sha256")
        .update(JSON.stringify([
        entry.conversationId,
        entry.agentId,
        completionIdentity,
    ]))
        .digest("hex");
    return `background-exit:${digest}`;
};
/**
 * Spill a command's captured output so the wake can cite a path instead of
 * inlining tens of kilobytes. Unlike a tool result, a wake is a one-shot
 * injection — the agent can't ask for the rest — so the rest has to live
 * somewhere it can read. Codex has no equivalent because its model always
 * re-polls for output; ours only gets told once.
 */
export const writeBackgroundExitLog = (stellaDataDir, sessionId, contents) => {
    try {
        const dir = path.join(stellaDataDir, EXIT_LOG_DIRNAME);
        fs.mkdirSync(dir, { recursive: true });
        const cutoff = Date.now() - EXIT_LOG_TTL_MS;
        for (const name of fs.readdirSync(dir)) {
            const stale = path.join(dir, name);
            try {
                if (fs.statSync(stale).mtimeMs < cutoff)
                    fs.rmSync(stale, { force: true });
            }
            catch {
                // A file that vanished under us needs no pruning.
            }
        }
        const logPath = path.join(dir, `${sessionId}.log`);
        fs.writeFileSync(logPath, contents, "utf-8");
        return logPath;
    }
    catch {
        // Losing the spill only costs detail; the wake still carries head+tail.
        return null;
    }
};
export const createBackgroundExitWake = (deps) => {
    const now = deps.now ?? (() => Date.now());
    let disposed = false;
    const armed = new Map();
    const ownerKey = (conversationId, agentId) => JSON.stringify([conversationId, agentId]);
    const ownerMatches = (entry, owner) => owner?.conversationId === entry.conversationId &&
        owner?.agentId === entry.agentId;
    const keysFor = (identity) => {
        if (typeof identity !== "string") {
            return [ownerKey(identity.conversationId, identity.agentId)];
        }
        // Backward-compatible diagnostic/test seam. Production callers always
        // pass the full owner so one conversation cannot disarm another.
        return [...armed.entries()]
            .filter(([, entry]) => entry.agentId === identity)
            .map(([key]) => key);
    };
    const clearEntry = (key, entry) => {
        if (armed.get(key) !== entry)
            return;
        for (const dispose of entry.disposers.values())
            dispose();
        entry.disposers.clear();
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = null;
        armed.delete(key);
    };
    const disarm = (identity) => {
        for (const key of keysFor(identity)) {
            const entry = armed.get(key);
            if (entry)
                clearEntry(key, entry);
        }
    };
    const scheduleTimer = (key, entry, delay) => {
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
            void flush(key);
        }, delay);
        entry.timer.unref?.();
    };
    const scheduleRetry = (key, entry) => {
        if (armed.get(key) !== entry || disposed)
            return;
        const exponent = Math.min(Math.max(0, entry.deliveryFailures - 1), 10);
        const delay = Math.min(DELIVERY_RETRY_BASE_MS * 2 ** exponent, DELIVERY_RETRY_MAX_MS);
        scheduleTimer(key, entry, delay);
    };
    const flushEntry = async (key, entry) => {
        if (armed.get(key) !== entry)
            return;
        // Once delivery starts, freeze this exact batch and its event id until
        // acknowledgement. New exits remain in `collected` for a later batch;
        // otherwise an ack-loss retry that absorbed a sibling exit would get a
        // different id and could inject the already-committed wake twice.
        const batch = entry.pendingDelivery ?? (() => {
            const exits = entry.collected.splice(0);
            if (exits.length === 0)
                return null;
            return {
                exits,
                eventId: buildWakeEventId(entry, exits),
            };
        })();
        if (batch && !entry.pendingDelivery)
            entry.pendingDelivery = batch;
        const exits = batch?.exits ?? [];
        // Sessions still running keep their watchers; the arm survives until
        // every one of them has reported or the thread runs again.
        if (entry.timer)
            clearTimeout(entry.timer);
        entry.timer = null;
        entry.firstExitAt = null;
        if (exits.length === 0) {
            if (entry.disposers.size === 0)
                clearEntry(key, entry);
            return;
        }
        const isCurrent = () => !disposed && armed.get(key) === entry;
        if (deps.getThreadStatus) {
            try {
                const status = await deps.getThreadStatus(entry.agentId, entry.conversationId);
                if (!isCurrent())
                    return;
                if (status === "canceled") {
                    // The user stopped this thread on purpose. Its leftovers finishing
                    // is not a reason to start it up again.
                    clearEntry(key, entry);
                    return;
                }
            }
            catch {
                // Status is an optimization; deliver rather than drop the wake.
            }
        }
        if (!isCurrent())
            return;
        const logPaths = new Map();
        for (const exit of exits) {
            if (exit.output.length <= INLINE_OUTPUT_CHARS || !deps.writeExitLog) {
                continue;
            }
            try {
                logPaths.set(exit.sessionId, await deps.writeExitLog(exit.sessionId, exit.output));
            }
            catch {
                logPaths.set(exit.sessionId, null);
            }
            if (!isCurrent())
                return;
        }
        if (!isCurrent())
            return;
        try {
            const delivered = await deps.deliver({
                conversationId: entry.conversationId,
                agentId: entry.agentId,
                eventId: batch.eventId,
                isCurrent,
                text: buildWakeText(exits, logPaths),
            });
            if (!isCurrent())
                return;
            if (!delivered) {
                entry.deliveryFailures += 1;
                scheduleRetry(key, entry);
                return;
            }
            entry.pendingDelivery = null;
            entry.deliveryFailures = 0;
            if (entry.collected.length > 0) {
                scheduleFlush(key);
                return;
            }
            if (entry.disposers.size === 0 &&
                entry.collected.length === 0 &&
                entry.timer === null) {
                clearEntry(key, entry);
            }
        }
        catch (error) {
            if (isCurrent()) {
                entry.deliveryFailures += 1;
                scheduleRetry(key, entry);
            }
            console.warn(`[background-wake] failed to deliver exit wake to ${entry.agentId}:`, error instanceof Error ? error.message : String(error));
        }
    };
    const flush = (key) => {
        const entry = armed.get(key);
        if (!entry)
            return Promise.resolve();
        if (entry.flushPromise)
            return entry.flushPromise;
        const attempt = flushEntry(key, entry).finally(() => {
            if (entry.flushPromise === attempt)
                entry.flushPromise = null;
        });
        entry.flushPromise = attempt;
        return attempt;
    };
    const scheduleFlush = (key) => {
        const entry = armed.get(key);
        if (!entry)
            return;
        const startedAt = entry.firstExitAt ?? now();
        entry.firstExitAt = startedAt;
        // Extend for late siblings, but never past the ceiling measured from
        // the first exit.
        const remaining = Math.max(0, startedAt + MAX_COALESCE_MS - now());
        const delay = Math.min(COALESCE_WINDOW_MS, remaining);
        scheduleTimer(key, entry, delay);
    };
    return {
        /**
         * Arm exit wakes for the sessions a finished run left running.
         *
         * Called once per run teardown. Re-arming replaces any previous arm for
         * the thread, which is what keeps a stale exit from waking a thread
         * that has already moved on.
         */
        arm: (args) => {
            const { agentId } = args;
            if (!agentId || disposed) {
                // No durable thread to resume — an orchestrator or one-shot caller.
                // Nothing to arm; the caller logs this case.
                return [];
            }
            const identity = {
                conversationId: args.conversationId,
                agentId,
            };
            const key = ownerKey(identity.conversationId, identity.agentId);
            disarm(identity);
            if (args.interrupted || args.runningSessionIds.length === 0)
                return [];
            const entry = {
                conversationId: args.conversationId,
                agentId,
                disposers: new Map(),
                collected: [],
                timer: null,
                firstExitAt: null,
                deliveryFailures: 0,
                flushPromise: null,
                pendingDelivery: null,
            };
            armed.set(key, entry);
            for (const sessionId of new Set(args.runningSessionIds)) {
                try {
                    const dispose = deps.watchShellExit(sessionId, () => {
                        const live = armed.get(key);
                        if (live !== entry)
                            return;
                        entry.disposers.delete(sessionId);
                        const snapshot = deps.readShellExitSnapshot(sessionId);
                        if (snapshot && ownerMatches(entry, snapshot.owner))
                            entry.collected.push(snapshot);
                        if (entry.collected.length > 0) {
                            scheduleFlush(key);
                        }
                        else if (entry.disposers.size === 0) {
                            clearEntry(key, entry);
                        }
                    });
                    entry.disposers.set(sessionId, dispose);
                }
                catch {
                    // One malformed/stale session must not keep the remaining
                    // owner-scoped watchers from being armed.
                }
            }
            if (entry.disposers.size === 0)
                clearEntry(key, entry);
            return [...entry.disposers.keys()];
        },
        /** Drop a thread's arm — it is running again, so it can poll for itself. */
        disarm,
        /** Test seam: force any buffered exits out without waiting on the timer. */
        flushNow: async (identity) => {
            await Promise.all(keysFor(identity).map((key) => flush(key)));
        },
        /** Test/diagnostic: threads currently waiting on a background exit. */
        armedThreadIds: () => [...armed.values()].map((entry) => entry.agentId),
        /** Full owner identities, so duplicate agent ids remain distinguishable. */
        armedOwners: () => [...armed.values()].map((entry) => ({
            conversationId: entry.conversationId,
            agentId: entry.agentId,
        })),
        dispose: () => {
            disposed = true;
            for (const [key, entry] of [...armed.entries()])
                clearEntry(key, entry);
        },
    };
};
