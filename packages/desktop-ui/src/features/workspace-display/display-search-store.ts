import { useSyncExternalStore } from "react";

type DisplaySearchSnapshot = {
  query: string;
  open: boolean;
  focusRequest: number;
};

let snapshot: DisplaySearchSnapshot = {
  query: "",
  open: false,
  focusRequest: 0,
};
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const update = (next: DisplaySearchSnapshot): void => {
  snapshot = next;
  emit();
};

export const displaySearchStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getQuery(): string {
    return snapshot.query;
  },
  getSnapshot(): DisplaySearchSnapshot {
    return snapshot;
  },
  setQuery(next: string): void {
    if (snapshot.query === next) return;
    update({ ...snapshot, query: next });
  },
  open(): void {
    update({
      ...snapshot,
      open: true,
      focusRequest: snapshot.focusRequest + 1,
    });
  },
  close(): void {
    if (!snapshot.open && snapshot.query === "") return;
    update({ ...snapshot, query: "", open: false });
  },
  clear(): void {
    if (snapshot.query === "") return;
    update({ ...snapshot, query: "" });
  },
};

export const useDisplaySearchQuery = (): string =>
  useSyncExternalStore(
    displaySearchStore.subscribe,
    () => displaySearchStore.getSnapshot().query,
    () => displaySearchStore.getSnapshot().query,
  );

export const useDisplaySearchOpen = (): boolean =>
  useSyncExternalStore(
    displaySearchStore.subscribe,
    () => displaySearchStore.getSnapshot().open,
    () => displaySearchStore.getSnapshot().open,
  );

export const useDisplaySearchFocusRequest = (): number =>
  useSyncExternalStore(
    displaySearchStore.subscribe,
    () => displaySearchStore.getSnapshot().focusRequest,
    () => displaySearchStore.getSnapshot().focusRequest,
  );

export const matchesQuery = (haystack: string, q: string): boolean => {
  if (!q) return true;
  return haystack.toLowerCase().includes(q.toLowerCase());
};
