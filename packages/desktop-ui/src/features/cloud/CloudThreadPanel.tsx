import { createElement } from "react";
import { displayTabs } from "@/features/workspace-display/tab-store";
import {
  cloudThreadReport,
  cloudWorkspaceLabel,
  useCloudActivity,
} from "./use-cloud-activity";
import "./cloud-inline.css";

/**
 * The read-only view behind a cloud Activity row's eye button — the cloud
 * counterpart of `ThreadChatTab`. A cloud thread's durable record is its
 * description, placement, and the report it left behind, so that is what
 * this shows; there is no local transcript to replay.
 */

const STATUS_LABEL: Record<string, string> = {
  running: "Working",
  completed: "Finished",
  failed: "Couldn’t finish",
  canceled: "Stopped",
};

export function CloudThreadPanel({ threadId }: { threadId: string }) {
  const { threadsById } = useCloudActivity();
  const thread = threadsById.get(threadId);

  if (!thread) {
    return (
      <main className="cloud-thread-panel cloud-thread-panel--state">
        This agent is no longer in the recent activity window.
      </main>
    );
  }

  const report = cloudThreadReport(thread);
  return (
    <main className="cloud-thread-panel">
      <header className="cloud-thread-panel__head">
        <h1 className="cloud-thread-panel__title">{thread.description}</h1>
        <div className="cloud-thread-panel__meta">
          <span
            className="cloud-placement-badge"
            title={`Ran in the cloud — ${cloudWorkspaceLabel(thread.workspace)}`}
          >
            <span className="cloud-placement-badge__dot" aria-hidden="true" />
            {cloudWorkspaceLabel(thread.workspace)}
          </span>
          <span
            className="cloud-thread-panel__status"
            data-status={thread.status}
          >
            {STATUS_LABEL[thread.status] ?? thread.status}
          </span>
        </div>
      </header>
      {report ? (
        <p className="cloud-thread-panel__report">{report}</p>
      ) : (
        <p className="cloud-thread-panel__report cloud-thread-panel__report--empty">
          {thread.status === "running"
            ? "Still working. Its report lands here when it finishes."
            : "This agent finished without a report."}
        </p>
      )}
    </main>
  );
}

export const openCloudThreadPanel = (args: {
  threadId: string;
  title?: string;
}): void => {
  const threadId = args.threadId.trim();
  if (!threadId) return;
  const title = args.title?.trim() || "Cloud agent";
  displayTabs.openTab({
    id: `cloud-thread:${threadId}`,
    kind: "chat",
    title,
    tooltip: `Ran in the cloud · ${title}`,
    metadata: { kind: "cloud-agent-thread", threadId, readOnly: true },
    render: () => createElement(CloudThreadPanel, { threadId }),
  });
};
