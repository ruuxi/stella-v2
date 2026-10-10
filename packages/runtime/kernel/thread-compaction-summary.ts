import fs from "node:fs";
import path from "node:path";
import { completeSimple, readAssistantText } from "../ai/stream.js";
import { sleepMs } from "../ai/effect-runtime.js";
import { ORCHESTRATOR_ROSTER_CUSTOM_TYPE } from "./storage/shared.js";
import type { ResolvedLlmRoute } from "./model-routing.js";
import { createRuntimeLogger } from "./debug.js";
import { redactMemoryText } from "./memory/redaction.js";
import { readRuntimePrompt } from "./prompts/home-prompts.js";
import { CONTEXT_DELTA_CUSTOM_TYPE_PREFIX } from "./agent-runtime/resident-context.js";
import { QUARANTINE_CUSTOM_TYPE } from "./agent-runtime/provider-abort-containment.js";
import { loadLocalPreferences } from "./preferences/local-preferences.js";
import {
  SUMMARY_RETRY_DELAYS_MS,
  buildOrchestratorSummaryPrompt,
  capSummaryConversation,
  contextWindowTokens,
  durableMemoryReference,
  ellipsize,
  summaryInputCharBudget,
  summaryLinesForPayload,
  summaryMaxTokens,
  summaryOverheadChars,
  summaryTargetTokens,
  truncateForSummary,
} from "./agent-runtime/orchestrator-compaction.js";
import {
  getThreadTokenEstimate,
  type StoredThreadMessage,
  type ThreadCompactionSplitPolicy,
  type ThreadMessage,
} from "./thread-compaction-plan.js";

/**
 * Checkpoint summary generation: the summarizer prompts, the transcript
 * rendering they read, and the retrying model call.
 */

const logger = createRuntimeLogger("thread-runtime");

export const resolveThreadCompactionSystemPrompt = (): string =>
  readRuntimePrompt("thread-compaction") ?? "";

const stringifyMessage = (message: ThreadMessage): string => {
  const content = message.content.trim();
  if (!content) {
    return "";
  }
  if (message.role === "user") {
    return `[User] ${ellipsize(content)}`;
  }
  if (message.role === "runtimeInternal") {
    return `[Runtime] ${ellipsize(content)}`;
  }
  return `[Assistant] ${ellipsize(content)}`;
};

const stringifyStoredMessage = (message: StoredThreadMessage): string[] => {
  if (message.customMessage?.customType === QUARANTINE_CUSTOM_TYPE) {
    return [];
  }
  if (message.payload) {
    return summaryLinesForPayload(message.payload);
  }
  if (message.role === "toolResult") {
    const content = message.content.trim();
    return content
      ? [`[Tool result] ${truncateForSummary(content, 2_000)}`]
      : [];
  }
  return [stringifyMessage(message as ThreadMessage)].filter(
    (entry) => entry.length > 0,
  );
};

const formatThreadMessagesForCompaction = (
  messages: StoredThreadMessage[],
): string =>
  messages
    .filter((message) => {
      const customType = message.customMessage?.customType;
      return (
        !customType?.startsWith("bootstrap.") &&
        !customType?.startsWith(CONTEXT_DELTA_CUSTOM_TYPE_PREFIX) &&
        customType !== ORCHESTRATOR_ROSTER_CUSTOM_TYPE
      );
    })
    .flatMap((message) => stringifyStoredMessage(message))
    .filter((entry) => entry.length > 0)
    .join("\n\n");

