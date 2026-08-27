import fs from "node:fs";
import path from "node:path";
const EXIT_LOG_DIRNAME = "background-exits";

const EXIT_LOG_TTL_MS = 24 * 60 * 60 * 1000;

const COALESCE_WINDOW_MS = 2_000;

const MAX_COALESCE_MS = 15_000;

const INLINE_OUTPUT_CHARS = 2_000;

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

            }
        }
        const logPath = path.join(dir, `${sessionId}.log`);
        fs.writeFileSync(logPath, contents, "utf-8");
        return logPath;
    }
    catch {

        return null;
    }
};
export const createBackgroundExitWake = (deps) => {
    const now = deps.now ?? (() => Date.now());
    const armed = new Map();
    const disarm = (agentId) => {
        const entry = armed.get(agentId);
        if (!entry)
            return;
        for (const dispose of entry.disposers.values())
            dispose();
        entry.disposers.clear();
        if (entry.timer)
            clearTimeout(entry.timer);
        armed.delete(agentId);
    };
    const flush = async (agentId) => {
        const entry = armed.get(agentId);
        if (!entry)
            return;
        const exits = entry.collected.splice(0);

        entry.timer = null;
        entry.firstExitAt = null;
        if (entry.disposers.size === 0)
            armed.delete(agentId);
        if (exits.length === 0)
            return;
        if (deps.getThreadStatus) {
            try {
                const status = await deps.getThreadStatus(agentId);
                if (status === "canceled") {

                    disarm(agentId);
                    return;
                }
            }
            catch {

            }
        }
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
        }
        try {
            const delivered = await deps.deliver({
                conversationId: entry.conversationId,
                agentId,
                text: buildWakeText(exits, logPaths),
            });
            if (!delivered)
                disarm(agentId);
        }
        catch (error) {
            console.warn(`[background-wake] failed to deliver exit wake to ${agentId}:`, error.message);
        }
    };
    const scheduleFlush = (agentId) => {
        const entry = armed.get(agentId);
        if (!entry)
            return;
        const startedAt = entry.firstExitAt ?? now();
        entry.firstExitAt = startedAt;
        if (entry.timer)
            clearTimeout(entry.timer);

        const remaining = Math.max(0, startedAt + MAX_COALESCE_MS - now());
        const delay = Math.min(COALESCE_WINDOW_MS, remaining);
        entry.timer = setTimeout(() => {
            void flush(agentId);
        }, delay);
        entry.timer.unref?.();
    };
    return {

        arm: (args) => {
            const { agentId } = args;
            if (!agentId) {

                return [];
            }
            disarm(agentId);
            if (args.interrupted || args.runningSessionIds.length === 0)
                return [];
            const entry = {
                conversationId: args.conversationId,
                agentId,
                disposers: new Map(),
                collected: [],
                timer: null,
                firstExitAt: null,
            };
            armed.set(agentId, entry);
            for (const sessionId of args.runningSessionIds) {
                const dispose = deps.watchShellExit(sessionId, () => {
                    const live = armed.get(agentId);
                    if (live !== entry)
                        return;
                    entry.disposers.delete(sessionId);
                    const snapshot = deps.readShellExitSnapshot(sessionId);
                    if (snapshot)
                        entry.collected.push(snapshot);
                    scheduleFlush(agentId);
                });
                entry.disposers.set(sessionId, dispose);
            }
            return [...entry.disposers.keys()];
        },

        disarm,

        flushNow: flush,

        armedThreadIds: () => [...armed.keys()],
        dispose: () => {
            for (const agentId of [...armed.keys()])
                disarm(agentId);
        },
    };
};
