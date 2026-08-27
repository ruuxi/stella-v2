import type { CloudApp } from "./cloud-api";

type Snapshot = {
  accountScope: string | null;
  titles: Readonly<Record<string, string>>;
};

const EMPTY: Snapshot = { accountScope: null, titles: Object.freeze({}) };
let snapshot = EMPTY;
const listeners = new Set<() => void>();

const sameTitles = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean => {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
};

export const cloudAppTitles = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): Snapshot {
    return snapshot;
  },
  replace(accountScope: string, apps: readonly CloudApp[]): void {
    const titles = Object.freeze(
      Object.fromEntries(apps.map((app) => [app.appId, app.title])),
    );
    if (
      snapshot.accountScope === accountScope &&
      sameTitles(snapshot.titles, titles)
    ) {
      return;
    }
    snapshot = { accountScope, titles };
    for (const listener of listeners) listener();
  },
  clear(accountScope?: string): void {
    if (accountScope && snapshot.accountScope !== accountScope) return;
    if (snapshot === EMPTY) return;
    snapshot = EMPTY;
    for (const listener of listeners) listener();
  },
};

