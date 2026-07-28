import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Upload } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import { driveApi } from "@/features/cloud/cloud-api";
import { DriveFileCard } from "./DriveFileCard";
import {
  driveErrorText,
  useDriveFileActions,
  useDriveUpload,
} from "./drive-files";
import "./drive-panel.css";

/**
 * The drive browser: the owner's cloud files with preview, download, delete,
 * and a plain upload. It lives in the workspace panel rather than the left
 * sidebar — the drive is a place you open, not a section of every chat.
 */

const DRIVE_LIST_LIMIT = 100;

export function DrivePanel() {
  const { isAuthenticated } = useConvexAuth();
  const files = useQuery(
    driveApi.listMyDriveFiles,
    isAuthenticated ? { limit: DRIVE_LIST_LIMIT } : "skip",
  );
  const notify = useCallback((message: string) => {
    showToast({ title: message, variant: "error" });
  }, []);
  const actions = useDriveFileActions(notify);
  const upload = useDriveUpload();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files;
      event.target.value = "";
      if (!list?.length) return;
      setUploading(true);
      try {
        for (const file of Array.from(list)) {
          await upload(file);
        }
      } catch (error) {
        notify(driveErrorText(error));
      } finally {
        setUploading(false);
      }
    },
    [notify, upload],
  );

  const handleRemove = useCallback(
    (path: string) => {
      if (confirmPath !== path) {
        setConfirmPath(path);
        return;
      }
      setConfirmPath(null);
      void actions.remove(path);
    },
    [actions, confirmPath],
  );

  return (
    <main className="drive-panel">
      <header className="drive-panel__head">
        <h1 className="drive-panel__title">Drive</h1>
        <button
          type="button"
          className="cloud-file-card__action"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </header>
      {files === undefined ? (
        <p className="drive-panel__state">Loading…</p>
      ) : files.length === 0 ? (
        <p className="drive-panel__state">
          Nothing here yet. Files Stella produces in the cloud, and anything you
          upload, land in your drive.
        </p>
      ) : (
        <ul className="drive-panel__list">
          {files.map((file) => (
            <li key={file.path}>
              <DriveFileCard
                path={file.path}
                name={file.name}
                sizeBytes={file.sizeBytes}
                actions={actions}
                onRemove={handleRemove}
                // "workspace" rows are metadata for bytes that never left the
                // sandbox; there is nothing behind a signed URL for them.
                stored={file.source !== "workspace"}
              />
              {confirmPath === file.path ? (
                <p className="drive-panel__confirm">
                  Press Delete again to remove {file.name}.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="drive-panel__file-input"
        onChange={(event) => void handleFiles(event)}
      />
    </main>
  );
}
