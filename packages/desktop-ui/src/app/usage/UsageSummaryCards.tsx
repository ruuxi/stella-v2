import { memo } from "react";
import type { UsageSummary } from "./usage-data";
import { formatCost, formatPercent, formatTokens } from "./format";

export const UsageSummaryCards = memo(function UsageSummaryCards({
  summary,
}: {
  summary: UsageSummary;
}) {
  return (
    <section className="usage-summary" aria-label="Usage summary">
      <article>
        <span>Estimated cost</span>
        <strong>{formatCost(summary.totalCostUsd)}</strong>
        <small>{summary.calls} provider calls</small>
      </article>
      <article>
        <span>Total tokens</span>
        <strong>{formatTokens(summary.totalTokens)}</strong>
        <small>{formatTokens(summary.inputTokens)} uncached input</small>
      </article>
      <article>
        <span>Cache read</span>
        <strong>{formatPercent(summary.cacheReadRate)}</strong>
        <small>
          {formatTokens(summary.cacheReadTokens)} read ·{" "}
          {formatTokens(summary.cacheWriteTokens)} written
        </small>
      </article>
      <article>
        <span>Output</span>
        <strong>{formatTokens(summary.outputTokens)}</strong>
        <small>{formatTokens(summary.reasoningTokens)} reasoning tokens</small>
      </article>
    </section>
  );
});
