import { useMemo, useSyncExternalStore } from "react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import {
  getActivityRowCompletedAtMs,
  getActivityRowStatus,
  groupActivityTasks,
} from "@/features/chat/lib/event-transforms";

export const TERMINAL_ROW_AUTOHIDE_MS = 30 * 60 * 1000;

const COARSE_TICK_MS = 60_000;

let coarseNowMs = Date.now();
let coarseIntervalId = null;
const coarseListeners = new Set();

function emitCoarseNow() {
  coarseNowMs = Date.now();
  for (const listener of coarseListeners) listener();
}

function subscribeCoarseNow(listener) {
  coarseListeners.add(listener);
  if (coarseIntervalId === null) {

    coarseNowMs = Date.now();
    coarseIntervalId = window.setInterval(emitCoarseNow, COARSE_TICK_MS);
  }
  return () => {
    coarseListeners.delete(listener);
    if (coarseListeners.size === 0 && coarseIntervalId !== null) {
      window.clearInterval(coarseIntervalId);
      coarseIntervalId = null;
    }
  };
}

function getCoarseNowSnapshot() {
  return coarseNowMs;
}

function subscribeNever() {
  return () => {};
}
function getStaticNowSnapshot() {
  return 0;
}

export function useQualifyingActivityCount() {
  const chat = useChatRuntime();
  const tasks = chat.conversation.tasks;

  const groupedRows = useMemo(() => groupActivityTasks(tasks), [tasks]);

  const runningCount = useMemo(
    () =>
      groupedRows.filter((row) => getActivityRowStatus(row) === "running")
        .length,
    [groupedRows],
  );

  const doneRows = useMemo(
    () => groupedRows.filter((row) => getActivityRowStatus(row) !== "running"),
    [groupedRows],
  );

  const hasDoneRows = doneRows.length > 0;
  const nowMs = useSyncExternalStore(
    hasDoneRows ? subscribeCoarseNow : subscribeNever,
    hasDoneRows ? getCoarseNowSnapshot : getStaticNowSnapshot,
  );

  const visibleDoneCount = useMemo(
    () =>
      doneRows.filter(
        (row) =>
          nowMs - getActivityRowCompletedAtMs(row) <= TERMINAL_ROW_AUTOHIDE_MS,
      ).length,
    [doneRows, nowMs],
  );

  return runningCount + visibleDoneCount;
}

export function useHasQualifyingActivity() {
  return useQualifyingActivityCount() > 0;
}
