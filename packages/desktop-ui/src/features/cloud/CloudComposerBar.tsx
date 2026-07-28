import { useCallback, useRef, useState, type ChangeEvent } from "react";
import { useConvexAuth } from "convex/react";
import { Paperclip, X } from "@/ui/icons";
import { showToast } from "@/ui/toast";
import {
  driveErrorText,
  formatFileSize,
  useDriveUpload,
} from "@/features/drive/drive-files";
import {
  cloudAttachmentsStore,
  isWebShell,
  useCloudAttachments,
} from "./cloud-composer-store";
import "./cloud-composer.css";

/**
 * Drive attachments for the composer.
 *
 * There is no "where does this run" control: placement is routed by what the
 * work is about, not by a setting the user has to keep in mind. The web and
 * mobile interiors have no local runtime, so their turns run in the cloud and
 * a file has to reach the drive to be readable; desktop has a real filesystem
 * and refers to files by path, so it needs no attach affordance here.
 */
export function CloudComposerBar() {
  const { isAuthenticated } = useConvexAuth();
  const attachments = useCloudAttachments();
  const upload = useDriveUpload();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const webShell = isWebShell();

  const handleFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const list = event.target.files;
      event.target.value = "";
      if (!list?.length) return;
      setUploading(true);
      try {
        for (const file of Array.from(list)) {
          const uploaded = await upload(file);
          cloudAttachmentsStore.add({
            path: uploaded.path,
            name: uploaded.name,
            sizeBytes: uploaded.sizeBytes,
          });
        }
      } catch (error) {
        showToast({ title: driveErrorText(error), variant: "error" });
      } finally {
        setUploading(false);
      }
    },
    [upload],
  );

  if (!isAuthenticated || !webShell) return null;

  return (
    <div className="cloud-composer-bar">
      <button
        type="button"
        className="cloud-composer-bar__attach"
        title="Attach a file to your drive"
        aria-label="Attach a file to your drive"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip size={14} strokeWidth={1.8} aria-hidden="true" />
        {uploading ? "Uploading…" : "Attach"}
      </button>
      {attachments.map((file) => (
        <span
          key={file.path}
          className="cloud-attachment-chip"
          title={`${file.path} · ${formatFileSize(file.sizeBytes)}`}
        >
          <span className="cloud-attachment-chip__name">{file.name}</span>
          <button
            type="button"
            className="cloud-attachment-chip__remove"
            aria-label={`Remove ${file.name}`}
            onClick={() => cloudAttachmentsStore.remove(file.path)}
          >
            <X size={11} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="file"
        multiple
        className="cloud-composer-bar__file-input"
        onChange={(event) => void handleFiles(event)}
      />
    </div>
  );
}
