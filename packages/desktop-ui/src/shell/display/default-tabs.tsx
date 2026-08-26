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

/**
 * Chat display tab body — the live in-panel chat, available from any route
 * so users can keep talking to Stella while a viewer is open. (The home
 * index now lives in the right sidebar's Tasks section, not here.)
 */
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
      isStreamingResponseText={
        chat.conversation.streaming.isStreamingResponseText
      }
      runtimeStatusText={chat.conversation.streaming.runtimeStatusText}
      activeToolCallId={chat.conversation.streaming.activeToolCallId}
      activeToolName={chat.conversation.streaming.activeToolName}
      latestCompletedTool={chat.conversation.streaming.latestCompletedTool}
      hasToolActivity={chat.conversation.streaming.hasToolActivity}
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

/**
 * Open the Home launcher tab — the quiet launcher of the other display
 * surfaces shown when the user summons the panel while on home. Home itself
 * is the chat, so the panel never opens to a duplicate chat there.
 */
export function openHomeDisplayTab(): void {
  displayTabs.openTab({
    id: HOME_DISPLAY_TAB_ID,
    kind: "home",
    title: "Home",
    tooltip: "Jump into Files, Trash, and more",
    render: () => createElement(HomeLauncherTab),
  });
}

/**
 * Ensure the Chat tab is registered. The tab is always present so users
 * can switch to it from any route — content adapts inside `ChatDisplayTab`
 * based on the active route. This is a passive register: it never steals
 * activation from the user's current selection or opens the panel.
 */
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

/**
 * Open the Models picker. It is a footer popover now, anchored by whichever
 * footer is on screen, so this only flips the shared store — it deliberately
 * does not move or open the right sidebar.
 */
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
