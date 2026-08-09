import { memo } from "react";
import { useT } from "@/shared/i18n";
import { executionLabel, type UsageThreadGroup } from "./usage-data";
import {
  formatCost,
  formatPercent,
  formatTokens,
  shortId,
  threadLabel,
} from "./format";

type UsageThreadsTableProps = {
  threads: UsageThreadGroup[];
  onSelectThread: (conversationId: string, threadId: string) => void;
};

export const UsageThreadsTable = memo(function UsageThreadsTable({
  threads,
  onSelectThread,
}: UsageThreadsTableProps) {
  const t = useT();
  return (
    <section className="usage-panel">
      <div className="usage-panel-heading">
        <div>
          <h2>{t("app.usage.threads.title")}</h2>
          <p>{t("app.usage.threads.description")}</p>
        </div>
      </div>
      <div className="usage-table-scroll">
        <table className="usage-table">
          <thead>
            <tr>
              <th>{t("app.usage.threads.columns.execution")}</th>
              <th>{t("app.usage.threads.columns.model")}</th>
              <th>{t("app.usage.threads.columns.calls")}</th>
              <th>{t("app.usage.threads.columns.tokens")}</th>
              <th>{t("app.usage.threads.columns.cache")}</th>
              <th>{t("app.usage.threads.columns.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((thread) => (
              <tr key={thread.threadId}>
                <td>
                  <button
                    type="button"
                    className="usage-thread-link"
                    onClick={() =>
                      onSelectThread(thread.conversationId, thread.threadId)
                    }
                  >
                    <span>{executionLabel(thread)}</span>
                    <strong>{threadLabel(thread)}</strong>
                    <small title={thread.threadId}>
                      {shortId(thread.threadId)}
                    </small>
                  </button>
                </td>
                <td title={thread.models.join(", ")}>
                  {thread.models.join(", ")}
                </td>
                <td>{thread.calls}</td>
                <td>{formatTokens(thread.totalTokens)}</td>
                <td>{formatPercent(thread.cacheReadRate)}</td>
                <td>{formatCost(thread.totalCostUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
});