const extractFilePathFromToolArgs = (
  args: Record<string, unknown> | undefined,
): string | undefined => {
  if (!args) {
    return undefined;
  }
  for (const key of ["file_path", "path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const extractFileOpsFromStoredMessage = (
  message: StoredThreadMessage,
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> },
): void => {
  if (message.role !== "assistant" || message.payload?.role !== "assistant") {
    return;
  }
  for (const block of message.payload.content) {
    if (block.type !== "toolCall") {
      continue;
    }
    const pathArg = extractFilePathFromToolArgs(
      (block.arguments ?? {}) as Record<string, unknown>,
    );
    if (!pathArg) {
      continue;
    }
    const name = block.name.toLowerCase();
    if (name === "read") {
      fileOps.read.add(pathArg);
    } else if (name === "write") {
      fileOps.written.add(pathArg);
    } else if (name === "edit") {
      fileOps.edited.add(pathArg);
    }
  }
};

export const collectFileOperations = (
  messages: StoredThreadMessage[],
): { readFiles: string[]; modifiedFiles: string[] } => {
  const fileOps = {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
  for (const message of messages) {
    extractFileOpsFromStoredMessage(message, fileOps);
  }
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
};

export const formatFileOperationsForSummary = (
  readFiles: string[],
  modifiedFiles: string[],
): string => {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
};

const computeSummaryBudget = (
  messages: StoredThreadMessage[],
  maxTokens: number,
): number => summaryTargetTokens(getThreadTokenEstimate(messages), maxTokens);

let summaryRetryDelaysMs: readonly number[] = SUMMARY_RETRY_DELAYS_MS;

/** Test seam: shorten (or restore) the summary retry backoff. */
export const setThreadSummaryRetryDelaysForTest = (
  delays?: readonly number[],
): void => {
  summaryRetryDelaysMs = delays ?? SUMMARY_RETRY_DELAYS_MS;
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? sleepMs(ms) : Promise.resolve();

const GENERAL_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const GENERAL_SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve exact \`thread_id\` values from spawn_agent / send_message / check-status tool calls so follow-ups can resume existing threads.`;

const GENERAL_UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.
Preserve exact \`thread_id\` values from spawn_agent / send_message / check-status tool calls so follow-ups can resume existing threads.`;

// Conversation content and instructions are separate sections, and the task
// is framed as a continuation checkpoint: Claude Fable refused the earlier
// "PREFIX / SUFFIX of a turn" wording (pi-mono d192bd6dc).
const GENERAL_TURN_PREFIX_SUMMARIZATION_PROMPT = `The messages above are earlier context from an ongoing conversation. Later messages are stored separately and do not need to be reconstructed.

Create a concise checkpoint of the user's request and the progress shown above. This checkpoint will be placed before the later messages so the conversation can continue with the necessary context.

## Original Request
[What did the user ask for?]

## Progress So Far
- [Key decisions and work completed in these messages]

## Context Needed to Continue
- [Information from these messages needed to understand the later work]

Only summarize information explicitly present above. Do not infer or recreate later messages.`;

export const buildGeneralSummaryPrompt = (
  formattedConversation: string,
  previousSummary?: string,
): string => {
  const basePrompt = previousSummary
    ? GENERAL_UPDATE_SUMMARIZATION_PROMPT
    : GENERAL_SUMMARIZATION_PROMPT;
  let promptText = `<conversation>\n${formattedConversation}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  return `${promptText}${basePrompt}`;
};

export const buildGeneralTurnPrefixPrompt = (
  formattedConversation: string,
): string =>
  `# Conversation\n${formattedConversation}\n\n# Instructions\n${GENERAL_TURN_PREFIX_SUMMARIZATION_PROMPT}`;

// Per-doc cap for the ALREADY KNOWN reference. The docs are small
// always-loaded files; the cap only guards against a runaway doc inflating
// the compaction request.
/**
 * The "already known — do not repeat" reference for the summarizer, from the
 * always-loaded user profile.
 */
export const buildDurableMemoryReference = (
  stellaDataDir: string | undefined,
): string | undefined => {
  if (!stellaDataDir?.trim()) {
    return undefined;
  }
  if (loadLocalPreferences(stellaDataDir).memoryEnabled === false) {
    return undefined;
  }
  try {
    const content = fs
      .readFileSync(path.join(stellaDataDir, "memories", "profile.md"), "utf-8")
      .trim();
    return durableMemoryReference(content ? redactMemoryText(content) : "");
  } catch {
    return undefined;
  }
};

export const generateThreadSummary = async (args: {
  threadKey: string;
  messages: StoredThreadMessage[];
  previousSummary?: string;
  resolvedLlm: ResolvedLlmRoute;
  durableMemoryReference?: string;
  policy?: ThreadCompactionSplitPolicy;
  promptKind?: "history" | "turnPrefix";
}): Promise<{ text: string | null; reason?: string }> => {
  const policy = args.policy ?? "orchestrator";
  const systemPrompt =
    policy === "general"
      ? GENERAL_SUMMARIZATION_SYSTEM_PROMPT
      : resolveThreadCompactionSystemPrompt();
  const previousSummary = args.previousSummary?.trim();
  const overheadChars = summaryOverheadChars({
    systemPromptChars: systemPrompt.length,
    previousSummary,
    durableMemoryReference:
      policy === "general" ? undefined : args.durableMemoryReference,
  });
  const formattedConversation = capSummaryConversation(
    formatThreadMessagesForCompaction(args.messages).trim(),
    summaryInputCharBudget(
      contextWindowTokens(args.resolvedLlm.model.contextWindow),
      overheadChars,
    ),
  );
  if (!formattedConversation) {
    return {
      text: previousSummary || null,
      ...(!previousSummary ? { reason: "empty formatted conversation" } : {}),
    };
  }

  const maxTokens = summaryMaxTokens(
    args.resolvedLlm.model.maxTokens,
    args.promptKind ?? "history",
  );
  const promptBody =
    policy === "general"
      ? args.promptKind === "turnPrefix"
        ? buildGeneralTurnPrefixPrompt(formattedConversation)
        : buildGeneralSummaryPrompt(formattedConversation, previousSummary)
      : buildOrchestratorSummaryPrompt({
          formattedConversation,
          previousSummary,
          targetTokens: computeSummaryBudget(args.messages, maxTokens),
          durableMemoryReference: args.durableMemoryReference,
        });

  // Every failure mode is treated as transient and retried with backoff:
  // provider errors (429/overloaded/network/400), thrown transport errors,
  // and a missing credential (the key is re-resolved per attempt so an
  // OAuth-refresh blip recovers). Only after the full schedule is exhausted
  // does compaction report failure.
  let reason = "summary generation failed";
  for (let attempt = 0; attempt <= summaryRetryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(summaryRetryDelaysMs[attempt - 1]!);
    }
    try {
      const apiKey = (await args.resolvedLlm.getApiKey())?.trim();
      if (!apiKey) {
        reason = "no API key";
        logger.warn("thread.compaction.summary-attempt-failed", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          attempt: attempt + 1,
          reason,
        });
        continue;
      }
      const message = await completeSimple(
        args.resolvedLlm.model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: promptBody }],
              timestamp: Date.now(),
            },
          ],
        },
        // A summary prompt is never replayed, so writing it to the prompt
        // cache only pays the write premium (pi-mono 9b3a20591). No
        // sessionId either: an absent id keeps this one-off request off the
        // live session's routing affinity and Codex socket, which is the
        // isolation a fresh per-summary id buys in pi-mono.
        {
          apiKey,
          maxTokens,
          cacheRetention: "none",
        },
      );
      const text = readAssistantText(message);
      if (message.stopReason !== "stop") {
        reason = `unclean terminal reason ${String(message.stopReason)}`;
        logger.warn("thread.compaction.summary-attempt-failed", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          attempt: attempt + 1,
          reason,
          errorMessage: message.errorMessage,
          partialChars: text.length,
        });
        continue;
      }
      if (!text) {
        reason = "empty output";
        logger.warn("thread.compaction.summary-attempt-failed", {
          threadKey: args.threadKey,
          model: args.resolvedLlm.model.id,
          attempt: attempt + 1,
          reason,
        });
        continue;
      }
      return { text };
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      logger.warn("thread.compaction.summary-attempt-failed", {
        threadKey: args.threadKey,
        model: args.resolvedLlm.model.id,
        attempt: attempt + 1,
        reason,
      });
    }
  }
  return { text: null, reason };
};

