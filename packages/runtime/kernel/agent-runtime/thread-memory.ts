import { createRuntimeLogger } from "../debug.js";
import {
  buildRuntimeThreadKey,
  maybeCompactRuntimeThread,
} from "../thread-runtime.js";
import { RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE } from "../storage/shared.js";
import { now } from "./shared.js";
import {
  BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE,
  LIFE_CORE_MEMORY_DISPLAY_PATH,
  LIFE_MEMORY_INDEX_DISPLAY_PATH,
  LIFE_USER_PROFILE_DISPLAY_PATH,
  buildResidentContextMessages,
  customMessageContentText,
  isRetiredMemoryCustomMessage,
} from "./resident-context.js";
import { QUARANTINE_CUSTOM_TYPE } from "./provider-abort-containment.js";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "../storage/shared.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import type { RuntimeStore } from "../storage/runtime-store.js";
import type { AgentMessage } from "../agent-core/types.js";
import type { HookEmitter } from "../extensions/hook-emitter.js";
import type { HookRuntimeContext } from "../extensions/types.js";
import type { ResolvedLlmRoute } from "../model-routing.js";
import type { ThreadCompactionResult } from "../thread-runtime.js";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";
import type { ResidentContext } from "./resident-context.js";

type ThreadMessageRecord = ReturnType<
  RuntimeStore["loadThreadMessages"]
>[number];
type ThreadPayload = PersistedRuntimeThreadPayload;
type AssistantPayload = Extract<ThreadPayload, { role: "assistant" }>;
type ToolResultPayload = Extract<ThreadPayload, { role: "toolResult" }>;
type HistoryEntry = RuntimeThreadMessage | ThreadMessageRecord;
type ToolGuidanceContext = { toolsAllowlist?: readonly string[] };
type SystemPromptSection = { id: string; text: string };
type PromptBuildContext = ResidentContext & {
  staleUserReminderText?: string;
  connectorTransitionReminderText?: string;
};
type PromptBuildHookContext = HookRuntimeContext & {
  hookEmitter?: HookEmitter;
};
type PromptBuildArgs = {
  context: PromptBuildContext;
  userPrompt: string;
  promptMessages?: RuntimePromptMessage[];
  stellaDataDir?: string;
  stellaAppDir?: string;
  agentType?: string;
  hookContext?: PromptBuildHookContext;
};
type CompactThreadArgs = {
  store: RuntimeStore;
  threadKey: string;
  resolvedLlm: ResolvedLlmRoute;
  agentType: string;
  overrideSummary?: string;
  preserveLastN?: number;
  stellaDataDir?: string;
  readAgentRoster?: () => Promise<string | undefined>;
};
const logger = createRuntimeLogger("agent-runtime.thread-memory");
const MEMORY_STARTUP_DOC_PATHS = [
  LIFE_CORE_MEMORY_DISPLAY_PATH,
  LIFE_USER_PROFILE_DISPLAY_PATH,
  LIFE_MEMORY_INDEX_DISPLAY_PATH,
];
export const buildRunThreadKey = ({
  conversationId,
  agentType,
  runId,
  threadId,
}: {
  conversationId: string;
  agentType: string;
  runId: string;
  threadId?: string;
}) =>
  buildRuntimeThreadKey({
    conversationId,
    agentType,
    runId,
    threadId,
  });
// Historical compatibility shim. Never rewrite the active message array on
// every turn: doing so shifts the provider prompt prefix and destroys prompt
// cache reuse. Image pressure is handled at the existing compaction/checkpoint
// boundary in thread-runtime.ts, where a cache-prefix change is expected and
// the harness persists deterministic structured image receipts outside the
// model-authored summary.
export const stripStaleImageBlocks = <T>(messages: T): T => {
  return messages;
};
export const buildHistorySource = (context: {
  threadHistory?: readonly HistoryEntry[];
  memoryEnabled?: boolean;
}): AgentMessage[] => {
  const threadHistory = context.threadHistory ?? [];
  let latestRosterIndex = -1;
  for (let index = threadHistory.length - 1; index >= 0; index -= 1) {
    if (
      threadHistory[index]?.customMessage?.customType ===
      ORCHESTRATOR_ROSTER_CUSTOM_TYPE
    ) {
      latestRosterIndex = index;
      break;
    }
  }
  const messages =
    threadHistory
      ?.filter(
        (entry, index) =>
          (entry.customMessage?.customType !==
            ORCHESTRATOR_ROSTER_CUSTOM_TYPE ||
            index === latestRosterIndex) &&
          entry.customMessage?.customType !==
            RUNTIME_PRIVATE_TASK_LIFECYCLE_CUSTOM_TYPE &&
          !isRetiredMemoryEntry(entry) &&
          entry.customMessage?.customType !== QUARANTINE_CUSTOM_TYPE &&
          !isFailedAssistantPayload(entry.payload) &&
          (context.memoryEnabled !== false || !isMemoryStartupDocEntry(entry)),
      )
      ?.map((entry): AgentMessage | null => {
        if (entry.payload) {
          return entry.payload;
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
          if (!trimmed) return null;
          return createHistoryAssistantMessage([
            { type: "text", text: trimmed },
          ]);
        }
        if (
          entry.role === "runtimeInternal" &&
          typeof entry.content === "string"
        ) {
          const trimmed = entry.content.trim();
          if (!trimmed) return null;
          return {
            role: "runtimeInternal",
            content: [{ type: "text", text: trimmed }],
            timestamp: now(),
          };
        }
        return null;
      })
      .filter((entry): entry is AgentMessage => entry !== null) ?? [];
  return messages;
};
const isRetiredMemoryEntry = (entry: HistoryEntry) =>
  entry.role === "runtimeInternal" &&
  isRetiredMemoryCustomMessage(entry.customMessage);
