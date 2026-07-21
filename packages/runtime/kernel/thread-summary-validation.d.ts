export const THREAD_SUMMARY_FLOOR_EXEMPT_TOKENS: 2000;

export type ThreadSummaryValidation = {
  valid: boolean;
  reason?: string;
  visibleCodePoints: number;
  wordCount: number;
  uniqueWordCount: number;
};

export function normalizeSummaryForValidation(summary: string): string;

export function validateThreadSummary(
  summary: string,
  middleTokens: number,
  previousSummary?: string,
): ThreadSummaryValidation;
