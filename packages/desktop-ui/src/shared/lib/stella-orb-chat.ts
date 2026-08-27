import type { ChatContext } from "@/shared/types/electron";

export const STELLA_OPEN_PANEL_CHAT_EVENT = "stella:open-panel-chat";
export const STELLA_CLOSE_PANEL_EVENT = "stella:close-panel";
export const STELLA_OPEN_WORKSPACE_PANEL_EVENT = "stella:open-workspace-panel";
export const STELLA_COMPOSE_TEXT_EVENT = "stella:compose-text";

export type StellaOpenPanelChatDetail = {
  chatContext?: ChatContext | null;

  prefillText?: string;
};

export type StellaComposeTextDetail = {
  text: string;
  chatContext?: ChatContext | null;
  selectedText?: string | null;
};

export function dispatchOpenPanelChat(detail: StellaOpenPanelChatDetail = {}) {
  window.dispatchEvent(
    new CustomEvent<StellaOpenPanelChatDetail>(STELLA_OPEN_PANEL_CHAT_EVENT, {
      detail,
    }),
  );
}

export function dispatchComposeText(detail: StellaComposeTextDetail) {
  window.dispatchEvent(
    new CustomEvent<StellaComposeTextDetail>(STELLA_COMPOSE_TEXT_EVENT, {
      detail,
    }),
  );
}

export function dispatchClosePanel() {
  window.dispatchEvent(new CustomEvent(STELLA_CLOSE_PANEL_EVENT));
}

export function dispatchOpenWorkspacePanel() {
  window.dispatchEvent(new CustomEvent(STELLA_OPEN_WORKSPACE_PANEL_EVENT));
}

export const STELLA_SHOW_HOME_EVENT = "stella:show-home";

export function dispatchShowHome() {
  window.dispatchEvent(new CustomEvent(STELLA_SHOW_HOME_EVENT));
}