const isFailedAssistantPayload = (payload?: ThreadPayload) =>
  payload?.role === "assistant" &&
  (payload.stopReason === "error" ||
    payload.stopReason === "aborted" ||
    !payload.content.some(
      (block) =>
        block.type === "toolCall" ||
        (block.type === "text" && block.text.trim().length > 0),
    ));
const isMemoryStartupDocEntry = (entry: HistoryEntry) => {
  if (
    entry.role !== "runtimeInternal" ||
    entry.customMessage?.customType !== BOOTSTRAP_STARTUP_DOC_CUSTOM_TYPE
  ) {
    return false;
  }
  const text = customMessageContentText(entry.customMessage!.content);
  return MEMORY_STARTUP_DOC_PATHS.some((displayPath) =>
    text.includes(`<startup_doc path="${displayPath}">`),
  );
};
const createHistoryAssistantMessage = (
  content: AssistantPayload["content"],
  errorMessage?: string,
): AssistantPayload => ({
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
const stringifyPayload = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
const contentPreviewFromTextAndImages = (
  content: Exclude<
    Extract<ThreadPayload, { role: "user" | "toolResult" }>["content"],
    string
  >,
) =>
  content
    .map((block) => {
      if (block.type === "text") return block.text;
      // Image blocks persisted by the runtime may carry the saved file path.
      const { sourcePath } = block as { sourcePath?: string };
      return `[Image receipt: ${block.mimeType}${sourcePath ? ` path=${sourcePath}` : ""}]`;
    })
    .join("\n")
    .trim();
export const buildThreadMessagePreview = (
  payload: ThreadPayload | AgentMessage,
): string => {
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
  const body = contentPreviewFromTextAndImages(
    payload.content as ToolResultPayload["content"],
  );
  return [
    `[Tool result] ${(payload as ToolResultPayload).toolName}`,
    ...(body ? [body] : []),
  ]
    .join("\n")
    .trim();
};
export const persistThreadPayloadMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    payload: ThreadPayload;
    runId?: string;
    attemptGeneration?: number;
    preservePayloadExactly?: boolean;
  },
) => {
  const payload: ThreadPayload =
    args.payload.role === "assistant"
      ? {
          ...args.payload,
          ...(args.runId ? { stellaRunId: args.runId } : {}),
          ...(typeof args.attemptGeneration === "number"
            ? { stellaAttemptGeneration: args.attemptGeneration }
            : {}),
        }
      : args.payload;
  const preview = buildThreadMessagePreview(payload);
  const toolCallId =
    payload.role === "toolResult" ? payload.toolCallId : undefined;
  appendThreadMessage(store, {
    threadKey: args.threadKey,
    role: payload.role,
    content: preview,
    ...(toolCallId ? { toolCallId } : {}),
    payload,
    ...(args.preservePayloadExactly ? { preservePayloadExactly: true } : {}),
  });
};
export const persistThreadCustomMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    /** Required by the store, which rejects a missing one. */
    customType: string | undefined;
    content: Parameters<
      RuntimeStore["appendThreadCustomMessage"]
    >[0]["content"];
    timestamp?: number;
    display?: boolean;
    preservePayloadExactly?: boolean;
    eventId?: string;
    /** Accepted from callers but not written by this path. */
    lifecycleEvent?: unknown;
  },
) => {
  store.appendThreadCustomMessage({
    threadKey: args.threadKey,
    timestamp: args.timestamp ?? now(),
    customType: args.customType!,
    content: args.content,
    display: args.display === true,
    ...(args.preservePayloadExactly ? { preservePayloadExactly: true } : {}),
    ...(args.eventId ? { eventId: args.eventId } : {}),
  });
};
const getPlatformIdentityPrompt = () => {
  if (process.platform === "win32") {
    return "You are running on Windows.";
  }
  if (process.platform === "darwin") {
    return "You are running on macOS.";
  }
  if (process.platform === "linux") {
    return "You are running on Linux.";
  }
  return null;
};
const hasToolGuidance = (
  context: ToolGuidanceContext,
  toolNames: readonly string[],
) => {
  const toolsAllowlist = context.toolsAllowlist;
  if (!Array.isArray(toolsAllowlist) || toolsAllowlist.length === 0) {
    return true;
  }
  return toolNames.some((toolName) => toolsAllowlist.includes(toolName));
};
const hasShellToolGuidance = (context: ToolGuidanceContext) => {
  return hasToolGuidance(context, ["Bash", "exec_command"]);
};
/**
 * Runtime facts about waiting, stated wherever an agent has a shell rather
 * than left to each agent's prompt body.
 *
 * Agents were writing checks the runtime couldn't cash — "I'll report back
 * when the benchmark lands" — and their threads stopped forever; one left a
 * GPU pod idle-billing for hours. There are exactly two ways to wait now
 * and no tool for either: a background `Bash` session wakes the
 * thread when it exits, and everything else is polled inside the turn.
 * Since the covered case is defined by what the tool host can see, the
 * boundary has to be spelled out too.
 */
