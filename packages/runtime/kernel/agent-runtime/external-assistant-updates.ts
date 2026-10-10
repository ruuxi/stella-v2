import { now } from "./shared.js";
import { persistThreadPayloadMessage } from "./thread-memory.js";
import type { RuntimeStore } from "../storage/runtime-store.js";

type ExternalAssistantUpdateArgs = {
  store: RuntimeStore;
  threadKey: string;
  engine: string;
  runId?: string;
  attemptGeneration?: number;
};

const EMPTY_USAGE = {
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
};

const persistAssistantUpdate = (
  args: ExternalAssistantUpdateArgs,
  preamble: string,
) => {
  const text = preamble.trim();
  if (!text) return;
  const claude = args.engine === "claude_code";
  persistThreadPayloadMessage(args.store, {
    threadKey: args.threadKey,
    ...(args.runId ? { runId: args.runId } : {}),
    ...(typeof args.attemptGeneration === "number"
      ? { attemptGeneration: args.attemptGeneration }
      : {}),
    payload: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: claude ? "anthropic-messages" : "chatgpt-responses",
      provider: claude ? "anthropic" : "chatgpt",
      model: claude ? "claude-code" : "codex",
      usage: EMPTY_USAGE,
      stopReason: "toolUse" as const,
      timestamp: now(),
    },
  });
};

export const createExternalAssistantUpdateBuffer = (
  args: ExternalAssistantUpdateArgs,
) => {
  let text = "";
  const flush = () => {
    const partial = text.trim();
    text = "";
    if (!partial) return "";
    persistAssistantUpdate(args, partial);
    return partial;
  };
  return {
    append(chunk: string) {
      text += chunk;
    },
    flushBeforeTool: flush,
    flushOnTermination: flush,
    discard() {
      text = "";
    },
  };
};
