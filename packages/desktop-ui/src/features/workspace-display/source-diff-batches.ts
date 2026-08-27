import { useSyncExternalStore } from "react";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import { displayTabs } from "./tab-store";

export type SourceDiffBatch = {

  id: string;

  label?: string;

  createdAt: number;

  payloads: DisplayPayload[];
};

const MAX_BATCHES = 3;

export const SOURCE_DIFF_TAB_ID = "source-diff";

type Snapshot = {
  batches: ReadonlyArray<SourceDiffBatch>;
  activeBatchId: string | null;
};

const EMPTY: Snapshot = { batches: [], activeBatchId: null };

let state: Snapshot = EMPTY;
const listeners = new Set<() => void>();

const emit = (next: Snapshot) => {
  state = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): Snapshot => state;

export const useSourceDiffBatches = (): Snapshot =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

export const peekSourceDiffBatches = (): Snapshot => state;

export const sourceDiffBatches = {

  push(batch: SourceDiffBatch): void {
    if (batch.payloads.length === 0) return;
    const existing = state.batches.findIndex((entry) => entry.id === batch.id);
    if (existing >= 0) {
      const nextBatches = state.batches.slice();
      nextBatches[existing] = batch;
      emit({ batches: nextBatches, activeBatchId: state.activeBatchId });
      return;
    }
    const nextBatches = [batch, ...state.batches].slice(0, MAX_BATCHES);
    emit({ batches: nextBatches, activeBatchId: batch.id });
  },

  pushAndActivate(batch: SourceDiffBatch): void {
    if (batch.payloads.length === 0) return;
    const existing = state.batches.findIndex((entry) => entry.id === batch.id);
    if (existing >= 0) {
      const nextBatches = state.batches.slice();
      nextBatches[existing] = batch;
      emit({ batches: nextBatches, activeBatchId: batch.id });
      return;
    }
    const nextBatches = [batch, ...state.batches].slice(0, MAX_BATCHES);
    emit({ batches: nextBatches, activeBatchId: batch.id });
  },

  select(batchId: string): void {
    if (state.activeBatchId === batchId) return;
    if (!state.batches.some((entry) => entry.id === batchId)) return;
    emit({ batches: state.batches, activeBatchId: batchId });
  },
  clear(): void {
    if (state.batches.length === 0 && state.activeBatchId === null) return;
    emit(EMPTY);
  },
};

export const pushAndOpenSourceDiffBatch = (
  batch: SourceDiffBatch,
  spec: Parameters<typeof displayTabs.openTab>[0],
): void => {
  sourceDiffBatches.pushAndActivate(batch);
  displayTabs.openTab(spec);
};
