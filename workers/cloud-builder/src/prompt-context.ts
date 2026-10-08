import type {
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { RuntimePromptMessage } from "@stella/contracts/protocol";
import {
  advanceFrozenContext,
  freezeContext,
  frozenProviderTools,
  type FrozenContext,
  type SystemPromptSection,
} from "@stella/runtime/kernel/agent-runtime/frozen-context.js";
import { checkpointMessages } from "@stella/runtime/kernel/agent-runtime/orchestrator-compaction.js";
import {
  buildResidentContextMessages,
  residentIdentityForCustomMessage,
  type ResidentContext,
} from "@stella/runtime/kernel/agent-runtime/resident-context.js";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import type { ContextCheckpoint } from "./context-compaction.js";
import { WORLD_ROOT } from "./workspace.js";

export const PROMPT_CONTEXT_KEY = "cloudPromptContext:v2";

/** A hidden context message the model reads before a user message. */
export type ResidentPrompt = { customType: string; text: string };

/**
 * One frozen provider context: what the model was given at the last boundary
 * (thread start, compaction, a memory policy change). Between boundaries the
 * provider receives these bytes unchanged and every change is appended.
 */
export type PromptContext = {
  version: 2;
  epoch: string;
  journalEpoch: number;
  ownerGeneration: string;
  memoryEpoch: string;
  memoryEnabled: boolean;
  /** The system prompt and tool definitions, frozen; see `frozen-context.ts`. */
  frozen: FrozenContext;
  /** The resident blocks pinned at the head of this context. */
  head: ResidentPrompt[];
  startSeq: number;
};

export const reusablePromptContext = (args: {
  storedContext?: PromptContext;
  journalEpoch: number;
  ownerGeneration: string;
}): PromptContext | undefined =>
  args.storedContext?.journalEpoch === args.journalEpoch &&
  args.storedContext.ownerGeneration === args.ownerGeneration
    ? args.storedContext
    : undefined;

export const promptContextHistoryStartAfterSeq = (args: {
  previousContext?: PromptContext;
  previousCheckpoint?: ContextCheckpoint;
}): number =>
  args.previousCheckpoint?.coveredThroughSeq ??
  Math.max(-1, (args.previousContext?.startSeq ?? 0) - 1);

export const promptContextCheckpointChanged = (args: {
  storedContext?: PromptContext;
  previousContext?: PromptContext;
  storedCheckpoint?: ContextCheckpoint;
  nextCheckpoint?: ContextCheckpoint;
}): boolean =>
  args.nextCheckpoint
    ? args.storedCheckpoint?.coveredThroughSeq !==
        args.nextCheckpoint.coveredThroughSeq ||
      args.storedCheckpoint?.summary !== args.nextCheckpoint.summary
    : Boolean(args.storedCheckpoint) ||
      args.storedContext !== args.previousContext;

const residentPrompt = (message: RuntimePromptMessage): ResidentPrompt => ({
  customType: message.customType ?? "",
  text: message.text,
});

const residentHistoryEntry = (prompt: ResidentPrompt) => ({
  role: "runtimeInternal",
  customMessage: { customType: prompt.customType, content: prompt.text },
});

/**
 * This turn's frozen context and what to append before its user message,
 * through the same resident registry and frozen-context policy as a desktop
 * thread: at a boundary everything is rendered fresh and frozen; otherwise
 * only what changed since the model last saw it is appended.
 */
export const preparePromptContext = (args: {
  previous?: PromptContext;
  policy: MemoryPolicy;
  sections: SystemPromptSection[];
  tools: AgentTool[];
  /** Fresh resident values for this turn. */
  resident: Omit<ResidentContext, "threadHistory">;
  /** The resident prompts this context already appended (its rows' prepends). */
  sent: readonly ResidentPrompt[];
  startSeq: number;
  journalEpoch: number;
}) => {
  const { previous, policy } = args;
  const boundary = !previous || crossesContextBoundary(previous, args);
  let state: PromptContext;
  const prepend: ResidentPrompt[] = [];
  if (boundary) {
    state = {
      version: 2,
      epoch: crypto.randomUUID(),
      journalEpoch: args.journalEpoch,
      ownerGeneration: policy.ownerGeneration,
      memoryEpoch: policy.memoryEpoch,
      memoryEnabled: policy.memoryEnabled,
      frozen: freezeContext(args.sections, args.tools),
      head: buildResidentContextMessages(args.resident).map(residentPrompt),
      startSeq: args.startSeq,
    };
  } else {
    const resident = buildResidentContextMessages({
      ...args.resident,
      threadHistory: [...previous.head, ...args.sent].map(residentHistoryEntry),
    });
    const advanced = advanceFrozenContext(
      previous.frozen,
      args.sections,
      args.tools,
    );
    state =
      advanced.frozen === previous.frozen
        ? previous
        : { ...previous, frozen: advanced.frozen };
    prepend.push(...[...resident, ...advanced.deltas].map(residentPrompt));
  }
  return {
    state,
    tools: providerTools(state, args.tools),
    prepend,
    boundary,
  };
};

/**
 * The request a lost isolate was sending, rebuilt for a resumed turn: the
 * stored frozen context, bound to this turn's tool implementations. Throws
 * across a boundary, whose frozen context may carry context that must not be
 * sent again.
 */
export const resumePromptContext = (args: {
  previous: PromptContext;
  policy: MemoryPolicy;
  tools: AgentTool[];
  startSeq: number;
  journalEpoch: number;
}): { state: PromptContext; tools: AgentTool[] } | null =>
  crossesContextBoundary(args.previous, args)
    ? null
    : { state: args.previous, tools: providerTools(args.previous, args.tools) };

/**
 * A shortened history already breaks the cache. Privacy changes must never
 * retain a frozen context that contains newly disabled or erased memory.
 */
const crossesContextBoundary = (
  previous: PromptContext,
  args: { policy: MemoryPolicy; startSeq: number; journalEpoch: number },
): boolean =>
  previous.journalEpoch !== args.journalEpoch ||
  previous.startSeq !== args.startSeq ||
  previous.ownerGeneration !== args.policy.ownerGeneration ||
  previous.memoryEpoch !== args.policy.memoryEpoch ||
  previous.memoryEnabled !== args.policy.memoryEnabled;

const providerTools = (
  context: PromptContext,
  liveTools: AgentTool[],
): AgentTool[] =>
  frozenProviderTools(
    context.frozen,
    liveTools,
    (snapshot, text): AgentTool => ({
      name: snapshot.name,
      label: snapshot.name,
      description: snapshot.description,
      parameters: snapshot.parameters as AgentTool["parameters"],
      execute: async () => ({
        content: [{ type: "text", text }],
        details: { unavailable: true },
      }),
    }),
  );

/** The resident prompts a context's rows already appended. */
export const sentResidentPrompts = (
  messages: readonly AgentMessage[],
  epoch: string,
): ResidentPrompt[] =>
  messages.flatMap((message) => {
    const metadata =
      message.role === "user" ? providerContextMetadata(message) : undefined;
    return metadata?.epoch === epoch ? metadata.prepend : [];
  });

type ProviderContextMetadata = {
  version: 2;
  epoch: string;
  prepend: ResidentPrompt[];
  clock: string;
  attachments?: string[];
};
const providerContextMetadata = (
  value: unknown,
): ProviderContextMetadata | undefined => {
  if (!value || typeof value !== "object" || !("providerContext" in value))
    return;
  const context = value.providerContext;
  if (
    !context ||
    typeof context !== "object" ||
    !("version" in context) ||
    (context.version !== 1 && context.version !== 2) ||
    !("epoch" in context) ||
    typeof context.epoch !== "string" ||
    !("clock" in context) ||
    typeof context.clock !== "string" ||
    !("prepend" in context) ||
    !Array.isArray(context.prepend)
  )
    return;
  // A version 1 row predates resident prompts; its epoch never matches a
  // version 2 context, so only its clock and attachments still render.
  const prepend =
    context.version === 2
      ? context.prepend.filter(
          (entry): entry is ResidentPrompt =>
            !!entry &&
            typeof entry === "object" &&
            typeof entry.customType === "string" &&
            typeof entry.text === "string",
        )
      : [];
  return {
    version: 2,
    epoch: context.epoch,
    clock: context.clock,
    prepend,
    ...("attachments" in context &&
    Array.isArray(context.attachments) &&
    context.attachments.every((path): path is string => typeof path === "string")
      ? { attachments: context.attachments }
      : {}),
  };
};

/**
 * The attachment note on a cloud user message, for both cloud engines.
 * Two names for one file, each true where it is used: the drive path is the
 * file's stable name, and `readableAt` is what Read takes in a session that
 * has the world on disk (the Claude Code orchestrator session does not). An
 * agent started on one of the user's computers receives the attachments as
 * real files there, so it needs no path.
 */
export const attachedFilesText = (
  attachments: readonly string[],
  options: { readableHere: boolean },
): string =>
  [
    "<attached-files>",
    "The user attached these exact files to this message. Do not substitute other files found by searching the Drive.",
    JSON.stringify(
      attachments.map((path) =>
        options.readableHere
          ? { drivePath: path, readableAt: `${WORLD_ROOT}/drive/${path}` }
          : { drivePath: path },
      ),
    ),
    options.readableHere
      ? "Use Read on `readableAt` to open one here. An agent you start on one of the user's computers is given these same attachments as files on that computer, so it needs no path from you; `readableAt` is valid only in this session."
      : "An agent you start is given these same attachments as files, so it needs no path from you.",
    "</attached-files>",
  ].join("\n");

/** Canonical UI text stays plain; provider-only metadata replays byte-for-byte. */
export const materializeProviderContext = (
  messages: AgentMessage[],
  epoch: string,
): AgentMessage[] =>
  messages.flatMap((message) => {
    const metadata =
      message.role === "user" ? providerContextMetadata(message) : undefined;
    if (!metadata || message.role !== "user") return [message];
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    return [
      ...(metadata.epoch === epoch ? metadata.prepend : []).map(
        (prompt): AgentMessage => ({
          role: "user",
          content: [{ type: "text", text: prompt.text }],
          timestamp: message.timestamp,
        }),
      ),
      {
        role: "user" as const,
        timestamp: message.timestamp,
        content: [
          {
            type: "text" as const,
            text: `<current-time>${metadata.clock}</current-time>`,
          },
          ...content,
          ...(metadata.attachments?.length
            ? [
                {
                  type: "text" as const,
                  text: attachedFilesText(metadata.attachments, {
                    readableHere: true,
                  }),
                },
              ]
            : []),
        ],
      },
    ];
  });

/**
 * The provider history for a context, laid out like a desktop thread: the
 * pinned resident head, the checkpoint and pinned instruction when the
 * conversation was compacted, then the window's messages with the hidden
 * context each of them carries.
 */
export const providerHistory = (args: {
  context: PromptContext;
  checkpoint?: ContextCheckpoint;
  messages: AgentMessage[];
}): AgentMessage[] => [
  ...args.context.head.map(
    (prompt): AgentMessage => ({
      role: "user",
      content: [{ type: "text", text: prompt.text }],
      timestamp: 0,
    }),
  ),
  ...(args.checkpoint
    ? checkpointMessages({
        summary: args.checkpoint.summary,
        pinnedInstruction: args.checkpoint.pinnedInstruction,
        timestamp: 0,
      })
    : []),
  ...materializeProviderContext(args.messages, args.context.epoch),
];

/**
 * Resident prompts for an engine that keeps its own session (Claude Code):
 * what to send before this turn's message, and what that session will have
 * seen once it takes the turn. A fresh session (`seen` empty) gets the whole
 * head; a continuing one only what changed, as on a desktop thread.
 */
export const sessionResidentPrompts = (args: {
  resident: Omit<ResidentContext, "threadHistory">;
  seen: readonly ResidentPrompt[];
}): { prompts: ResidentPrompt[]; seen: ResidentPrompt[] } => {
  const prompts = buildResidentContextMessages({
    ...args.resident,
    threadHistory: args.seen.map(residentHistoryEntry),
  }).map(residentPrompt);
  const latest = new Map<string, ResidentPrompt>();
  for (const prompt of [...args.seen, ...prompts]) {
    const identity = residentIdentityForCustomMessage({
      customType: prompt.customType,
      content: prompt.text,
    });
    if (identity) latest.set(identity, prompt);
  }
  return { prompts, seen: [...latest.values()] };
};
