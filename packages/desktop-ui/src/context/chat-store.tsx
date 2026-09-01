import { useMemo } from "react";
import type { ReactNode } from "react";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import {
  ChatStoreContextProvider,
  LocalChatStoreProvider,
  useChatStore,
  type ChatStorageMode,
  type ChatStoreContextValue,
} from "./chat-store-context";

export { LocalChatStoreProvider, useChatStore };

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { isCloudConversationReady } = useCloudConversationSession();

  // Conversation ownership is never a renderer preference. Every authenticated
  // identity (including the automatically-created anonymous identity) owns a
  // cloud conversation; Electron's SQLite is only a rebuildable execution
  // cache for turns that run on this computer.
  const cloudFeaturesEnabled = isCloudConversationReady;
  const storageMode: ChatStorageMode = "cloud";
  const isLocalStorage = Boolean(window.electronAPI?.localChat);

  const value = useMemo<ChatStoreContextValue>(
    () => ({
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      isAuthenticated: isCloudConversationReady,
    }),
    [
      storageMode,
      isLocalStorage,
      cloudFeaturesEnabled,
      isCloudConversationReady,
    ],
  );

  return (
    <ChatStoreContextProvider value={value}>
      {children}
    </ChatStoreContextProvider>
  );
};