export const generateThreadSummaryWithoutElision = async (args: {
  threadKey: string;
  messages: StoredThreadMessage[];
  resolvedLlm: ResolvedLlmRoute;
  durableMemoryReference?: string;
  policy?: ThreadCompactionSplitPolicy;
}): Promise<{ text: string | null; reason?: string }> => {
  const policy = args.policy ?? "orchestrator";
  const systemPrompt =
    policy === "general"
      ? GENERAL_SUMMARIZATION_SYSTEM_PROMPT
      : resolveThreadCompactionSystemPrompt();
  let previousSummary: string | undefined;
  let offset = 0;

  while (offset < args.messages.length) {
    const maxChars = summaryInputCharBudget(
      contextWindowTokens(args.resolvedLlm.model.contextWindow),
      summaryOverheadChars({
        systemPromptChars: systemPrompt.length,
        previousSummary,
        durableMemoryReference:
          policy === "general" ? undefined : args.durableMemoryReference,
      }),
    );
    let end = offset;
    while (end < args.messages.length) {
      const candidate = formatThreadMessagesForCompaction(
        args.messages.slice(offset, end + 1),
      ).trim();
      if (candidate.length > maxChars) {
        break;
      }
      end += 1;
    }
    if (end === offset) {
      return {
        text: null,
        reason: "one compaction message exceeds the summary input budget",
      };
    }

    const generated = await generateThreadSummary({
      ...args,
      messages: args.messages.slice(offset, end),
      previousSummary,
    });
    if (!generated.text) {
      return generated;
    }
    previousSummary = generated.text;
    offset = end;
  }

  return {
    text: previousSummary ?? null,
    ...(!previousSummary ? { reason: "empty formatted conversation" } : {}),
  };
};
