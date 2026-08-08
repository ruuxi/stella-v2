import { memo } from "react";
import type { LocalModelUsageRecord } from "@stella/contracts/local-chat";
import { executionLabel } from "./usage-data";
import { formatCallTime, formatCost, formatTokens } from "./format";

type UsageCallsTableProps = {
  records: LocalModelUsageRecord[];
  onSelectThread: (conversationId: string, threadId: string) => void;
};

export const UsageCallsTable = memo(function UsageCallsTable({
  records,
  onSelectThread,
}: UsageCallsTableProps) {
  return (
    <section className="usage-panel">
      <div className="usage-panel-heading">
        <div>
          <h2>Provider calls</h2>
          <p>
            Output includes reasoning where the provider includes it; reasoning
            is also shown separately when reported.
          </p>
        </div>
      </div>
      <div className="usage-table-scroll">
        <table className="usage-table usage-call-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Execution</th>
              <th>Provider / model</th>
              <th>Input</th>
              <th>Cache R / W</th>
              <th>Output</th>
              <th>Reasoning</th>
              <th>Cost</th>
              <th>Stop</th>
            </tr>
          </thead>
          <tbody>
            {records.slice(0, 500).map((record) => (
              <tr key={record.id}>
                <td title={new Date(record.timestamp).toISOString()}>
                  {formatCallTime(record.timestamp)}
                </td>
                <td>
                  <button
                    type="button"
                    className="usage-call-thread"
                    onClick={() =>
                      onSelectThread(record.conversationId, record.threadId)
                    }
                    title={record.threadId}
                  >
                    {executionLabel(record)} · {record.agentType}
                  </button>
                </td>
                <td>
                  <span>{record.provider}</span>
                  <strong>{record.responseModel || record.model}</strong>
                  <small>{record.api}</small>
                </td>
                <td>{formatTokens(record.inputTokens)}</td>
                <td>
                  {formatTokens(record.cacheReadTokens)} /{" "}
                  {formatTokens(record.cacheWriteTokens)}
                </td>
                <td>{formatTokens(record.outputTokens)}</td>
                <td>{formatTokens(record.reasoningTokens)}</td>
                <td
                  title={`Input ${formatCost(record.inputCostUsd)} · cache read ${formatCost(record.cacheReadCostUsd)} · cache write ${formatCost(record.cacheWriteCostUsd)} · output ${formatCost(record.outputCostUsd)}`}
                >
                  {formatCost(record.totalCostUsd)}
                </td>
                <td data-stop={record.stopReason} title={record.errorMessage}>
                  {record.stopReason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {records.length > 500 ? (
        <p className="usage-table-note">
          Showing the latest 500 matching calls; summary totals include all
          {` ${records.length.toLocaleString()} `}loaded calls.
        </p>
      ) : null}
    </section>
  );
});
