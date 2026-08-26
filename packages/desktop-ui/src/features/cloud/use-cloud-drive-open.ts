import { useAction } from "convex/react";
import { useCallback } from "react";
import type { ConversationFileEntry } from "@/features/workspace-display/derive-conversation-files";
import { openDisplayPayloadTab } from "@/features/workspace-display/open-payload";
import { showToast } from "@/ui/toast";
import { driveApi } from "./cloud-api";

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
 * owner-scoped action resolves a short-lived signed URL at click time.
 */
export const useOpenConversationFile = (
  onOpened?: () => void,
): ((entry: ConversationFileEntry) => Promise<boolean>) => {
  const getCloudUrl = useAction(driveApi.getMyDriveFileUrl);
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
      // A browser popup must be created during the click's user-activation
      // window, before the signed-URL action awaits the network. Electron has
      // a privileged external-open bridge and does not need a placeholder.
      const nativeOpen = window.electronAPI?.system?.openExternal;
      const pendingWindow = nativeOpen
        ? null
        : window.open("about:blank", "_blank");
      if (pendingWindow) pendingWindow.opener = null;
      try {
        const { url } = await getCloudUrl({ path: entry.cloudDriveFile!.path });
        if (nativeOpen) {
          nativeOpen(url);
        } else if (pendingWindow) {
          pendingWindow.location.replace(url);
        } else {
          const opened = window.open(url, "_blank");
          if (!opened) {
            throw new Error("Your browser blocked the Drive file window.");
          }
          opened.opener = null;
        }
        onOpened?.();
        return true;
      } catch (error) {
        pendingWindow?.close();
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
    [getCloudUrl, onOpened],
  );
};
