import { useMemo } from "react";
import type { ReactNode } from "react";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import {
  ChatStoreContextProvider,
  LocalChatStoreProvider,
  useChatStore,
  type ChatStorageMode,
  type ChatStoreContextValue,
} from "./chat-store-context";

export { LocalChatStoreProvider, useChatStore };

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { cloudMode } = useCloudMode();

  // `storageMode` is the authority selected for NEW turns. A signed-in
  // desktop still has a local SQLite cache and live IPC overlays, but those
  // are not the transcript authority; passing "cloud" through startChat is
  // what binds the local execution to the DO-owned conversation.
  const storageMode: ChatStorageMode = cloudMode ? "cloud" : "local";
  const isLocalStorage = Boolean(window.electronAPI?.localChat);
  const cloudFeaturesEnabled = cloudMode;

  const value = useMemo<ChatStoreContextValue>(
    () => ({
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      isAuthenticated: cloudMode,
    }),
    [storageMode, isLocalStorage, cloudFeaturesEnabled, cloudMode],
  );

  return (
    <ChatStoreContextProvider value={value}>
      {children}
    </ChatStoreContextProvider>
  );
};
