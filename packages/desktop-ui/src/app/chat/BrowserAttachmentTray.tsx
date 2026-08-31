import {
  browserAttachmentUploads,
  useBrowserAttachmentUploads,
} from "@/features/cloud/browser-chat-attachments";
import { platformCapabilities } from "@/platform/capabilities";

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function BrowserAttachmentTray() {
  const uploads = useBrowserAttachmentUploads();
  if (!platformCapabilities.browserUploads || uploads.length === 0) return null;
  return (
    <div className="browser-attachment-tray" aria-label="Attachments">
      {uploads.map((upload) => (
        <div
          className="browser-attachment-chip"
          data-status={upload.status}
          data-image={upload.previewUrl ? "true" : undefined}
          key={upload.id}
        >
          {upload.previewUrl ? (
            <img
              className="browser-attachment-chip__thumbnail"
              src={upload.previewUrl}
              alt={upload.name}
            />
          ) : null}
          <div className="browser-attachment-chip__copy">
            <strong title={upload.name}>{upload.name}</strong>
            <small>
              {upload.status === "error"
                ? upload.error
                : formatSize(upload.sizeBytes)}
            </small>
          </div>
          {upload.status === "error" ? (
            <button
              type="button"
              onClick={() => browserAttachmentUploads.retry(upload.id)}
            >
              Retry
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Remove ${upload.name}`}
            onClick={() => browserAttachmentUploads.remove(upload.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
