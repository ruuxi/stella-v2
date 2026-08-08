import { executionLabel } from "./usage-data";

const compactTokensFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const standardTokensFormat = new Intl.NumberFormat(undefined, {
  notation: "standard",
  maximumFractionDigits: 1,
});
const callTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export const formatTokens = (value: number) =>
  (value >= 10_000 ? compactTokensFormat : standardTokensFormat).format(value);

export const formatCost = (value: number) => {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(3)}`;
};

export const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

export const formatCallTime = (timestamp: number) =>
  callTimeFormat.format(timestamp);

export const shortId = (value: string) =>
  value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;

export const threadLabel = (record: {
  threadName: string;
  agentType: string;
  agentDepth?: number;
}) =>
  record.threadName ||
  `${executionLabel(record)} · ${record.agentType || "unknown"}`;
