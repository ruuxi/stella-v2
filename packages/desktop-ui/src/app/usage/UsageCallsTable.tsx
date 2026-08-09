import { memo } from "react";
import type { LocalModelUsageRecord } from "@stella/contracts/local-chat";
import { useT } from "@/shared/i18n";
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
  const t = useT();
  return (
    <section className="usage-panel">
      <div className="usage-panel-heading">
        <div>
          <h2>{t("app.usage.calls.title")}</h2>
          <p>{t("app.usage.calls.description")}</p>
        </div>
      </div>
      <div className="usage-table-scroll">
        <table className="usage-table usage-call-table">
          <thead>
            <tr>
              <th>{t("app.usage.calls.columns.time")}</th>
              <th>{t("app.usage.calls.columns.execution")}</th>
              <th>{t("app.usage.calls.columns.providerModel")}</th>
              <th>{t("app.usage.calls.columns.input")}</th>
              <th>{t("app.usage.calls.columns.cache")}</th>
              <th>{t("app.usage.calls.columns.output")}</th>
              <th>{t("app.usage.calls.columns.reasoning")}</th>
              <th>{t("app.usage.calls.columns.cost")}</th>
              <th>{t("app.usage.calls.columns.stop")}</th>
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
                  title={t("app.usage.calls.costBreakdown", {
                    input: formatCost(record.inputCostUsd),
                    cacheRead: formatCost(record.cacheReadCostUsd),
                    cacheWrite: formatCost(record.cacheWriteCostUsd),
                    output: formatCost(record.outputCostUsd),
                  })}
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
          {t("app.usage.calls.truncatedNote", {
            count: records.length.toLocaleString(),
          })}
        </p>
      ) : null}
    </section>
  );
});
