import crypto from "node:crypto";

const isEnabled = () => process.env.STELLA_DEBUG_PROMPT_CACHE === "1";

const snapshots = new Map();

const hashText = (value) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

const safeStringify = (value) => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

const toolBytes = (tools) =>
  safeStringify(
    (tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );

export const clearPromptPrefixSnapshot = (threadKey) => {
  snapshots.delete(threadKey);
};

export const checkPromptPrefixStability = ({
  threadKey,
  systemPrompt,
  tools,
  messages,
  boundary,
  logger,
}) => {
  if (!isEnabled()) return;
  const systemPromptHash = hashText(systemPrompt ?? "");
  const toolsHash = hashText(toolBytes(tools));
  const previous = snapshots.get(threadKey);
  if (previous && !boundary) {
    const diverged = [];
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
