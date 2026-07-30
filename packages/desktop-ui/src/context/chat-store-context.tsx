import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export type ChatStorageMode = "cloud";

export type ChatStoreContextValue = {
  storageMode: ChatStorageMode;
  isLocalStorage: boolean;
  cloudFeaturesEnabled: boolean;
  isAuthenticated: boolean;
};

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null);

export const ChatStoreContextProvider = ({
  children,
  value,
}: {
  children: ReactNode;
  value: ChatStoreContextValue;
}) => (
  <ChatStoreContext.Provider value={value}>
    {children}
  </ChatStoreContext.Provider>
);

export const useChatStore = () => {
  const context = useContext(ChatStoreContext);
  if (!context) {
    throw new Error("useChatStore must be used within ChatStoreProvider");
  }
  return context;
};
