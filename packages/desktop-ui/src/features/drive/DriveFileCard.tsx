import { FileText } from "@/ui/icons";
import { formatFileSize, type DriveFileActions } from "./drive-files";
import "@/features/cloud/cloud-inline.css";

/**
 * One drive file, rendered with the same one-row/one-action idiom as the
 * inline app apply card. Used for both `output_files` chat cards (C4) and
 * the drive browser list.
 */
export function DriveFileCard({
  path,
  name,
  sizeBytes,
  actions,
  onRemove,
  stored = true,
}: {
  path: string;
  name: string;
  sizeBytes: number;
  actions: DriveFileActions;
  /** Present only where deletion belongs (the drive browser). */
  onRemove?: (path: string) => void;
  /**
   * False for a file an agent registered but was too large to upload: it is
   * still in its workspace, so a signed URL would resolve to nothing. The row
   * stays visible — the file is real — but without preview or download.
   */
  stored?: boolean;
}) {
  const busy = actions.busyPath === path;
  const size = formatFileSize(sizeBytes);
  const meta = stored
    ? size
      ? `${size} · ${path}`
      : path
    : `${size ? `${size} · ` : ""}too large to deliver — still in the workspace`;
  return (
    <div className="cloud-file-card">
      <span className="cloud-file-card__icon">
        <FileText size={18} strokeWidth={1.7} aria-hidden="true" />
      </span>
      <span className="cloud-file-card__text">
        <span className="cloud-file-card__name" title={path}>
          {name}
        </span>
        <span className="cloud-file-card__meta">{meta}</span>
      </span>
      <span className="cloud-file-card__actions">
        {stored ? (
          <>
            <button
              type="button"
              className="cloud-file-card__action"
              disabled={busy}
              onClick={() => void actions.open(path)}
            >
              Preview
            </button>
            <button
              type="button"
              className="cloud-file-card__action"
              disabled={busy}
              onClick={() => void actions.download(path, name)}
            >
              Download
            </button>
          </>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            className="cloud-file-card__action cloud-file-card__action--danger"
            disabled={busy}
            onClick={() => onRemove(path)}
          >
            Delete
          </button>
        ) : null}
      </span>
    </div>
  );
}
