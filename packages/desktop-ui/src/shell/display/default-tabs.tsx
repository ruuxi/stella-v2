import { createElement } from "react";
import { ChatPanelTab, type ChatPanelOpenRequest } from "@/shell/ChatSidebar";
import { useChatRuntime } from "@/context/use-chat-runtime";
import { useChatMessages } from "@/context/use-chat-messages";
import { TrashTabContent } from "./TrashTabContent";
import { HomeLauncherTab } from "./HomeLauncherTab";
import { displayTabs, useDisplayPanelExpanded } from "@/features/workspace-display/tab-store";
import { engineOverlay } from "./engine-overlay-store";
import {
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
  registerWorkspaceDefaultTabs,
} from "@/features/workspace-display/default-tabs";
import type { OpenTabOptions } from "@/features/workspace-display/types";

export {
  CHAT_DISPLAY_TAB_ID,
  HOME_DISPLAY_TAB_ID,
  TRASH_DISPLAY_TAB_ID,
} from "@/features/workspace-display/default-tabs";

function ChatDisplayTab({
  openRequest,
}: {
  openRequest: ChatPanelOpenRequest | null;
}) {
  const panelExpanded = useDisplayPanelExpanded();
  const chat = useChatRuntime();
  const messages = useChatMessages();

  return (
    <ChatPanelTab
      openRequest={openRequest}
      wideLayout={panelExpanded}
      messages={messages}
      isStreaming={chat.conversation.isStreaming}
      runtimeStatusText={chat.conversation.streaming.runtimeStatusText}
      activeToolCallId={chat.conversation.streaming.activeToolCallId}
      activeToolName={chat.conversation.streaming.activeToolName}
      isToolActive={chat.conversation.streaming.isToolActive}
      pendingUserMessageId={chat.conversation.pendingUserMessageId}
      queuedUserMessages={chat.conversation.streaming.queuedUserMessages}
      removeQueuedUserMessage={
        chat.conversation.streaming.removeQueuedUserMessage
      }
      hasOlderMessages={chat.conversation.hasOlderMessages}
      hasNewerMessages={chat.conversation.hasNewerMessages}
      isLoadingOlder={chat.conversation.isLoadingOlder}
      isLoadingNewer={chat.conversation.isLoadingNewer}
      isInitialLoading={chat.conversation.isInitialLoading}
      onLoadOlder={chat.conversation.loadOlderMessages}
      onLoadNewer={chat.conversation.loadNewerMessages}
      onLoadLatest={chat.conversation.loadLatestMessages}
      onSend={chat.conversation.sendMessageWithContext}
      onStop={chat.conversation.cancelCurrentStream}
    />
  );
}

export function openChatDisplayTab(
  openRequest: ChatPanelOpenRequest | null = null,
  opts?: OpenTabOptions,
): void {
  displayTabs.openTab(
    {
      id: CHAT_DISPLAY_TAB_ID,
      kind: "chat",
      title: "Chat",
      render: () => createElement(ChatDisplayTab, { openRequest }),
    },
    opts,
  );
}

export function openHomeDisplayTab(): void {
  displayTabs.openTab({
    id: HOME_DISPLAY_TAB_ID,
    kind: "home",
    title: "Home",
    tooltip: "Jump into Files, Trash, and more",
    render: () => createElement(HomeLauncherTab),
  });
}

export function ensureChatDisplayTab(): void {
  openChatDisplayTab(null, { activate: false, openPanel: false });
}

export function openTrashDisplayTab(): void {
  displayTabs.openTab({
    id: TRASH_DISPLAY_TAB_ID,
    kind: "trash",
    title: "Trash",
    render: () => createElement(TrashTabContent),
  });
}

export function openModelPicker(): void {
  engineOverlay.setOpen(true);
}

registerWorkspaceDefaultTabs({
  openChatDisplayTab: (openRequest, opts) =>
    openChatDisplayTab(openRequest as ChatPanelOpenRequest | null, opts),
  openHomeDisplayTab,
  ensureChatDisplayTab,
  openTrashDisplayTab,
  openModelPicker,
});
