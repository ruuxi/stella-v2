/**
 * Focus (lineage) view state for the single chat.
 *
 * Focus is the iMessage thread overlay: the timeline dims and only the rows
 * that belong to one message or one agent thread stay readable. It is a
 * lens over the one conversation, not a separate thread, so the state is a
 * single root per window. Opening focus from anywhere (a reply preview, a
 * "N replies" affordance, a Tasks row, an inline agent card) lands here.
 */
import { useEffect, useState } from "react";
import type { ConversationFocusRoot } from "@stella/contracts/reply-refs";

export type ConversationFocus = {
  conversationId: string;
  root: ConversationFocusRoot;
  /** Optional caller-supplied title (a task description, a message excerpt). */
  title?: string;
};

type Listener = (focus: ConversationFocus | null) => void;

let current: ConversationFocus | null = null;
const listeners = new Set<Listener>();

const emit = () => {
  for (const listener of listeners) listener(current);
};

export const getConversationFocus = (): ConversationFocus | null => current;

export const openConversationFocus = (focus: ConversationFocus): void => {
  if (
    current &&
    current.conversationId === focus.conversationId &&
    focusRootKey(current.root) === focusRootKey(focus.root)
  ) {
    if ((current.title ?? "") === (focus.title ?? "")) return;
  }
  current = focus;
  emit();
};

export const closeConversationFocus = (): void => {
  if (!current) return;
  current = null;
  emit();
};

export const subscribeToConversationFocus = (
  listener: Listener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const focusRootKey = (root: ConversationFocusRoot): string =>
  root.kind === "message" ? `message:${root.id}` : `agent:${root.threadId}`;

/** The active focus for one conversation, or null. */
export const useConversationFocus = (
  conversationId: string | null | undefined,
): ConversationFocus | null => {
  const [focus, setFocus] = useState<ConversationFocus | null>(() =>
    current && current.conversationId === conversationId ? current : null,
  );
  useEffect(() => {
    const sync = (next: ConversationFocus | null) => {
      setFocus(next && next.conversationId === conversationId ? next : null);
    };
    sync(current);
    return subscribeToConversationFocus(sync);
  }, [conversationId]);
  return focus;
};

export const __testing = {
  reset(): void {
    current = null;
    listeners.clear();
  },
};
