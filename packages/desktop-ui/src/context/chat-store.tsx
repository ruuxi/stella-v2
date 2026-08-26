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

  // Conversation ownership is never a renderer preference. Every authenticated
  // identity (including the automatically-created anonymous identity) owns a
  // cloud conversation; Electron's SQLite is only a rebuildable execution
  // cache for turns that run on this computer.
  const cloudFeaturesEnabled = cloudMode;
  const storageMode: ChatStorageMode = "cloud";
  const isLocalStorage = Boolean(window.electronAPI?.localChat);

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
