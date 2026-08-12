import { execFile, spawn, } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setupGitEnvironment } from "../../git-environment.js";
import { DEFAULT_CODEX_SERVICE_TIER } from "@stella/contracts/agent-engine";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import { redactSensitiveText } from "@stella/contracts/sensitive-data";
import { executeToolWithInactivityBound } from "./tool-inactivity.js";
import { normalizeProviderToolInputSchema } from "../../ai/utils/tool-schema.js";
import { DEFAULT_CODEX_MODEL, loadLocalPreferences, } from "../preferences/local-preferences.js";
import { buildExternalCliChildEnv, resolveExternalCliPath, } from "./external-cli-resolution.js";
const MAX_STDERR_CAPTURE = 8_000;
const SIGTERM_TIMEOUT_MS = 1_500;
const SIGKILL_TIMEOUT_MS = 4_000;
const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 60 * 1000;
const DEFAULT_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS = 2_000;
const DEFAULT_CODEX_TURN_STARTUP_IDLE_TIMEOUT_MS = 15 * 1000;
const DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Ceiling while confirmed turn work (native command / Stella tool) is in
// flight. A native command that never leaves inProgress, or a Stella tool
// whose bookkeeping leaked, would otherwise disarm the watchdog forever.
// (Bridged Stella tools are separately bounded at 10 min by
// executeToolWithInactivityBound; this only backstops native commands and
// leaked tracking.)
const DEFAULT_CODEX_TURN_TOOL_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const CODEX_AGENT_MESSAGE_COMPLETION_GRACE_MS = 750;
export const CODEX_LIGHT_MODEL = "gpt-5.4-mini";
/** Cheap model reserved for automatic utility work, not explicit agent spawns. */
export const CODEX_UTILITY_MODEL = "gpt-5.6-luna";
const execFileAsync = promisify(execFile);
const stableJson = (value) => {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
};
export const sanitizeCodexCommandForActivity = (command) => redactSensitiveText(command);
const CODEX_REASONING_EFFORT_ORDER = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
];
export const clampCodexSpawnReasoningEffort = (model, requested) => {
    const supported = new Set(model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort));
    if (supported.has(requested))
        return requested;
    const requestedIndex = CODEX_REASONING_EFFORT_ORDER.indexOf(requested);
    for (let distance = 1; distance < CODEX_REASONING_EFFORT_ORDER.length; distance += 1) {
        const higher = CODEX_REASONING_EFFORT_ORDER[requestedIndex + distance];
        if (higher && supported.has(higher))
            return higher;
        const lower = CODEX_REASONING_EFFORT_ORDER[requestedIndex - distance];
        if (lower && supported.has(lower))
            return lower;
    }
    return undefined;
};
export const shouldUseCodexAgentRuntime = (args) => args.agentEngine === "codex_cli" && args.agentType === AGENT_IDS.GENERAL;
const formatCodexPromptMessage = (message, index) => {
    const text = message.text.trim();
    if (!text)
        return "";
    const messageType = message.messageType ?? "user";
    const visibility = message.uiVisibility ?? "visible";
    const customType = message.customType?.trim();
    if (messageType === "user" && visibility === "visible" && !customType) {
        return text;
    }
    const contextLabel = visibility === "hidden"
        ? "Hidden Stella context"
        : messageType === "user"
            ? "User context"
            : "Stella context";
    const suffix = customType ? ` (${customType})` : "";
    return `[${contextLabel} ${index + 1}${suffix}]\n${text}`;
};
export const buildCodexPromptFromMessages = (args) => args.promptMessages
    .map(formatCodexPromptMessage)
    .filter((section) => section.trim().length > 0)
    .join("\n\n");
