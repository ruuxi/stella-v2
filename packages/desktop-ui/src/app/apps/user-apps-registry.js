const EMPTY_APPS = Object.freeze([]);
const USER_APP_STATUSES = new Set([
  "stopped",
  "installing",
  "starting",
  "running",
  "stopping",
  "error",
]);

const initialSnapshot = Object.freeze({
  phase: "loading",
  apps: EMPTY_APPS,
  error: null,
  refreshing: false,
});

let snapshot = initialSnapshot;
let initialized = false;
let inFlight = null;
let refreshQueued = false;
let unsubscribeChanged = null;
let retryTimer = null;
let retryAttempt = 0;
const subscribers = new Set();

const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const notify = () => {
  for (const subscriber of subscribers) {
    try {
      subscriber();
    } catch {

    }
  }
};

const publish = (next) => {
  snapshot = Object.freeze(next);
  notify();
};

const normalizeApps = (result) => {
  const candidates = Array.isArray(result?.apps) ? result.apps : [];
  return Object.freeze(
    candidates
      .filter(
        (app) =>
          app &&
          typeof app.slug === "string" &&
          app.meta &&
          typeof app.meta.label === "string" &&
          typeof app.meta.createdAt === "string",
      )
      .map((app) =>
        Object.freeze({
          slug: app.slug,
          meta: Object.freeze({
            label: app.meta.label,
            createdAt: app.meta.createdAt,
          }),
          status: USER_APP_STATUSES.has(app.status) ? app.status : "stopped",
        }),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug)),
  );
};

const errorMessage = (error) =>
  error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Stella couldn't read your apps folder.";

const userAppsApi = () => window.electronAPI?.userApps ?? null;

const clearRetryTimer = () => {
  if (retryTimer === null) return;
  window.clearTimeout(retryTimer);
  retryTimer = null;
};

const scheduleRetry = () => {
  if (subscribers.size === 0 || retryTimer !== null) return;
  const delay = Math.min(
    RETRY_INITIAL_MS * 2 ** Math.min(retryAttempt, 5),
    RETRY_MAX_MS,
  );
  retryAttempt += 1;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    if (subscribers.size > 0) void requestApps("refresh");
  }, delay);
};

const requestApps = (method) => {
  clearRetryTimer();
  const api = userAppsApi();
  if (!api || typeof api.list !== "function") {
    initialized = true;
    publish({
      phase: "unsupported",
      apps: snapshot.apps,
      error: null,
      refreshing: false,
    });
    return Promise.resolve();
  }

  if (inFlight) {
    refreshQueued = true;
    const current = inFlight;
    return current.then(() => inFlight ?? undefined);
  }

  const hasApps = snapshot.apps.length > 0;
  publish({
    ...snapshot,
    phase: initialized && hasApps ? snapshot.phase : "loading",
    error: initialized && hasApps ? snapshot.error : null,
    refreshing: initialized,
  });

  const operation =
    method === "refresh" && typeof api.refresh === "function"
      ? api.refresh.bind(api)
      : api.list.bind(api);

  inFlight = Promise.resolve()
    .then(operation)
    .then((result) => {
      initialized = true;
      retryAttempt = 0;
      publish({
        phase: "ready",
        apps: normalizeApps(result),
        error: null,
        refreshing: false,
      });
    })
    .catch((error) => {
      initialized = true;
      publish({
        phase: "error",
        apps: snapshot.apps,
        error: errorMessage(error),
        refreshing: false,
      });
      scheduleRetry();
    })
    .finally(() => {
      inFlight = null;
      if (refreshQueued) {
        refreshQueued = false;
        void requestApps("refresh");
      }
    });

  return inFlight;
};

const attachChangeListener = () => {
  if (unsubscribeChanged) return;
  const api = userAppsApi();
  const onChanged = api?.onChanged ?? api?.onUpdated;
  if (typeof onChanged !== "function") return;
  unsubscribeChanged = onChanged(() => {
    void requestApps("refresh");
  });
};

export const subscribe = (subscriber) => {
  subscribers.add(subscriber);
  attachChangeListener();
  if (!initialized && !inFlight) {
    void requestApps("list");
  } else if (initialized && subscribers.size === 1) {
    void requestApps("refresh");
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      unsubscribeChanged?.();
      unsubscribeChanged = null;
      clearRetryTimer();
    }
  };
};

export const getSnapshot = () => snapshot;

export const getServerSnapshot = () => initialSnapshot;

export const getUserApp = (slug) =>
  snapshot.apps.find((app) => app.slug === slug);

export const refreshUserApps = () => requestApps("refresh");

export const stopUserApp = async (slug) => {
  const api = userAppsApi();
  if (typeof api?.stop !== "function") {
    throw new Error("Apps are unavailable on this device.");
  }
  const result = await api.stop(slug);
  await requestApps("refresh");
  return result;
};

export const __resetUserAppsRegistryForTests = () => {
  unsubscribeChanged?.();
  unsubscribeChanged = null;
  subscribers.clear();
  snapshot = initialSnapshot;
  initialized = false;
  inFlight = null;
  refreshQueued = false;
  clearRetryTimer();
  retryAttempt = 0;
};
