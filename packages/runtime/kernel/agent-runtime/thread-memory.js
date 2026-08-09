import path from "node:path";
import { createRuntimeLogger } from "../debug.js";
import { buildRuntimeThreadKey, maybeCompactRuntimeThread, } from "../thread-runtime.js";
import { now } from "./shared.js";
import { readOptionalTextFile } from "../shared/read-optional-text-file.js";
import { redactMemoryText } from "../memory/redaction.js";
const logger = createRuntimeLogger("agent-runtime.thread-memory");
const LIFE_REGISTRY_DISPLAY_PATH = "~/.stella/registry.md";
const LIFE_CORE_MEMORY_DISPLAY_PATH = "~/.stella/core-memory.md";
const LIFE_USER_PROFILE_DISPLAY_PATH = "~/.stella/memories/profile.md";
const LIFE_MEMORY_SUMMARY_DISPLAY_PATH = "~/.stella/memories/memory_summary.md";
const LIFE_PERSONALITY_DISPLAY_PATH = "~/.stella/PERSONALITY.md";
const BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE = "bootstrap.startup_doc";
const MEMORY_STARTUP_DOC_PATHS = [
    LIFE_CORE_MEMORY_DISPLAY_PATH,
    LIFE_USER_PROFILE_DISPLAY_PATH,
    LIFE_MEMORY_SUMMARY_DISPLAY_PATH,
];
export const buildRunThreadKey = ({ conversationId, agentType, runId, threadId, }) => buildRuntimeThreadKey({
    conversationId,
    agentType,
    runId,
    threadId,
});
const MAX_IMAGES_IN_HISTORY = 8;
const IMAGE_HISTORY_BASE64_BUDGET = 12 * 1024 * 1024;
export const stripStaleImageBlocks = (messages) => {
    let imagesKept = 0;
    let imageBytesKept = 0;
    let rewroteAny = false;
    const out = [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "toolResult") {
            out.push(message);
            continue;
        }
        const hasImage = message.content.some((block) => block.type === "image");
        if (!hasImage) {
            out.push(message);
            continue;
        }
        let rewroteThisMessage = false;
        const compactContent = [...message.content]
            .reverse()
            .map((block) => {
            if (block.type !== "image") {
                return block;
            }
            const base64Bytes = block.data?.length ?? 0;
            if (imagesKept < MAX_IMAGES_IN_HISTORY &&
                imageBytesKept + base64Bytes <= IMAGE_HISTORY_BASE64_BUDGET) {
                imagesKept += 1;
                imageBytesKept += base64Bytes;
                return block;
            }
            rewroteThisMessage = true;
            const sizeKb = Math.round((base64Bytes * 0.75) / 1024);
            return {
                type: "text",
                text: `[Older ${block.mimeType ?? "image/png"} screenshot omitted from history (~${sizeKb}KB). Re-run the tool to see it again.]`,
            };
        })
            .reverse();
        if (!rewroteThisMessage) {
            out.push(message);
            continue;
        }
        rewroteAny = true;
        out.push({ ...message, content: compactContent });
    }
    return rewroteAny ? out.reverse() : messages;
};
export const buildHistorySource = (context) => {
    // Keep older bootstrap entries so cadence injections do not shift the
    // prompt-cache prefix on coast turns.
    const messages = context.threadHistory
        ?.filter((entry) => context.memoryEnabled !== false || !isMemoryStartupDocEntry(entry))
        ?.map((entry) => {
        if (entry.payload) {
            return toRuntimeMessage(entry.payload);
        }
        if (entry.role === "runtimeInternal" && entry.customMessage) {
            return {
                role: "runtimeInternal",
                content: entry.customMessage.content,
                timestamp: entry.timestamp ?? now(),
                customType: entry.customMessage.customType,
                display: entry.customMessage.display,
            };
        }
        if (entry.role === "user" && typeof entry.content === "string") {
            return {
                role: "user",
                content: entry.content,
                timestamp: now(),
            };
        }
        if (entry.role === "assistant" && typeof entry.content === "string") {
            const trimmed = entry.content.trim();
            if (!trimmed)
                return null;
            return createHistoryAssistantMessage([
                { type: "text", text: trimmed },
            ]);
        }
        if (entry.role === "runtimeInternal" &&
            typeof entry.content === "string") {
            const trimmed = entry.content.trim();
            if (!trimmed)
                return null;
            return {
                role: "runtimeInternal",
                content: [{ type: "text", text: trimmed }],
                timestamp: now(),
            };
        }
        return null;
    })
        .filter((entry) => entry !== null) ?? [];
    return messages;
};
const isMemoryStartupDocEntry = (entry) => {
    if (entry.role !== "runtimeInternal" ||
        entry.customMessage?.customType !== BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE) {
        return false;
    }
    const text = customMessageContentText(entry.customMessage.content);
    return MEMORY_STARTUP_DOC_PATHS.some((displayPath) => text.includes(`<startup_doc path="${displayPath}">`));
};
const createHistoryAssistantMessage = (content, errorMessage) => ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "history",
    usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    },
    stopReason: "stop",
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: now(),
});
const toRuntimeMessage = (payload) => {
    if (payload.role === "user") {
        return payload;
    }
    if (payload.role === "assistant") {
        return payload;
    }
    return payload;
};
const stringifyPayload = (value) => {
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
};
const contentPreviewFromTextAndImages = (content) => content
    .map((block) => block.type === "text" ? block.text : `[Image: ${block.mimeType}]`)
    .join("\n")
    .trim();
