/**
 * Dev-only byte-stability guard for the provider prompt prefix.
 *
 * The prompt-cache contract for a long-lived session: between two
 * consecutive turns with no compaction/refresh boundary, the system prompt,
 * the tools block, and every already-sent message must be byte-identical —
 * only new tail messages may appear. Silent violations (the class of bug the
 * ResidentBlock refactor removes) are invisible in normal operation; this
 * guard makes them loud in development.
 *
 * Enabled only when `STELLA_DEBUG_PROMPT_CACHE=1` (hashing the full message
 * mirror every turn is not free). No test files — this is a runtime
 * assertion by design.
 */
import crypto from "node:crypto";

type PrefixSnapshot = {
  systemPromptHash: string;
  toolsHash: string;
  messageCount: number;
  messagesPrefixHash: string;
};

const isEnabled = () => process.env.STELLA_DEBUG_PROMPT_CACHE === "1";

/** threadKey → snapshot taken at the previous turn's prompt time. */
const snapshots = new Map<string, PrefixSnapshot>();

const hashText = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

const safeStringify = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const toolBytes = (
  tools:
    | ReadonlyArray<{
        name: string;
        description?: string;
        parameters?: unknown;
      }>
    | null
    | undefined,
) =>
  safeStringify(
    (tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );

export const clearPromptPrefixSnapshot = (threadKey: string) => {
  snapshots.delete(threadKey);
};

/**
 * Record this turn's prefix and warn when it diverged from the previous
 * turn without a legitimate boundary (thread build, compaction refresh,
 * memory toggle, structural tool change).
 */
export const checkPromptPrefixStability = ({
  threadKey,
  systemPrompt,
  tools,
  messages,
  boundary,
  logger,
}: {
  threadKey: string;
  systemPrompt?: string;
  tools?: Parameters<typeof toolBytes>[0];
  messages: readonly unknown[];
  boundary?: boolean;
  logger: { warn: (message: string, fields?: unknown) => void };
}) => {
  if (!isEnabled()) return;
  const systemPromptHash = hashText(systemPrompt ?? "");
  const toolsHash = hashText(toolBytes(tools));
  const previous = snapshots.get(threadKey);
  if (previous && !boundary) {
    const diverged: string[] = [];
    if (previous.systemPromptHash !== systemPromptHash) {
      diverged.push("system-prompt");
    }
    if (previous.toolsHash !== toolsHash) {
      diverged.push("tools");
    }
    if (messages.length < previous.messageCount) {
      diverged.push("messages(shrunk)");
    } else if (
      hashText(safeStringify(messages.slice(0, previous.messageCount))) !==
      previous.messagesPrefixHash
    ) {
      diverged.push("messages");
    }
    if (diverged.length > 0) {
      logger.warn("prompt-cache.prefix-diverged", {
        threadKey,
        diverged,
        previousMessageCount: previous.messageCount,
        messageCount: messages.length,
      });
    }
  }
  snapshots.set(threadKey, {
    systemPromptHash,
    toolsHash,
    messageCount: messages.length,
    messagesPrefixHash: hashText(safeStringify(messages)),
  });
};
