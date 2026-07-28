/**
 * Drive file helpers shared by the drive browser, the chat output cards, and
 * the composer upload chip. The bytes live in R2 (C3); everything here goes
 * through W2's signed-URL action rather than touching a bucket directly.
 */
import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { driveApi } from "@/features/cloud/cloud-api";

export const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

export const driveErrorText = (error: unknown): string => {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: string } | string;
    if (typeof data === "string") return data;
    if (data?.message) return data.message;
  }
  if (
    error instanceof Error &&
    !/Server Error|ConvexError/.test(error.message)
  ) {
    return error.message;
  }
  return "That didn't work. Try again.";
};

/** Drive-relative POSIX path for an uploaded file (C3: no leading slash). */
export const uploadPathFor = (name: string): string => {
  const safe = name
    .replace(/[\\/]+/g, "-")
    .replace(/^\.+/, "")
    .trim();
  return `uploads/${safe || "file"}`;
};

const triggerBrowserDownload = (url: string, name: string): void => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

export type DriveFileActions = {
  /** Path currently being resolved/removed, for per-row button state. */
  busyPath: string | null;
  open: (path: string) => Promise<void>;
  download: (path: string, name: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
};

export const useDriveFileActions = (
  onError: (message: string) => void,
): DriveFileActions => {
  const getUrl = useAction(driveApi.getMyDriveFileUrl);
  const deleteFile = useAction(driveApi.deleteMyDriveFile);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const run = useCallback(
    async (path: string, work: () => Promise<void>) => {
      setBusyPath(path);
      try {
        await work();
      } catch (error) {
        onError(driveErrorText(error));
      } finally {
        setBusyPath(null);
      }
    },
    [onError],
  );

  return {
    busyPath,
    open: useCallback(
      (path: string) =>
        run(path, async () => {
          const { url } = await getUrl({ path });
          window.open(url, "_blank", "noopener");
        }),
      [getUrl, run],
    ),
    download: useCallback(
      (path: string, name: string) =>
        run(path, async () => {
          const { url } = await getUrl({ path });
          triggerBrowserDownload(url, name);
        }),
      [getUrl, run],
    ),
    remove: useCallback(
      (path: string) => run(path, () => deleteFile({ path }).then(() => {})),
      [deleteFile, run],
    ),
  };
};

export type DriveUpload = (file: File) => Promise<{
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  updatedAt: number;
}>;

/**
 * Two-step upload: Convex mints a signed R2 PUT, the browser sends the bytes
 * straight to R2, then `finalizeDriveUpload` records the row from the size R2
 * itself reports. Bytes never pass through Convex.
 */
export const useDriveUpload = (): DriveUpload => {
  const prepare = useAction(driveApi.prepareDriveUpload);
  const finalize = useAction(driveApi.finalizeDriveUpload);
  return useCallback(
    async (file: File) => {
      const prepared = await prepare({
        path: uploadPathFor(file.name),
        sizeBytes: file.size,
        ...(file.type ? { contentType: file.type } : {}),
      });
      const response = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: { "content-type": prepared.contentType },
        body: file,
      });
      if (!response.ok) {
        throw new Error(`Upload failed (${response.status}).`);
      }
      return await finalize({
        path: prepared.path,
        contentType: prepared.contentType,
      });
    },
    [finalize, prepare],
  );
};