export const buildThreadMessagePreview = (payload) => {
    if (payload.role === "user") {
        return typeof payload.content === "string"
            ? payload.content
            : contentPreviewFromTextAndImages(payload.content);
    }
    if (payload.role === "assistant") {
        return payload.content
            .flatMap((block) => {
            if (block.type === "text") {
                const trimmed = block.text.trim();
                return trimmed ? [trimmed] : [];
            }
            if (block.type === "toolCall") {
                return [
                    `[Tool call] ${block.name}\nargs: ${stringifyPayload(block.arguments ?? {})}`,
                ];
            }
            return [];
        })
            .join("\n\n")
            .trim();
    }
    const body = contentPreviewFromTextAndImages(payload.content);
    return [`[Tool result] ${payload.toolName}`, ...(body ? [body] : [])]
        .join("\n")
        .trim();
};
export const persistThreadPayloadMessage = (store, args) => {
    const preview = buildThreadMessagePreview(args.payload);
    const toolCallId = args.payload.role === "toolResult" ? args.payload.toolCallId : undefined;
    appendThreadMessage(store, {
        threadKey: args.threadKey,
        role: args.payload.role,
        content: preview,
        ...(toolCallId ? { toolCallId } : {}),
        payload: args.payload,
    });
};
export const persistThreadCustomMessage = (store, args) => {
    store.appendThreadCustomMessage({
        threadKey: args.threadKey,
        timestamp: args.timestamp ?? now(),
        customType: args.customType,
        content: args.content,
        display: args.display === true,
        ...(args.eventId ? { eventId: args.eventId } : {}),
    });
};
const getPlatformShellPrompt = () => {
    if (process.platform === "win32") {
        return "On Windows, use the native command shell and Windows paths. Prefer PowerShell when it is the clearer fit for the task.";
    }
    if (process.platform === "darwin") {
        return "On macOS, use standard POSIX shell commands and native /Users/... paths when using Bash.";
    }
    return null;
};
const hasToolGuidance = (context, toolNames) => {
    const toolsAllowlist = context.toolsAllowlist;
    if (!Array.isArray(toolsAllowlist) || toolsAllowlist.length === 0) {
        return true;
    }
    return toolNames.some((toolName) => toolsAllowlist.includes(toolName));
};
const hasShellToolGuidance = (context) => {
    return hasToolGuidance(context, ["Bash", "exec_command"]);
};
/**
 * Runtime facts about waiting, stated wherever an agent has a shell rather
 * than left to each agent's prompt body.
 *
 * Agents were writing checks the runtime couldn't cash — "I'll report back
 * when the benchmark lands" — and their threads stopped forever; one left a
 * GPU pod idle-billing for hours. There are exactly two ways to wait now
 * and no tool for either: a background `exec_command` session wakes the
 * thread when it exits, and everything else is polled inside the turn.
 * Since the covered case is defined by what the tool host can see, the
 * boundary has to be spelled out too.
 */
