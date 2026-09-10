import { useCallback } from "react";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { showToast } from "@/ui/toast";

export type ConversationFileOpenKind =
  | "local"
  | "cloud-signed-url"
  | "cloud-not-stored";

export const conversationFileOpenKind = (
  entry: ConversationFileEntry,
): ConversationFileOpenKind => {
  if (!entry.cloudDriveFile) return "local";
  return entry.cloudDriveFile.stored === false
    ? "cloud-not-stored"
    : "cloud-signed-url";
};

/**
 * One authority-aware open path for Recent Files and completion pills.
 * Cloud paths are never fed to the local display/Open-With machinery: the
 * sidebar viewer resolves an owner-scoped signed URL when reading the file.
 */
export const useOpenConversationFile = (
  onOpened?: () => void,
): ((entry: ConversationFileEntry) => Promise<boolean>) => {
  return useCallback(
    async (entry: ConversationFileEntry) => {
      const kind = conversationFileOpenKind(entry);
      if (kind === "local") {
        openDisplayPayloadTab(entry.payload);
        onOpened?.();
        return true;
      }
      if (kind === "cloud-not-stored") {
        showToast({
          title: "File isn’t stored in Drive",
          description:
            "This output stayed in the agent workspace and has no reusable cloud file to open.",
          variant: "error",
        });
        return false;
      }
      try {
        openDisplayPayloadTab({ ...entry.payload, cloudDrivePath: entry.cloudDriveFile!.path });
        onOpened?.();
        return true;
      } catch (error) {
        showToast({
          title: "Couldn’t open this Drive file",
          description:
            error instanceof Error && error.message.trim()
              ? error.message
              : "Try again in a moment.",
          variant: "error",
        });
        return false;
      }
    },
    [onOpened],
  );
};
