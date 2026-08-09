import { memo, useCallback } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import type { UsageTimelinePoint } from "./usage-data";
import { useT } from "@/shared/i18n";
import { formatCost, formatTokens } from "./format";

const formatCostTick = (value: unknown) => formatCost(Number(value));
const formatTokensTick = (value: unknown) => formatTokens(Number(value));

export const UsageTimelineChart = memo(function UsageTimelineChart({
  timeline,
}: {
  timeline: UsageTimelinePoint[];
}) {
  const t = useT();
  const UsageTooltip = useCallback(
    ({ active, payload, label }: TooltipContentProps) => {
      if (!active || !payload?.length) return null;
      const point = payload[0]?.payload as UsageTimelinePoint | undefined;
      if (!point) return null;
      return (
        <div className="usage-chart-tooltip">
          <strong>{label}</strong>
          <span>
            {t("app.usage.timeline.tooltip.estimated", {
              value: formatCost(point.totalCostUsd),
            })}
          </span>
          <span>
            {t("app.usage.timeline.tooltip.tokens", {
              value: formatTokens(point.totalTokens),
            })}
          </span>
          <span>
            {t("app.usage.timeline.tooltip.calls", { count: point.calls })}
          </span>
        </div>
      );
    },
    [t],
  );
  return (
    <section className="usage-panel usage-chart-panel">
      <div className="usage-panel-heading">
        <div>
          <h2>{t("app.usage.timeline.title")}</h2>
          <p>{t("app.usage.timeline.description")}</p>
        </div>
      </div>
      <div
        className="usage-chart"
        role="img"
        aria-label={t("app.usage.timeline.chartLabel")}
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={timeline}
            margin={{ top: 10, right: 8, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="usageCostFill" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--accent, #7c6cf2)"
                  stopOpacity={0.35}
                />
                <stop
                  offset="95%"
                  stopColor="var(--accent, #7c6cf2)"
                  stopOpacity={0.02}
                />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border-weak)" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              yAxisId="cost"
              tickFormatter={formatCostTick}
              tickLine={false}
              axisLine={false}
              width={58}
            />
            <YAxis
              yAxisId="tokens"
              orientation="right"
              tickFormatter={formatTokensTick}
              tickLine={false}
              axisLine={false}
              width={54}
            />
            <Tooltip content={UsageTooltip} />
            <Legend />
            <Area
              yAxisId="cost"
              type="monotone"
              dataKey="totalCostUsd"
              name={t("app.usage.timeline.series.cost")}
              stroke="var(--accent, #7c6cf2)"
              fill="url(#usageCostFill)"
              strokeWidth={2}
            />
            <Line
              yAxisId="tokens"
              type="monotone"
              dataKey="totalTokens"
              name={t("app.usage.timeline.series.tokens")}
              stroke="var(--foreground)"
              strokeWidth={1.5}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
});
