import { createContext, useContext } from "react";
import type { UserRowViewModel } from "@/features/chat/conversation-row-types";

/**
 * Quick per-user-message actions surfaced in the hover action row next to
 * Copy. Both operate relative to the specific user message they are
 * attached to:
 *
 *  - `rewind` truncates the CURRENT conversation at that message (removing
 *    it and everything after) and loads it back into this chat's composer.
 *  - `fork` branches the history *before* that message into a brand-new
 *    conversation and drops the message into the new chat's composer,
 *    leaving the original conversation untouched. Present ONLY in the
 *    multi-tab (orchestrator-off) experience where new tabs exist; omitted
 *    entirely in orchestrated mode, so the Fork button never renders there.
 *
 * The value is a STABLE object (its callbacks read live state through refs)
 * so every user row can consume it without re-rendering when conversation
 * state churns. Null outside a chat runtime (the buttons then hide).
 */
export type UserMessageActions = {
  rewind: (row: UserRowViewModel) => void;
  fork?: (row: UserRowViewModel) => void;
};

export const UserMessageActionsContext =
  createContext<UserMessageActions | null>(null);

export const useUserMessageActions = (): UserMessageActions | null =>
  useContext(UserMessageActionsContext);

/**
 * True while the conversation has a turn in flight. Fork / Rewind are
 * disabled (greyed, non-clickable) during this window and re-enable once the
 * turn settles — we never interrupt in-flight work. Split into its own
 * context so the action callbacks stay a stable object; only this boolean
 * flips at turn boundaries.
 */
export const UserMessageActionsBusyContext = createContext<boolean>(false);

export const useUserMessageActionsBusy = (): boolean =>
  useContext(UserMessageActionsBusyContext);