const buildBackgroundWaitPrompt = (context) => {
    if (!hasShellToolGuidance(context)) {
        return null;
    }
    return [
        "Waiting on long work:",
        "- A command still running when `exec_command` yields keeps running after your turn ends, and the runtime watches it for you. When it exits you are resumed in this thread, with your history, holding its command, exit code, and output. So you may start a long job, end your turn, and genuinely be woken when it finishes — several exits close together arrive as one wake.",
        "- That covers sessions `exec_command` gave you a `session_id` for. It does NOT cover a process you detach from that session (`nohup … &`, `disown`, a daemon that forks away): the session exits immediately and the thing you actually care about is invisible to the runtime. Run long work in the foreground of its own session and let it hold the session open.",
        "- For anything else you need to wait on — a file appearing, a remote job flipping to done, an endpoint going healthy — poll inside the current turn. `write_stdin` with empty `chars` blocks on a session until it prints or exits, up to 5 minutes per call; a foreground `sleep N && check` loop works for the rest. There is no tool that wakes you later, so a wait you do not either background as a session or finish in-turn is a wait nobody is keeping.",
        "- Never claim you'll report back on something outside those two paths. If a wait is genuinely unattended, say so plainly and hand over the exact command to check it.",
    ].join("\n");
};
const buildFileEditingPrompt = (context) => {
    const explicitlyHasWriteEdit = Array.isArray(context.toolsAllowlist) &&
        context.toolsAllowlist.length > 0 &&
        (context.toolsAllowlist.includes("Write") ||
            context.toolsAllowlist.includes("Edit"));
    if (explicitlyHasWriteEdit) {
        return [
            "File edits:",
            "- Use `Write` for new files or full-file replacements.",
            "- Use `Edit` for targeted text replacements inside existing files.",
            "- Use `exec_command` for read-only inspection, builds/tests, package-manager commands, and commands that create external artifacts.",
            "- Do not use shell heredocs or `cat > file` for source edits when `Write` or `Edit` can express the change.",
        ].join("\n");
    }
    if (!hasToolGuidance(context, ["apply_patch"])) {
        return null;
    }
    return [
        "File edits:",
        "- Prefer `apply_patch` for source and text-file edits so changes are tracked as structured patches.",
        "- Use `exec_command` for read-only inspection, builds/tests, package-manager commands, and commands that create external artifacts.",
        "- Do not use shell heredocs or `cat > file` for source edits when `apply_patch` can express the change.",
    ].join("\n");
};
export const buildSystemPrompt = (context) => {
    const sections = [context.systemPrompt.trim()];
    if (context.dynamicContext?.trim()) {
        sections.push(context.dynamicContext.trim());
    }
    const fileEditingPrompt = buildFileEditingPrompt(context);
    if (fileEditingPrompt) {
        sections.push(fileEditingPrompt);
    }
    const platformShellPrompt = getPlatformShellPrompt();
    if (platformShellPrompt && hasShellToolGuidance(context)) {
        sections.push(platformShellPrompt);
    }
    const backgroundWaitPrompt = buildBackgroundWaitPrompt(context);
    if (backgroundWaitPrompt) {
        sections.push(backgroundWaitPrompt);
    }
    return sections.filter(Boolean).join("\n\n");
};
const buildStartupDocMessage = (displayPath, content) => {
    return [
        `<startup_doc path="${displayPath}">`,
        content,
        "</startup_doc>",
    ].join("\n");
};
export const isBootstrapStartupDocMessage = (message) => message.role === "runtimeInternal" &&
    message.customType === BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE;
