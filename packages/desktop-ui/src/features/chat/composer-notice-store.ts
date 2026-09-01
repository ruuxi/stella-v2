/**
 * Store for "you need to act before Stella can continue" notices — the
 * user is signed out, their plan ran out of room, a provider key is
 * missing, a model is gated behind an upgrade.
 *
 * These used to be error toasts. A toast is the wrong shape for them: it
 * slides in at the corner, auto-dismisses after a few seconds, and is
 * easy to miss, while the thing it describes blocks the very composer
 * the user is looking at. So chat surfaces render the current notice as
 * a card pinned directly above the composer (the same slot the
 * agent-initiated connector connect card uses), where it stays until the
 * user acts on it, dismisses it, or sends again.
 *
 * Transient failures (network blips, timeouts, a blocked prompt) are not
 * notices and keep using the toast.
 */

import { useSyncExternalStore } from "react";
import { showToast, type ToastOptions } from "@/ui/toast";

export type ComposerNoticeKind = "sign-in" | "upgrade" | "limit" | "provider";

export type ComposerNoticeAction = {
  label: string;
  onClick: () => void;
};

export type ComposerNotice = {
  id: string;
  /**
   * Owning chat. `null` = unscoped, shown on every surface — used by
   * callers that know nothing about conversations (dictation, voice, the
   * submit-time plan check).
   */
  conversationId: string | null;
  kind: ComposerNoticeKind;
  title: string;
  description?: string;
  action?: ComposerNoticeAction;
  secondaryAction?: ComposerNoticeAction;
};

export type ComposerNoticeInput = Omit<ComposerNotice, "id"> & {
  id?: string;
};

let notices: ComposerNotice[] = [];
const listeners = new Set<() => void>();
let mountedSurfaces = 0;
let nextId = 0;

const emitChange = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => notices;

/** Current notices, newest last. */
export const getComposerNotices = (): readonly ComposerNotice[] => notices;

/**
 * Show (or replace) the notice for a conversation scope. One notice per
 * scope: a fresh limit/auth failure supersedes the previous one rather
 * than stacking, since the newest reason is the one the user must act on.
 */
export const showComposerNotice = (input: ComposerNoticeInput): string => {
  const id = input.id ?? `composer-notice-${++nextId}`;
  const next: ComposerNotice = { ...input, id };
  notices = [
    ...notices.filter((entry) => entry.conversationId !== input.conversationId),
    next,
  ];
  emitChange();
  return id;
};

export const dismissComposerNotice = (id: string): void => {
  if (!notices.some((entry) => entry.id === id)) return;
  notices = notices.filter((entry) => entry.id !== id);
  emitChange();
};

/**
 * Drop every notice a new send in `conversationId` makes stale: the one
 * scoped to that chat plus any unscoped one. If the problem persists the
 * failed run raises a fresh notice.
 */
export const clearComposerNotices = (
  conversationId: string | null | undefined,
): void => {
  const remaining = notices.filter(
    (entry) =>
      entry.conversationId !== null &&
      entry.conversationId !== (conversationId ?? null),
  );
  if (remaining.length === notices.length) return;
  notices = remaining;
  emitChange();
};

/** Test/reset hook. */
export const resetComposerNotices = (): void => {
  notices = [];
  emitChange();
};

/**
 * The notice a chat surface should show: the one scoped to its chat,
 * else an unscoped one. Newest wins within a scope by construction.
 */
export const selectComposerNotice = (
  entries: readonly ComposerNotice[],
  conversationId: string | null | undefined,
): ComposerNotice | null => {
  const scoped = conversationId
    ? entries.find((entry) => entry.conversationId === conversationId)
    : undefined;
  if (scoped) return scoped;
  return entries.find((entry) => entry.conversationId === null) ?? null;
};

export const useComposerNotice = (
  conversationId: string | null | undefined,
): ComposerNotice | null => {
  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return selectComposerNotice(entries, conversationId);
};

/**
 * Surfaces register while mounted so non-React callers can tell whether a
 * pinned notice would actually be visible somewhere. Windows without a
 * composer (the overlay, the pet) fall back to the toast.
 */
export const registerComposerNoticeSurface = (): (() => void) => {
  mountedSurfaces += 1;
  return () => {
    mountedSurfaces = Math.max(0, mountedSurfaces - 1);
  };
};

export const hasComposerNoticeSurface = (): boolean => mountedSurfaces > 0;

/**
 * Pin `notice` above the composer when a chat surface is mounted;
 * otherwise show `fallback` (or the notice's own content) as a toast so
 * the user is never left without feedback.
 */
export const presentComposerNotice = (
  notice: ComposerNoticeInput,
  fallback?: ToastOptions,
): void => {
  if (hasComposerNoticeSurface()) {
    showComposerNotice(notice);
    return;
  }
  showToast(
    fallback ?? {
      title: notice.title,
      description: notice.description,
      variant: "error",
      duration: 8000,
      action: notice.action,
      secondaryAction: notice.secondaryAction,
    },
  );
};