const absoluteChangePath = (cwd, value) => {
    const trimmed = value.trim();
    if (path.isAbsolute(trimmed))
        return trimmed;
    return path.resolve(cwd ?? process.cwd(), trimmed);
};
const codexChangeKindToFileChangeKind = (kind, cwd) => {
    if (kind.type === "add" || kind.type === "delete")
        return { type: kind.type };
    return {
        type: "update",
        ...(kind.move_path
            ? { move_path: absoluteChangePath(cwd, kind.move_path) }
            : {}),
    };
};
export const fileChangesFromCodexItem = (item, cwd) => {
    if (item.type !== "fileChange" || item.status !== "completed")
        return [];
    return item.changes.map((change) => ({
        path: absoluteChangePath(cwd, change.path),
        kind: codexChangeKindToFileChangeKind(change.kind, cwd),
    }));
};
const normalizeGitPath = (value) => value.trim().replace(/\\/g, "/");
const statusKeyForEntry = (entry) => entry.movePath ?? entry.path;
const absoluteRepoPath = (repoRoot, repoRelativePath) => path.resolve(repoRoot, repoRelativePath);
const parseStatusLine = (line) => {
    if (!line || line.length < 4)
        return null;
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath)
        return null;
    const renameMarker = rawPath.lastIndexOf(" -> ");
    if (renameMarker >= 0) {
        return {
            status,
            path: normalizeGitPath(rawPath.slice(0, renameMarker)),
            movePath: normalizeGitPath(rawPath.slice(renameMarker + 4)),
        };
    }
    return {
        status,
        path: normalizeGitPath(rawPath),
    };
};
const parseGitStatus = (stdout) => {
    const entries = new Map();
    for (const line of stdout.replace(/\r?\n$/, "").split(/\r?\n/)) {
        const entry = parseStatusLine(line);
        if (!entry)
            continue;
        entries.set(statusKeyForEntry(entry), entry);
    }
    return entries;
};
const runGit = async (repoRoot, args) => {
    const { env, gitLocation } = setupGitEnvironment(process.env);
    try {
        const result = await execFileAsync(gitLocation, args, {
            cwd: repoRoot,
            env,
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        return { ok: true, stdout: String(result.stdout ?? "") };
    }
    catch {
        return { ok: false, stdout: "" };
    }
};
const fingerprintFile = async (repoRoot, repoRelativePath) => {
    try {
        const data = await readFile(absoluteRepoPath(repoRoot, repoRelativePath));
        return crypto.createHash("sha256").update(data).digest("hex");
    }
    catch {
        return null;
    }
};
const snapshotWorktree = async (repoRoot) => {
    const root = repoRoot?.trim();
    if (!root)
        return null;
    const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") {
        return null;
    }
    const status = await runGit(root, [
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain",
        "--untracked-files=all",
    ]);
    if (!status.ok)
        return null;
    const entries = parseGitStatus(status.stdout);
    const fingerprints = new Map();
    for (const [key, entry] of entries) {
        fingerprints.set(key, await fingerprintFile(root, statusKeyForEntry(entry)));
    }
    return { repoRoot: root, entries, fingerprints };
};
const entryToChange = (snapshot, entry) => {
    const status = entry.status;
    const changePath = absoluteRepoPath(snapshot.repoRoot, entry.path);
    const movePath = entry.movePath
        ? absoluteRepoPath(snapshot.repoRoot, entry.movePath)
        : undefined;
    if (status === "??" || status.includes("A")) {
        return { path: movePath ?? changePath, kind: { type: "add" } };
    }
    if (status.includes("D") && !status.includes("A")) {
        return { path: changePath, kind: { type: "delete" } };
    }
    return {
        path: changePath,
        kind: {
            type: "update",
            ...(movePath ? { move_path: movePath } : {}),
        },
    };
};
const diffWorktreeSnapshots = (before, after) => {
    if (!before || !after || before.repoRoot !== after.repoRoot) {
        return [];
    }
    const changes = [];
    const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
    for (const key of keys) {
        const beforeEntry = before.entries.get(key);
        const afterEntry = after.entries.get(key);
        const beforeFingerprint = before.fingerprints.get(key);
        const afterFingerprint = after.fingerprints.get(key);
        if (!beforeEntry && afterEntry) {
            changes.push(entryToChange(after, afterEntry));
            continue;
        }
        if (beforeEntry && !afterEntry) {
            if (beforeFingerprint === afterFingerprint)
                continue;
            const absolutePath = absoluteRepoPath(before.repoRoot, statusKeyForEntry(beforeEntry));
            changes.push({
                path: absolutePath,
                kind: fs.existsSync(absolutePath)
                    ? { type: "update" }
                    : { type: "delete" },
            });
            continue;
        }
        if (!beforeEntry || !afterEntry)
            continue;
        if (beforeEntry.status !== afterEntry.status ||
            beforeEntry.path !== afterEntry.path ||
            beforeEntry.movePath !== afterEntry.movePath ||
            beforeFingerprint !== afterFingerprint) {
            changes.push(entryToChange(after, afterEntry));
        }
    }
    return changes;
};
const normalizeCodexRuntimeReasoningEffort = (value) => {
    if (value === "none" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh") {
        return value;
    }
    return undefined;
};
export const getCodexRuntimePreferences = (stellaDataDir, stellaModel, modelOverride) => {
    const prefs = stellaDataDir ? loadLocalPreferences(stellaDataDir) : null;
    const lightDefault = stellaModel?.trim() === "stella/light" ? CODEX_LIGHT_MODEL : undefined;
    const preferredModel = prefs?.codexModel;
    // Provenance, not string-matching: only an explicit pick (marker set at
    // selection time) makes a Stella Light spawn honor the saved model. Legacy
    // prefs.json without the marker read as non-explicit, so a baked default
    // (including gpt-5.5) still downgrades light spawns to CODEX_LIGHT_MODEL.
    const userSelectedModel = prefs?.codexModelExplicit === true && preferredModel
        ? preferredModel
        : undefined;
    // A per-spawn pin (spawn_agent `model: codex/<model>`) is an explicit user
    // request for this one run — it outranks the env escape hatch and the saved
    // codexModel preference, neither of which it modifies.
    const model = modelOverride?.trim() ||
        process.env.STELLA_CODEX_MODEL?.trim() ||
        userSelectedModel ||
        lightDefault ||
        preferredModel ||
        DEFAULT_CODEX_MODEL;
    const envReasoning = normalizeCodexRuntimeReasoningEffort(process.env.STELLA_CODEX_REASONING_EFFORT?.trim());
    const prefReasoning = prefs?.codexReasoningEffort;
    const reasoningEffort = envReasoning ??
        (prefReasoning && prefReasoning !== "default" ? prefReasoning : undefined);
    return {
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        serviceTier: prefs?.codexServiceTier ?? DEFAULT_CODEX_SERVICE_TIER,
    };
};
export const codexServiceTierRequestValue = (serviceTier) => (serviceTier === "fast" ? "priority" : "default");
const mimeExtension = (mimeType) => {
    switch (mimeType.trim().toLowerCase()) {
        case "image/jpeg":
        case "image/jpg":
            return ".jpg";
        case "image/png":
            return ".png";
        case "image/gif":
            return ".gif";
        case "image/webp":
            return ".webp";
        default:
            return ".bin";
    }
};
export const codexImagePathFromFileUrl = (url) => {
    try {
        return fileURLToPath(url);
    }
    catch {
        return null;
    }
};
const materializeCodexAttachments = (runId, attachments) => {
    if (!attachments?.length)
        return { inputs: [] };
    const inputs = [];
    let cleanupDir;
    for (const [index, attachment] of attachments.entries()) {
        if (!attachment.mimeType?.startsWith("image/"))
            continue;
        if (attachment.url.startsWith("file://")) {
            const imagePath = codexImagePathFromFileUrl(attachment.url);
            if (imagePath)
                inputs.push({ type: "localImage", path: imagePath });
            continue;
        }
        if (path.isAbsolute(attachment.url)) {
            inputs.push({ type: "localImage", path: attachment.url });
            continue;
        }
        if (/^https?:\/\//i.test(attachment.url)) {
            inputs.push({ type: "image", url: attachment.url });
            continue;
        }
        const match = attachment.url.match(/^data:([^;]+);base64,(.*)$/);
        if (!match)
            continue;
        cleanupDir ??= fs.mkdtempSync(path.join(os.tmpdir(), `stella-codex-${runId.replace(/[^a-zA-Z0-9_-]/g, "-")}-`));
        const filePath = path.join(cleanupDir, `attachment-${index + 1}-${crypto.randomUUID()}${mimeExtension(match[1] ?? attachment.mimeType)}`);
        fs.writeFileSync(filePath, Buffer.from(match[2] ?? "", "base64"));
        inputs.push({ type: "localImage", path: filePath });
    }
    return { inputs, cleanupDir };
};
export const buildCodexUserInput = (args) => {
    const { inputs, cleanupDir } = materializeCodexAttachments(args.runId, args.attachments);
    return {
        input: [{ type: "text", text: args.prompt, text_elements: [] }, ...inputs],
        ...(cleanupDir ? { cleanupDir } : {}),
    };
};
const truncateStderr = (chunks) => {
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length <= MAX_STDERR_CAPTURE)
        return text;
    return text.slice(text.length - MAX_STDERR_CAPTURE);
};
/**
 * True only when the child has actually terminated. `child.killed` is
 * "a signal was SENT", not "the process died" — using it as a ladder
 * guard made SIGTERM/SIGKILL unreachable after the SIGINT in
 * `abortCodexProcess`, so a signal-ignoring app-server survived.
 */