const buildBackgroundWaitPrompt = (context: ToolGuidanceContext) => {
  if (!hasShellToolGuidance(context)) {
    return null;
  }
  return [
    "Waiting on long work:",
    "- A command still running when `Bash` yields keeps running after your turn ends, and the runtime watches it for you. When it exits you are resumed in this thread, with your history, holding its command, exit code, and output. So you may start a long job, end your turn, and genuinely be woken when it finishes — several exits close together arrive as one wake.",
    "- That covers sessions `Bash` gave you a `session_id` for. It does NOT cover a process you detach from that session (`nohup … &`, `disown`, a daemon that forks away): the session exits immediately and the thing you actually care about is invisible to the runtime. Run long work in the foreground of its own session and let it hold the session open.",
    "- For anything else you need to wait on — a file appearing, a remote job flipping to done, an endpoint going healthy — poll inside the current turn. `write_stdin` with empty `chars` blocks on a session until it prints or exits, up to 5 minutes per call; a foreground `sleep N && check` loop works for the rest. There is no tool that wakes you later, so a wait you do not either background as a session or finish in-turn is a wait nobody is keeping.",
    "- Never claim you'll report back on something outside those two paths. If a wait is genuinely unattended, say so plainly and hand over the exact command to check it.",
  ].join("\n");
};
const buildFileEditingPrompt = (context: ToolGuidanceContext) => {
  const explicitlyHasWriteEdit =
    Array.isArray(context.toolsAllowlist) &&
    context.toolsAllowlist.length > 0 &&
    (context.toolsAllowlist.includes("Write") ||
      context.toolsAllowlist.includes("Edit"));
  if (explicitlyHasWriteEdit) {
    return [
      "File edits:",
      "- Use `Write` for new files or full-file replacements.",
      "- Use `Edit` for targeted text replacements inside existing files.",
      "- Use `Bash` for read-only inspection, builds/tests, package-manager commands, and commands that create external artifacts.",
      "- Do not use shell heredocs or `cat > file` for source edits when `Write` or `Edit` can express the change.",
    ].join("\n");
  }
  if (!hasToolGuidance(context, ["apply_patch"])) {
    return null;
  }
  return [
    "File edits:",
    "- Prefer `apply_patch` for source and text-file edits so changes are tracked as structured patches.",
    "- Use `Bash` for read-only inspection, builds/tests, package-manager commands, and commands that create external artifacts.",
    "- Do not use shell heredocs or `cat > file` for source edits when `apply_patch` can express the change.",
  ].join("\n");
};
/** The system prompt as named sections, in order. */
export const buildSystemPromptSections = (
  context: ToolGuidanceContext & {
    systemPrompt: string;
    dynamicContextSections?: readonly SystemPromptSection[];
  },
): SystemPromptSection[] => {
  const sections: SystemPromptSection[] = [
    { id: "instructions", text: context.systemPrompt.trim() },
    ...(context.dynamicContextSections ?? []),
  ];
  const fileEditingPrompt = buildFileEditingPrompt(context);
  if (fileEditingPrompt) {
    sections.push({ id: "file-edits", text: fileEditingPrompt });
  }
  const platformIdentityPrompt = getPlatformIdentityPrompt();
  if (platformIdentityPrompt && hasShellToolGuidance(context)) {
    sections.push({ id: "platform", text: platformIdentityPrompt });
  }
  const backgroundWaitPrompt = buildBackgroundWaitPrompt(context);
  if (backgroundWaitPrompt) {
    sections.push({ id: "background-wait", text: backgroundWaitPrompt });
  }
  return sections.filter((section) => section.text);
};
/**
 * Resident-block delta step. All resident context blocks (personality,
 * core memory, user profile, skill catalog) live in the
 * ResidentBlock registry (`resident-context.js`), which owns rendering,
 * byte-exact dedup against the persisted thread, and the compaction
 * fold-in. This wrapper keeps the historical call sites stable.
 */
