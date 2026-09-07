/** Activity recoverable from the canonical journal, including device-written tools. */
type ActivityRecord = {
  kind: string;
  turnId: string;
  role?: string;
  hidden?: boolean;
  payload?: Record<string, unknown>;
};

export function journalWorkingActivity(records: readonly ActivityRecord[], turnId: string | null) {
  let answerLanded = false;
  let hasToolActivity = false;
  const tools = new Map<string, string>();
  if (turnId) for (const record of records) {
    if (record.turnId !== turnId || record.kind !== "message" || record.hidden) continue;
    const payload = record.payload ?? {};
    if (record.role === "toolResult") {
      hasToolActivity = true;
      if (typeof payload.toolCallId === "string") tools.delete(payload.toolCallId);
      continue;
    }
    if (record.role !== "assistant") continue;
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    let hasCalls = false;
    let hasText = typeof payload.content === "string" && payload.content.trim().length > 0;
    for (const value of blocks) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) hasText = true;
      if (block.type !== "toolCall") continue;
      hasCalls = true;
      hasToolActivity = true;
      if (typeof block.id === "string" && typeof block.name === "string") tools.set(block.id, block.name);
    }
    answerLanded = hasText && !hasCalls && payload.followedByToolCall !== true;
    // A final assistant answer supersedes any missed tool-result row.
    if (answerLanded) tools.clear();
  }
  const last = [...tools].at(-1);
  return { answerLanded, hasToolActivity,
    ...(last ? { toolCallId: last[0], toolName: last[1] } : {}) };
}
