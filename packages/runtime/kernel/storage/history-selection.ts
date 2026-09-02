/**
 * Walk a newest-first list and keep items until the token budget (or the
 * optional item cap) is exhausted. The newest item is always kept even when
 * it alone exceeds the budget.
 */
export const selectRecentByTokenBudget = <T>(args: {
  itemsNewestFirst: T[];
  maxTokens: number;
  maxItems?: number;
  estimateTokens: (item: T) => number;
}): T[] => {
  const safeMaxTokens = Math.max(1, Math.floor(args.maxTokens));
  const safeMaxItems =
    args.maxItems === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.floor(args.maxItems));
  const selected: T[] = [];
  let usedTokens = 0;
  for (const item of args.itemsNewestFirst) {
    if (selected.length >= safeMaxItems) break;
    const itemTokens = Math.max(1, Math.floor(args.estimateTokens(item)));
    if (selected.length > 0 && usedTokens + itemTokens > safeMaxTokens) {
      break;
    }
    selected.push(item);
    usedTokens += itemTokens;
  }
  return selected;
};
