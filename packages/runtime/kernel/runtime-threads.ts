/**
 * Active work is budgeted in SLOTS, not raw threads: a thread group
 * (several related threads spawned for one request) occupies one slot,
 * and an ungrouped thread is its own slot. Eviction flips whole slots
 * to 'evicted'; the rows survive and stay resumable via `send_message`
 * and stay in the `thread` table.
 */
import type { TaskLifecycleStatus } from "@stella/contracts/agent-runtime";

export const MAX_ACTIVE_RUNTIME_THREADS = 16;

/**
 * Cap on active member threads per group so one fan-out can't grow the
 * injected context block without bound. The 9th spawn into a group is
 * rejected with an instructive error (continue a member with
 * `send_message` instead).
 */
export const MAX_GROUP_MEMBER_THREADS = 8;

/**
 * Group keys are minted as `grp-<slug>` so the orchestrator (and the
 * pause routing) can tell a group id from a thread id at a glance.
 */
export const THREAD_GROUP_KEY_PREFIX = "grp-";

export type RuntimeThreadRecord = {
  conversationId: string;
  threadId: string;
  name: string;
  agentType: string;
  // Slot/eviction state, NOT execution state: "active" means the thread
  // still occupies a live roster slot (vs "evicted" — dropped from the
  // budget but resumable). This says nothing about whether the agent is
  // currently running a turn; that is `agentStatus`.
  status: "active" | "evicted";
  createdAt: number;
  lastUsedAt: number;
  // Live lifecycle status of the agent bound to this thread, sourced from
  // `runtime_agents.status`. "running" means the agent is executing a turn
  // right now; any terminal value (or absence) means it is idle/resumable.
  // This is the single source of truth for the active-vs-paused distinction
  // surfaced to the orchestrator.
  agentStatus?: TaskLifecycleStatus;
  // When the agent record was last written (turn start / terminal). Folded
  // into the last-active timestamp so a currently-running thread reads as
  // freshly active even if the durable thread row wasn't touched this turn.
  agentUpdatedAt?: number;
  description?: string;
  summary?: string;
};

/**
 * The one place the orchestrator-facing active-vs-paused distinction is
 * derived. Per the product model there is no "dead" thread: a thread is
 * either actively executing a turn or paused (idle but resumable). Only a
 * live "running" agent record counts as active; everything else — a
 * terminal run outcome or no agent record at all — is paused.
 */
export type RuntimeThreadLiveState = "active" | "paused";

export const deriveRuntimeThreadLiveState = (
  record: Pick<RuntimeThreadRecord, "agentStatus">,
): RuntimeThreadLiveState =>
  record.agentStatus === "running" ? "active" : "paused";

/**
 * Compact, machine-legible status token for a single thread. Primary token
 * is always active/paused; a paused thread whose last run errored keeps that
 * detail (still resumable, but worth flagging) so the orchestrator isn't
 * flying blind on failures.
 */
export const formatRuntimeThreadStatusLabel = (
  record: Pick<RuntimeThreadRecord, "agentStatus">,
): string => {
  if (deriveRuntimeThreadLiveState(record) === "active") return "active";
  return record.agentStatus === "error"
    ? "paused (last run errored)"
    : "paused";
};

export const normalizeRuntimeThreadId = (value: string): string | undefined => {
  // Preserve case: conversation ids are case-sensitive and orchestrator thread
  // keys are derived directly from them.
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const estimateRuntimeTokens = (value: string): number => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Math.max(1, Math.ceil(trimmed.length / 4)) : 0;
};
