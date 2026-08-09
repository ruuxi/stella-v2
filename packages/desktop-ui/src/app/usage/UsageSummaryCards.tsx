import { memo } from "react";
import type { UsageSummary } from "./usage-data";
import { useT } from "@/shared/i18n";
import { formatCost, formatPercent, formatTokens } from "./format";

export const UsageSummaryCards = memo(function UsageSummaryCards({
  summary,
}: {
  summary: UsageSummary;
}) {
  const t = useT();
  return (
    <section
      className="usage-summary"
      aria-label={t("app.usage.summary.label")}
    >
      <article>
        <span>{t("app.usage.summary.estimatedCost")}</span>
        <strong>{formatCost(summary.totalCostUsd)}</strong>
        <small>
          {t("app.usage.summary.providerCalls", { count: summary.calls })}
        </small>
      </article>
      <article>
        <span>{t("app.usage.summary.totalTokens")}</span>
        <strong>{formatTokens(summary.totalTokens)}</strong>
        <small>
          {t("app.usage.summary.uncachedInput", {
            value: formatTokens(summary.inputTokens),
          })}
        </small>
      </article>
      <article>
        <span>{t("app.usage.summary.cacheRead")}</span>
        <strong>{formatPercent(summary.cacheReadRate)}</strong>
        <small>
          {t("app.usage.summary.cacheDetail", {
            read: formatTokens(summary.cacheReadTokens),
            written: formatTokens(summary.cacheWriteTokens),
          })}
        </small>
      </article>
      <article>
        <span>{t("app.usage.summary.output")}</span>
        <strong>{formatTokens(summary.outputTokens)}</strong>
        <small>
          {t("app.usage.summary.reasoningTokens", {
            value: formatTokens(summary.reasoningTokens),
          })}
        </small>
      </article>
    </section>
  );
});
