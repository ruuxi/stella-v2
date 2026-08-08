import { memo } from "react";
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
import { formatCost, formatTokens } from "./format";

const formatCostTick = (value: unknown) => formatCost(Number(value));
const formatTokensTick = (value: unknown) => formatTokens(Number(value));

const UsageTooltip = ({ active, payload, label }: TooltipContentProps) => {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as UsageTimelinePoint | undefined;
  if (!point) return null;
  return (
    <div className="usage-chart-tooltip">
      <strong>{label}</strong>
      <span>{formatCost(point.totalCostUsd)} estimated</span>
      <span>{formatTokens(point.totalTokens)} tokens</span>
      <span>{point.calls} model calls</span>
    </div>
  );
};

export const UsageTimelineChart = memo(function UsageTimelineChart({
  timeline,
}: {
  timeline: UsageTimelinePoint[];
}) {
  return (
    <section className="usage-panel usage-chart-panel">
      <div className="usage-panel-heading">
        <div>
          <h2>Timeline</h2>
          <p>Estimated cost and total tokens per time bucket.</p>
        </div>
      </div>
      <div
        className="usage-chart"
        role="img"
        aria-label="Timeline of estimated model cost and token usage"
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
              name="Estimated cost"
              stroke="var(--accent, #7c6cf2)"
              fill="url(#usageCostFill)"
              strokeWidth={2}
            />
            <Line
              yAxisId="tokens"
              type="monotone"
              dataKey="totalTokens"
              name="Tokens"
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