const customMessageContentText = (content) => {
    if (typeof content === "string") {
        return content;
    }
    return content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
};
const hasPersistedStartupDoc = (context, docText) => {
    const needle = docText.trim();
    return (context.threadHistory?.some((entry) => {
        const customMessage = entry.customMessage;
        if (entry.role !== "runtimeInternal" ||
            customMessage?.customType !== BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE) {
            return false;
        }
        // Match on the full doc body, not just its path. A resident doc whose
        // content changed mid-thread (a Remember replace/remove, or Dream
        // refreshing memory_summary.md) must re-inject so the thread sees the
        // current version instead of the stale copy already in history.
        return customMessageContentText(customMessage.content).trim() === needle;
    }) ?? false);
};
const createInternalPromptMessage = (text, uiVisibility = "hidden", customType) => ({
    text,
    uiVisibility,
    messageType: "message",
    ...(customType ? { customType } : {}),
});
const readRegistryContent = async (args) => {
    const stellaDataDir = args.stellaDataDir?.trim();
    if (!stellaDataDir) {
        return null;
    }
    return await readOptionalTextFile(path.join(stellaDataDir, "registry.md"));
};
export const buildStartupPromptMessages = async (args) => {
    const messages = [];
    const shouldIncludeRegistry = args.includeRegistry ?? false;
    const personality = args.context.personality?.trim();
    if (personality) {
        const doc = buildStartupDocMessage(LIFE_PERSONALITY_DISPLAY_PATH, personality);
        if (!hasPersistedStartupDoc(args.context, doc)) {
            messages.push(createInternalPromptMessage(doc, "hidden", BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE));
        }
    }
    if (shouldIncludeRegistry) {
        const registryContent = await readRegistryContent({
            stellaDataDir: args.stellaDataDir,
        });
        if (registryContent) {
            const doc = buildStartupDocMessage(LIFE_REGISTRY_DISPLAY_PATH, registryContent);
            if (!hasPersistedStartupDoc(args.context, doc)) {
                messages.push(createInternalPromptMessage(doc, "hidden", BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE));
            }
        }
    }
    const coreMemory = args.context.coreMemory
        ? redactMemoryText(args.context.coreMemory.trim())
        : "";
    if (coreMemory) {
        const doc = buildStartupDocMessage(LIFE_CORE_MEMORY_DISPLAY_PATH, coreMemory);
        if (!hasPersistedStartupDoc(args.context, doc)) {
            messages.push(createInternalPromptMessage(doc, "hidden", BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE));
        }
    }
    // Resident user profile — durable facts the Remember tool persists. Pushed
    // every session so identity facts ("the user goes by Bob") are always in
    // context without a Context lookup.
    const userProfile = args.context.userProfile
        ? redactMemoryText(args.context.userProfile.trim())
        : "";
    if (userProfile) {
        const doc = buildStartupDocMessage(LIFE_USER_PROFILE_DISPLAY_PATH, userProfile);
        if (!hasPersistedStartupDoc(args.context, doc)) {
            messages.push(createInternalPromptMessage(doc, "hidden", BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE));
        }
    }
    // Resident focus summary — Dream's dynamic snapshot of what the user is
    // actively working on, now pushed instead of only reachable via Context.
    const memorySummary = args.context.memorySummary
        ? redactMemoryText(args.context.memorySummary.trim())
        : "";
    if (memorySummary) {
        const doc = buildStartupDocMessage(LIFE_MEMORY_SUMMARY_DISPLAY_PATH, memorySummary);
        if (!hasPersistedStartupDoc(args.context, doc)) {
            messages.push(createInternalPromptMessage(doc, "hidden", BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE));
        }
    }
    return messages;
};
const fanOutBeforeUserMessage = async (args) => {
    const empty = { prepend: [], append: [] };
    const { hookEmitter } = args.hookContext;
    if (!hookEmitter)
        return empty;
    const results = await hookEmitter.emitAll("before_user_message", {
        agentType: args.agentType,
        userPrompt: args.userPrompt,
        ...(args.staleUserReminderText !== undefined
            ? { staleUserReminderText: args.staleUserReminderText }
            : {}),
        ...(args.orchestratorReminderText !== undefined
            ? { orchestratorReminderText: args.orchestratorReminderText }
            : {}),
        ...(args.connectorTransitionReminderText !== undefined
            ? {
                connectorTransitionReminderText: args.connectorTransitionReminderText,
            }
            : {}),
        ...(args.shouldInjectDynamicReminder !== undefined
            ? { shouldInjectDynamicReminder: args.shouldInjectDynamicReminder }
            : {}),
        ...(args.hookContext.conversationId
            ? { conversationId: args.hookContext.conversationId }
            : {}),
        ...(args.hookContext.threadKey
            ? { threadKey: args.hookContext.threadKey }
            : {}),
        ...(args.hookContext.runId ? { runId: args.hookContext.runId } : {}),
        ...(args.hookContext.uiVisibility
            ? { uiVisibility: args.hookContext.uiVisibility }
            : {}),
        isUserTurn: args.hookContext.uiVisibility !== "hidden",
    }, { agentType: args.agentType });
    const prepend = [];
    const append = [];
    for (const result of results) {
        if (result?.prependMessages?.length) {
            prepend.push(...result.prependMessages);
        }
        if (result?.appendMessages?.length) {
            append.push(...result.appendMessages);
        }
    }
    return { prepend, append };
};
export const buildSubagentPromptMessages = async (args) => {
    const trimmedUserPrompt = args.userPrompt.trim();
    const messages = [];
    // `before_user_message` fan-out runs first so extension-injected
    // context lands at the very top of the prompt-message array.
    // Subagent reminder fields are intentionally undefined — they're an
    // orchestrator-only concept on `LocalAgentContext` today.
    if (args.agentType && args.hookContext) {
        const { prepend, append } = await fanOutBeforeUserMessage({
            hookContext: args.hookContext,
            agentType: args.agentType,
            userPrompt: args.userPrompt,
        });
        messages.push(...prepend);
        messages.push(...(await buildStartupPromptMessages({
            context: args.context,
            stellaDataDir: args.stellaDataDir,
            stellaAppDir: args.stellaAppDir,
        })));
        messages.push(...append);
    }
    else {
        messages.push(...(await buildStartupPromptMessages({
            context: args.context,
            stellaDataDir: args.stellaDataDir,
            stellaAppDir: args.stellaAppDir,
        })));
    }
    if (args.promptMessages?.length) {
        messages.push(...args.promptMessages);
    }
    if (trimmedUserPrompt.length > 0 || messages.length === 0) {
        messages.push({ text: args.userPrompt });
    }
    return messages;
};
export const buildOrchestratorPromptMessages = async (args) => {
    const trimmedUserPrompt = args.userPrompt.trim();
    const messages = [];
    // Stale-user / dynamic-memory reminders used to be inline branches
    // here; they now live as `before_user_message` hooks in
    // `runtime/extensions/stella-runtime/hooks/`. The reminder text is
    // forwarded through the hook payload so the hooks can decide whether
    // to inject. When no hook emitter is wired (legacy / direct test
    // callers) the prompt builds without reminders, matching the
    // pre-migration behavior for those callers.
    if (args.agentType && args.hookContext) {
        const { prepend, append } = await fanOutBeforeUserMessage({
            hookContext: args.hookContext,
            agentType: args.agentType,
            userPrompt: args.userPrompt,
            ...(args.context.staleUserReminderText !== undefined
                ? { staleUserReminderText: args.context.staleUserReminderText }
                : {}),
            ...(args.context.orchestratorReminderText !== undefined
                ? { orchestratorReminderText: args.context.orchestratorReminderText }
                : {}),
            ...(args.context.connectorTransitionReminderText !== undefined
                ? {
                    connectorTransitionReminderText: args.context.connectorTransitionReminderText,
                }
                : {}),
            ...(args.context.shouldInjectDynamicReminder !== undefined
                ? {
                    shouldInjectDynamicReminder: args.context.shouldInjectDynamicReminder,
                }
                : {}),
        });
        messages.push(...prepend);
        messages.push(...(await buildStartupPromptMessages({
            context: args.context,
            stellaDataDir: args.stellaDataDir,
            stellaAppDir: args.stellaAppDir,
        })));
        messages.push(...append);
    }
    else {
        messages.push(...(await buildStartupPromptMessages({
            context: args.context,
            stellaDataDir: args.stellaDataDir,
            stellaAppDir: args.stellaAppDir,
        })));
    }
    if (args.promptMessages?.length) {
        messages.push(...args.promptMessages);
    }
    if (trimmedUserPrompt.length > 0 || messages.length === 0) {
        messages.push({ text: args.userPrompt });
    }
    return messages;
};
export const updateOrchestratorReminderState = (store, args) => {
    const updateCounter = store.updateOrchestratorReminderCounter;
    if (typeof updateCounter !== "function") {
        return;
    }
    if (args.shouldInjectDynamicReminder) {
        updateCounter.call(store, {
            conversationId: args.conversationId,
            resetTo: 0,
        });
    }
};
export const appendThreadMessage = (store, args) => {
    store.appendThreadMessage({
        timestamp: now(),
        threadKey: args.threadKey,
        role: args.role,
        content: args.content,
        ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
        ...(args.payload ? { payload: args.payload } : {}),
    });
};
export const compactRuntimeThreadHistory = async (args) => {
    try {
        return await maybeCompactRuntimeThread({
            store: args.store,
            threadKey: args.threadKey,
            resolvedLlm: args.resolvedLlm,
            agentType: args.agentType,
            ...(args.overrideSummary
                ? { overrideSummary: args.overrideSummary }
                : {}),
            ...(args.preserveLastN !== undefined
                ? { preserveLastN: args.preserveLastN }
                : {}),
            ...(args.stellaDataDir ? { stellaDataDir: args.stellaDataDir } : {}),
        });
    }
    catch (error) {
        logger.warn("thread.compaction.failed", {
            threadKey: args.threadKey,
            agentType: args.agentType,
            error: error instanceof Error ? error.message : String(error),
        });
        return { compacted: false };
    }
};
export const persistAssistantReply = async (args) => {
    if (!args.content.trim()) {
        return;
    }
    appendThreadMessage(args.store, {
        threadKey: args.threadKey,
        role: "assistant",
        content: args.content,
    });
    await compactRuntimeThreadHistory(args);
};
