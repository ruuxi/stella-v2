import type { OfficePreviewRef } from "@stella/contracts/office-preview";
import { useOfficePreview } from "@/features/chat/office-preview-store";
import { useFilePreviewActions } from "@/features/chat/hooks/use-file-preview-actions";
import { FilePreviewCardShell } from "./FilePreviewCardShell";
import { useT } from "@/shared/i18n";
import "./office-preview-card.css";

const statusLabelKey = (status?: string) => {
  if (status === "ready") return "app.chat.officePreview.statusReady";
  if (status === "error") return "app.chat.officePreview.statusError";
  if (status === "stopped") return "app.chat.officePreview.statusStopped";
  return "app.chat.officePreview.statusPreparing";
};

export function OfficePreviewCard({
  previewRef,
}: {
  previewRef: OfficePreviewRef;
}) {
  const t = useT();
  const { actionStatus, handleSave, handleCopy } = useFilePreviewActions({
    sourcePath: previewRef.sourcePath,
    suggestedName: previewRef.title,
  });
  const snapshot = useOfficePreview(previewRef.sessionId);
  const title = snapshot?.title ?? previewRef.title;
  const status = snapshot?.status;
  const statusLabel = t(statusLabelKey(status));
  const updatedAtLabel =
    snapshot?.updatedAt != null
      ? new Date(snapshot.updatedAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        })
      : null;

  return (
    <FilePreviewCardShell
      className="office-preview-card"
      eyebrow={statusLabel}
      title={title}
      titlePath={previewRef.sourcePath}
      meta={
        updatedAtLabel ? (
          <span className="office-preview-card__timestamp">
            {t("app.chat.officePreview.updatedAt", { time: updatedAtLabel })}
          </span>
        ) : null
      }
      actionStatus={actionStatus}
      onSave={handleSave}
      onCopy={handleCopy}
    >
      {snapshot?.status === "error" ? (
        <div className="file-preview-card__placeholder file-preview-card__placeholder--error office-preview-card__placeholder">
          {snapshot.error?.trim() || t("app.chat.officePreview.sessionError")}
        </div>
      ) : snapshot?.html ? (
        <iframe
          className="office-preview-card__frame"
          title={t("app.chat.officePreview.frameTitle", { title })}
          sandbox="allow-scripts"
          srcDoc={snapshot.html}
        />
      ) : (
        <div className="file-preview-card__placeholder office-preview-card__placeholder">
          {t("app.chat.officePreview.preparingBody")}
        </div>
      )}
    </FilePreviewCardShell>
  );
}
