import { useSyncExternalStore } from "react";
import type { ConversationSummary } from "@stella/contracts/local-chat";
import { uiState } from "@/platform/ui-state";

export const CONVERSATION_TABS_STORAGE_KEY = "stella.conversationTabs.v1";
const MAX_PERSISTED_TABS = 100;
const MAX_TITLE_CHARS = 240;
const LOCAL_CONVERSATION_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type ConversationTab = {
  conversationId: string;
  title: string;
  latestMessageAt?: number;
  latestMessageId?: string;
  /**
   * A message landed on this conversation while the user was looking at a
   * different tab. Persisted so a restart doesn't quietly drop the notice.
   */
  unread?: boolean;
};

export type ConversationTitleCursor = {
  latestMessageAt: number;
  latestMessageId: string;
};

export type ConversationTabsSnapshot = {
  tabs: readonly ConversationTab[];
};

type PersistedConversationTabs = {
  version: 1;
  tabs: ConversationTab[];
};

type Listener = () => void;

const normalizeId = (value: unknown): string =>
  typeof value === "string" && LOCAL_CONVERSATION_ID_RE.test(value.trim())
    ? value.trim()
    : "";

const normalizeTitleCursor = (value: {
  latestMessageAt?: unknown;
  latestMessageId?: unknown;
}): ConversationTitleCursor | null => {
  const latestMessageAt = value.latestMessageAt;
  const latestMessageId =
    typeof value.latestMessageId === "string"
      ? value.latestMessageId.trim()
      : "";
  return typeof latestMessageAt === "number" &&
    Number.isFinite(latestMessageAt) &&
    latestMessageId
    ? { latestMessageAt, latestMessageId }
    : null;
};

export const compareConversationTitleCursors = (
  left: ConversationTitleCursor,
  right: ConversationTitleCursor,
): number =>
  left.latestMessageAt !== right.latestMessageAt
    ? left.latestMessageAt - right.latestMessageAt
    : left.latestMessageId.localeCompare(right.latestMessageId);

const shouldApplyTitleCursor = (
  current: ConversationTab,
  incoming: ConversationTitleCursor | null,
): boolean => {
  if (!incoming) return true;
  const currentCursor = normalizeTitleCursor(current);
  if (!currentCursor) return true;
  if (incoming.latestMessageId === currentCursor.latestMessageId) return true;
  return compareConversationTitleCursors(incoming, currentCursor) > 0;
};

export const normalizeConversationTabTitle = (value: unknown): string => {
  const title =
    typeof value === "string"
      ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS)
      : "";
  return title || "New chat";
};

const readPersistedTabs = (): ConversationTab[] => {
  const raw = uiState.getItem(CONVERSATION_TABS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedConversationTabs>;
    if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) return [];
    const seen = new Set<string>();
    const tabs: ConversationTab[] = [];
    for (const candidate of parsed.tabs) {
      const conversationId = normalizeId(candidate?.conversationId);
      if (!conversationId || seen.has(conversationId)) continue;
      seen.add(conversationId);
      const cursor = normalizeTitleCursor(candidate ?? {});
      tabs.push({
        conversationId,
        title: normalizeConversationTabTitle(candidate?.title),
        ...(cursor ?? {}),
        ...(candidate?.unread === true ? { unread: true } : {}),
      });
      if (tabs.length >= MAX_PERSISTED_TABS) break;
    }
    return tabs;
  } catch {
    return [];
  }
};

let snapshot: ConversationTabsSnapshot = { tabs: readPersistedTabs() };
const listeners = new Set<Listener>();

const persist = (tabs: readonly ConversationTab[]) => {
  const payload: PersistedConversationTabs = {
    version: 1,
    tabs: tabs.slice(0, MAX_PERSISTED_TABS).map((tab) => ({ ...tab })),
  };
  uiState.setItem(CONVERSATION_TABS_STORAGE_KEY, JSON.stringify(payload));
};

const emit = (tabs: readonly ConversationTab[]) => {
  snapshot = { tabs };
  persist(tabs);
  for (const listener of listeners) listener();
};

const findTabIndex = (conversationId: string) =>
  snapshot.tabs.findIndex((tab) => tab.conversationId === conversationId);