const codexProcessIsDead = (child) => child.exitCode !== null || child.signalCode !== null;
const killCodexProcess = (child) => {
    if (codexProcessIsDead(child))
        return;
    try {
        child.kill("SIGTERM");
    }
    catch {
        // Process may have already exited.
    }
    const sigkillTimer = setTimeout(() => {
        if (codexProcessIsDead(child))
            return;
        try {
            child.kill("SIGKILL");
        }
        catch {
            // Process may have already exited.
        }
    }, SIGKILL_TIMEOUT_MS);
    child.once("exit", () => clearTimeout(sigkillTimer));
};
const abortCodexProcess = (child) => {
    if (codexProcessIsDead(child))
        return;
    try {
        child.kill("SIGINT");
    }
    catch {
        // Fall through to the harder kill path.
    }
    setTimeout(() => killCodexProcess(child), SIGTERM_TIMEOUT_MS);
};
const appendUniqueFileChanges = (target, changes) => {
    const seen = new Set(target.map((change) => `${change.path}\0${JSON.stringify(change.kind)}`));
    for (const change of changes) {
        const key = `${change.path}\0${JSON.stringify(change.kind)}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        target.push(change);
    }
};
const textFromUnknown = (value) => {
    if (value === undefined || value === null)
        return "";
    if (typeof value === "string")
        return value;
    if (typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint") {
        return String(value);
    }
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
};
const buildToolResultText = (toolResult) => toolResult.error
    ? `Error: ${toolResult.error}`
    : textFromUnknown(toolResult.result);
const extractCodexStellaContextInstructions = (systemPrompt) => {
    const lines = systemPrompt
        ?.split(/\r?\n/u)
        .filter((line) => line.startsWith("Current working directory: ") ||
        line.startsWith("- `~/.stella/outputs/`") ||
        line.startsWith("- `~/.stella/projects/<name>/`"));
    return lines?.length ? lines.join("\n") : undefined;
};
export const extractCodexDeveloperInstructions = (systemPrompt) => {
    const skillsBlock = systemPrompt?.match(/<skills>[\s\S]*?<\/skills>/u)?.[0];
    const sections = [
        extractCodexStellaContextInstructions(systemPrompt),
        skillsBlock?.trim(),
    ].filter((section) => Boolean(section?.trim()));
    return sections.length ? sections.join("\n\n") : undefined;
};
const toolArgsFromCodexValue = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
};
export const codexDurableImageToolCallId = (args) => {
    const requestHash = crypto
        .createHash("sha256")
        .update("image_gen")
        .update("\0")
        .update(stableJson(args.toolArgs))
        .digest("hex");
    const durableScope = crypto
        .createHash("sha256")
        .update(args.sessionKey ?? args.threadId)
        .digest("hex")
        .slice(0, 24);
    return `codex:${durableScope}:${args.callId}:${requestHash.slice(0, 24)}`;
};
export const buildCodexThreadStartParams = (args) => {
    const developerInstructions = extractCodexDeveloperInstructions(args.systemPrompt);
    return {
        model: args.model,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        serviceName: "Stella",
        ...(developerInstructions
            ? {
                developerInstructions,
            }
            : {}),
        ephemeral: false,
        experimentalRawEvents: false,
        ...(args.tools?.length
            ? {
                dynamicTools: args.tools.map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    inputSchema: normalizeProviderToolInputSchema(tool.parameters),
                })),
            }
            : {}),
    };
};
export const buildCodexThreadResumeParams = (args) => {
    const developerInstructions = extractCodexDeveloperInstructions(args.systemPrompt);
    return {
        threadId: args.threadId,
        model: args.model,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(developerInstructions
            ? {
                developerInstructions,
            }
            : {}),
        excludeTurns: true,
    };
};
export const buildCodexTurnStartParams = (args) => ({
    threadId: args.threadId,
    input: args.input,
    ...(args.cwd ? { cwd: args.cwd } : {}),
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    model: args.model,
    ...(args.reasoningEffort ? { effort: args.reasoningEffort } : {}),
    ...(args.serviceTier
        ? { serviceTier: codexServiceTierRequestValue(args.serviceTier) }
        : {}),
});
const CODEX_RESPONSE_WITH_ACK = Symbol("codex-response-with-ack");
const responseWithAck = (result, afterResponseWritten) => ({
    [CODEX_RESPONSE_WITH_ACK]: true,
    result,
    afterResponseWritten,
});
const isResponseWithAck = (value) => Boolean(value &&
    typeof value === "object" &&
    value[CODEX_RESPONSE_WITH_ACK]);
const configuredTimeoutMs = (envName, fallbackMs) => {
    const raw = process.env[envName]?.trim();
    if (!raw)
        return fallbackMs;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
};
class CodexAppServerClient {
    child;
    stderrChunks = [];
    pending = new Map();
    nextId = 1;
    closedError = null;
    notificationHandlers = new Set();
    requestHandlers = new Set();
    closeHandlers = new Set();
    constructor(cliBridgeSocketPath) {
        const executablePath = resolveExternalCliPath("codex");
        this.child = spawn(executablePath, ["app-server", "--listen", "stdio://"], {
            stdio: "pipe",
            env: buildExternalCliChildEnv(executablePath, process.env, {
                ...(cliBridgeSocketPath ? { cliBridgeSocketPath } : {}),
            }),
        });
        const lines = readline.createInterface({ input: this.child.stdout });
        lines.on("line", (line) => this.handleLine(line));
        this.child.stderr.on("data", (chunk) => {
            this.stderrChunks.push(chunk);
        });
        // stdin is a separate EventEmitter from ChildProcess. If app-server
        // exits between the liveness check and write, EPIPE lands here; owning
        // it keeps the runtime worker alive and rejects in-flight RPC calls.
        this.child.stdin.on("error", (error) => {
            this.rejectAll(new Error(`Codex app-server write failed: ${error.message}`));
        });
        this.child.once("error", (error) => {
            this.rejectAll(new Error(`Codex app-server failed to start: ${error.message}`));
        });
        this.child.once("exit", (code, signal) => {
            if (this.closedError)
                return;
            const detail = signal ?? (code === null ? "without exit code" : `with code ${code}`);
            const stderr = truncateStderr(this.stderrChunks).trim();
            this.rejectAll(new Error(`Codex app-server exited ${detail}${stderr ? `: ${stderr}` : ""}`));
        });
    }
    onNotification(handler) {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }
    onRequest(handler) {
        this.requestHandlers.add(handler);
        return () => this.requestHandlers.delete(handler);
    }
    onClose(handler) {
        this.closeHandlers.add(handler);
        return () => this.closeHandlers.delete(handler);
    }
    isClosed() {
        // A signaled (dying) child counts as closed for reuse: the shared
        // client must not accept new work while the kill ladder tears the
        // app-server down.
        return (Boolean(this.closedError) ||
            this.child.killed ||
            codexProcessIsDead(this.child));
    }
    async initialize() {
        await this.request("initialize", {
            clientInfo: {
                name: "stella",
                title: "Stella",
                version: "0.0.0",
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        this.notify("initialized");
    }
    async request(method, params) {
        if (this.closedError)
            throw this.closedError;
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => {
            const timeoutMs = configuredTimeoutMs("STELLA_CODEX_REQUEST_TIMEOUT_MS", DEFAULT_CODEX_REQUEST_TIMEOUT_MS);
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Codex app-server request ${method} timed out after ${Math.round(timeoutMs / 1000)}s.`));
            }, timeoutMs);
            timeout.unref?.();
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timeout);
                    reject(error);
                },
                timeout,
            });
        });
        try {
            this.write({ jsonrpc: "2.0", id, method, params });
        }
        catch (error) {
            const pending = this.pending.get(id);
            if (pending?.timeout) {
                clearTimeout(pending.timeout);
            }
            this.pending.delete(id);
            throw error;
        }
        return promise;
    }
    notify(method, params) {
        if (this.closedError)
            return;
        this.write({ jsonrpc: "2.0", method, params });
    }
    async interrupt(threadId, turnId) {
        try {
            await this.request("turn/interrupt", { threadId, turnId });
        }
        catch {
            // The process may already be shutting down.
        }
    }
    async steer(threadId, turnId, input) {
        await this.request("turn/steer", {
            threadId,
            input,
            expectedTurnId: turnId,
        });
    }
    close() {
        this.rejectAll(new Error("Codex app-server closed."));
        killCodexProcess(this.child);
    }
    abort() {
        this.rejectAll(new Error("Codex app-server aborted."));
        abortCodexProcess(this.child);
    }
    write(message) {
        const line = `${JSON.stringify(message)}\n`;
        try {
            this.child.stdin.write(line, (error) => {
                if (!error)
                    return;
                this.rejectAll(new Error(`Codex app-server write failed: ${error.message}`));
            });
        }
        catch (error) {
            const messageText = error instanceof Error ? error.message : textFromUnknown(error);
            throw new Error(`Codex app-server write failed: ${messageText}`);
        }
    }
    writeAsync(message) {
        if (this.closedError)
            return Promise.reject(this.closedError);
        const line = `${JSON.stringify(message)}\n`;
        return new Promise((resolve, reject) => {
            this.child.stdin.write(line, (error) => {
                if (error) {
                    const wrapped = new Error(`Codex app-server write failed: ${error.message}`);
                    this.rejectAll(wrapped);
                    reject(wrapped);
                    return;
                }
                resolve();
            });
        });
    }
    handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let message;
        try {
            message = JSON.parse(trimmed);
        }
        catch {
            return;
        }
        if (!message || typeof message !== "object")
            return;
        const rpc = message;
        if (rpc.id !== undefined && typeof rpc.method !== "string") {
            this.handleResponse(rpc);
            return;
        }
        if (rpc.id !== undefined && typeof rpc.method === "string") {
            void this.handleServerRequest(rpc);
            return;
        }
        if (typeof rpc.method === "string") {
            for (const handler of this.notificationHandlers) {
                handler(rpc);
            }
        }
    }
    handleResponse(message) {
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        this.pending.delete(message.id);
        if (pending.timeout) {
            clearTimeout(pending.timeout);
        }
        if (message.error) {
            pending.reject(new Error(message.error.message ??
                `Codex app-server request ${String(message.id)} failed.`));
            return;
        }
        pending.resolve(message.result);
    }
    async handleServerRequest(message) {
        try {
            for (const handler of this.requestHandlers) {
                const result = await handler(message);
                if (result !== undefined) {
                    const response = isResponseWithAck(result) ? result.result : result;
                    await this.writeAsync({
                        jsonrpc: "2.0",
                        id: message.id,
                        result: response,
                    });
                    if (isResponseWithAck(result)) {
                        await Promise.resolve(result.afterResponseWritten?.()).catch(() => undefined);
                    }
                    return;
                }
            }
            this.write({
                jsonrpc: "2.0",
                id: message.id,
                error: {
                    code: -32000,
                    message: `Unsupported Codex app-server request: ${message.method}`,
                },
            });
        }
        catch (error) {
            const messageText = error instanceof Error ? error.message : textFromUnknown(error);
            await this.writeAsync({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: messageText },
            }).catch(() => undefined);
        }
    }
    rejectAll(error) {
        if (this.closedError)
            return;
        this.closedError = error;
        for (const pending of this.pending.values()) {
            if (pending.timeout) {
                clearTimeout(pending.timeout);
            }
            pending.reject(error);
        }
        this.pending.clear();
        for (const handler of this.closeHandlers) {
            handler(error);
        }
    }
}
const createInitializedCodexClient = async (cliBridgeSocketPath) => {
    const client = new CodexAppServerClient(cliBridgeSocketPath);
    try {
        await client.initialize();
        return client;
    }
    catch (error) {
        client.close();
        throw error;
    }
};
let sharedCodexClientPromise = null;
let sharedCodexClient = null;
let sharedCodexBridgePath;
const getSharedCodexClient = async (cliBridgeSocketPath) => {
    if (sharedCodexBridgePath !== cliBridgeSocketPath) {
        shutdownCodexAppServerRuntime();
    }
    if (sharedCodexClient && !sharedCodexClient.isClosed()) {
        return sharedCodexClient;
    }
    if (sharedCodexClientPromise) {
        return sharedCodexClientPromise;
    }
    sharedCodexBridgePath = cliBridgeSocketPath;
    const pending = createInitializedCodexClient(cliBridgeSocketPath)
        .then((client) => {
        if (sharedCodexClientPromise !== pending ||
            sharedCodexBridgePath !== cliBridgeSocketPath) {
            client.close();
            throw new Error("Codex app-server launch configuration changed.");
        }
        sharedCodexClient = client;
        client.onClose(() => {
            if (sharedCodexClient === client) {
                sharedCodexClient = null;
                sharedCodexClientPromise = null;
                sharedCodexBridgePath = undefined;
            }
        });
        return client;
    })
        .catch((error) => {
        if (sharedCodexClientPromise === pending) {
            sharedCodexClientPromise = null;
        }
        throw error;
    });
    sharedCodexClientPromise = pending;
    return pending;
};
export const shutdownCodexAppServerRuntime = () => {
    const client = sharedCodexClient;
    sharedCodexClient = null;
    sharedCodexClientPromise = null;
    sharedCodexBridgePath = undefined;
    client?.close();
};
export const listCodexAppServerModels = async () => {
    const client = await createInitializedCodexClient();
    const models = [];
    try {
        let cursor = null;
        do {
            const response = await client.request("model/list", {
                cursor,
                limit: 100,
                includeHidden: false,
            });
            models.push(...response.data);
            cursor = response.nextCursor;
        } while (cursor);
        return { models };
    }
    finally {
        client.close();
    }
};
const requestCodexModels = async (client, includeHidden) => {
    const models = [];
    let cursor = null;
    do {
        const response = await client.request("model/list", {
            cursor,
            limit: 100,
            includeHidden,
        });
        models.push(...response.data);
        cursor = response.nextCursor;
    } while (cursor);
    return models;
};
const requestCodexModelsWithDeadline = async (client, includeHidden) => {
    const timeoutMs = Math.min(5_000, configuredTimeoutMs("STELLA_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS", DEFAULT_CODEX_EFFORT_MODEL_LIST_TIMEOUT_MS));
    let timeout;
    try {
        return await Promise.race([
            requestCodexModels(client, includeHidden),
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(`Codex effort model/list timed out after ${timeoutMs}ms.`)), timeoutMs);
                timeout.unref?.();
            }),
        ]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
};
const startOrResumeCodexThread = async (args) => {
    if (args.persistedSessionId) {
        try {
            const response = await args.client.request("thread/resume", buildCodexThreadResumeParams({
                threadId: args.persistedSessionId,
                model: args.model,
                cwd: args.cwd,
                systemPrompt: args.systemPrompt,
            }));
            return response.thread.id;
        }
        catch {
            // Fall through to a fresh Codex thread when the persisted id is stale.
        }
    }
    const response = await args.client.request("thread/start", buildCodexThreadStartParams({
        model: args.model,
        cwd: args.cwd,
        systemPrompt: args.systemPrompt,
        tools: args.tools,
    }));
    return response.thread.id;
};
const isNotificationForTurn = (notification, threadId, turnId) => {
    const params = notification.params && typeof notification.params === "object"
        ? notification.params
        : null;
    if (!params)
        return false;
    if (!params.threadId)
        return false;
    if (threadId && params.threadId !== threadId)
        return false;
    if (turnId && params.turnId && params.turnId !== turnId)
        return false;
    return true;
};
const isRequestForTurn = (message, threadId, turnId) => {
    const params = message.params && typeof message.params === "object"
        ? message.params
        : null;
    if (!params)
        return true;
    if (params.threadId && !threadId) {
        return false;
    }
    if (threadId && params.threadId && params.threadId !== threadId) {
        return false;
    }
    if (turnId && params.turnId && params.turnId !== turnId) {
        return false;
    }
    return true;
};
const statusFromCodexItem = (item) => {
    switch (item.type) {
        case "commandExecution":
            return null;
        case "fileChange":
            return item.status === "completed"
                ? `Codex changed ${item.changes.length} file${item.changes.length === 1 ? "" : "s"}`
                : `Codex file change ${item.status}`;
        case "dynamicToolCall":
            return null;
        case "mcpToolCall":
            return null;
        case "webSearch":
            return `Searching ${item.query}`;
        default:
            return null;
    }
};
const isFinalCodexAgentMessage = (item) => item.type === "agentMessage" && item.phase !== "commentary";
export const runCodexAgentTurn = async (request) => {
    const emitStatus = (status) => request.onStatus?.(redactSensitiveText(status));
    const runtimePreferences = getCodexRuntimePreferences(request.stellaDataDir, request.stellaModel, request.utility ? CODEX_UTILITY_MODEL : request.modelOverride);
    const model = runtimePreferences.model;
    const serviceTier = request.serviceTier ?? runtimePreferences.serviceTier;
    let reasoningEffort = request.utility
        ? "low"
        : (request.reasoningEffort ?? runtimePreferences.reasoningEffort);
    const { input, cleanupDir } = buildCodexUserInput({
        runId: request.runId,
        prompt: request.prompt,
        attachments: request.attachments,
    });
    const snapshotBefore = request.cwd
        ? await snapshotWorktree(request.cwd)
        : null;
    const fileChanges = [];
    let finalText = "";
    // Tracks whether each streamed agentMessage item is a commentary preamble
    // (keyed by item id). Codex streams a visible commentary preamble before a
    // tool; external-engines flushes that preamble separately as its own bubble
    // (see flushPreambleBeforeTool), so its deltas must not also accumulate into
    // finalText — otherwise the same commentary can surface twice (once as the
    // flushed preamble, once inside the persisted final answer) whenever no
    // final-answer item overwrites finalText.
    const agentMessageIsCommentary = new Map();
    let threadId;
    let turnId;
    let turnFailure = null;
    let completed = false;
    let finalAgentMessageCompleted = false;
    let turnCompletionReported = false;
    let waitingForTurnCompletion = false;
    let hasTurnProgress = false;
    const activeTurnWork = new Set();
    let turnIdleTimer;
    let agentMessageCompletionTimer;
    let refreshTurnIdleTimer;
    let scheduleCompletionGrace;
    const client = request.reuseAppServer
        ? await getSharedCodexClient(request.cliBridgeSocketPath)
        : await createInitializedCodexClient(request.cliBridgeSocketPath);
    if (request.reasoningEffort &&
        !request.reasoningEffortResolved &&
        !request.utility) {
        try {
            const models = await requestCodexModelsWithDeadline(client, true);
            const resolvedModel = models.find((candidate) => candidate.model === model || candidate.id === model);
            reasoningEffort = resolvedModel
                ? clampCodexSpawnReasoningEffort(resolvedModel, request.reasoningEffort)
                : undefined;
            if (!reasoningEffort) {
                console.debug("[stella:spawn-reasoning] effort dropped", {
                    requested: request.reasoningEffort,
                    model,
                    reason: resolvedModel
                        ? "resolved Codex model has no reasoning dial"
                        : "resolved Codex model was absent from model/list",
                });
            }
            else if (reasoningEffort !== request.reasoningEffort) {
                console.debug("[stella:spawn-reasoning] effort clamped", {
                    requested: request.reasoningEffort,
                    effective: reasoningEffort,
                    model,
                });
            }
        }
        catch (error) {
            reasoningEffort = undefined;
            console.debug("[stella:spawn-reasoning] effort dropped", {
                requested: request.reasoningEffort,
                model,
                reason: `Codex model/list unavailable: ${error.message}`,
            });
        }
    }
    let removeNotificationHandler;
    let removeRequestHandler;
    let removeCloseHandler;
    let detachTurnControl;
    let steeringInputCount = 0;
    const steeringCleanupDirs = [];
    const turnCompleted = new Promise((resolve, reject) => {
        const resolveCompleted = () => {
            if (completed)
                return;
            completed = true;
            resolve();
        };
        scheduleCompletionGrace = () => {
            if (!waitingForTurnCompletion ||
                completed ||
                !turnCompletionReported ||
                !finalAgentMessageCompleted) {
                return;
            }
            if (agentMessageCompletionTimer) {
                clearTimeout(agentMessageCompletionTimer);
            }
            agentMessageCompletionTimer = setTimeout(() => {
                resolveCompleted();
            }, CODEX_AGENT_MESSAGE_COMPLETION_GRACE_MS);
        };
        refreshTurnIdleTimer = () => {
            if (!waitingForTurnCompletion || completed)
                return;
            if (turnIdleTimer)
                clearTimeout(turnIdleTimer);
            turnIdleTimer = undefined;
            // App-server notifications are edge-triggered. A native command or a
            // Stella tool may remain silent while it legitimately runs beyond the
            // stream idle window, so while confirmed work is in flight the watchdog
            // is armed with the much longer tool ceiling instead of disarming —
            // work that never reports completion must not hang the turn forever.
            const workInFlight = activeTurnWork.size > 0;
            const timeoutMs = workInFlight
                ? configuredTimeoutMs("STELLA_CODEX_TURN_TOOL_IDLE_TIMEOUT_MS", DEFAULT_CODEX_TURN_TOOL_IDLE_TIMEOUT_MS)
                : hasTurnProgress
                    ? configuredTimeoutMs("STELLA_CODEX_TURN_IDLE_TIMEOUT_MS", DEFAULT_CODEX_TURN_IDLE_TIMEOUT_MS)
                    : configuredTimeoutMs("STELLA_CODEX_TURN_STARTUP_IDLE_TIMEOUT_MS", DEFAULT_CODEX_TURN_STARTUP_IDLE_TIMEOUT_MS);
            turnIdleTimer = setTimeout(() => {
                if (turnCompletionReported &&
                    finalAgentMessageCompleted &&
                    finalText.trim()) {
                    resolveCompleted();
                    return;
                }
                reject(new Error(workInFlight
                    ? `Codex app-server reported no turn progress for ${Math.round(timeoutMs / 1000)}s with ${activeTurnWork.size} work item(s) still marked in flight.`
                    : `Codex app-server did not report turn progress for ${Math.round(timeoutMs / 1000)}s.`));
                // Shared-client guard (same policy as the abort handler): one
                // turn's idleness must interrupt only ITS turn, never tear down a
                // shared app-server that other turns are using.
                if (threadId && turnId) {
                    void client.interrupt(threadId, turnId).catch(() => { });
                }
                if (!request.reuseAppServer) {
                    client.abort();
                }
            }, timeoutMs);
            turnIdleTimer.unref?.();
        };
        const markTurnProgress = () => {
            hasTurnProgress = true;
            refreshTurnIdleTimer?.();
        };
        removeNotificationHandler = client.onNotification((notification) => {
            if (!threadId)
                return;
            if (!isNotificationForTurn(notification, threadId, turnId))
                return;
            markTurnProgress();
            switch (notification.method) {
                case "turn/started":
                    turnId = notification.params.turn.id;
                    return;
                case "turn/completed": {
                    turnId = notification.params.turn.id;
                    const turn = notification.params.turn;
                    if (turn.status === "failed" || turn.status === "interrupted") {
                        const message = turn.error?.message ||
                            (turn.status === "interrupted"
                                ? "Codex was interrupted."
                                : null) ||
                            "Codex run failed.";
                        reject(new Error(message));
                        return;
                    }
                    turnCompletionReported = true;
                    scheduleCompletionGrace?.();
                    return;
                }
                case "error":
                    if (notification.params.willRetry)
                        return;
                    turnFailure =
                        notification.params.error?.message ||
                            notification.params.error?.additionalDetails ||
                            "Codex run failed.";
                    reject(new Error(turnFailure ?? "Codex run failed."));
                    return;
                case "item/agentMessage/delta":
                    // Only final-answer deltas accumulate into finalText. Commentary
                    // preambles are streamed live and flushed as their own bubble, so
                    // accumulating them here would duplicate the commentary in the
                    // persisted final answer when no final item overwrites finalText.
                    if (agentMessageIsCommentary.get(notification.params.itemId) !== true) {
                        finalText += notification.params.delta;
                    }
                    if (request.streamFinalAnswer !== false) {
                        request.onStream?.(notification.params.delta);
                    }
                    return;
                case "item/reasoning/textDelta":
                case "item/reasoning/summaryTextDelta": {
                    if (notification.params.delta) {
                        request.onReasoning?.(redactSensitiveText(notification.params.delta));
                    }
                    return;
                }
                case "item/started":
                case "item/completed": {
                    const item = notification.params.item;
                    const status = statusFromCodexItem(item);
                    if (status)
                        emitStatus(status);
                    if (item.type === "commandExecution") {
                        const workKey = `command:${item.id}`;
                        if (item.status === "inProgress") {
                            activeTurnWork.add(workKey);
                        }
                        else {
                            activeTurnWork.delete(workKey);
                        }
                        refreshTurnIdleTimer?.();
                        request.onCommandExecution?.({
                            id: item.id,
                            command: sanitizeCodexCommandForActivity(item.command),
                            ...(item.cwd ? { cwd: redactSensitiveText(item.cwd) } : {}),
                            status: item.status,
                            ...(item.exitCode !== undefined
                                ? { exitCode: item.exitCode }
                                : {}),
                        });
                    }
                    if (item.type === "agentMessage") {
                        agentMessageIsCommentary.set(item.id, item.phase === "commentary");
                    }
                    if (item.type === "agentMessage" &&
                        item.text &&
                        isFinalCodexAgentMessage(item)) {
                        finalText = item.text;
                        if (notification.method === "item/completed") {
                            finalAgentMessageCompleted = true;
                            scheduleCompletionGrace?.();
                        }
                    }
                    appendUniqueFileChanges(fileChanges, fileChangesFromCodexItem(item, request.cwd ?? request.stellaAppDir));
                    return;
                }
                default:
                    return;
            }
        });
        removeCloseHandler = client.onClose((error) => {
            if (waitingForTurnCompletion && !completed)
                reject(error);
        });
        removeRequestHandler = client.onRequest(async (message) => {
            if (!isRequestForTurn(message, threadId, turnId)) {
                return undefined;
            }
            markTurnProgress();
            if (message.method === "item/tool/call") {
                const params = message.params;
                if (!request.executeTool) {
                    return {
                        contentItems: [
                            {
                                type: "inputText",
                                text: `Error: Stella tool ${params.tool} is not available.`,
                            },
                        ],
                        success: false,
                    };
                }
                const executeTool = request.executeTool;
                const toolName = params.tool;
                const toolArgs = toolArgsFromCodexValue(params.arguments);
                const toolCallId = toolName === "image_gen"
                    ? codexDurableImageToolCallId({
                        sessionKey: request.sessionKey,
                        threadId: params.threadId,
                        callId: params.callId,
                        toolArgs,
                    })
                    : params.callId;
                const workKey = `tool:${params.callId}`;
                activeTurnWork.add(workKey);
                refreshTurnIdleTimer?.();
                let toolResult;
                try {
                    // Same per-tool inactivity bound as the native loop: a Stella tool
                    // that never settles gets cancelled with an error result instead of
                    // holding the turn open until the run-level ceiling kills it.
                    toolResult = await executeToolWithInactivityBound({
                        toolName,
                        signal: request.abortSignal,
                        run: (signal, onActivity) => executeTool(toolCallId, toolName, toolArgs, signal, (update) => {
                            onActivity();
                            refreshTurnIdleTimer?.();
                            request.onToolUpdate?.({
                                toolCallId,
                                toolName,
                                update,
                            });
                            const statusText = buildToolResultText(update).trim();
                            if (statusText)
                                emitStatus(statusText);
                        }),
                    });
                }
                finally {
                    activeTurnWork.delete(workKey);
                    refreshTurnIdleTimer?.();
                }
                appendUniqueFileChanges(fileChanges, toolResult.fileChanges ?? []);
                const response = {
                    contentItems: [
                        { type: "inputText", text: buildToolResultText(toolResult) },
                    ],
                    success: !toolResult.error,
                };
                return responseWithAck(response, toolName === "image_gen"
                    ? () => request.onToolResponseWritten?.({
                        toolCallId,
                        toolName,
                    })
                    : undefined);
            }
            if (message.method === "item/commandExecution/requestApproval") {
                return { decision: "decline" };
            }
            if (message.method === "item/fileChange/requestApproval") {
                return { decision: "decline" };
            }
            if (message.method === "item/tool/requestUserInput") {
                return { answers: {} };
            }
            if (message.method === "applyPatchApproval") {
                return { decision: "denied" };
            }
            if (message.method === "execCommandApproval") {
                return { decision: "denied" };
            }
            return undefined;
        });
    });
    const abortHandler = () => {
        if (threadId && turnId) {
            void client.interrupt(threadId, turnId);
        }
        if (!request.reuseAppServer) {
            client.abort();
        }
    };
    request.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    try {
        if (request.abortSignal?.aborted) {
            throw new Error("Aborted");
        }
        threadId = await startOrResumeCodexThread({
            client,
            persistedSessionId: request.persistedSessionId,
            model,
            cwd: request.cwd,
            systemPrompt: request.systemPrompt,
            tools: request.tools,
            onStatus: emitStatus,
        });
        request.onSessionId?.(threadId);
        if (request.abortSignal?.aborted) {
            throw new Error("Aborted");
        }
        const turn = await client.request("turn/start", buildCodexTurnStartParams({
            threadId,
            input,
            model,
            cwd: request.cwd,
            reasoningEffort,
            serviceTier,
        }));
        turnId = turn.turn.id;
        if (request.onTurnControl) {
            detachTurnControl = request.onTurnControl({
                steer: async ({ prompt, attachments }) => {
                    if (!threadId || !turnId) {
                        throw new Error("Codex turn is not ready for steering.");
                    }
                    const steeringInput = buildCodexUserInput({
                        runId: `${request.runId}-steer-${++steeringInputCount}`,
                        prompt,
                        attachments,
                    });
                    if (steeringInput.cleanupDir) {
                        steeringCleanupDirs.push(steeringInput.cleanupDir);
                    }
                    await client.steer(threadId, turnId, steeringInput.input);
                },
            });
        }
        if (request.abortSignal?.aborted) {
            void client.interrupt(threadId, turnId);
            throw new Error("Aborted");
        }
        if (turn.turn.status === "failed" || turn.turn.status === "interrupted") {
            throw new Error(turn.turn.error?.message ?? "Codex run failed.");
        }
        waitingForTurnCompletion = true;
        scheduleCompletionGrace?.();
        refreshTurnIdleTimer?.();
        await turnCompleted;
        const snapshotAfter = request.cwd && snapshotBefore
            ? await snapshotWorktree(request.cwd)
            : null;
        if (snapshotBefore && snapshotAfter) {
            appendUniqueFileChanges(fileChanges, diffWorktreeSnapshots(snapshotBefore, snapshotAfter));
        }
        if (request.abortSignal?.aborted) {
            throw new Error("Aborted");
        }
        if (turnFailure) {
            throw new Error(turnFailure);
        }
        if (!threadId) {
            throw new Error("Codex app-server did not report a thread id.");
        }
        if (!completed) {
            throw new Error("Codex app-server did not complete the turn.");
        }
        return {
            text: finalText.trim(),
            sessionId: threadId,
            ...(fileChanges.length ? { fileChanges } : {}),
        };
    }
    finally {
        if (turnIdleTimer)
            clearTimeout(turnIdleTimer);
        if (agentMessageCompletionTimer)
            clearTimeout(agentMessageCompletionTimer);
        request.abortSignal?.removeEventListener("abort", abortHandler);
        removeNotificationHandler?.();
        removeRequestHandler?.();
        removeCloseHandler?.();
        detachTurnControl?.();
        if (!request.reuseAppServer) {
            client.close();
        }
        if (cleanupDir)
            fs.rmSync(cleanupDir, { recursive: true, force: true });
        for (const steeringCleanupDir of steeringCleanupDirs) {
            fs.rmSync(steeringCleanupDir, { recursive: true, force: true });
        }
    }
};