export const buildStartupPromptMessages = async (args: {
  context: ResidentContext;
  stellaDataDir?: string;
  stellaAppDir?: string;
}) => buildResidentContextMessages(args.context);
const fanOutBeforeUserMessage = async (args: {
  hookContext: PromptBuildHookContext;
  agentType: string;
  userPrompt: string;
  staleUserReminderText?: string;
  connectorTransitionReminderText?: string;
}) => {
  const empty: {
    prepend: RuntimePromptMessage[];
    append: RuntimePromptMessage[];
  } = { prepend: [], append: [] };
  const { hookEmitter } = args.hookContext;
  if (!hookEmitter) return empty;
  const results = await hookEmitter.emitAll(
    "before_user_message",
    {
      agentType: args.agentType,
      userPrompt: args.userPrompt,
      ...(args.staleUserReminderText !== undefined
        ? { staleUserReminderText: args.staleUserReminderText }
        : {}),
      ...(args.connectorTransitionReminderText !== undefined
        ? {
            connectorTransitionReminderText:
              args.connectorTransitionReminderText,
          }
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
    },
    { agentType: args.agentType },
  );
  const prepend: RuntimePromptMessage[] = [];
  const append: RuntimePromptMessage[] = [];
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
export const buildSubagentPromptMessages = async (
  args: PromptBuildArgs,
): Promise<RuntimePromptMessage[]> => {
  const trimmedUserPrompt = args.userPrompt.trim();
  const messages: RuntimePromptMessage[] = [];
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
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
    messages.push(...append);
  } else {
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
  }
  if (args.promptMessages?.length) {
    messages.push(...args.promptMessages);
  }
  if (trimmedUserPrompt.length > 0 || messages.length === 0) {
    messages.push({ text: args.userPrompt });
  }
  return messages;
};
export const buildOrchestratorPromptMessages = async (
  args: PromptBuildArgs,
): Promise<RuntimePromptMessage[]> => {
  const trimmedUserPrompt = args.userPrompt.trim();
  const messages: RuntimePromptMessage[] = [];
  // Stale-user reminders used to be inline branches here; they now live as `before_user_message` hooks in
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
      ...(args.context.connectorTransitionReminderText !== undefined
        ? {
            connectorTransitionReminderText:
              args.context.connectorTransitionReminderText,
          }
        : {}),
    });
    messages.push(...prepend);
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
    messages.push(...append);
  } else {
    messages.push(
      ...(await buildStartupPromptMessages({
        context: args.context,
        stellaDataDir: args.stellaDataDir,
        stellaAppDir: args.stellaAppDir,
      })),
    );
  }
  if (args.promptMessages?.length) {
    messages.push(...args.promptMessages);
  }
  if (trimmedUserPrompt.length > 0 || messages.length === 0) {
    messages.push({ text: args.userPrompt });
  }
  return messages;
};
export const appendThreadMessage = (
  store: RuntimeStore,
  args: {
    threadKey: string;
    role: RuntimeThreadMessage["role"];
    content: string;
    toolCallId?: string;
    payload?: ThreadPayload;
    preservePayloadExactly?: boolean;
  },
) => {
  store.appendThreadMessage({
    timestamp: now(),
    threadKey: args.threadKey,
    role: args.role,
    content: args.content,
    ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    ...(args.payload ? { payload: args.payload } : {}),
    ...(args.preservePayloadExactly ? { preservePayloadExactly: true } : {}),
  });
};
// Retries live where the failures are: summary generation has its own
// backoff schedule and the overlay write retries a busy SQLite inside
// `maybeCompactRuntimeThread`. This wrapper only converts a residual
// store-level throw into a logged `compacted: false`.
export const compactRuntimeThreadHistory = async (
  args: CompactThreadArgs,
): Promise<ThreadCompactionResult | { compacted: false }> => {
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
      ...(args.readAgentRoster
        ? { readAgentRoster: args.readAgentRoster }
        : {}),
    });
  } catch (error) {
    logger.warn("thread.compaction.failed", {
      threadKey: args.threadKey,
      agentType: args.agentType,
      error: error instanceof Error ? error.message : String(error),
    });
    return { compacted: false };
  }
};
export const persistAssistantReply = async (
  args: CompactThreadArgs & {
    content: string;
    runId?: string;
    attemptGeneration?: number;
  },
) => {
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