export const conversationTabs = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): ConversationTabsSnapshot {
    return snapshot;
  },
  openConversation(
    conversationIdInput: string,
    titleInput?: string,
    cursorInput?: ConversationTitleCursor,
  ): void {
    const conversationId = normalizeId(conversationIdInput);
    if (!conversationId) return;
    const existingIndex = findTabIndex(conversationId);
    if (existingIndex >= 0) {
      if (titleInput === undefined) return;
      const title = normalizeConversationTabTitle(titleInput);
      const current = snapshot.tabs[existingIndex];
      const cursor = normalizeTitleCursor(cursorInput ?? {});
      if (!current || !shouldApplyTitleCursor(current, cursor)) return;
      if (
        current.title === title &&
        (!cursor ||
          (current.latestMessageAt === cursor.latestMessageAt &&
            current.latestMessageId === cursor.latestMessageId))
      ) {
        return;
      }
      emit(
        snapshot.tabs.map((tab, index) =>
          index === existingIndex ? { ...tab, title, ...(cursor ?? {}) } : tab,
        ),
      );
      return;
    }
    const title = normalizeConversationTabTitle(titleInput);
    const cursor = normalizeTitleCursor(cursorInput ?? {});
    const tabs = [
      ...snapshot.tabs,
      { conversationId, title, ...(cursor ?? {}) },
    ];
    emit(
      tabs.length > MAX_PERSISTED_TABS
        ? tabs.slice(tabs.length - MAX_PERSISTED_TABS)
        : tabs,
    );
  },
  updateTitle(
    conversationIdInput: string,
    titleInput: string,
    cursorInput?: ConversationTitleCursor,
  ): void {
    const conversationId = normalizeId(conversationIdInput);
    const index = findTabIndex(conversationId);
    if (index < 0) return;
    const title = normalizeConversationTabTitle(titleInput);
    const current = snapshot.tabs[index];
    const cursor = normalizeTitleCursor(cursorInput ?? {});
    if (!current || !shouldApplyTitleCursor(current, cursor)) return;
    if (
      current.title === title &&
      (!cursor ||
        (current.latestMessageAt === cursor.latestMessageAt &&
          current.latestMessageId === cursor.latestMessageId))
    ) {
      return;
    }
    emit(
      snapshot.tabs.map((tab, tabIndex) =>
        tabIndex === index ? { ...tab, title, ...(cursor ?? {}) } : tab,
      ),
    );
  },
  mergeSummaries(summaries: readonly ConversationSummary[]): void {
    if (summaries.length === 0 || snapshot.tabs.length === 0) return;
    const summariesById = new Map(
      summaries.map((summary) => [summary.conversationId, summary]),
    );
    let changed = false;
    const tabs = snapshot.tabs.map((tab) => {
      const summary = summariesById.get(tab.conversationId);
      if (!summary) return tab;
      const title = normalizeConversationTabTitle(summary.title);
      const cursor = normalizeTitleCursor(summary);
      if (!shouldApplyTitleCursor(tab, cursor)) return tab;
      if (
        title === tab.title &&
        (!cursor ||
          (tab.latestMessageAt === cursor.latestMessageAt &&
            tab.latestMessageId === cursor.latestMessageId))
      ) {
        return tab;
      }
      changed = true;
      return { ...tab, title, ...(cursor ?? {}) };
    });
    if (changed) emit(tabs);
  },
  /**
   * Flag a background tab as having new activity. Only tabs that are open
   * carry the notice — an update for a conversation with no tab is ignored
   * rather than opening one.
   */
  markUnread(conversationIdInput: string): void {
    const conversationId = normalizeId(conversationIdInput);
    const index = findTabIndex(conversationId);
    if (index < 0) return;
    const current = snapshot.tabs[index];
    if (!current || current.unread) return;
    emit(
      snapshot.tabs.map((tab, tabIndex) =>
        tabIndex === index ? { ...tab, unread: true } : tab,
      ),
    );
  },
  markRead(conversationIdInput: string): void {
    const conversationId = normalizeId(conversationIdInput);
    const index = findTabIndex(conversationId);
    if (index < 0) return;
    const current = snapshot.tabs[index];
    if (!current?.unread) return;
    emit(
      snapshot.tabs.map((tab, tabIndex) => {
        if (tabIndex !== index) return tab;
        const next: ConversationTab = { ...tab };
        delete next.unread;
        return next;
      }),
    );
  },
  closeConversation(
    conversationIdInput: string,
    activeConversationIdInput: string | null,
  ): { closed: boolean; nextConversationId: string | null } {
    const conversationId = normalizeId(conversationIdInput);
    const activeConversationId = normalizeId(activeConversationIdInput);
    const index = findTabIndex(conversationId);
    if (index < 0) {
      return {
        closed: false,
        nextConversationId: activeConversationId || null,
      };
    }
    const tabs = snapshot.tabs.filter(
      (tab) => tab.conversationId !== conversationId,
    );
    const nextConversationId =
      activeConversationId === conversationId
        ? (tabs[index]?.conversationId ??
          tabs[index - 1]?.conversationId ??
          null)
        : activeConversationId || null;
    emit(tabs);
    return { closed: true, nextConversationId };
  },
  reorderConversation(conversationIdInput: string, targetIndex: number): void {
    const conversationId = normalizeId(conversationIdInput);
    const index = findTabIndex(conversationId);
    if (index < 0) return;
    const boundedTarget = Math.max(
      0,
      Math.min(Math.floor(targetIndex), snapshot.tabs.length - 1),
    );
    if (index === boundedTarget) return;
    const tabs = [...snapshot.tabs];
    const [tab] = tabs.splice(index, 1);
    if (!tab) return;
    tabs.splice(boundedTarget, 0, tab);
    emit(tabs);
  },
  reloadPersisted(): void {
    snapshot = { tabs: readPersistedTabs() };
    for (const listener of listeners) listener();
  },
  reset(): void {
    snapshot = { tabs: [] };
    uiState.removeItem(CONVERSATION_TABS_STORAGE_KEY);
    for (const listener of listeners) listener();
  },
};

export const useConversationTabs = (): ConversationTabsSnapshot =>
  useSyncExternalStore(
    conversationTabs.subscribe,
    conversationTabs.getSnapshot,
    conversationTabs.getSnapshot,
  );
