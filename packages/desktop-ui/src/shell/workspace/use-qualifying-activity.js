import { useMemo, useSyncExternalStore } from "react";
import { useChatRuntime } from "@/context/use-chat-runtime";
import {
  getActivityRowCompletedAtMs,
  getActivityRowStatus,
  groupActivityTasks,
} from "@/features/chat/lib/event-transforms";

// Terminal (done / failed / paused / canceled) agents drop out of the activity
// index this long after their last activity; running agents are never hidden.
// Single source of truth shared by the rendered Activity list (WorkspaceSections)
// and the shell's authoritative right-workspace visibility (WorkspaceHomeSurface
// and the global Models control), so the two can never diverge.
export const TERMINAL_ROW_AUTOHIDE_MS = 30 * 60 * 1000;

// Coarse 60s cadence: terminal rows fall out ~30 minutes after their last
// activity even when nothing else in the conversation is changing.
const COARSE_TICK_MS = 60_000;

// One process-wide coarse clock so every right-workspace consumer (the Activity
// strip and the global Models control) recomputes the auto-hide expiry on the
// exact same tick — independent per-hook intervals could otherwise drift up to a
// minute apart and let the strip and the button disappear at slightly different
// times. The interval is only armed while at least one consumer is subscribed.
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
    // Refresh on arm so the first snapshot after a quiet period isn't stale.
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

// While there are no terminal rows the count is running-only, so the clock value
// is irrelevant: return a stable snapshot and never subscribe (no interval).
function subscribeNever() {
  return () => {};
}
function getStaticNowSnapshot() {
  return 0;
}

/**
 * Number of Activity rows that legitimately qualify to appear in the ambient
 * (off-search) Activity list: every running row, plus terminal rows still inside
 * the 30-minute auto-hide window. This mirrors WorkspaceSections' off-search
 * `visibleActivityRows` count exactly — search/quick-search only ever narrows the
 * set further, so the ambient qualifying count is the correct "is anything
 * legitimately on the right?" signal.
 *
 * The raw `conversation.tasks.length` is NOT that signal: a conversation keeps
 * its finished tasks long after their rows have auto-hidden, which is why gating
 * the right workspace on the raw count left an empty gutter (and a stray Models
 * button) mounted with nothing to show.
 *
 * @returns {number}
 */
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

  // Shared coarse clock, but only subscribe while terminal rows exist — a
  // running-only list has nothing to expire, so it needn't re-render on ticks.
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

/**
 * Whether any Activity row legitimately qualifies to be shown right now.
 * @returns {boolean}
 */
export function useHasQualifyingActivity() {
  return useQualifyingActivityCount() > 0;
}
