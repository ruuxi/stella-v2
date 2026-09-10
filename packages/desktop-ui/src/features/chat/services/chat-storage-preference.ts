import { uiState } from "@/platform/ui-state";
import { useSyncExternalStore } from "react";

const KEY = "stella:chat-storage-mode";
const EVENT = "stella:chat-storage-changed";
export const isPrivateConversationId = (id: string | null | undefined) =>
  Boolean(id?.startsWith("local_"));
export const getChatStorageMode = (): "cloud" | "local" =>
  typeof window !== "undefined" &&
  window.electronAPI?.localChat &&
  uiState.getItem(KEY) === "local"
    ? "local"
    : "cloud";
const subscribe = (listener: () => void) => {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
};
export const useChatStorageMode = () =>
  useSyncExternalStore(subscribe, getChatStorageMode, () => "cloud" as const);
export const setChatStorageMode = async (mode: "cloud" | "local") => {
  await window.electronAPI?.system.setCloudSyncEnabled({
    enabled: mode === "cloud",
  });
  uiState.setItem(KEY, mode);
  window.dispatchEvent(new Event(EVENT));
};
export const createPrivateConversation = async () => {
  const id = `local_${crypto.randomUUID()}`;
  await window.electronAPI!.localChat.setActiveConversationId({
    conversationId: id,
  });
  return id;
};
export const selectPrivateConversation = async (requested: string | null) => {
  const cached =
    await window.electronAPI!.localChat.getOrCreateDefaultConversationId();
  const id = isPrivateConversationId(requested)
    ? requested
    : isPrivateConversationId(cached)
      ? cached
      : null;
  if (!id) return createPrivateConversation();
  await window.electronAPI!.localChat.setActiveConversationId({
    conversationId: id,
  });
  return id;
};
