import {
  UI_STATE_DEV_ENDPOINT,
  UI_STATE_DEV_EVENT,
  type UiStateChanges,
  type UiStateDevChangedEvent,
} from "@stella/contracts/ui-state";

const FLUSH_DELAY_MS = 10;

const hasWindow = typeof window !== "undefined";

const memory = new Map<string, string>(
  Object.entries((hasWindow ? window.__stellaUiState : undefined) ?? {}),
);

type WriteAdapter = {
  flushChanges: (changes: UiStateChanges) => void;
  clear: () => void;
};

const getStorageArea = (): Storage | null => {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
};

const dispatchStorageEvent = (
  key: string,
  oldValue: string | null,
  newValue: string | null,
) => {
  try {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        oldValue,
        newValue,
        url: window.location.href,

        storageArea: getStorageArea(),
      }),
    );
  } catch {

  }
};

const applyRemoteChanges = (changes: UiStateChanges) => {
  for (const [key, value] of Object.entries(changes)) {
    const oldValue = memory.get(key) ?? null;
    if (value === null) {
      if (!memory.has(key)) continue;
      memory.delete(key);
    } else {
      if (oldValue === value) continue;
      memory.set(key, value);
    }
    dispatchStorageEvent(key, oldValue, value);
  }
};

const createElectronAdapter = (): WriteAdapter | null => {
  const api = window.electronAPI?.uiState;
  if (!api) return null;
  api.onChanged(applyRemoteChanges);
  return {
    flushChanges: (changes) => api.apply(changes),
    clear: () => api.clear(),
  };
};

const createDevServerAdapter = (): WriteAdapter | null => {
  const hot = import.meta.hot;
  if (!hot) return null;
  const clientId = Math.random().toString(36).slice(2);
  hot.on(UI_STATE_DEV_EVENT, (data: UiStateDevChangedEvent) => {
    if (data.clientId === clientId) return;
    applyRemoteChanges(data.changes);
  });
  const post = (body: Record<string, unknown>) => {
    void fetch(UI_STATE_DEV_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, ...body }),

      keepalive: true,
    }).catch(() => {});
  };
  return {
    flushChanges: (changes) => post({ changes }),
    clear: () => post({ clear: true }),
  };
};

const noopAdapter: WriteAdapter = {
  flushChanges: () => {},
  clear: () => {},
};

const adapter = hasWindow
  ? (createElectronAdapter() ?? createDevServerAdapter() ?? noopAdapter)
  : noopAdapter;

let pending: UiStateChanges = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const flushPending = () => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const changes = pending;
  pending = {};
  if (Object.keys(changes).length > 0) {
    adapter.flushChanges(changes);
  }
};

const queueChange = (key: string, value: string | null) => {
  pending[key] = value;
  if (flushTimer === null) {
    flushTimer = setTimeout(flushPending, FLUSH_DELAY_MS);
  }
};

if (hasWindow) {
  window.addEventListener("pagehide", flushPending);
}

if (hasWindow && memory.size === 0) {
  try {
    const legacy = window.localStorage;
    for (let i = 0; legacy && i < legacy.length; i++) {
      const key = legacy.key(i);
      if (key === null || key.startsWith("better-auth")) continue;
      const value = legacy.getItem(key);
      if (value === null) continue;
      memory.set(key, value);
      queueChange(key, value);
    }
  } catch {

  }
}

export const uiState = {
  getItem(key: string): string | null {
    return memory.get(key) ?? null;
  },

  setItem(key: string, value: string): void {
    const normalized = String(value);
    if (memory.get(key) === normalized) return;
    memory.set(key, normalized);
    queueChange(key, normalized);
  },

  removeItem(key: string): void {
    if (!memory.has(key)) return;
    memory.delete(key);
    queueChange(key, null);
  },

  clear(): void {
    memory.clear();
    pending = {};
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    adapter.clear();
  },

  keys(): string[] {
    return [...memory.keys()];
  },
};
