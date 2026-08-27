import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";

const MATERIALIZED_KEY = "stella-media-materialized-jobs";
const MATERIALIZED_PAYLOADS_KEY = "stella-media-materialized-payloads";
const FAILED_NOTIFIED_KEY = "stella-media-failed-notified-jobs";
const MATERIALIZED_CAP = 1000;

const loadFromStorage = (key = MATERIALIZED_KEY): string[] => {
  try {
    const raw = uiState.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as string[] | { jobIds?: string[] };
    const ids = Array.isArray(parsed) ? parsed : parsed.jobIds;
    return ids ?? [];
  } catch {
    return [];
  }
};

export const capInMemory = (
  collection: Set<string> | Map<string, unknown>,
): void => {
  while (collection.size > MATERIALIZED_CAP) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) break;
    collection.delete(oldest);
  }
};

const persistToStorage = (ids: Set<string>, key = MATERIALIZED_KEY): void => {
  const trimmed = Array.from(ids).slice(-MATERIALIZED_CAP);
  uiState.setItem(key, JSON.stringify(trimmed));
};

const loadPayloadsFromStorage = (): Map<string, DisplayPayload> => {
  const map = new Map<string, DisplayPayload>();
  try {
    const raw = uiState.getItem(MATERIALIZED_PAYLOADS_KEY);
    if (!raw) return map;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return map;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as { jobId?: unknown; payload?: unknown };
      if (typeof record.jobId !== "string") continue;
      const payload = record.payload;
      if (!payload || typeof payload !== "object") continue;
      if ((payload as { kind?: unknown }).kind !== "media") continue;
      map.set(record.jobId, payload as DisplayPayload);
    }
  } catch {
    return new Map();
  }
  return map;
};

const persistPayloadsToStorage = (
  payloads: Map<string, DisplayPayload>,
): void => {
  const entries = Array.from(payloads.entries()).slice(-MATERIALIZED_CAP);
  uiState.setItem(
    MATERIALIZED_PAYLOADS_KEY,
    JSON.stringify(
      entries.map(([jobId, payload]) => ({
        jobId,
        payload,
      })),
    ),
  );
};

export const materializedJobs: Set<string> = new Set(loadFromStorage());
export const failedNotifiedJobs: Set<string> = new Set(
  loadFromStorage(FAILED_NOTIFIED_KEY),
);

const materializedPayloadsByJobId = loadPayloadsFromStorage();
const EMPTY_MATERIALIZED_PAYLOAD_SNAPSHOT = new Map<string, DisplayPayload>();
let materializedPayloadSnapshot = new Map(materializedPayloadsByJobId);
const materializedPayloadListeners = new Set<() => void>();

export const persistMaterializedJobs = (): void => {
  persistToStorage(materializedJobs);
};

export const persistFailedNotifiedJobs = (): void => {
  persistToStorage(failedNotifiedJobs, FAILED_NOTIFIED_KEY);
};

export const publishMaterializedMediaPayload = (
  payload: DisplayPayload,
): boolean => {
  if (payload.kind === "media" && payload.jobId) {
    const existing = materializedPayloadsByJobId.get(payload.jobId);

    if (existing) return false;
    materializedPayloadsByJobId.set(payload.jobId, payload);

    capInMemory(materializedPayloadsByJobId);
    persistPayloadsToStorage(materializedPayloadsByJobId);

    materializedPayloadSnapshot = new Map(materializedPayloadsByJobId);
  }
  for (const listener of materializedPayloadListeners) listener();
  return true;
};

export const useMaterializedMediaPayload = (
  jobId: string | undefined,
): DisplayPayload | null =>
  useSyncExternalStore(
    (listener) => {
      materializedPayloadListeners.add(listener);
      return () => materializedPayloadListeners.delete(listener);
    },
    () => (jobId ? (materializedPayloadsByJobId.get(jobId) ?? null) : null),
    () => null,
  );

export const useMaterializedMediaPayloadSnapshot = (): ReadonlyMap<
  string,
  DisplayPayload
> =>
  useSyncExternalStore(
    (listener) => {
      materializedPayloadListeners.add(listener);
      return () => materializedPayloadListeners.delete(listener);
    },
    () => materializedPayloadSnapshot,
    () => EMPTY_MATERIALIZED_PAYLOAD_SNAPSHOT,
  );

export const markMediaJobMaterialized = (jobId: string): void => {
  if (materializedJobs.has(jobId)) return;
  materializedJobs.add(jobId);

  capInMemory(materializedJobs);
  persistMaterializedJobs();
};
