import {
  normalizeDisplayPayload,
  type DisplayTabPayload,
} from "@stella/contracts/desktop/display-payload";
import { getFileEntries } from "@/features/workspace-display/files-index";
import { isFilesPayload } from "@/features/workspace-display/payload-kind";
import type { SidebarTab } from "@/features/workspace-display/sidebar-sections";

export const restorablePayloadFor = (
  tab: SidebarTab,
): DisplayTabPayload | null => {
  if (tab.kind !== "files" || tab.location === null) return null;
  const saved = normalizeDisplayPayload(tab.file?.payload);
  if (saved && isFilesPayload(saved)) return saved;
  const entry = getFileEntries().find((item) => item.id === tab.location);
  return entry && isFilesPayload(entry.payload) ? entry.payload : null;
};

const localPathFor = (payload: DisplayTabPayload): string | null => {
  if (payload.cloudDrivePath) return null;
  switch (payload.kind) {
    case "canvas-html":
      return payload.driveBacked ? null : payload.filePath;
    case "markdown":
    case "file-artifact":
    case "pdf":
      return payload.filePath;
    case "office":
      return payload.previewRef.sourcePath;
    case "media":
      switch (payload.asset.kind) {
        case "image":
          return payload.asset.filePaths[0] ?? null;
        case "video":
        case "audio":
        case "model3d":
        case "download":
          return payload.asset.filePath;
        case "text":
          return null;
      }
      return null;
    case "url":
    case "source-diff":
    case "trash":
      return null;
  }
};

export const isPayloadFileMissing = async (
  payload: DisplayTabPayload,
): Promise<boolean> => {
  const filePath = localPathFor(payload);
  const readFile = window.electronAPI?.display?.readFile;
  if (!filePath || typeof readFile !== "function") return false;
  try {
    const result = await readFile(filePath, { maxBytes: 1 });
    return result.missing === true;
  } catch {
    return false;
  }
};
