/**
 * Transcript pruning shared by the orchestrator DO and the sandbox executor.
 *
 * The canonical transcript in Convex only grows; the loop's context window
 * does not. Without a cut, a long conversation eventually overflows the
 * relay model's window and every subsequent turn fails the same way — the
 * conversation bricks. Until real compaction lands (the desktop runtime's
 * compaction scheduler is the model), the cloud loops keep the newest suffix
 * of history that fits a token budget.
 */

/**
 * History budget for cloud loops using the pinned relay model
 * (contextWindow 80k, maxTokens 16,384): leaves room for the system prompt,
 * tool schemas, the incoming prompt, and a full-size response. The estimate
 * (serialized chars / 4) overshoots real token counts for JSON payloads,
 * which errs on the safe side.
 */
export const CLOUD_HISTORY_TOKEN_BUDGET = 48_000;

// ~4 chars/token holds for ASCII text, but CJK and most non-Latin scripts
// tokenize near 1 token/char — counting them at 1/4 would let a CJK-dense
// transcript blow the real window 4x past the budget.
const estimateTokens = (message: unknown): number => {
  const serialized = JSON.stringify(message);
  let nonAscii = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    if (serialized.charCodeAt(index) > 0x7f) nonAscii += 1;
  }
  return Math.ceil((serialized.length - nonAscii) / 4) + nonAscii;
};

/**
 * Trim an oldest-first message history to fit `budgetTokens`, cutting only
 * at a plain `user` message so the window never opens with a toolResult
 * orphaned from its toolCall (which the provider rejects). Returns the
 * newest suffix that fits; an over-budget history with no clean boundary
 * degrades to an empty history rather than a dead turn.
 */
export const pruneAgentHistory = <T extends { role?: string }>(
  messages: T[],
  budgetTokens: number = CLOUD_HISTORY_TOKEN_BUDGET,
): T[] => {
  if (messages.length === 0) return messages;
  let start = messages.length;
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    used += estimateTokens(messages[index]);
    if (used > budgetTokens) break;
    start = index;
  }
  if (start === 0) return messages;
  while (start < messages.length && messages[start]?.role !== "user") {
    start += 1;
  }
  return messages.slice(start);
};

/** Server-enforced ceiling on one `/api/cloud/messages` append. */
export const MESSAGE_APPEND_BATCH_LIMIT = 50;

/** Split rows into ordered batches the append route will accept. */
export const chunkForAppend = <T>(rows: T[], size = MESSAGE_APPEND_BATCH_LIMIT): T[][] => {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }
  return batches;
};
