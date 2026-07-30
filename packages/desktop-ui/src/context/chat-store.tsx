import { useMemo } from "react";
import type { ReactNode } from "react";
import { useCloudMode } from "@/global/auth/hooks/use-cloud-mode";
import {
  ChatStoreContextProvider,
  useChatStore,
  type ChatStorageMode,
  type ChatStoreContextValue,
} from "./chat-store-context";

export { useChatStore };

export const ChatStoreProvider = ({ children }: { children: ReactNode }) => {
  const { cloudMode } = useCloudMode();

  // Cloud is the only authority for new turns. While automatic anonymous auth
  // is still bootstrapping, no conversation id is exposed and therefore no
  // turn can start; we must not silently route that interval into SQLite.
  const storageMode: ChatStorageMode = "cloud";
  // SQLite remains available as a cache/recovery overlay for desktop
  // execution. This is capability, not conversation ownership.
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
