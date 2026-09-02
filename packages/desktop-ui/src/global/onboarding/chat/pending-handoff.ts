/**
 * Hand-off from onboarding into the first real conversation.
 *
 * Onboarding finishes before the root layout has selected (or created) the
 * cloud conversation, so anything that must land in that conversation is
 * parked in shared UI state and consumed once by the chat surface:
 *
 *  - the discovery greeting Stella wrote from the synthesized profile,
 *    appended as her first message in the thread;
 *  - a composer draft — the starter the user tapped on the finale, or the
 *    text they typed into the onboarding composer to skip straight in.
 */
import { useEffect } from "react";
import { uiState } from "@/platform/ui-state";

const PENDING_WELCOME_KEY = "stella-onboarding-pending-welcome";
const PENDING_COMPOSER_KEY = "stella-onboarding-pending-composer";

export const setPendingDiscoveryWelcome = (message: string) => {
  const trimmed = message.trim();
  if (!trimmed) return;
  uiState.setItem(PENDING_WELCOME_KEY, trimmed);
};

export const takePendingDiscoveryWelcome = (): string | null => {
  const value = uiState.getItem(PENDING_WELCOME_KEY);
  if (value === null) return null;
  uiState.removeItem(PENDING_WELCOME_KEY);
  return value;
};

export type PendingComposerDraft = {
  text: string;
  /** Submit as soon as the composer is able to, instead of leaving a draft. */
  send: boolean;
};

export const setPendingComposerDraft = (draft: PendingComposerDraft) => {
  const text = draft.text.trim();
  if (!text) return;
  uiState.setItem(
    PENDING_COMPOSER_KEY,
    JSON.stringify({ text, send: draft.send }),
  );
};

export const peekPendingComposerDraft = (): PendingComposerDraft | null => {
  const raw = uiState.getItem(PENDING_COMPOSER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingComposerDraft>;
    if (typeof parsed?.text !== "string" || !parsed.text.trim()) {
      uiState.removeItem(PENDING_COMPOSER_KEY);
      return null;
    }
    return { text: parsed.text, send: parsed.send === true };
  } catch {
    uiState.removeItem(PENDING_COMPOSER_KEY);
    return null;
  }
};

export const takePendingComposerDraft = (): PendingComposerDraft | null => {
  const draft = peekPendingComposerDraft();
  if (draft) uiState.removeItem(PENDING_COMPOSER_KEY);
  return draft;
};

export const clearPendingHandoff = () => {
  uiState.removeItem(PENDING_WELCOME_KEY);
  uiState.removeItem(PENDING_COMPOSER_KEY);
};

/**
 * Appends the parked discovery greeting to the active conversation the
 * first time one is selected. Mounted by the root layout, which owns
 * conversation selection; runs at most once per parked greeting.
 */
export function usePendingDiscoveryWelcome(conversationId: string | null) {
  useEffect(() => {
    if (!conversationId) return;
    const persist = window.electronAPI?.localChat?.persistDiscoveryWelcome;
    if (!persist) return;
    const message = takePendingDiscoveryWelcome();
    if (!message) return;
    void persist({ conversationId, message }).catch((error) => {
      console.error(
        "[onboarding-chat] Failed to persist the discovery greeting.",
        error,
      );
    });
  }, [conversationId]);
}
