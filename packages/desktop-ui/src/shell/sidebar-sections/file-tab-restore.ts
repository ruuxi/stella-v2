import {
  normalizeDisplayPayload,
  type DisplayTabPayload,
} from "@stella/contracts/desktop/display-payload";
import {
  deviceFileUnavailableMessage,
  type DeviceFileNoun,
} from "@stella/contracts/device-files";
import { getFileEntries } from "@/features/workspace-display/files-index";
import { isFilesPayload } from "@/features/workspace-display/payload-kind";
import {
  fileNameFromDisplayTabId,
  type SidebarTab,
} from "@/features/workspace-display/sidebar-sections";

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

const nounFor = (payload: DisplayTabPayload): DeviceFileNoun => {
  if (payload.kind !== "media") return "file";
  if (payload.asset.kind === "video") return "video";
  if (payload.asset.kind === "audio") return "audio file";
  return "file";
};

export const unrestorableFileMessage = (location: string): string =>
  deviceFileUnavailableMessage(null, fileNameFromDisplayTabId(location));

export const payloadFileUnavailableMessage = async (
  payload: DisplayTabPayload,
): Promise<string | null> => {
  const filePath = localPathFor(payload);
  const describe = window.electronAPI?.display?.mediaSource;
  if (!filePath || typeof describe !== "function") return null;
  const source = await describe(filePath).catch(() => null);
  if (
    !source ||
    source.kind === "local" ||
    source.kind === "drive" ||
    source.kind === "unreachable"
  ) {
    return null;
  }
  return deviceFileUnavailableMessage(source, filePath, nounFor(payload));
};
