import type {
  AgentMessage,
  AgentTool,
} from "@stella/runtime/kernel/agent-core/types.js";
import type { MemoryPolicy } from "@stella/contracts/turn-plane/memory-policy";
import type { ContextCheckpoint } from "./context-compaction.js";

export const PROMPT_CONTEXT_KEY = "cloudPromptContext:v1";
type ToolSnapshot = Pick<AgentTool, "name" | "description" | "parameters">;
export type PromptContext = {
  version: 1;
  epoch: string;
  journalEpoch: number;
  ownerGeneration: string;
  memoryEpoch: string;
  memoryEnabled: boolean;
  systemPrompt: string;
  tools: ToolSnapshot[];
  latestSystemPrompt: string;
  latestTools: string;
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

const snapshotTools = (tools: AgentTool[]): ToolSnapshot[] =>
  tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters: structuredClone(parameters),
  }));

/** Freeze provider descriptors, while every executable closure belongs to this turn. */
export const preparePromptContext = (args: {
  previous?: PromptContext;
  policy: MemoryPolicy;
  systemPrompt: string;
  tools: AgentTool[];
  startSeq: number;
  journalEpoch: number;
}) => {
  const { previous, policy } = args;
  const liveDescriptors = snapshotTools(args.tools);
  const signature = JSON.stringify(liveDescriptors);
  // A shortened history already breaks the cache. Privacy changes must never
  // retain a frozen prompt that contains newly disabled or erased memory.
  const boundary =
    !previous ||
    previous.journalEpoch !== args.journalEpoch ||
    previous.startSeq !== args.startSeq ||
    previous.ownerGeneration !== policy.ownerGeneration ||
    previous.memoryEpoch !== policy.memoryEpoch ||
    previous.memoryEnabled !== policy.memoryEnabled;
  let state: PromptContext;
  if (boundary) {
    state = {
      version: 1,
      epoch: crypto.randomUUID(),
      journalEpoch: args.journalEpoch,
      ownerGeneration: policy.ownerGeneration,
      memoryEpoch: policy.memoryEpoch,
      memoryEnabled: policy.memoryEnabled,
      systemPrompt: args.systemPrompt,
      tools: liveDescriptors,
      latestSystemPrompt: args.systemPrompt,
      latestTools: signature,
      startSeq: args.startSeq,
    };
  } else if (
    previous.latestSystemPrompt === args.systemPrompt &&
    previous.latestTools === signature
  ) {
    state = previous;
  } else {
    state = {
      ...previous,
      latestSystemPrompt: args.systemPrompt,
      latestTools: signature,
    };
  }
  const deltas: string[] = [];
  if (!boundary && previous.latestSystemPrompt !== args.systemPrompt) {
    deltas.push(
      `<system-reminder>Stella's current context has changed. Use this updated context for subsequent work. Earlier context remains in the transcript for continuity.\n${args.systemPrompt}\n</system-reminder>`,
    );
  }
  if (!boundary && previous.latestTools !== signature) {
    deltas.push(
      `<system-reminder>Tool availability or definitions changed. Existing provider tool definitions stay fixed until context compaction. Removed tools are unavailable; newly added tools become visible after compaction. Current definitions:\n${signature}\n</system-reminder>`,
    );
  }
  const live = new Map(args.tools.map((tool) => [tool.name, tool]));
  const tools: AgentTool[] = state.tools.map((snapshot) => {
    const current = live.get(snapshot.name);
    return current
      ? { ...current, ...snapshot }
      : {
          ...snapshot,
          label: snapshot.name,
          execute: async () => ({
            content: [
              {
                type: "text",
                text: "This tool is no longer available. Wait for context compaction or use another available tool.",
              },
            ],
            details: { unavailable: true },
          }),
        };
  });
  return { state, tools, deltas, boundary };
};

type ProviderContextMetadata = {
  version: 1;
  epoch: string;
  prepend: string[];
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
    context.version !== 1 ||
    !("epoch" in context) ||
    typeof context.epoch !== "string" ||
    !("clock" in context) ||
    typeof context.clock !== "string" ||
    !("prepend" in context) ||
    !Array.isArray(context.prepend) ||
    !context.prepend.every((text): text is string => typeof text === "string")
  )
    return;
  return {
    version: 1,
    epoch: context.epoch,
    clock: context.clock,
    prepend: context.prepend,
    ...("attachments" in context &&
    Array.isArray(context.attachments) &&
    context.attachments.every((path): path is string => typeof path === "string")
      ? { attachments: context.attachments }
      : {}),
  };
};

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
        (text): AgentMessage => ({
          role: "user",
          content: [{ type: "text", text }],
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
            ? [{
                type: "text" as const,
                text: `<attached-drive-files>\nThe user attached these exact Drive paths to this message. Read these files, and pass these paths to any agent handling the attachments. Do not substitute other files found by searching the Drive.\n${JSON.stringify(metadata.attachments)}\n</attached-drive-files>`,
              }]
            : []),
        ],
      },
    ];
  });
