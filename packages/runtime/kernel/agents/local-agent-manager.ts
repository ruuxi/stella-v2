/**
 * LocalAgentManager
 *
 * Two layers stacked on top of each other for every subagent thread, easy to
 * conflate:
 *
 *   1. Conversation layer — `subagentSession`, keyed by durable `threadId`,
 *      holds the long-lived `Agent` + message array. Lives across many
 *      runs and is only disposed when the task reaches a real terminal
 *      state (see end of `executeTask`) or `cancelAgent` is called.
 *
 *   2. Run-loop layer — `executeTask` / `runSubagent`. Each call to
 *      `runSubagent` is one user-turn → assistant-resolution cycle: a
 *      user message goes in, the assistant streams + uses tools until it
 *      decides to stop, then `runSubagent` returns.
 *
 * What this file historically called a "restart" only happens at layer 2.
 * Layer 1 is untouched: the session's message array is preserved across
 * the re-entry, so the LLM sees `[system, original user, prior turns,
 * follow-up user]` — i.e. the same conversation continuing with a new
 * user turn. The cached prefix doesn't change, prompt cache is preserved.
 *
 * The reason we have to exit and re-enter `executeTask` at all is that
 * `runSubagent` owns the agent loop for the duration of one user turn;
 * there is no way to splice an extra user message into the middle of an
 * in-flight assistant turn. So `send_input` aborts the current
 * `runSubagent` (ending the in-flight assistant turn early) and re-enters
 * with the follow-up as the next user message. The path funnels through
 * `deliverFollowUpAsNextTurn` → `tryStartNext` → `executeTask` →
 * `runSubagent`.
 *
 * Effect-native supervision (M5 surface 3): the manager's concurrency
 * plumbing runs as Effect fibers on one module-level ManagedRuntime while
 * the public surface stays a plain TS/Promise facade with the exact
 * pre-Effect names, signatures, event ordering, and error strings:
 *
 * - Each started attempt is supervised by a fiber in a keyed structure
 *   (`attemptFibers`, FiberMap-style: Map<threadId, {generation, fiber}>)
 *   forked into the manager's supervisory scope; the fiber joins the
 *   attempt promise and owns the slot-release bookkeeping.
 * - The stale-attempt takeover `setTimeout`s are deadline fibers in the
 *   same scope (`attemptTakeoverDeadlines`), interrupted by `clear` or by
 *   scope close at `shutdown()` — the Effect replacement for
 *   `clearTimeout` + `timer.unref()`.
 * - Completion detection is Deferred-based: per-thread update latches
 *   (`waitForAgentUpdate`) and settlement latches (`awaitAgentSettled`)
 *   wake blocking callers the moment a transition persists, instead of on
 *   a polling tick. SQLite stays the only truth — every wake re-reads the
 *   durable snapshot, and a bounded fallback re-check covers records
 *   rehydrated by out-of-band writers.
 * - CANCELLATION STAYS LATCH-COOPERATIVE. `cancelAgent` aborts the run's
 *   `AbortController`; the agent loop observes the latch, the provider
 *   emits a terminal, and the loop settles with its normal terminal
 *   events (message_end → turn_end → agent_end). No fiber running the
 *   loop is ever interrupted — fiber interruption is reserved for the
 *   manager's own supervisory fibers (deadlines, latch race losers,
 *   scope teardown). The `*Effect` variants exposed for the orchestrator
 *   simply wrap that cooperative path.
 */

import path from "path";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  type Fiber,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";
import type {
  TaskToolActivity,
  TaskLifecycleStatus,
  TerminalTaskLifecycleStatus,
} from "@stella/contracts/agent-runtime";
import { AGENT_IDS } from "@stella/contracts/agent-runtime";
import type {
  FileChangeRecord,
  ProducedFileRecord,
} from "@stella/contracts/file-changes";
import type {
  ToolContext,
  ToolResult,
  ToolUpdateCallback,
  AgentToolApi,
  AgentToolRequest,
  AgentToolSnapshot,
} from "../tools/types.js";
import { sanitizeForLogs, truncate } from "../tools/utils.js";
import type { PersistedAgentRecord } from "../storage/runtime-store.js";
import type {
  PersistedRuntimeThreadPayload,
  RuntimeThreadMessage,
} from "../storage/shared.js";
import type { RuntimeThreadRecord } from "../runtime-threads.js";
import type { ReasoningEffort } from "../preferences/local-preferences.js";
import type {
  AgentModelConfigSnapshot,
  AgentRuntimeEngine,
  SpawnEngineSelection,
  SpawnReasoningEffort,
} from "@stella/contracts/agent-engine";
import type { RuntimeActiveRun } from "@stella/contracts/protocol";
import type { ResolvedLlmRoute } from "../model-routing.js";
import {
  type SubagentSession,
  getOrCreateSubagentSession,
} from "../agent-runtime/subagent-session.js";

export type LocalAgentContext = {
  systemPrompt: string;
  dynamicContext: string;
  orchestratorReminderText?: string;
  staleUserReminderText?: string;
  connectorTransitionReminderText?: string;
  shouldInjectDynamicReminder?: boolean;
  toolsAllowlist?: string[];
  model?: string;
  resolvedLlm?: ResolvedLlmRoute;
  /** Durable effective Orchestrator route used by Manager threads. */
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  reasoningEffort?: ReasoningEffort;
  agentDepth?: number;
  maxAgentDepth: number;
  coreMemory?: string;
  /** Dream's routing map, push-injected as the single resident Dream doc. */
  memoryMap?: string;
  /** Durable user-profile facts (Remember tool), push-injected at session start. */
  userProfile?: string;
  personality?: string;
  threadHistory?: Array<{
    timestamp?: number;
    role: string;
    content: string;
    toolCallId?: string;
    payload?: PersistedRuntimeThreadPayload;
    customMessage?: RuntimeThreadMessage["customMessage"];
  }>;
  activeThreadId?: string;
  agentEngine?: AgentRuntimeEngine;
  /**
   * Per-spawn engine selection from spawn_agent's `model` parameter. When
   * set, `agentEngine` reflects the selected engine for this run and external
   * engines honor the pinned engine-native model (if any). For Claude Code
   * this also switches the run to vanilla pass-through mode (CC's own tools
   * and config, no Stella tool bridge or system-prompt override).
   */
  spawnEngine?: SpawnEngineSelection;
  /** Per-spawn reasoning override; never persisted to user preferences. */
  spawnReasoningEffort?: SpawnReasoningEffort;
  maxAgentConcurrency?: number;
  /** Durable attempt epoch for transcript writes on a reused agent thread. */
  attemptGeneration?: number;
};

export type LocalAgentStatus = "pending" | TaskLifecycleStatus;

type MessageEntry = {
  from: "orchestrator" | "subagent";
  text: string;
  timestamp: number;
};

type RuntimeAgentRecord = {
  /**
   * Durable thread id this agent execution is bound to. There is at most
   * one in-flight agent per thread, so this doubles as the agent identity.
   */
  threadId: string;
  conversationId: string;
  rootRunId?: string;
  description: string;
  prompt: string;
  agentType: string;
  /** Per-spawn model override (plain model-reference string). */
  model?: string;
  /** Per-spawn engine selection, including `default` for plain model pins. */
  spawnEngine?: SpawnEngineSelection;
  /** Per-spawn reasoning override; never persisted to user preferences. */
  spawnReasoningEffort?: SpawnReasoningEffort;
  modelConfigSnapshot?: AgentModelConfigSnapshot;
  toolWorkspaceRoot?: string;
  agentDepth: number;
  maxAgentDepth?: number;
  status: LocalAgentStatus;
  startedAt: number;
  completedAt: number | null;
  result?: string;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  /**
   * File records banked across runs whose terminal `agent-completed` was
   * never emitted. A `send_input` follow-up aborts the in-flight
   * `runSubagent` before its completion rollup fires, and without banking,
   * everything that run wrote (e.g. rendered videos in
   * `~/.stella/outputs/`) would never surface on any completion card.
   * Merged into `task.fileChanges` / `task.producedFiles` when a completion
   * finally lands, then drained at emission so a later re-run's completion
   * only reveals files produced since the last emitted rollup (preserving
   * the append-only reveal property the completion card relies on).
   */
  bankedFileChanges?: FileChangeRecord[];
  bankedProducedFiles?: ProducedFileRecord[];
  error?: string;
  controller: AbortController;
  storageMode: "cloud" | "local";
  cloudAgentId?: string;
  /** Resolves when the cloud task record has been created (or rejected). */
  cloudCreatePromise?: Promise<void>;
  parentAgentId?: string;
  /** Parked Manager whose next turn begins when managed work or input arrives. */
  waitingForManagedChildren?: boolean;
  /** Accepted terminal report, retained across fenced/retried attempts. */
  managerFinalReport?: string;
  /** Tool-call identity of the accepted terminal report. */
  managerFinalReportId?: string;
  /** Tool call ids already accepted as reports in this Manager run. */
  managerReportIds: Set<string>;
  /** Monotonic count of durably acknowledged intermediate reports. */
  managerReportSequence: number;
  /** This turn explicitly opened a non-terminal upward boundary. */
  managerIntermediateReportInTurn: boolean;
  /** Monotonic ownership token for mutable executeTask attempts. */
  attemptGeneration: number;
  recentActivity: string[];
  /**
   * Wall-clock timestamp of the last discrete liveness event: streamed
   * progress, a tool starting, or a tool finishing. It does NOT advance
   * while a tool call is running, so mid-call this stamp goes stale by
   * design — `activeToolCount` below is the authoritative in-flight signal.
   * Timeout/idle logic must never trust this timestamp alone; check the
   * count first (see the Schedule tool's idle accounting in tools/schedule.ts).
   */
  lastActivityAt: number;
  /**
   * Number of tool calls currently in flight (incremented on tool start,
   * decremented on tool end). The stamp above only moves on discrete events,
   * so a single tool call that runs longer than a poller's idle window would
   * still read as idle mid-call; a non-zero count tells pollers "working,
   * not idle" for the whole duration. Reset at turn boundaries so a run that
   * dies without emitting tool-end events can't leak a stuck non-zero count.
   */
  activeToolCount: number;
  progressBuffer: string;
  toSubagentQueue: string[];
  toOrchestratorQueue: string[];
  messageLog: MessageEntry[];
  /**
   * How many user turns this thread has had so far on the long-lived
   * subagent session. Zero on the first run (initial `spawn_agent`
   * prompt is still part of that first user message); incremented at
   * the top of every `executeTask` invocation. Used by
   * `buildTaskPrompt` to decide whether queued follow-ups should be
   * appended to the original prompt (first turn) or sent as a
   * standalone "Task update from orchestrator" user message
   * (subsequent turns).
   *
   * Not "retry count" — every increment is a legitimate user turn in
   * the same conversation. The session's message array is preserved
   * across the re-entry.
   */
  turnCount: number;
  /**
   * Set by `send_input` when the current `runSubagent` call has been
   * aborted so we can deliver the queued follow-up as the next user turn
   * on the same session. The post-run branch in `executeTask` checks
   * this to decide whether to fall through into
   * `deliverFollowUpAsNextTurn` (treat as continuation) vs. treating the
   * abort as a real cancellation.
   *
   * Not "restart" — the long-lived `subagentSession` is reused; only
   * the outer `executeTask` invocation re-enters.
   */
  interruptedForFollowUp: boolean;
  terminalEventEmitted: boolean;
  pendingStartStatusText?: string;
  /**
   * Set on the re-activation paths (`send_input` follow-up delivery:
   * `sendAgentMessage` terminal/evicted resume, `deliverFollowUpAsNextTurn`)
   * so the NEXT `agent-started` emitted from `tryStartNext` is stamped as a
   * follow-up rather than a fresh spawn. Read-once and cleared alongside
   * `pendingStartStatusText`; a plain retry/reset leaves it unset so it
   * reads as a spawn.
   */
  pendingStartIsFollowUp?: boolean;
  /** UI-only audience for the next start event. Never affects turn outcome. */
  pendingStartAudience?: "orchestrator-only" | "default";
};

export type ManagerAncestryResolution =
  | { kind: "none" }
  | { kind: "manager"; managerThreadId: string }
  | { kind: "invalid"; reason: "cycle" | "missing"; threadId: string };

const formatTaskUpdateStatusText = (text: string): string =>
  truncate(text.replace(/\s+/g, " ").trim(), 200);

const fileRecordKey = (record: FileChangeRecord): string =>
  `${record.kind.type}:${record.path}:${
    record.kind.type === "update" ? (record.kind.move_path ?? "") : ""
  }`;

/**
 * Append-merge file records, deduped by `(kind, path, move_path)` — the same
 * identity the runner's per-run collectors use. First occurrence wins so a
 * banked record from an interrupted run keeps its original position when the
 * completing run re-reports the same write.
 */
const mergeUniqueFileRecords = <T extends FileChangeRecord>(
  existing: T[] | undefined,
  incoming: T[] | undefined,
): T[] | undefined => {
  if (!incoming?.length) return existing;
  if (!existing?.length) return [...incoming];
  const out: T[] = [];
  const seen = new Set<string>();
  for (const record of [...existing, ...incoming]) {
    const key = fileRecordKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
};

type FsLock = {
  id: string;
  threadId: string;
  key: string;
};

export type AgentLifecycleEvent = {
  type:
    | "agent-started"
    | "agent-completed"
    | "agent-failed"
    | "agent-canceled"
    | "agent-message"
    | "agent-progress";
  conversationId: string;
  /** Stable identity used to deduplicate durable manager-event routing. */
  eventId?: string;
  rootRunId?: string;
  userMessageId?: string;
  agentId: string;
  agentType: string;
  description?: string;
  parentAgentId?: string;
  result?: string;
  fileChanges?: FileChangeRecord[];
  producedFiles?: ProducedFileRecord[];
  error?: string;
  statusText?: string;
  toolActivity?: TaskToolActivity;
  /** Durable identity of the execution attempt that owns this lifecycle
   * occurrence and its authored Activity projection. Present on every new
   * start/progress/update/terminal event; absent only on legacy events. */
  attemptGeneration?: number;
  /**
   * `agent-started` only. `true` when this start re-activates an existing
   * thread (a `send_input` follow-up) rather than spawning fresh work — the
   * explicit signal the inline "background work" card uses to render the
   * follow-up variant. A fresh spawn leaves this unset. The follow-up's own
   * message still rides on `statusText` (the card title); this flag is only
   * the spawn-vs-follow-up discriminator.
   */
  isFollowUp?: boolean;
  /**
   * Delivery scope for the event. `orchestrator-only` skips every display
   * surface (persisted chat row / completion card, renderer stream event,
   * OS notification); `display-only` skips the hidden orchestrator
   * follow-up. Absent = both.
   *
   * Internal managed-child wakeups set `orchestrator-only` on the Manager's
   * re-entry start so the durable child report can resume Manager work without
   * creating a root-chat follow-up card. Completion still follows the
   * state-based rule: a real finish emits the full event immediately, while an
   * internal turn boundary superseded by a pending follow-up emits nothing.
   */
  audience?: "orchestrator-only" | "display-only";
  /**
   * Work group of the thread that emitted this event. Emit sites leave
   * these unset; the runner's central lifecycle handler enriches every
   * event from the thread registry so the Activity UI can collapse
   * sibling agents under one group header.
   */
  groupKey?: string;
  groupLabel?: string;
};

const ENV_ASSIGNMENT_RE =
  /\b([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s]+)/g;
const SECRET_FLAG_RE =
  /(\s--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi;
const TOOL_ACTIVITY_HINT_CHARS = 320;

const redactEnvironmentValues = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactEnvironmentValues);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      /^(?:env|environment)$/i.test(key) &&
      entry &&
      typeof entry === "object"
    ) {
      output[key] = Object.fromEntries(
        Object.keys(entry as Record<string, unknown>).map((envKey) => [
          envKey,
          "[REDACTED]",
        ]),
      );
      continue;
    }
    output[key] = redactEnvironmentValues(entry);
  }
  return output;
};

export const sanitizeTaskToolArgsHint = (value: unknown): string => {
  let serialized = "";
  try {
    const json = JSON.stringify(
      redactEnvironmentValues(sanitizeForLogs(value)),
    );
    serialized = typeof json === "string" ? json : "";
  } catch {
    return "";
  }
  return truncate(
    serialized
      .replace(ENV_ASSIGNMENT_RE, "$1=[REDACTED]")
      .replace(SECRET_FLAG_RE, "$1 [REDACTED]"),
    TOOL_ACTIVITY_HINT_CHARS,
  );
};

const exitCodeFromToolEnd = (event: {
  details?: unknown;
  resultPreview?: string;
}): number | null | undefined => {
  const details =
    event.details && typeof event.details === "object"
      ? (event.details as Record<string, unknown>)
      : null;
  const value = details?.exitCode ?? details?.exit_code;
  return typeof value === "number" ? value : undefined;
};

const taskToolActivityFromStart = (event: {
  toolCallId: string;
  toolName: string;
  statusText?: string;
  args?: Record<string, unknown>;
}): TaskToolActivity => {
  const argsHint = sanitizeTaskToolArgsHint(event.args);
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    label: event.statusText ?? `Running ${event.toolName}`,
    ...(argsHint ? { argsHint } : {}),
    state: "started",
  };
};

const taskToolActivityFromEnd = (event: {
  toolCallId: string;
  toolName: string;
  details?: unknown;
  resultPreview?: string;
}): TaskToolActivity => {
  const exitCode = exitCodeFromToolEnd(event);
  const argsHint = sanitizeTaskToolArgsHint(event.details);
  return {
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    label:
      exitCode === undefined
        ? `Finished ${event.toolName}`
        : `${event.toolName} exited ${exitCode}`,
    ...(argsHint ? { argsHint } : {}),
    state: "completed",
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
};

type LocalAgentManagerOpts = {
  maxConcurrent?: number;
  getMaxConcurrent?: () => number;
  resolveTaskThread?: (args: {
    conversationId: string;
    agentType: string;
    threadId?: string;
    nameHint?: string;
  }) => {
    threadId: string;
    reused: boolean;
    groupKey?: string;
    groupLabel?: string;
  } | null;
  /** Member thread ids of a `grp-…` work group, for group-level cancel. */
  listGroupMemberThreadIds?: (groupKey: string) => string[];
  onAgentEvent?: (event: AgentLifecycleEvent) => void;
  fetchAgentContext: (args: {
    conversationId: string;
    agentType: string;
    runId: string;
    threadId?: string;
    model?: string;
    spawnEngine?: SpawnEngineSelection;
    spawnReasoningEffort?: SpawnReasoningEffort;
    modelConfigSnapshot?: AgentModelConfigSnapshot;
    toolWorkspaceRoot?: string;
  }) => Promise<LocalAgentContext>;
  /** Resolve the concrete General route before its durable record is written. */
  resolveAgentModelConfig?: (args: {
    agentType: string;
    model?: string;
    spawnEngine?: SpawnEngineSelection;
    spawnReasoningEffort?: SpawnReasoningEffort;
  }) => Promise<AgentModelConfigSnapshot>;
  runSubagent: (args: {
    conversationId: string;
    userMessageId: string;
    agentType: string;
    agentId?: string;
    rootRunId?: string;
    toolWorkspaceRoot?: string;
    taskDescription: string;
    taskPrompt: string;
    agentContext: LocalAgentContext;
    persistToConvex: boolean;
    enableRemoteTools: boolean;
    abortSignal: AbortSignal;
    /**
     * Long-lived session bound to the durable subagent threadId. The
     * runner forwards this to `runSubagentTask` so the underlying Pi
     * `Agent` survives across restart-on-input cycles. Disposed by the
     * manager when the task reaches a terminal status.
     */
    subagentSession?: SubagentSession;
    onProgress?: (chunk: string) => void;
    onStatus?: (statusText: string) => void;
    onToolStart?: (event: {
      runId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      statusText?: string;
    }) => void;
    onToolEnd?: (event: {
      runId: string;
      seq: number;
      toolCallId: string;
      toolName: string;
      resultPreview: string;
      html?: string;
    }) => void;
    toolExecutor: (
      toolName: string,
      args: Record<string, unknown>,
      context: ToolContext,
      signal?: AbortSignal,
      onUpdate?: ToolUpdateCallback,
    ) => Promise<ToolResult>;
  }) => Promise<{
    runId: string;
    result: string;
    interrupted?: boolean;
    error?: string;
    fileChanges?: FileChangeRecord[];
    producedFiles?: ProducedFileRecord[];
  }>;
  toolExecutor: (
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
    signal?: AbortSignal,
    onUpdate?: ToolUpdateCallback,
  ) => Promise<ToolResult>;
  createCloudAgentRecord: (args: {
    agentId: string;
    conversationId: string;
    description: string;
    prompt: string;
    agentType: string;
    attemptGeneration: number;
    parentAgentId?: string;
    maxAgentDepth?: number;
  }) => Promise<{ agentId: string }>;
  completeCloudAgentRecord: (args: {
    agentId: string;
    attemptGeneration: number;
    status: TerminalTaskLifecycleStatus;
    result?: string;
    error?: string;
  }) => Promise<void>;
  getCloudAgentRecord: (agentId: string) => Promise<AgentToolSnapshot | null>;
  cancelCloudAgentRecord: (
    agentId: string,
    reason?: string,
    attemptGeneration?: number,
  ) => Promise<{ canceled: boolean }>;
  saveAgentRecord?: (record: PersistedAgentRecord) => void;
  getAgentRecord?: (threadId: string) => PersistedAgentRecord | null;
  listAgentRecordsByStatus?: (
    status: TaskLifecycleStatus,
  ) => PersistedAgentRecord[];
  /**
   * Persist active thread identities before a restart-related sweep changes
   * their durable status. The returned episode id binds the capture to the
   * shutdown record that authorized it; boot conversion rejects every other
   * episode. This is also called during v2's graceful Effect teardown because
   * that teardown cancels rows before the replacement worker can inspect them.
   */
  persistBootInterruptionSnapshot?: (
    threads: Array<{ threadId: string; conversationId: string }>,
  ) => string | null | undefined;
  hasAgentLifecycleEvent?: (
    conversationId: string,
    eventId: string,
    type: AgentLifecycleEvent["type"],
  ) => boolean;
  listActiveThreads?: (conversationId: string) => RuntimeThreadRecord[];
  /**
   * Kernel supervision hook for in-flight attempts. Called once per started
   * attempt with the attempt's already-running promise and a cooperative
   * cancel that routes through `cancelAgent` (full terminal semantics:
   * lifecycle events, session dispose, managed-child cascade). The runner
   * wires this to the kernel run supervisor so an attempt spawned with a
   * `rootRunId` is interrupted and joined when that root run is canceled,
   * and every attempt is interrupted and joined at runtime shutdown.
   */
  superviseAttempt?: (attempt: {
    threadId: string;
    rootRunId?: string;
    abort: (reason?: unknown) => void;
    settled: Promise<void>;
  }) => void;
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeFsPathKey = (candidate: string, cwd?: string): string => {
  const resolved = path.resolve(cwd ?? process.cwd(), candidate);
  const normalized = path.normalize(resolved);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const pathsOverlap = (a: string, b: string): boolean => {
  if (a === "*" || b === "*") return true;
  if (a === b) return true;
  const sep = path.sep;
  return a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
};

const BASH_PATH_PATTERN = String.raw`(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])`;

const extractBashPath = (command: string): string | undefined => {
  const match = command.match(
    new RegExp(
      String.raw`(?:^|\s)(?:"(${BASH_PATH_PATTERN}[^"]+)"|'(${BASH_PATH_PATTERN}[^']+)'|(${BASH_PATH_PATTERN}[^\s"'` +
        "`" +
        String.raw`]+))`,
    ),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
};

const READ_ONLY_EXEC_TOOLS = new Set([
  "read_file",
  "search",
  "glob",
  "web_fetch",
  "web_search",
  "heartbeat_get",
  "cron_list",
  "describe",
]);

const EXEC_MUTATION_PATTERNS: RegExp[] = [
  /\btools\s*\.\s*write_file\s*\(/,
  /\btools\s*\.\s*apply_patch\s*\(/,
  /\btools\s*\.\s*shell\s*\(/,
  /\btools\s*\.\s*display\s*\(/,
  /\btools\s*\.\s*memory\s*\(/,
  /\btools\s*\.\s*spawn_agent\s*\(/,
  /\btools\s*\.\s*spawn_manager\s*\(/,
  /\btools\s*\.\s*send_input\s*\(/,
  /\btools\s*\.\s*pause_agent\s*\(/,
  /\btools\s*\.\s*cron_(?:add|update|remove|run)\s*\(/,
  /\btools\s*\.\s*heartbeat_(?:upsert|run)\s*\(/,
  /\btools\s*\.\s*schedule\s*\(/,
  /\bfs(?:\.promises)?\.(?:writeFile|appendFile|cp|copyFile|rename|rm|rmdir|unlink|mkdir|mkdtemp|truncate|chmod|chown|utimes)\s*\(/,
  /\bchild_process\s*\.\s*(?:exec|execFile|spawn|fork)\s*\(/,
  /\bprocess\s*\.\s*chdir\s*\(/,
];

const isClearlyReadOnlyExecProgram = (source: string): boolean => {
  for (const pattern of EXEC_MUTATION_PATTERNS) {
    if (pattern.test(source)) {
      return false;
    }
  }

  const toolCalls = source.matchAll(/\btools\s*\.\s*(\w+)\s*\(/g);
  for (const match of toolCalls) {
    const method = match[1];
    if (!method || !READ_ONLY_EXEC_TOOLS.has(method)) {
      return false;
    }
  }

  return true;
};

const getFsLockKey = (
  toolName: string,
  args: Record<string, unknown>,
  context?: ToolContext,
): string | null => {
  if (toolName === "Write" || toolName === "Edit") {
    const filePath = normalizeString(
      args.file_path ?? args.path ?? args.target_path,
    );
    if (!filePath) return "*";
    return normalizeFsPathKey(
      filePath,
      normalizeString(
        args.working_directory ??
          args.cwd ??
          context?.workingDirectory ??
          context?.stellaAppDir,
      ),
    );
  }
  if (toolName === "Bash") {
    const command = normalizeString(args.command);
    if (!command) return "*";
    const pathFromCommand = extractBashPath(command);
    if (!pathFromCommand) return "*";
    return normalizeFsPathKey(
      pathFromCommand,
      normalizeString(
        args.working_directory ??
          args.cwd ??
          context?.workingDirectory ??
          context?.stellaAppDir,
      ),
    );
  }
  if (toolName === "Exec") {
    const source = normalizeString(args.source ?? args.code);
    if (!source) return "*";
    return isClearlyReadOnlyExecProgram(source) ? null : "*";
  }
  return null;
};

const isSpawnAgentTool = (toolName: string): boolean =>
  toolName === "spawn_agent" || toolName === "spawn_manager";

const AGENT_INPUT_INTERRUPT_ERROR = "Interrupted by agent input";

export const AGENT_SHUTDOWN_CANCEL_REASON =
  "Canceled because Stella closed or restarted.";
export const AGENT_ORPHANED_RESTART_CANCEL_REASON =
  "Canceled because Stella restarted before the agent finished.";
// Sentinel set by the orchestrator's pause_agent tool so the runner
// can suppress the hidden `[Task canceled]` follow-up turn that would
// otherwise replace the user-facing reply with an empty silence.
export const AGENT_PAUSE_CANCEL_REASON = "Paused by orchestrator.";
export const DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS = 5_000;
/** Explicit completion result used when a Manager never submits report(final=true). */
export const MANAGER_MISSING_FINAL_REPORT_FALLBACK =
  "Manager ended without a final report.";

const logWorkingIndicatorTrace = (
  label: string,
  payload: Record<string, unknown>,
): void => {
  process.stderr.write(`${JSON.stringify({ label, ...payload })}\n`);
};

/**
 * Requirements-free runtime for the manager's supervisory fibers (house
 * convention: ONE module-level ManagedRuntime, context rides in closures —
 * never a per-call `Effect.runPromise`). Same fence as
 * `shared/supervised-scope.ts`: Effect types cross the class surface only on
 * the explicitly Effect-native `*Effect` methods consumed inside
 * `packages/runtime`.
 */
const managerRuntime = ManagedRuntime.make(Layer.empty);

/** Terminal outcome observed by `awaitAgentSettled` / `awaitAgentSettledEffect`. */
export type LocalAgentSettlement = {
  threadId: string;
  status: TerminalTaskLifecycleStatus;
  result?: string;
  error?: string;
};

const isTerminalSnapshotStatus = (
  status: AgentToolSnapshot["status"],
): status is TerminalTaskLifecycleStatus =>
  status === "completed" || status === "error" || status === "canceled";

export class LocalAgentManager implements AgentToolApi {
  private readonly defaultMaxConcurrent: number;
  private readonly opts: LocalAgentManagerOpts;
  private readonly tasks = new Map<string, RuntimeAgentRecord>();
  private readonly pendingQueue: string[] = [];
  private runningCount = 0;
  private readonly inFlightAttempts = new Map<
    string,
    { generation: number; promise: Promise<void> }
  >();
  /**
   * Supervisory scope for the manager's own fibers: per-attempt supervision
   * fibers (`attemptFibers`) and stale-attempt takeover deadline fibers
   * (`attemptTakeoverDeadlines`). Closed at the end of `shutdown()`, which
   * interrupts every remaining supervisory fiber. Run-loop work is NEVER
   * forked in here — cancellation of a run stays cooperative via its
   * `AbortController` so the agent loop always settles through its terminal
   * events.
   */
  private readonly supervisoryScope = Scope.makeUnsafe();
  private supervisoryScopeClosed = false;
  private supervisoryScopeClosePromise: Promise<void> | null = null;
  /**
   * FiberMap-style keyed attempt supervision: one fiber per in-flight
   * `executeTask` attempt, keyed by durable threadId, forked into the
   * supervisory scope. The fiber joins the attempt promise and owns the
   * slot-release bookkeeping that used to hang off `execution.finally`.
   * Identity fences (generation + promise) — not fiber identity — guard
   * every mutation, so a late-settling superseded attempt can never release
   * a successor's slot.
   */
  private readonly attemptFibers = new Map<
    string,
    { generation: number; promise: Promise<void>; fiber: Fiber.Fiber<void> }
  >();
  /**
   * Stale-attempt takeover deadlines as sleeping fibers (formerly unref'd
   * `setTimeout`s). Interrupted by `clearAttemptTakeoverTimer` or by scope
   * close; the deadline body re-validates map/generation/promise identity,
   * so an interrupt racing an already-started body is harmless.
   */
  private readonly attemptTakeoverDeadlines = new Map<
    string,
    {
      generation: number;
      promise: Promise<void>;
      fiber: Fiber.Fiber<void>;
    }
  >();
  private readonly cancelCascadeInProgress = new Set<string>();
  private readonly activeFsLocks: FsLock[] = [];
  private readonly fsLockWaiters: Array<() => void> = [];
  /**
   * Long-lived per-task subagent sessions keyed by durable threadId (E2).
   * Created lazily on first `executeTask` for a thread, reused across
   * restart-on-input attempts within the same thread, disposed when the
   * task reaches a terminal status. Paused tasks keep their session.
   */
  private readonly subagentSessions = new Map<string, SubagentSession>();
  private static readonly MAX_QUEUE_MESSAGES = 32;
  private static readonly MAX_LOG_MESSAGES = 80;
  private nextId = 0;
  private readonly bootInterruptedThreads: Array<{
    threadId: string;
    conversationId: string;
  }> = [];
  private bootInterruptionEpisodeId: string | null = null;

  constructor(opts: LocalAgentManagerOpts) {
    this.opts = opts;
    this.defaultMaxConcurrent = Math.max(1, opts.maxConcurrent ?? 3);
    this.recoverOrCancelOrphanedPersistedAgents();
  }

  getBootInterruptedThreads(): Array<{
    threadId: string;
    conversationId: string;
  }> {
    return [...this.bootInterruptedThreads];
  }

  getBootInterruptionEpisodeId(): string | null {
    return this.bootInterruptionEpisodeId;
  }

  private persistInterruptionSnapshot(
    threads: Array<{ threadId: string; conversationId: string }>,
  ): string | null {
    if (threads.length === 0) return null;
    try {
      return this.opts.persistBootInterruptionSnapshot?.(threads) ?? null;
    } catch {
      // Continuation bookkeeping must never prevent boot or shutdown. The
      // live capture can still convert on this boot; otherwise recovery fails
      // closed instead of attributing rows to the wrong restart.
      return null;
    }
  }

  private assignModelConfigSnapshotIfMissing(
    task: RuntimeAgentRecord,
    modelConfigSnapshot: AgentModelConfigSnapshot | undefined,
  ): void {
    // model_config_json is a nullable migration-added column, so Manager
    // tasks created before that migration can legitimately resume without a
    // snapshot. Backfill those rows from the current Orchestrator options.
    if (
      task.agentType === AGENT_IDS.MANAGER &&
      !task.modelConfigSnapshot &&
      modelConfigSnapshot
    ) {
      task.modelConfigSnapshot = modelConfigSnapshot;
    }
  }

  private async resolveGeneralModelConfigIfMissing(
    task: RuntimeAgentRecord,
  ): Promise<void> {
    if (
      task.agentType !== AGENT_IDS.GENERAL ||
      task.modelConfigSnapshot ||
      !this.opts.resolveAgentModelConfig
    ) {
      return;
    }
    task.modelConfigSnapshot = await this.opts.resolveAgentModelConfig({
      agentType: task.agentType,
      ...(task.model ? { model: task.model } : {}),
      ...(task.spawnEngine ? { spawnEngine: task.spawnEngine } : {}),
      ...(task.spawnReasoningEffort
        ? { spawnReasoningEffort: task.spawnReasoningEffort }
        : {}),
    });
  }

  private recoverOrCancelOrphanedPersistedAgents(): void {
    const now = Date.now();
    const runningRecords =
      this.opts.listAgentRecordsByStatus?.("running") ?? [];
    for (const record of runningRecords) {
      this.bootInterruptedThreads.push({
        threadId: record.threadId,
        conversationId: record.conversationId,
      });
    }
    this.bootInterruptionEpisodeId = this.persistInterruptionSnapshot(
      this.bootInterruptedThreads,
    );
    for (const record of runningRecords) {
      if (record.agentType === AGENT_IDS.MANAGER) {
        const result =
          record.managerFinalReport && record.managerFinalReportId
            ? record.managerFinalReport
            : MANAGER_MISSING_FINAL_REPORT_FALLBACK;
        const eventId = `${record.threadId}:${record.attemptGeneration}:agent-completed`;
        if (
          !this.opts.hasAgentLifecycleEvent?.(
            record.conversationId,
            eventId,
            "agent-completed",
          )
        ) {
          this.opts.onAgentEvent?.({
            type: "agent-completed",
            conversationId: record.conversationId,
            eventId,
            rootRunId: record.rootRunId,
            agentId: record.threadId,
            agentType: record.agentType,
            description: record.description,
            parentAgentId: record.parentAgentId,
            result,
            attemptGeneration: record.attemptGeneration,
          });
        }
        this.opts.saveAgentRecord?.({
          ...record,
          status: "completed",
          completedAt: now,
          result,
          error: undefined,
          updatedAt: now,
        });
        if (record.storageMode === "cloud") {
          void this.opts
            .completeCloudAgentRecord({
              agentId: record.threadId,
              attemptGeneration: record.attemptGeneration,
              status: "completed",
              result,
            })
            .catch(() => undefined);
        }
        continue;
      }
      const error = AGENT_ORPHANED_RESTART_CANCEL_REASON;
      this.opts.saveAgentRecord?.({
        ...record,
        status: "canceled",
        completedAt: now,
        error,
        updatedAt: now,
      });
      // The runtime worker, not Electron's renderer/main process, owns agent
      // execution. Persist the matching lifecycle transition here so every
      // Activity consumer observes the real worker restart. Renderer code
      // must not guess that an old `agent-started` event stopped merely
      // because the desktop window restarted: the detached worker may still
      // be running it.
      this.opts.onAgentEvent?.({
        type: "agent-canceled",
        conversationId: record.conversationId,
        eventId: `${record.threadId}:${record.attemptGeneration}:agent-canceled`,
        agentId: record.threadId,
        agentType: record.agentType,
        description: record.description,
        parentAgentId: record.parentAgentId,
        error,
        attemptGeneration: record.attemptGeneration,
        audience: "display-only",
      });
      if (record.storageMode === "cloud") {
        void this.opts
          .completeCloudAgentRecord({
            agentId: record.threadId,
            attemptGeneration: record.attemptGeneration,
            status: "canceled",
            error,
          })
          .catch(() => undefined);
      }
    }
  }

  private consumeTaskMessages(
    task: RuntimeAgentRecord,
    recipient: "orchestrator" | "subagent",
  ): string[] {
    const queue =
      recipient === "subagent"
        ? task.toSubagentQueue
        : task.toOrchestratorQueue;
    if (queue.length === 0) return [];
    const out = [...queue];
    queue.length = 0;
    return out;
  }

  private buildTaskPrompt(task: RuntimeAgentRecord): string {
    const updates = this.consumeTaskMessages(task, "subagent");
    if (updates.length === 0) {
      return task.prompt;
    }

    const updateBlock = updates
      .map((text, index) => `${index + 1}. ${text}`)
      .join("\n");
    const isManager = task.agentType === AGENT_IDS.MANAGER;
    const updateInstruction = isManager
      ? "Interpret the orchestrator's message by its natural-language intent. Your assistant response remains private. Use report only for a genuine blocker that prevents progress and requires outside action after reasonable recovery is exhausted, or exactly once with final true after all work and review/fix rounds are settled. Never report status, milestones, child completions, or recoverable failures. If the message changes instructions, apply the steering and continue. Newer updates override conflicting earlier instructions."
      : "Apply the orchestrator's message according to its intent. If it asks a question, requests status, or asks for a report, answer that request and then stop; do not continue the underlying task. If it gives new or changed work instructions, apply them and continue the task. Newer updates override conflicting earlier instructions.";
    if (task.turnCount === 0) {
      return [
        task.prompt,
        "Task updates from orchestrator:",
        updateBlock,
        updateInstruction,
      ].join("\n\n");
    }

    return isManager
      ? [
          "Task update from orchestrator:",
          updateBlock,
          "Your previous turn was paused so you can apply this update now.",
          updateInstruction,
        ].join("\n\n")
      : [
          "Task update from orchestrator:",
          updateBlock,
          "Your previous turn was paused so you can apply this update now. Follow the orchestrator's message according to its intent: if it asks a question, requests status, or asks for a report, answer that request and then stop; do not continue the underlying task. If it gives new or changed work instructions, apply them and continue the task. Newer updates override conflicting earlier instructions.",
        ].join("\n\n");
  }

  private shouldDeliverFollowUp(task: RuntimeAgentRecord): boolean {
    return task.interruptedForFollowUp && task.status !== "canceled";
  }

  /**
   * Wake-up seam for blocking waiters (phase 2 batch 4). Purely a
   * notification: waiters re-read the durable record and decide for
   * themselves, so SQLite stays the only truth and a missed wakeup (e.g.
   * a record rehydrated by another writer) is covered by the caller's
   * fallback timeout. One shared per-thread Deferred; completed + replaced
   * on every persisted transition.
   */
  private readonly updateLatches = new Map<string, Deferred.Deferred<void>>();

  /**
   * Per-thread settlement latches, completed exactly when a terminal
   * transition (completed/error/canceled) is persisted for the thread. A
   * `send_input` resurrection re-arms naturally: the next waiter creates a
   * fresh latch that the next terminal transition completes.
   */
  private readonly settlementLatches = new Map<
    string,
    Deferred.Deferred<void>
  >();

  private latchFor(
    latches: Map<string, Deferred.Deferred<void>>,
    threadId: string,
  ): Deferred.Deferred<void> {
    const existing = latches.get(threadId);
    if (existing) return existing;
    const latch = Deferred.makeUnsafe<void>();
    latches.set(threadId, latch);
    return latch;
  }

  private openLatch(
    latches: Map<string, Deferred.Deferred<void>>,
    threadId: string,
  ): void {
    const latch = latches.get(threadId);
    if (!latch) return;
    latches.delete(threadId);
    Deferred.doneUnsafe(latch, Effect.void);
  }

  private notifyAgentUpdated(threadId: string): void {
    this.openLatch(this.updateLatches, threadId);
  }

  private settleAgentThread(threadId: string): void {
    this.openLatch(this.settlementLatches, threadId);
  }

  /**
   * Effect variant of `waitForAgentUpdate`: resolves on the next persisted
   * update for `threadId`, or after `timeoutMs` as a rehydration-safe
   * fallback (a non-finite/non-positive `timeoutMs` waits unbounded, as
   * before). Never fails.
   */
  waitForAgentUpdateEffect(
    threadId: string,
    timeoutMs = 2_000,
  ): Effect.Effect<void> {
    return Effect.suspend(() => {
      const wait = Deferred.await(
        this.latchFor(this.updateLatches, threadId),
      );
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return wait;
      }
      // raceFirst interrupts the losing arm, so a woken waiter tears down
      // its fallback sleep (the Effect replacement for `clearTimeout`).
      return Effect.raceFirst(wait, Effect.sleep(timeoutMs));
    });
  }

  /**
   * Resolve on the next persisted update for `threadId`, or after
   * `timeoutMs` as a rehydration-safe fallback. Replaces fixed-interval
   * completion polling: terminal transitions wake blocking callers
   * immediately instead of on the next poll tick.
   */
  waitForAgentUpdate(threadId: string, timeoutMs = 2_000): Promise<void> {
    return managerRuntime.runPromise(
      this.waitForAgentUpdateEffect(threadId, timeoutMs),
    );
  }

  /**
   * Await the thread's terminal settlement (completed/error/canceled) and
   * return the terminal snapshot fields, or `null` when no record exists
   * anywhere (the caller's "record disappeared" case). Completion detection
   * is Deferred-driven — a terminal transition wakes the waiter immediately —
   * with a bounded fallback re-read (`fallbackRecheckMs`) so records mutated
   * by out-of-band writers still settle; SQLite remains the only truth (the
   * latch is only ever a wakeup, every pass re-reads the snapshot).
   *
   * This is the Effect-native replacement for polling `getAgent` until a
   * terminal status appears (`runBlockingLocalAgent`'s historical 250ms
   * loop). Cancellation note: interrupting THIS effect abandons the wait
   * only — it never cancels the underlying run; use `cancelAgentEffect`
   * for the cooperative cancel path.
   */
  awaitAgentSettledEffect(
    threadId: string,
    fallbackRecheckMs = 2_000,
  ): Effect.Effect<LocalAgentSettlement | null> {
    const manager = this;
    return Effect.gen(function* () {
      for (;;) {
        // Latch first, snapshot second: a terminal transition landing
        // between the two completes the latch we already hold, so the
        // wakeup cannot be missed.
        const settled = Deferred.await(
          manager.latchFor(manager.settlementLatches, threadId),
        );
        const snapshot = yield* Effect.promise(() =>
          manager.getAgent(threadId),
        );
        if (!snapshot) return null;
        if (isTerminalSnapshotStatus(snapshot.status)) {
          return {
            threadId,
            status: snapshot.status,
            ...(typeof snapshot.result === "string"
              ? { result: snapshot.result }
              : {}),
            ...(typeof snapshot.error === "string"
              ? { error: snapshot.error }
              : {}),
          };
        }
        yield* Number.isFinite(fallbackRecheckMs) && fallbackRecheckMs > 0
          ? Effect.raceFirst(settled, Effect.sleep(fallbackRecheckMs))
          : settled;
      }
    });
  }

  /** Promise facade over `awaitAgentSettledEffect`. */
  awaitAgentSettled(
    threadId: string,
    fallbackRecheckMs = 2_000,
  ): Promise<LocalAgentSettlement | null> {
    return managerRuntime.runPromise(
      this.awaitAgentSettledEffect(threadId, fallbackRecheckMs),
    );
  }

  private persistTask(task: RuntimeAgentRecord): void {
    this.notifyAgentUpdated(task.threadId);
    if (
      task.status === "completed" ||
      task.status === "error" ||
      task.status === "canceled"
    ) {
      this.settleAgentThread(task.threadId);
    }
    this.opts.saveAgentRecord?.({
      threadId: task.threadId,
      conversationId: task.conversationId,
      storageMode: task.storageMode,
      agentType: task.agentType,
      description: task.description,
      agentDepth: task.agentDepth,
      ...(typeof task.maxAgentDepth === "number"
        ? { maxAgentDepth: task.maxAgentDepth }
        : {}),
      ...(task.parentAgentId ? { parentAgentId: task.parentAgentId } : {}),
      ...(task.modelConfigSnapshot
        ? { modelConfigSnapshot: task.modelConfigSnapshot }
        : {}),
      status: task.status === "pending" ? "running" : task.status,
      attemptGeneration: task.attemptGeneration,
      ...(task.rootRunId ? { rootRunId: task.rootRunId } : {}),
      ...(task.managerFinalReport
        ? { managerFinalReport: task.managerFinalReport }
        : {}),
      ...(task.managerFinalReportId
        ? { managerFinalReportId: task.managerFinalReportId }
        : {}),
      ...(task.managerReportIds.size > 0
        ? { managerReportIds: [...task.managerReportIds] }
        : {}),
      managerReportSequence: task.managerReportSequence,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      ...(typeof task.result === "string" ? { result: task.result } : {}),
      ...(typeof task.error === "string" ? { error: task.error } : {}),
      updatedAt: Date.now(),
    });
  }

  private buildTaskSnapshot(task: RuntimeAgentRecord): AgentToolSnapshot {
    return {
      id: task.threadId,
      description: task.description,
      ...(task.modelConfigSnapshot
        ? { modelConfigSnapshot: task.modelConfigSnapshot }
        : {}),
      status: task.status === "pending" ? "running" : task.status,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      result: task.result,
      error: task.error,
      recentActivity:
        task.status === "running" || task.status === "pending"
          ? task.recentActivity
          : undefined,
      lastActivityAt: task.lastActivityAt,
      activeToolCount:
        task.status === "running" || task.status === "pending"
          ? task.activeToolCount
          : 0,
      messages: task.messageLog.slice(-10),
    };
  }

  private buildPersistedSnapshot(
    record: PersistedAgentRecord,
  ): AgentToolSnapshot {
    return {
      id: record.threadId,
      description: record.description,
      ...(record.modelConfigSnapshot
        ? { modelConfigSnapshot: record.modelConfigSnapshot }
        : {}),
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private isDescendantOf(threadId: string, ancestorThreadId: string): boolean {
    const visited = new Set<string>();
    let cursor = this.getAgentState(threadId)?.parentAgentId;
    while (cursor) {
      if (cursor === ancestorThreadId) return true;
      if (visited.has(cursor)) return false;
      visited.add(cursor);
      cursor = this.getAgentState(cursor)?.parentAgentId;
    }
    return false;
  }

  /** True while at least one adopted/spawned descendant has work in flight. */
  private hasActiveManagedChildren(managerThreadId: string): boolean {
    for (const task of this.tasks.values()) {
      if (
        task.threadId !== managerThreadId &&
        this.isDescendantOf(task.threadId, managerThreadId) &&
        (task.status === "pending" || task.status === "running")
      ) {
        return true;
      }
    }
    return (this.opts.listAgentRecordsByStatus?.("running") ?? []).some(
      (record) =>
        record.threadId !== managerThreadId &&
        this.isDescendantOf(record.threadId, managerThreadId),
    );
  }

  isManagerThread(threadId: string): boolean {
    return (
      this.tasks.get(threadId)?.agentType === AGENT_IDS.MANAGER ||
      this.opts.getAgentRecord?.(threadId)?.agentType === AGENT_IDS.MANAGER
    );
  }

  /** Resolve the nearest owning Manager through live or persisted ancestry. */
  resolveManagerAncestry(parentAgentId?: string): ManagerAncestryResolution {
    if (!parentAgentId) return { kind: "none" };
    const visited = new Set<string>();
    let cursor: string | undefined = parentAgentId;
    while (cursor) {
      if (visited.has(cursor)) {
        return { kind: "invalid", reason: "cycle", threadId: cursor };
      }
      visited.add(cursor);
      const state = this.getAgentState(cursor);
      if (!state) {
        return { kind: "invalid", reason: "missing", threadId: cursor };
      }
      if (state.agentType === AGENT_IDS.MANAGER) {
        return { kind: "manager", managerThreadId: cursor };
      }
      cursor = state.parentAgentId;
    }
    return { kind: "none" };
  }

  private getAgentState(
    threadId: string,
  ): RuntimeAgentRecord | PersistedAgentRecord | null {
    return (
      this.tasks.get(threadId) ?? this.opts.getAgentRecord?.(threadId) ?? null
    );
  }

  private isExplicitlyPaused(
    task: RuntimeAgentRecord | PersistedAgentRecord | null,
  ): boolean {
    return (
      task?.status === "canceled" && task.error === AGENT_PAUSE_CANCEL_REASON
    );
  }

  private isActiveAgentState(
    task: RuntimeAgentRecord | PersistedAgentRecord | null,
  ): boolean {
    return task?.status === "pending" || task?.status === "running";
  }

  private lifecycleEventId(
    task: RuntimeAgentRecord,
    type:
      | "agent-message"
      | "agent-started"
      | "agent-completed"
      | "agent-failed"
      | "agent-canceled",
  ): string {
    return `${task.threadId}:${task.attemptGeneration}:${type}`;
  }

  private managerReportEventId(
    task: RuntimeAgentRecord,
    reportId: string,
  ): string {
    return `${task.threadId}:${task.attemptGeneration}:manager-report:${encodeURIComponent(reportId)}`;
  }

  private assertActiveParentChain(request: AgentToolRequest): void {
    if (!request.parentAgentId) return;
    const visited = new Set<string>();
    let cursor: string | undefined = request.parentAgentId;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error("Cannot create a child under a cyclic parent chain.");
      }
      visited.add(cursor);
      const parent = this.getAgentState(cursor);
      if (!parent) {
        throw new Error(`Parent thread not found: ${cursor}`);
      }
      if (parent.conversationId !== request.conversationId) {
        throw new Error("Cannot create a child in another conversation.");
      }
      if (!this.isActiveAgentState(parent)) {
        throw new Error(
          `Cannot create a child because parent thread ${cursor} is paused or finished.`,
        );
      }
      if (
        parent.agentType === AGENT_IDS.MANAGER &&
        parent.managerFinalReport &&
        parent.managerFinalReportId
      ) {
        throw new Error(
          `Cannot create a child because Manager thread ${cursor} sealed its fleet after accepting a final report.`,
        );
      }
      cursor = parent.parentAgentId;
    }
  }

  private wouldCreateParentCycle(
    threadId: string,
    parentAgentId: string,
  ): boolean {
    const visited = new Set<string>();
    let cursor: string | undefined = parentAgentId;
    while (cursor) {
      if (cursor === threadId) return true;
      if (visited.has(cursor)) return true;
      visited.add(cursor);
      cursor = this.getAgentState(cursor)?.parentAgentId;
    }
    return false;
  }

  async adoptAgent(
    threadId: string,
    parentAgentId: string,
  ): Promise<{ adopted: boolean; reason?: string }> {
    if (threadId === parentAgentId) {
      return { adopted: false, reason: "A manager cannot adopt itself." };
    }
    const manager = this.getAgentState(parentAgentId);
    if (!manager || manager.agentType !== AGENT_IDS.MANAGER) {
      return { adopted: false, reason: `Manager not found: ${parentAgentId}` };
    }
    if (manager.status !== "pending" && manager.status !== "running") {
      return {
        adopted: false,
        reason: "A paused or finished manager cannot adopt threads.",
      };
    }
    if (manager.managerFinalReport && manager.managerFinalReportId) {
      return {
        adopted: false,
        reason:
          "A Manager cannot adopt threads after its final report has sealed the fleet.",
      };
    }
    const target = this.getAgentState(threadId);
    if (!target) {
      return { adopted: false, reason: `Thread not found: ${threadId}` };
    }
    if (target.agentType === AGENT_IDS.MANAGER) {
      return {
        adopted: false,
        reason: "Managers cannot adopt other managers.",
      };
    }
    if (target.conversationId !== manager.conversationId) {
      return {
        adopted: false,
        reason: "A manager cannot adopt a thread from another conversation.",
      };
    }
    if (this.wouldCreateParentCycle(threadId, parentAgentId)) {
      return {
        adopted: false,
        reason: "Adoption would create a parent cycle.",
      };
    }

    const existingParentId = target.parentAgentId;
    if (existingParentId === parentAgentId) {
      return { adopted: true };
    }
    if (existingParentId) {
      const existingParent = this.getAgentState(existingParentId);
      if (
        !this.isExplicitlyPaused(existingParent) ||
        !this.isExplicitlyPaused(target)
      ) {
        return {
          adopted: false,
          reason: `Thread is already owned by manager ${existingParentId}; pause that manager before transferring ownership.`,
        };
      }
    } else if (
      target.status === "completed" ||
      target.status === "error" ||
      target.status === "canceled"
    ) {
      return {
        adopted: false,
        reason:
          "A terminal thread cannot be adopted after its completion was routed.",
      };
    }

    const task = this.tasks.get(threadId);
    if (task) {
      task.parentAgentId = parentAgentId;
      this.persistTask(task);
      return { adopted: true };
    }
    this.opts.saveAgentRecord?.({
      ...(target as PersistedAgentRecord),
      parentAgentId,
      updatedAt: Date.now(),
    });
    return { adopted: true };
  }

  private resetTaskForNextAttempt(
    task: RuntimeAgentRecord,
    prompt: string,
  ): void {
    const wasTerminal =
      task.status === "completed" ||
      task.status === "error" ||
      task.status === "canceled";
    // Invalidate any older executeTask still unwinding after an abort. It may
    // finish later, but it no longer owns this thread's mutable state.
    task.attemptGeneration += 1;
    task.prompt = prompt;
    task.status = "pending";
    task.startedAt = Date.now();
    task.completedAt = null;
    task.result = undefined;
    task.error = undefined;
    task.progressBuffer = "";
    task.recentActivity = [`Continuing thread: ${truncate(prompt, 200)}`];
    task.lastActivityAt = Date.now();
    task.activeToolCount = 0;
    task.toSubagentQueue.length = 0;
    task.toOrchestratorQueue.length = 0;
    // Effect-ratchet pin: `task.controller` is the subagent attempt's
    // cooperative cancellation seam — a REAL AbortSignal threaded through
    // the plain-TS agent session/tools; each new attempt gets a fresh one.
    task.controller = new AbortController();
    task.interruptedForFollowUp = false;
    task.terminalEventEmitted = false;
    task.pendingStartStatusText = undefined;
    // Cleared here so a bare reset reads as a spawn; the follow-up callers
    // (`sendAgentMessage` / `deliverFollowUpAsNextTurn`) re-set it right after.
    task.pendingStartIsFollowUp = undefined;
    task.pendingStartAudience = undefined;
    task.waitingForManagedChildren = false;
    task.managerIntermediateReportInTurn = false;
    if (wasTerminal) {
      task.managerFinalReport = undefined;
      task.managerFinalReportId = undefined;
      task.managerReportIds.clear();
      task.managerReportSequence = 0;
    }
  }

  private hydrateTaskFromRecord(
    record: PersistedAgentRecord,
    prompt: string,
    statusText = prompt,
  ): RuntimeAgentRecord {
    const continuingRun = record.status === "running";
    return {
      threadId: record.threadId,
      conversationId: record.conversationId,
      description: record.description,
      prompt,
      agentType: record.agentType,
      agentDepth: record.agentDepth,
      maxAgentDepth: record.maxAgentDepth,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
      // Effect-ratchet pin: fresh attempt seam controller (see
      // resetTaskForNextAttempt above).
      controller: new AbortController(),
      storageMode: record.storageMode ?? "local",
      parentAgentId: record.parentAgentId,
      modelConfigSnapshot: record.modelConfigSnapshot,
      recentActivity: [`Continuing thread: ${truncate(prompt, 200)}`],
      lastActivityAt: Date.now(),
      activeToolCount: 0,
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      turnCount: 0,
      interruptedForFollowUp: false,
      terminalEventEmitted: false,
      pendingStartStatusText: formatTaskUpdateStatusText(statusText),
      // Resuming an evicted/persisted thread is always a `send_input`
      // follow-up (this helper is only reached from that path).
      pendingStartIsFollowUp: true,
      waitingForManagedChildren: false,
      managerFinalReport: continuingRun ? record.managerFinalReport : undefined,
      managerFinalReportId: continuingRun
        ? record.managerFinalReportId
        : undefined,
      managerReportIds: new Set(
        continuingRun ? (record.managerReportIds ?? []) : [],
      ),
      managerReportSequence: continuingRun
        ? (record.managerReportSequence ?? 0)
        : 0,
      managerIntermediateReportInTurn: false,
      attemptGeneration: Number.isFinite(record.attemptGeneration)
        ? Math.max(0, Math.floor(record.attemptGeneration))
        : 0,
    };
  }

  private enqueueTask(task: RuntimeAgentRecord, prioritize = false): void {
    this.tasks.set(task.threadId, task);
    if (prioritize) {
      this.pendingQueue.unshift(task.threadId);
    } else {
      this.pendingQueue.push(task.threadId);
    }
    this.persistTask(task);
    this.tryStartNext();
  }

  /**
   * Re-enter the run-loop layer with the queued follow-up as the next
   * user turn on the existing long-lived `subagentSession`. Despite
   * being implemented as "reset + re-enqueue", this is NOT a fresh run
   * of the task — the session's accumulated message array (system +
   * original user prompt + prior assistant/tool turns) is preserved,
   * and the synthesized "Task update from orchestrator: …" string is
   * just the next user message that gets appended on top.
   *
   * Reached when `send_input` aborted the in-flight `runSubagent` and
   * we want to deliver the follow-up immediately (`shouldDeliverFollowUp`
   * true).
   */
  private deliverFollowUpAsNextTurn(task: RuntimeAgentRecord): void {
    const pendingStartStatusText = task.pendingStartStatusText;
    const pendingStartAudience = task.pendingStartAudience;
    const prompt = this.buildTaskPrompt(task);
    this.resetTaskForNextAttempt(task, prompt);
    // The superseded turn's boundary emitted no completion event (the
    // dispatch short-circuits into this delivery before the lifecycle
    // emit) — an interjection extends ongoing work, so only the continued
    // turn's eventual real finish surfaces a completion card.
    task.pendingStartStatusText = pendingStartStatusText;
    // Interjected in-flight work is a `send_input` follow-up, not a spawn.
    task.pendingStartIsFollowUp = true;
    task.pendingStartAudience = pendingStartAudience;
    task.recentActivity = [
      pendingStartStatusText ?? "Applying task update from orchestrator.",
    ];
    this.pendingQueue.unshift(task.threadId);
    this.persistTask(task);
  }

  private clearAttemptTakeoverTimer(
    threadId: string,
    generation?: number,
    promise?: Promise<void>,
  ): void {
    const pending = this.attemptTakeoverDeadlines.get(threadId);
    if (!pending) return;
    if (generation !== undefined && pending.generation !== generation) return;
    if (promise !== undefined && pending.promise !== promise) return;
    // The synchronous map delete is the real fence (the deadline body
    // re-validates against the map); the interrupt just reclaims the
    // sleeping fiber, replacing `clearTimeout`.
    this.attemptTakeoverDeadlines.delete(threadId);
    pending.fiber.interruptUnsafe();
  }

  private scheduleAttemptTakeover(
    task: RuntimeAgentRecord,
    activeAttempt: { generation: number; promise: Promise<void> },
  ): void {
    const existing = this.attemptTakeoverDeadlines.get(task.threadId);
    if (
      existing?.generation === activeAttempt.generation &&
      existing.promise === activeAttempt.promise
    ) {
      return;
    }
    this.clearAttemptTakeoverTimer(task.threadId);
    if (this.supervisoryScopeClosed) {
      // Shutdown already interrupted the supervisory scope; a takeover
      // deadline after that point has nothing left to arbitrate (shutdown
      // cancels every pending/running task).
      return;
    }
    const timeoutMs = DEFAULT_AGENT_ATTEMPT_TEARDOWN_TIMEOUT_MS;
    const deadlineBody = Effect.sync(() => {
      const inFlight = this.inFlightAttempts.get(task.threadId);
      const takeover = this.attemptTakeoverDeadlines.get(task.threadId);
      if (
        inFlight?.generation !== activeAttempt.generation ||
        inFlight.promise !== activeAttempt.promise ||
        takeover?.generation !== activeAttempt.generation ||
        takeover.promise !== activeAttempt.promise ||
        task.status !== "pending" ||
        task.attemptGeneration === activeAttempt.generation
      ) {
        this.clearAttemptTakeoverTimer(
          task.threadId,
          activeAttempt.generation,
          activeAttempt.promise,
        );
        return;
      }

      // The old promise may never settle (for example a bridge/tool that
      // ignored abort). Release its scheduler slot and remove its ownership
      // record. Generation/controller checks fence every later callback and
      // state write from that promise if it eventually returns.
      this.attemptTakeoverDeadlines.delete(task.threadId);
      this.inFlightAttempts.delete(task.threadId);
      this.runningCount = Math.max(0, this.runningCount - 1);
      this.tryStartNext();
    });
    const fiber = managerRuntime.runSync(
      Effect.forkIn(
        Effect.andThen(Effect.sleep(timeoutMs), deadlineBody),
        this.supervisoryScope,
        { startImmediately: true },
      ),
    );
    this.attemptTakeoverDeadlines.set(task.threadId, {
      generation: activeAttempt.generation,
      promise: activeAttempt.promise,
      fiber,
    });
  }

  private tryStartNext(): void {
    const maxConcurrent = Math.max(
      1,
      optsValueOrDefault(
        this.opts.getMaxConcurrent?.(),
        this.defaultMaxConcurrent,
      ),
    );
    // Schedule stale-attempt takeover independently of free global slots.
    // With max concurrency 1, the hung predecessor itself occupies the only
    // slot; waiting until the start loop runs would therefore deadlock before
    // the teardown deadline was ever armed.
    for (const threadId of this.pendingQueue) {
      const task = this.tasks.get(threadId);
      const activeAttempt = this.inFlightAttempts.get(threadId);
      if (task?.status === "pending" && activeAttempt) {
        this.scheduleAttemptTakeover(task, activeAttempt);
      }
    }
    let remainingCandidates = this.pendingQueue.length;
    while (
      this.runningCount < maxConcurrent &&
      this.pendingQueue.length > 0 &&
      remainingCandidates > 0
    ) {
      const threadId = this.pendingQueue.shift();
      if (!threadId) break;
      remainingCandidates -= 1;
      const task = this.tasks.get(threadId);
      if (!task || task.status !== "pending") {
        continue;
      }
      const activeAttempt = this.inFlightAttempts.get(threadId);
      if (activeAttempt) {
        // A canceled/interrupted attempt still owns teardown for this thread.
        // Keep the resume queued, but bound that ownership: an abort-ignoring
        // promise is fenced and replaced after the teardown lease expires.
        this.pendingQueue.push(threadId);
        this.scheduleAttemptTakeover(task, activeAttempt);
        continue;
      }
      this.runningCount += 1;
      task.status = "running";
      const generation = ++task.attemptGeneration;
      const controller = task.controller;
      const startStatusText = task.pendingStartStatusText ?? task.description;
      const startIsFollowUp = task.pendingStartIsFollowUp ?? false;
      const startAudience =
        task.pendingStartAudience === "orchestrator-only"
          ? "orchestrator-only"
          : undefined;
      task.pendingStartStatusText = undefined;
      task.pendingStartIsFollowUp = undefined;
      task.pendingStartAudience = undefined;
      task.managerIntermediateReportInTurn = false;
      this.persistTask(task);
      if (task.storageMode === "cloud") {
        // The local thread id is also the canonical cloud Activity id. Publish
        // every attempt (including send_input continuations) with its
        // generation so a late terminal from the prior attempt cannot close
        // the newly-running row.
        task.cloudAgentId = task.threadId;
        task.cloudCreatePromise = this.opts
          .createCloudAgentRecord({
            agentId: task.threadId,
            conversationId: task.conversationId,
            description: task.description,
            prompt: task.prompt,
            agentType: task.agentType,
            attemptGeneration: generation,
            ...(task.parentAgentId
              ? { parentAgentId: task.parentAgentId }
              : {}),
            ...(typeof task.maxAgentDepth === "number"
              ? { maxAgentDepth: task.maxAgentDepth }
              : {}),
          })
          .then((created) => {
            task.cloudAgentId = created.agentId;
          })
          .catch(() => {
            // The agent still runs on this computer. A later attempt republishes
            // the row; terminal sync below remains best-effort for this one.
          });
      }
      this.opts.onAgentEvent?.({
        type: "agent-started",
        conversationId: task.conversationId,
        eventId: this.lifecycleEventId(task, "agent-started"),
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        ...(startStatusText ? { statusText: startStatusText } : {}),
        ...(startIsFollowUp ? { isFollowUp: true } : {}),
        attemptGeneration: generation,
        ...(startAudience ? { audience: startAudience } : {}),
      });
      logWorkingIndicatorTrace("[stella:working-indicator:agent-started]", {
        threadId: task.threadId,
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        description: task.description,
        statusText: startStatusText,
      });
      const execution = this.executeTask(task, {
        generation,
        controller,
      }).catch(() => undefined);
      this.inFlightAttempts.set(threadId, { generation, promise: execution });
      this.opts.superviseAttempt?.({
        threadId,
        ...(task.rootRunId ? { rootRunId: task.rootRunId } : {}),
        abort: (reason) => {
          void this.cancelAgent(
            threadId,
            typeof reason === "string"
              ? reason
              : reason instanceof Error
                ? reason.message
                : undefined,
          );
        },
        settled: execution.then(() => undefined),
      });
      const settleAttempt = () => {
        const fiberEntry = this.attemptFibers.get(threadId);
        if (
          fiberEntry?.generation === generation &&
          fiberEntry.promise === execution
        ) {
          this.attemptFibers.delete(threadId);
        }
        const activeAttempt = this.inFlightAttempts.get(threadId);
        if (
          activeAttempt?.generation === generation &&
          activeAttempt.promise === execution
        ) {
          this.clearAttemptTakeoverTimer(threadId, generation, execution);
          this.inFlightAttempts.delete(threadId);
          this.runningCount = Math.max(0, this.runningCount - 1);
          this.tryStartNext();
        }
      };
      if (this.supervisoryScopeClosed) {
        // Post-shutdown resurrection path: no supervisory scope remains, so
        // fall back to a plain promise join for the bookkeeping.
        void execution.finally(settleAttempt);
      } else {
        // The attempt's supervision fiber: joins the (already-started,
        // never-rejecting) execution promise and releases the scheduler
        // slot. Interrupting this fiber (scope close at shutdown) runs the
        // same bookkeeping via `ensuring` but NEVER cancels the run itself —
        // run cancellation is only ever the cooperative `cancelAgent` path.
        const fiber = managerRuntime.runSync(
          Effect.forkIn(
            Effect.asVoid(Effect.promise(() => execution)).pipe(
              Effect.ensuring(Effect.sync(settleAttempt)),
            ),
            this.supervisoryScope,
            { startImmediately: true },
          ),
        );
        this.attemptFibers.set(threadId, {
          generation,
          promise: execution,
          fiber,
        });
      }
    }
  }

  private acquireFsLock(threadId: string, key: string): Promise<() => void> {
    return new Promise((resolve) => {
      const attempt = () => {
        const conflicting = this.activeFsLocks.some(
          (lock) => lock.threadId !== threadId && pathsOverlap(lock.key, key),
        );
        if (conflicting) {
          this.fsLockWaiters.push(attempt);
          return;
        }
        const lock: FsLock = {
          id: `${threadId}:${++this.nextId}`,
          threadId,
          key,
        };
        this.activeFsLocks.push(lock);
        resolve(() => {
          const index = this.activeFsLocks.findIndex(
            (entry) => entry.id === lock.id,
          );
          if (index >= 0) {
            this.activeFsLocks.splice(index, 1);
          }
          const waiters = this.fsLockWaiters.splice(
            0,
            this.fsLockWaiters.length,
          );
          for (const waiter of waiters) {
            queueMicrotask(waiter);
          }
        });
      };
      attempt();
    });
  }

  private async executeTask(
    task: RuntimeAgentRecord,
    attempt: { generation: number; controller: AbortController },
  ): Promise<void> {
    const isCurrentAttempt = () =>
      task.attemptGeneration === attempt.generation &&
      task.controller === attempt.controller;
    try {
      // Defensive legacy healing: every production spawn/resume resolves
      // before enqueue, but an old in-memory/null row must still be pinned
      // before its context is built or any model executes.
      if (!task.modelConfigSnapshot) {
        await this.resolveGeneralModelConfigIfMissing(task);
        if (task.modelConfigSnapshot) this.persistTask(task);
      }
      const runId = `run:${task.threadId}:${++this.nextId}`;
      // Create the session before the context load. A managed-child report
      // can persist while that async load (or prompt hooks) is in flight;
      // the session then retains `notifyHistoryChanged()` even before its Pi
      // Agent exists and reloads SQLite immediately after creation.
      const subagentSession = getOrCreateSubagentSession(
        this.subagentSessions,
        task.threadId,
        task.conversationId,
        task.agentType,
      );
      const context = await this.opts.fetchAgentContext({
        conversationId: task.conversationId,
        agentType: task.agentType,
        runId,
        threadId: task.threadId,
        ...(task.model ? { model: task.model } : {}),
        ...(task.spawnEngine ? { spawnEngine: task.spawnEngine } : {}),
        ...(task.spawnReasoningEffort
          ? { spawnReasoningEffort: task.spawnReasoningEffort }
          : {}),
        ...(task.modelConfigSnapshot
          ? { modelConfigSnapshot: task.modelConfigSnapshot }
          : {}),
        ...(task.toolWorkspaceRoot
          ? { toolWorkspaceRoot: task.toolWorkspaceRoot }
          : {}),
      });
      if (!isCurrentAttempt()) return;

      context.maxAgentDepth =
        typeof task.maxAgentDepth === "number"
          ? Math.min(context.maxAgentDepth, task.maxAgentDepth)
          : context.maxAgentDepth;
      context.agentDepth = task.agentDepth;
      context.attemptGeneration = attempt.generation;

      const taskPrompt = this.buildTaskPrompt(task);
      task.turnCount += 1;

      const runSubagentArgs: Parameters<
        LocalAgentManagerOpts["runSubagent"]
      >[0] = {
        conversationId: task.conversationId,
        userMessageId: runId,
        agentType: task.agentType,
        agentId: task.threadId,
        rootRunId: task.rootRunId,
        ...(task.toolWorkspaceRoot
          ? { toolWorkspaceRoot: task.toolWorkspaceRoot }
          : {}),
        taskDescription: task.description,
        taskPrompt,
        agentContext: context,
        subagentSession,
        persistToConvex: task.storageMode === "cloud",
        enableRemoteTools: true,
        abortSignal: attempt.controller.signal,
        onProgress: (chunk) => {
          if (
            !isCurrentAttempt() ||
            attempt.controller.signal.aborted ||
            task.status === "canceled"
          )
            return;
          if (typeof chunk !== "string" || !chunk) return;
          task.progressBuffer += chunk;
          if (task.progressBuffer.length > 4_000) {
            task.progressBuffer = task.progressBuffer.slice(
              task.progressBuffer.length - 4_000,
            );
          }
          const compact = task.progressBuffer.replace(/\s+/g, " ").trim();
          if (!compact) return;
          task.recentActivity = [truncate(compact, 500)];
          task.lastActivityAt = Date.now();
        },
        onStatus: (statusText) => {
          if (
            !isCurrentAttempt() ||
            attempt.controller.signal.aborted ||
            task.status === "canceled"
          ) {
            return;
          }
          const compact = statusText.replace(/\s+/g, " ").trim();
          if (!compact) return;
          task.recentActivity = [truncate(compact, 500)];
          task.lastActivityAt = Date.now();
          this.opts.onAgentEvent?.({
            type: "agent-progress",
            conversationId: task.conversationId,
            rootRunId: task.rootRunId,
            agentId: task.threadId,
            agentType: task.agentType,
            description: task.description,
            parentAgentId: task.parentAgentId,
            statusText: compact,
            attemptGeneration: attempt.generation,
          });
        },
        onToolStart: (ev) => {
          // Once cancelAgent has marked this task canceled, suppress any
          // in-flight `tool_execution_start` events from the agent loop —
          // those would otherwise leak `agent-progress` lifecycle events
          // after `agent-canceled`, leaving a phantom "Working … Task" chip
          // in the footer that re-adds the task to the live UI state.
          if (
            !isCurrentAttempt() ||
            attempt.controller.signal.aborted ||
            task.status === "canceled"
          ) {
            return;
          }
          const statusText = ev.statusText ?? `Running ${ev.toolName}`;
          const toolActivity = taskToolActivityFromStart({
            ...ev,
            statusText,
          });
          // Tool lifecycle is a liveness signal too: without this, a single
          // long tool call looks idle to snapshot pollers even though the
          // agent is working.
          task.recentActivity = [truncate(statusText, 500)];
          task.lastActivityAt = Date.now();
          task.activeToolCount += 1;
          this.opts.onAgentEvent?.({
            type: "agent-progress",
            conversationId: task.conversationId,
            rootRunId: task.rootRunId,
            agentId: task.threadId,
            agentType: task.agentType,
            description: task.description,
            parentAgentId: task.parentAgentId,
            statusText,
            toolActivity,
            attemptGeneration: attempt.generation,
          });
          logWorkingIndicatorTrace(
            "[stella:working-indicator:agent-progress]",
            {
              threadId: task.threadId,
              conversationId: task.conversationId,
              rootRunId: task.rootRunId,
              description: task.description,
              statusText,
            },
          );
        },
        onToolEnd: (ev) => {
          if (
            !isCurrentAttempt() ||
            attempt.controller.signal.aborted ||
            task.status === "canceled"
          ) {
            return;
          }
          task.lastActivityAt = Date.now();
          task.activeToolCount = Math.max(0, task.activeToolCount - 1);
          const toolActivity = taskToolActivityFromEnd(ev);
          task.recentActivity = [truncate(toolActivity.label, 500)];
          this.opts.onAgentEvent?.({
            type: "agent-progress",
            conversationId: task.conversationId,
            rootRunId: task.rootRunId,
            agentId: task.threadId,
            agentType: task.agentType,
            description: task.description,
            parentAgentId: task.parentAgentId,
            statusText: toolActivity.label,
            toolActivity,
            attemptGeneration: attempt.generation,
          });
        },
        toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
          const canFinishInterruptedTool = () =>
            this.shouldDeliverFollowUp(task);
          if (
            !isCurrentAttempt() ||
            (attempt.controller.signal.aborted && !canFinishInterruptedTool())
          ) {
            return { error: "Agent attempt was superseded." };
          }
          if (
            task.storageMode === "cloud" &&
            isSpawnAgentTool(toolName) &&
            task.cloudCreatePromise
          ) {
            await task.cloudCreatePromise.catch(() => undefined);
          }
          const scopedContext: ToolContext = {
            ...toolContext,
            agentId: task.threadId,
            attemptGeneration: attempt.generation,
            ...(task.cloudAgentId ? { cloudAgentId: task.cloudAgentId } : {}),
            agentDepth: task.agentDepth,
            maxAgentDepth: context.maxAgentDepth,
          };
          const lockKey = getFsLockKey(toolName, toolArgs, scopedContext);
          if (!lockKey) {
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          }
          const release = await this.acquireFsLock(task.threadId, lockKey);
          try {
            if (
              !isCurrentAttempt() ||
              (attempt.controller.signal.aborted && !canFinishInterruptedTool())
            ) {
              return { error: "Agent attempt was superseded." };
            }
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          } finally {
            release();
          }
        },
      };
      let result: Awaited<ReturnType<LocalAgentManagerOpts["runSubagent"]>>;
      // Turn boundary: whatever the run reports, no tool is in flight once
      // `runSubagent` returns (or throws). Clearing here — not just in
      // onToolEnd — keeps the in-flight signal honest for runs that die
      // mid-tool without ever emitting a tool-end event.
      try {
        result = await this.opts.runSubagent(runSubagentArgs);
      } finally {
        if (isCurrentAttempt()) {
          task.activeToolCount = 0;
        }
      }

      if (!isCurrentAttempt()) return;

      task.completedAt = Date.now();
      // Bank this run's collected file records immediately, before any
      // branch below decides the run's fate. A `send_input` follow-up
      // aborts the run without emitting its completion; banking is what
      // lets those files survive into the eventual rollup.
      task.bankedFileChanges = mergeUniqueFileRecords(
        task.bankedFileChanges,
        result.fileChanges,
      );
      task.bankedProducedFiles = mergeUniqueFileRecords(
        task.bankedProducedFiles,
        result.producedFiles,
      );
      if (this.shouldDeliverFollowUp(task)) {
        // `send_input` aborted the current `runSubagent` on purpose so
        // we can deliver the queued follow-up as the next user turn on
        // the same session. The dispatch at the end of this method calls
        // `deliverFollowUpAsNextTurn`; status stays in its current state
        // so the dispatch can read `interruptedForFollowUp`.
      } else if (
        attempt.controller.signal.aborted ||
        task.status === "canceled"
      ) {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else if (result.interrupted) {
        task.status = "canceled";
        task.error = "Canceled";
      } else if (result.error) {
        task.status = "error";
        task.error = result.error;
      } else {
        task.status = "completed";
        // Manager assistant-final text is private working conversation. Only
        // report() may populate the upward completion result below.
        task.result =
          task.agentType === AGENT_IDS.MANAGER ? undefined : result.result;
        // Completion rollup = banked records from send_input-interrupted
        // runs + this run's (already merged into the bank above). Drained
        // when the `agent-completed` event is actually emitted, so files
        // are never re-revealed across rollups but survive completions
        // that get skipped (e.g. a queued follow-up re-entering the loop).
        task.fileChanges = task.bankedFileChanges;
        task.producedFiles = task.bankedProducedFiles;
      }
    } catch (error) {
      if (!isCurrentAttempt()) return;
      task.completedAt = Date.now();
      if (this.shouldDeliverFollowUp(task)) {
        // `send_input` aborted the current `runSubagent` on purpose; see
        // comment above.
      } else if (attempt.controller.signal.aborted) {
        task.status = "canceled";
        task.error = task.error ?? "Canceled";
      } else {
        task.status = "error";
        task.error = (error as Error).message ?? "Task failed";
      }
    }

    if (!isCurrentAttempt()) return;

    if (
      this.shouldDeliverFollowUp(task) ||
      (task.toSubagentQueue.length > 0 && task.status === "completed")
    ) {
      this.deliverFollowUpAsNextTurn(task);
      return;
    }

    const managerHasActiveWork =
      task.agentType === AGENT_IDS.MANAGER &&
      this.hasActiveManagedChildren(task.threadId);
    if (
      task.agentType === AGENT_IDS.MANAGER &&
      task.status === "completed" &&
      (managerHasActiveWork || task.managerIntermediateReportInTurn)
    ) {
      // A non-terminal report or a turn ending while children remain is a wait
      // boundary. The assistant-final text is intentionally discarded.
      task.status = "pending";
      task.completedAt = null;
      task.result = undefined;
      task.error = undefined;
      // Effect-ratchet pin: fresh attempt seam controller for the manager's
      // wait-boundary turn (see resetTaskForNextAttempt).
      task.controller = new AbortController();
      task.waitingForManagedChildren = true;
      task.terminalEventEmitted = false;
      this.persistTask(task);
      return;
    }

    if (task.agentType === AGENT_IDS.MANAGER && task.status === "completed") {
      task.result =
        task.managerFinalReport ?? MANAGER_MISSING_FINAL_REPORT_FALLBACK;
    }

    // Task has reached a terminal status (completed/error/canceled). Drop
    // the long-lived SubagentSession so its Agent + message array can be
    // reclaimed; future tasks for this threadId would build a fresh
    // session if the runtime ever re-enqueues this thread (rare — terminal
    // is sticky). Done before persistTask + lifecycle emit so any
    // listener-triggered work (e.g. cloud sync) doesn't see stale state.
    const session = this.subagentSessions.get(task.threadId);
    if (session) {
      this.subagentSessions.delete(task.threadId);
      try {
        session.dispose();
      } catch {
        // Best-effort: dispose just aborts the agent and frees the ref.
      }
    }

    // Manager completion is event-first. If the process dies after the
    // durable lifecycle append but before this row becomes completed,
    // restart recovery sees the still-running row, detects the stable event
    // id, and only closes the row instead of emitting a duplicate. Other
    // agent types retain their existing row-first terminal ordering.
    const persistAfterTerminalEvent =
      task.agentType === AGENT_IDS.MANAGER && task.status === "completed";
    if (!persistAfterTerminalEvent) {
      this.persistTask(task);
    }

    // Emit task lifecycle event
    if (!task.terminalEventEmitted) {
      if (task.status === "completed") {
        const completedEvent: AgentLifecycleEvent = {
          type: "agent-completed",
          conversationId: task.conversationId,
          eventId: this.lifecycleEventId(task, "agent-completed"),
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          parentAgentId: task.parentAgentId,
          result: task.result,
          attemptGeneration: attempt.generation,
          ...(task.fileChanges?.length
            ? { fileChanges: task.fileChanges }
            : {}),
          ...(task.producedFiles?.length
            ? { producedFiles: task.producedFiles }
            : {}),
        };
        // The rollup is now captured on the event — drain the bank so a
        // send_input re-run's later completion only reveals new files.
        task.bankedFileChanges = undefined;
        task.bankedProducedFiles = undefined;
        // State-based completion rule: reaching this emit means the thread
        // is going idle with no pending follow-up (a pending follow-up
        // short-circuited into `deliverFollowUpAsNextTurn` above, before
        // this block) — that IS the real finish, so the full event emits
        // immediately. No deferral: if the orchestrator resumes the thread
        // afterwards, that's a new run with its own completion card —
        // Done → running-again is honest history, not a glitch.
        //
        // Busy-vs-idle classification is atomic with turn state: there is
        // no `await` between `runSubagent` resolving and this emit, so a
        // `send_input` either ran before dispatch (task still "running" →
        // queued as a follow-up → the short-circuit above wins and no
        // completion emits for this boundary) or runs after it (task
        // terminal → the terminal-resume path in `sendAgentMessage`, with
        // this completion already emitted). A completion can never be
        // misclassified as interjected.
        this.opts.onAgentEvent?.(completedEvent);
      } else if (task.status === "error") {
        this.opts.onAgentEvent?.({
          type: "agent-failed",
          conversationId: task.conversationId,
          eventId: this.lifecycleEventId(task, "agent-failed"),
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          parentAgentId: task.parentAgentId,
          error: task.error,
          attemptGeneration: attempt.generation,
        });
      } else if (task.status === "canceled") {
        this.opts.onAgentEvent?.({
          type: "agent-canceled",
          conversationId: task.conversationId,
          eventId: this.lifecycleEventId(task, "agent-canceled"),
          rootRunId: task.rootRunId,
          agentId: task.threadId,
          agentType: task.agentType,
          description: task.description,
          parentAgentId: task.parentAgentId,
          error: task.error,
          attemptGeneration: attempt.generation,
        });
      }
      task.terminalEventEmitted = true;
    }
    if (persistAfterTerminalEvent) {
      this.persistTask(task);
    }

    // Sync task completion to Convex in background (non-blocking)
    if (task.storageMode === "cloud") {
      void (async () => {
        // Wait for cloud task creation to finish so we have the cloudAgentId
        if (task.cloudCreatePromise) {
          await task.cloudCreatePromise.catch(() => {});
        }
        if (!task.cloudAgentId) return;
        const status =
          task.status === "completed"
            ? "completed"
            : task.status === "canceled"
              ? "canceled"
              : "error";
        await this.opts
          .completeCloudAgentRecord({
            agentId: task.cloudAgentId,
            attemptGeneration: attempt.generation,
            status,
            result: task.result ? truncate(task.result, 30_000) : undefined,
            error: task.error ? truncate(task.error, 10_000) : undefined,
          })
          .catch(() => {
            // Background sync failure — task is still tracked locally
          });
      })();
    }
  }

  async createAgent(request: AgentToolRequest): Promise<{
    threadId: string;
    activeThreads?: RuntimeThreadRecord[];
  }> {
    // `request.workspace` is intentionally ignored: local execution implies the computer workspace.
    this.assertActiveParentChain(request);
    // Effect-ratchet pin: the new agent's cooperative cancellation seam
    // (see resetTaskForNextAttempt) — created before the task record so the
    // spawn window is already cancellable.
    const controller = new AbortController();
    const resolvedThread =
      this.opts.resolveTaskThread?.({
        conversationId: request.conversationId,
        agentType: request.agentType,
        threadId: request.threadId,
        nameHint: request.description,
      }) ?? null;
    const threadId =
      resolvedThread?.threadId ?? request.threadId ?? `thread-${++this.nextId}`;
    const existingModelConfigSnapshot = resolvedThread?.reused
      ? this.opts.getAgentRecord?.(threadId)?.modelConfigSnapshot
      : undefined;
    const modelConfigSnapshot =
      existingModelConfigSnapshot ?? request.modelConfigSnapshot;

    const task: RuntimeAgentRecord = {
      threadId,
      conversationId: request.conversationId,
      rootRunId: request.rootRunId,
      description: request.description,
      prompt: request.prompt,
      agentType: request.agentType,
      ...(request.model ? { model: request.model } : {}),
      ...(request.spawnEngine ? { spawnEngine: request.spawnEngine } : {}),
      ...(request.spawnReasoningEffort
        ? { spawnReasoningEffort: request.spawnReasoningEffort }
        : {}),
      ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
      ...(request.toolWorkspaceRoot
        ? { toolWorkspaceRoot: request.toolWorkspaceRoot }
        : {}),
      agentDepth: Math.max(1, request.agentDepth ?? 1),
      maxAgentDepth:
        typeof request.maxAgentDepth === "number"
          ? Math.max(1, Math.floor(request.maxAgentDepth))
          : undefined,
      status: "pending",
      startedAt: Date.now(),
      completedAt: null,
      controller,
      storageMode: request.storageMode,
      parentAgentId: request.parentAgentId,
      recentActivity: [],
      lastActivityAt: Date.now(),
      activeToolCount: 0,
      progressBuffer: "",
      toSubagentQueue: [],
      toOrchestratorQueue: [],
      messageLog: [],
      turnCount: 0,
      interruptedForFollowUp: false,
      terminalEventEmitted: false,
      waitingForManagedChildren: false,
      managerReportIds: new Set(),
      managerReportSequence: 0,
      managerIntermediateReportInTurn: false,
      attemptGeneration: 0,
    };
    await this.resolveGeneralModelConfigIfMissing(task);
    logWorkingIndicatorTrace("[stella:working-indicator:create-agent]", {
      threadId,
      conversationId: request.conversationId,
      rootRunId: request.rootRunId,
      description: request.description,
      agentType: request.agentType,
      parentAgentId: request.parentAgentId,
    });

    // Re-check immediately before publication. Today the setup above is
    // synchronous, but keeping the invariant at the commit point closes the
    // spawn-during-pause race if thread/cloud setup later gains an await.
    this.assertActiveParentChain(request);
    this.enqueueTask(task);
    return {
      threadId: task.threadId,
      activeThreads: this.opts.listActiveThreads?.(request.conversationId),
    };
  }

  /**
   * Run a single agent turn OUTSIDE the durable task surface: no thread
   * row, no work slot, no lifecycle events, no persisted agent record.
   * This is the execution primitive for workflow scripts — their agents
   * report to the script, not to the orchestrator. The agentId should
   * use the `<conversationId>::subagent::<type>::…` shape so any
   * incidental thread-storage writes derive the right conversation.
   */
  async runEphemeralAgent(args: {
    conversationId: string;
    agentId: string;
    description: string;
    prompt: string;
    rootRunId?: string;
    signal: AbortSignal;
  }): Promise<{ result: string; error?: string; interrupted?: boolean }> {
    const agentType = "general";
    const agentContext = await this.opts.fetchAgentContext({
      conversationId: args.conversationId,
      agentType,
      runId: args.agentId,
      threadId: args.agentId,
    });
    const session = getOrCreateSubagentSession(
      this.subagentSessions,
      args.agentId,
      args.conversationId,
      agentType,
    );
    try {
      const outcome = await this.opts.runSubagent({
        conversationId: args.conversationId,
        userMessageId: args.agentId,
        agentType,
        agentId: args.agentId,
        ...(args.rootRunId ? { rootRunId: args.rootRunId } : {}),
        taskDescription: args.description,
        taskPrompt: args.prompt,
        agentContext,
        subagentSession: session,
        persistToConvex: false,
        enableRemoteTools: true,
        abortSignal: args.signal,
        toolExecutor: async (toolName, toolArgs, toolContext, signal) => {
          const scopedContext: ToolContext = {
            ...toolContext,
            agentId: args.agentId,
            agentDepth: 1,
            maxAgentDepth: agentContext.maxAgentDepth,
          };
          const lockKey = getFsLockKey(toolName, toolArgs, scopedContext);
          if (!lockKey) {
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          }
          const release = await this.acquireFsLock(args.agentId, lockKey);
          try {
            return await this.opts.toolExecutor(
              toolName,
              toolArgs,
              scopedContext,
              signal,
            );
          } finally {
            release();
          }
        },
      });
      return {
        result: outcome.result,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.interrupted ? { interrupted: true } : {}),
      };
    } finally {
      const liveSession = this.subagentSessions.get(args.agentId);
      if (liveSession) {
        this.subagentSessions.delete(args.agentId);
        try {
          liveSession.dispose();
        } catch {
          // Best-effort.
        }
      }
    }
  }

  /**
   * Cancel every member thread of a work group. Member discovery comes
   * from the durable thread registry (not the in-memory task map) so
   * already-persisted members are covered too; cancelAgent is a no-op
   * for members that already reached a terminal status.
   */
  private listActiveManagedDescendantThreadIds(
    managerThreadId: string,
  ): string[] {
    const threadIds = new Set<string>();
    for (const task of this.tasks.values()) {
      if (
        task.threadId !== managerThreadId &&
        this.isDescendantOf(task.threadId, managerThreadId) &&
        (task.status === "pending" || task.status === "running")
      ) {
        threadIds.add(task.threadId);
      }
    }
    for (const record of this.opts.listAgentRecordsByStatus?.("running") ??
      []) {
      if (
        record.threadId !== managerThreadId &&
        this.isDescendantOf(record.threadId, managerThreadId)
      ) {
        threadIds.add(record.threadId);
      }
    }
    return [...threadIds];
  }

  private async cascadeCancelManagedChildren(
    managerThreadId: string,
    reason?: string,
  ): Promise<void> {
    // Old persisted data may contain manager cycles from before adoption was
    // guarded. Keep pause durable without recursively walking such a cycle.
    if (this.cancelCascadeInProgress.has(managerThreadId)) return;
    this.cancelCascadeInProgress.add(managerThreadId);
    try {
      for (const childThreadId of this.listActiveManagedDescendantThreadIds(
        managerThreadId,
      )) {
        await this.cancelAgent(childThreadId, reason);
      }
    } finally {
      this.cancelCascadeInProgress.delete(managerThreadId);
    }
  }

  async cancelGroup(
    groupKey: string,
    reason?: string,
  ): Promise<{ canceled: boolean; canceledThreadIds: string[] }> {
    const memberIds = this.opts.listGroupMemberThreadIds?.(groupKey) ?? [];
    if (memberIds.length === 0) {
      return { canceled: false, canceledThreadIds: [] };
    }
    const canceledThreadIds: string[] = [];
    for (const threadId of memberIds) {
      const result = await this.cancelAgent(threadId, reason);
      if (result.canceled) {
        canceledThreadIds.push(threadId);
      }
    }
    return { canceled: canceledThreadIds.length > 0, canceledThreadIds };
  }

  async getAgent(agentId: string): Promise<AgentToolSnapshot | null> {
    const local = this.tasks.get(agentId);
    if (local) {
      return this.buildTaskSnapshot(local);
    }
    const persisted = this.opts.getAgentRecord?.(agentId);
    if (persisted) {
      return this.buildPersistedSnapshot(persisted);
    }
    return await this.opts.getCloudAgentRecord(agentId);
  }

  getActiveAgentCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        task.status === "completed" ||
        task.status === "error" ||
        task.status === "canceled"
      ) {
        continue;
      }
      count++;
    }
    return count;
  }

  listActiveAgentRuns(): RuntimeActiveRun[] {
    const byRunId = new Map<string, RuntimeActiveRun>();
    for (const task of this.tasks.values()) {
      if (
        task.status === "completed" ||
        task.status === "error" ||
        task.status === "canceled"
      ) {
        continue;
      }
      const runId = task.rootRunId ?? task.threadId;
      if (!runId) continue;
      byRunId.set(runId, {
        runId,
        conversationId: task.conversationId,
      });
    }
    return [...byRunId.values()];
  }

  /**
   * Cancel every pending/running task and await the cancellation cascades
   * (managed-child fan-out, cloud record updates, session disposal). Joining
   * the in-flight attempt promises themselves is the kernel supervisor's job
   * (`superviseAttempt`), which interrupts and joins them at shutdown.
   */
  async shutdown(reason = AGENT_SHUTDOWN_CANCEL_REASON): Promise<void> {
    for (const pending of this.attemptTakeoverDeadlines.values()) {
      pending.fiber.interruptUnsafe();
    }
    this.attemptTakeoverDeadlines.clear();
    // v1 could snapshot still-running rows on the replacement worker's boot.
    // v2 performs a graceful Effect shutdown first, which durably cancels
    // those rows. Capture every resumable task before that cancellation so the
    // episode-stamped sidecar remains the authoritative recovery evidence.
    // A Manager that already accepted its final report is intentionally
    // excluded: its two durable delivery artifacts are repaired below and it
    // must never be restarted as unfinished work.
    this.persistInterruptionSnapshot(
      [...this.tasks.values()]
        .filter(
          (task) =>
            (task.status === "pending" || task.status === "running") &&
            !(
              task.agentType === AGENT_IDS.MANAGER &&
              task.managerFinalReport &&
              task.managerFinalReportId
            ),
        )
        .map(({ threadId, conversationId }) => ({
          threadId,
          conversationId,
        })),
    );
    const cancels: Array<Promise<unknown>> = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "pending" && task.status !== "running") {
        continue;
      }
      if (
        task.agentType === AGENT_IDS.MANAGER &&
        task.managerFinalReport &&
        task.managerFinalReportId
      ) {
        // Preserve Manager's existing event-first two-artifact delivery even
        // when shutdown lands between report(final=true) and turn return.
        // Replacing the controller fences the old promise without changing
        // the persisted generation used by the stable completion event id.
        const eventId = this.lifecycleEventId(task, "agent-completed");
        if (
          !this.opts.hasAgentLifecycleEvent?.(
            task.conversationId,
            eventId,
            "agent-completed",
          )
        ) {
          this.opts.onAgentEvent?.({
            type: "agent-completed",
            conversationId: task.conversationId,
            eventId,
            rootRunId: task.rootRunId,
            agentId: task.threadId,
            agentType: task.agentType,
            description: task.description,
            parentAgentId: task.parentAgentId,
            result: task.managerFinalReport,
            attemptGeneration: task.attemptGeneration,
          });
        }
        const activeController = task.controller;
        task.status = "completed";
        task.completedAt = Date.now();
        task.result = task.managerFinalReport;
        task.error = undefined;
        task.terminalEventEmitted = true;
        // Effect-ratchet pin: replace the seam controller BEFORE aborting
        // the old one, so the interrupted attempt's teardown can never fire
        // a signal a future attempt observes (see resetTaskForNextAttempt).
        task.controller = new AbortController();
        this.persistTask(task);
        if (task.storageMode === "cloud") {
          void this.opts
            .completeCloudAgentRecord({
              agentId: task.threadId,
              attemptGeneration: task.attemptGeneration,
              status: "completed",
              result: task.managerFinalReport,
            })
            .catch(() => undefined);
        }
        activeController.abort(new Error(reason));
        continue;
      }
      cancels.push(
        this.cancelAgent(task.threadId, reason).catch(() => undefined),
      );
    }
    await Promise.allSettled(cancels);
    // Close the supervisory scope last: every remaining supervision fiber
    // (attempt joins whose underlying promise ignored abort, stray
    // deadlines) is interrupted, and their `ensuring` bookkeeping runs.
    // This never touches the run loops themselves — those were cancelled
    // cooperatively above and are joined by the kernel run supervisor.
    await this.closeSupervisoryScope();
  }

  /** Effect facade over `shutdown` for Effect-native callers. */
  shutdownEffect(
    reason = AGENT_SHUTDOWN_CANCEL_REASON,
  ): Effect.Effect<void> {
    return Effect.promise(() => this.shutdown(reason));
  }

  private closeSupervisoryScope(): Promise<void> {
    if (this.supervisoryScopeClosePromise) {
      return this.supervisoryScopeClosePromise;
    }
    this.supervisoryScopeClosed = true;
    this.supervisoryScopeClosePromise = managerRuntime
      .runPromise(
        Scope.close(this.supervisoryScope, Exit.failCause(Cause.interrupt())),
      )
      .catch(() => undefined)
      .then(() => undefined);
    return this.supervisoryScopeClosePromise;
  }

  async cancelAgent(
    agentId: string,
    reason?: string,
  ): Promise<{ canceled: boolean }> {
    const local = this.tasks.get(agentId);
    if (local) {
      if (
        local.status === "completed" ||
        local.status === "error" ||
        local.status === "canceled"
      ) {
        if (local.agentType === AGENT_IDS.MANAGER) {
          await this.cascadeCancelManagedChildren(agentId, reason);
        }
        return { canceled: true };
      }
      const previousStatus = local.status;
      local.error = reason ?? "Canceled";
      local.status = "canceled";
      local.completedAt = Date.now();
      local.interruptedForFollowUp = false;
      local.pendingStartStatusText = undefined;
      local.pendingStartIsFollowUp = undefined;
      local.pendingStartAudience = undefined;
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: local.conversationId,
        rootRunId: local.rootRunId,
        agentId: local.threadId,
        agentType: local.agentType,
        description: local.description,
        parentAgentId: local.parentAgentId,
        statusText: "Pausing",
        attemptGeneration: local.attemptGeneration,
      });
      local.controller.abort(new Error(local.error));
      // Dispose the long-lived `SubagentSession` eagerly here too.
      // `executeTask` disposes at the end of the run, which is the
      // happy path for normal cancellation (abort propagates into
      // `runTurn`, the interrupted finalize fires, executeTask
      // reaches its dispose block). But if the abort gets swallowed
      // mid-flight (e.g. a tool executor doesn't honor the signal,
      // or executeTask isn't running yet because the task was still
      // pending), the session's Pi `Agent` would stay allocated
      // forever — the canceled task never re-enters `executeTask`.
      // `PiSessionCore.dispose` is idempotent and guarded against
      // already-null state, so calling it from both paths is safe;
      // the second call is a no-op.
      const session = this.subagentSessions.get(agentId);
      if (session) {
        this.subagentSessions.delete(agentId);
        try {
          session.dispose();
        } catch {
          // Best-effort.
        }
      }
      if (
        !local.terminalEventEmitted &&
        (previousStatus === "pending" || previousStatus === "running")
      ) {
        this.opts.onAgentEvent?.({
          type: "agent-canceled",
          conversationId: local.conversationId,
          eventId: this.lifecycleEventId(local, "agent-canceled"),
          rootRunId: local.rootRunId,
          agentId: local.threadId,
          agentType: local.agentType,
          description: local.description,
          parentAgentId: local.parentAgentId,
          error: local.error,
          attemptGeneration: local.attemptGeneration,
        });
        local.terminalEventEmitted = true;
      }
      this.persistTask(local);
      if (local.agentType === AGENT_IDS.MANAGER) {
        await this.cascadeCancelManagedChildren(agentId, local.error);
      }
      if (local.storageMode === "cloud" && local.cloudAgentId) {
        if (local.cloudCreatePromise) {
          await local.cloudCreatePromise.catch(() => undefined);
        }
        await this.opts.cancelCloudAgentRecord(
          local.cloudAgentId,
          local.error,
          local.attemptGeneration,
        );
      }
      return { canceled: true };
    }
    const persisted = this.opts.getAgentRecord?.(agentId);
    if (persisted) {
      const wasActive = persisted.status === "running";
      if (wasActive) {
        const error = reason ?? "Canceled";
        this.opts.saveAgentRecord?.({
          ...persisted,
          status: "canceled",
          completedAt: Date.now(),
          error,
          updatedAt: Date.now(),
        });
        // Terminal transition outside `persistTask`: wake settlement
        // waiters directly (they re-read the durable record).
        this.settleAgentThread(agentId);
        this.opts.onAgentEvent?.({
          type: "agent-canceled",
          conversationId: persisted.conversationId,
          eventId: `${persisted.threadId}:${persisted.attemptGeneration}:agent-canceled`,
          rootRunId: persisted.rootRunId,
          agentId: persisted.threadId,
          agentType: persisted.agentType,
          description: persisted.description,
          parentAgentId: persisted.parentAgentId,
          error,
          attemptGeneration: persisted.attemptGeneration,
        });
      }
      if (persisted.agentType === AGENT_IDS.MANAGER) {
        await this.cascadeCancelManagedChildren(agentId, reason ?? "Canceled");
      }
      if (persisted.storageMode === "cloud" && wasActive) {
        await this.opts.cancelCloudAgentRecord(
          persisted.threadId,
          reason ?? "Canceled",
          persisted.attemptGeneration,
        );
      }
      return { canceled: true };
    }
    return await this.opts.cancelCloudAgentRecord(agentId, reason);
  }

  /**
   * Effect-native cooperative cancel for the orchestrator wave. Aborts the
   * run's `AbortController` and resolves only after full settlement —
   * lifecycle events emitted in order, session disposed, managed-child
   * cascade and cloud sync joined. It deliberately does NOT interrupt any
   * fiber running the agent loop: the loop's provider observes the abort
   * latch, emits its terminal, and settles through message_end → turn_end →
   * agent_end exactly as a Promise-land cancel does.
   */
  cancelAgentEffect(
    agentId: string,
    reason?: string,
  ): Effect.Effect<{ canceled: boolean }> {
    return Effect.promise(() => this.cancelAgent(agentId, reason));
  }

  /** Effect facade over `cancelGroup` (same cooperative semantics). */
  cancelGroupEffect(
    groupKey: string,
    reason?: string,
  ): Effect.Effect<{ canceled: boolean; canceledThreadIds: string[] }> {
    return Effect.promise(() => this.cancelGroup(groupKey, reason));
  }

  /**
   * Active (pending/running) agent threads spawned under `rootRunId`.
   * Parent-run association for the orchestrator: when a parent run is
   * interrupted, these are the children it should cancel through
   * `cancelAgentsForRootRunEffect`.
   */
  listActiveThreadIdsForRootRun(rootRunId: string): string[] {
    const threadIds: string[] = [];
    for (const task of this.tasks.values()) {
      if (
        task.rootRunId === rootRunId &&
        (task.status === "pending" || task.status === "running")
      ) {
        threadIds.push(task.threadId);
      }
    }
    return threadIds;
  }

  /**
   * Cooperatively cancel every active agent thread spawned under
   * `rootRunId`. Sequential like the managed-child cascade; each cancel is
   * joined to full settlement before the next starts. The Effect-native
   * path for "orchestrator interrupts a parent → children are cancelled
   * through the manager" (the Promise-land equivalent remains the
   * `superviseAttempt` hook's `abort` → `cancelAgent`).
   */
  cancelAgentsForRootRunEffect(
    rootRunId: string,
    reason?: string,
  ): Effect.Effect<{ canceledThreadIds: string[] }> {
    const manager = this;
    return Effect.gen(function* () {
      const canceledThreadIds: string[] = [];
      for (const threadId of manager.listActiveThreadIdsForRootRun(
        rootRunId,
      )) {
        const result = yield* Effect.promise(() =>
          manager.cancelAgent(threadId, reason),
        );
        if (result.canceled) {
          canceledThreadIds.push(threadId);
        }
      }
      return { canceledThreadIds };
    });
  }

  async sendAgentMessage(
    agentId: string,
    message: string,
    from: "orchestrator" | "subagent",
    options?: {
      description?: string;
      rootRunId?: string;
      parentAgentId?: string;
      deliveryKind?: "manager-event" | "external-input";
      modelConfigSnapshot?: AgentModelConfigSnapshot;
    },
  ): Promise<{ delivered: boolean; reason?: string }> {
    const text = message.trim();
    if (!text) return { delivered: false };
    const isManagerEvent = options?.deliveryKind === "manager-event";
    const updateStatusSource = options?.description?.trim()
      ? options.description
      : isManagerEvent
        ? "Continuing managed work"
        : text;
    const updateStatusText = formatTaskUpdateStatusText(updateStatusSource);
    const rootRunId = options?.rootRunId?.trim() || undefined;
    // An orchestrator follow-up re-tasks the thread, so the thread adopts
    // the follow-up's description. Everything keyed per-thread (the folded
    // Activity row, snapshots, the persisted record) then reflects the
    // latest instruction instead of the original spawn text — per-occurrence
    // surfaces (the inline chat cards) keep their own titles via statusText.
    const followUpDescription =
      from === "orchestrator"
        ? options?.description?.trim() || undefined
        : undefined;
    const deliveredInput = isManagerEvent
      ? "Review the newly persisted managed-child event in this thread and continue the instructed process."
      : text;
    const task = this.tasks.get(agentId);
    if (!task) {
      if (from !== "orchestrator") {
        return { delivered: false };
      }
      const persisted = this.opts.getAgentRecord?.(agentId);
      if (!persisted) {
        return { delivered: false };
      }
      if (persisted.agentType === "workflow") {
        // Workflow runs are script-driven, not conversational — hydrating
        // one as a General task would re-run its description as a prompt.
        return {
          delivered: false,
          reason: `${agentId} is a workflow and cannot take send_input. Start a new workflow (or spawn_agent) for follow-up work.`,
        };
      }
      if (
        isManagerEvent &&
        persisted.agentType === AGENT_IDS.MANAGER &&
        (persisted.status === "completed" ||
          persisted.status === "error" ||
          persisted.status === "canceled")
      ) {
        // The orchestration layer already persisted this child report into
        // the manager thread. Internal events may wake a waiting manager, but
        // they must never resurrect one the user paused or that already
        // finished. A later external send_input rehydrates the durable report.
        return { delivered: true };
      }
      // Re-activate the durable thread row (and its whole group) so the
      // resumed work re-enters the active slot budget and reappears under
      // "Other Threads" — without this, an evicted thread keeps running
      // with status 'evicted' and stays invisible to the orchestrator.
      this.opts.resolveTaskThread?.({
        conversationId: persisted.conversationId,
        agentType: persisted.agentType,
        threadId: persisted.threadId,
      });
      const resumedTask = this.hydrateTaskFromRecord(
        persisted,
        text,
        updateStatusText,
      );
      this.assignModelConfigSnapshotIfMissing(
        resumedTask,
        options?.modelConfigSnapshot,
      );
      await this.resolveGeneralModelConfigIfMissing(resumedTask);
      if (rootRunId) {
        resumedTask.rootRunId = rootRunId;
      }
      resumedTask.pendingStartAudience = isManagerEvent
        ? "orchestrator-only"
        : "default";
      if (options?.parentAgentId) {
        resumedTask.parentAgentId = options.parentAgentId;
      }
      if (followUpDescription) {
        resumedTask.description = followUpDescription;
      }
      resumedTask.messageLog.push({
        from,
        text: truncate(text, 500),
        timestamp: Date.now(),
      });
      this.enqueueTask(resumedTask);
      return { delivered: true };
    }
    if (isManagerEvent && task.agentType === AGENT_IDS.MANAGER) {
      // The orchestration layer persisted the event before calling us. Make
      // that durable row the only report source; a live session refreshes it
      // at the next turn instead of receiving a duplicate prompt copy.
      this.subagentSessions.get(agentId)?.notifyHistoryChanged();
    }
    if (
      isManagerEvent &&
      task.agentType === AGENT_IDS.MANAGER &&
      (task.status === "completed" ||
        task.status === "error" ||
        task.status === "canceled")
    ) {
      // Paused/finished managers stay terminal. Their next explicit
      // send_input rebuilds context from the persisted event exactly once.
      return { delivered: true };
    }
    if (options?.parentAgentId) {
      task.parentAgentId = options.parentAgentId;
    }
    this.assignModelConfigSnapshotIfMissing(task, options?.modelConfigSnapshot);
    await this.resolveGeneralModelConfigIfMissing(task);
    if (options?.deliveryKind === "external-input") {
      task.pendingStartAudience = "default";
    } else if (isManagerEvent && task.pendingStartAudience !== "default") {
      task.pendingStartAudience = "orchestrator-only";
    }
    if (task.waitingForManagedChildren && task.status === "pending") {
      task.toSubagentQueue.push(deliveredInput);
      task.messageLog.push({
        from,
        text: truncate(text, 500),
        timestamp: Date.now(),
      });
      task.waitingForManagedChildren = false;
      task.pendingStartStatusText = updateStatusText;
      task.pendingStartIsFollowUp = true;
      this.pendingQueue.unshift(task.threadId);
      this.persistTask(task);
      this.tryStartNext();
      return { delivered: true };
    }
    if (
      task.status === "completed" ||
      task.status === "error" ||
      task.status === "canceled"
    ) {
      if (from !== "orchestrator") {
        return { delivered: false };
      }
      task.messageLog.push({
        from,
        text: truncate(text, 500),
        timestamp: Date.now(),
      });
      if (task.messageLog.length > LocalAgentManager.MAX_LOG_MESSAGES) {
        task.messageLog.splice(
          0,
          task.messageLog.length - LocalAgentManager.MAX_LOG_MESSAGES,
        );
      }
      if (rootRunId) {
        task.rootRunId = rootRunId;
      }
      if (followUpDescription) {
        task.description = followUpDescription;
      }
      // Same re-activation as the persisted-record path above: the thread
      // row may have been evicted while this task sat terminal in memory.
      this.opts.resolveTaskThread?.({
        conversationId: task.conversationId,
        agentType: task.agentType,
        threadId: task.threadId,
      });
      this.resetTaskForNextAttempt(task, text);
      if (task.agentType === AGENT_IDS.MANAGER) {
        task.pendingStartAudience = "default";
      }
      task.pendingStartStatusText = updateStatusText;
      // Re-activating a terminal thread is a `send_input` follow-up.
      task.pendingStartIsFollowUp = true;
      task.recentActivity = [updateStatusText];
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText: updateStatusText,
        attemptGeneration: task.attemptGeneration,
      });
      this.enqueueTask(task);
      return { delivered: true };
    }

    const targetQueue =
      from === "orchestrator" ? task.toSubagentQueue : task.toOrchestratorQueue;
    targetQueue.push(deliveredInput);
    if (targetQueue.length > LocalAgentManager.MAX_QUEUE_MESSAGES) {
      targetQueue.splice(
        0,
        targetQueue.length - LocalAgentManager.MAX_QUEUE_MESSAGES,
      );
    }

    task.messageLog.push({
      from,
      text: truncate(text, 500),
      timestamp: Date.now(),
    });
    if (task.messageLog.length > LocalAgentManager.MAX_LOG_MESSAGES) {
      task.messageLog.splice(
        0,
        task.messageLog.length - LocalAgentManager.MAX_LOG_MESSAGES,
      );
    }

    if (from === "orchestrator") {
      if (rootRunId) {
        task.rootRunId = rootRunId;
      }
      if (followUpDescription) {
        task.description = followUpDescription;
      }
      task.pendingStartStatusText = updateStatusText;
      task.recentActivity = [updateStatusText];
      this.opts.onAgentEvent?.({
        type: "agent-progress",
        conversationId: task.conversationId,
        rootRunId: task.rootRunId,
        agentId: task.threadId,
        agentType: task.agentType,
        description: task.description,
        parentAgentId: task.parentAgentId,
        statusText: updateStatusText,
        attemptGeneration: task.attemptGeneration,
      });

      if (task.status === "running" && !task.controller.signal.aborted) {
        // The follow-up is already in `toSubagentQueue` above. Aborting the
        // in-flight `runSubagent` ends the current assistant turn early so
        // `executeTask`'s post-run dispatch can re-enter via
        // `deliverFollowUpAsNextTurn`, which builds the next user message
        // from the queue. We deliberately do NOT touch `task.prompt` here:
        // it stores the original user goal that gets persisted and is read
        // back on cold rehydration. The long-lived `subagentSession` keeps
        // the actual conversation history, so the LLM's cached prefix is
        // preserved across the re-entry.
        task.interruptedForFollowUp = true;
        task.controller.abort(new Error(AGENT_INPUT_INTERRUPT_ERROR));
      }
    }

    this.persistTask(task);
    return { delivered: true };
  }

  async drainAgentMessages(
    agentId: string,
    recipient: "orchestrator" | "subagent",
  ): Promise<string[]> {
    const task = this.tasks.get(agentId);
    if (!task) return [];
    return this.consumeTaskMessages(task, recipient);
  }

  async reportManager(request: {
    threadId: string;
    message: string;
    final: boolean;
    attemptGeneration: number;
    reportId: string;
  }): Promise<{ accepted: boolean; final: boolean; reason?: string }> {
    const task = this.tasks.get(request.threadId);
    if (!task || task.agentType !== AGENT_IDS.MANAGER) {
      return {
        accepted: false,
        final: request.final,
        reason: `Manager thread not found: ${request.threadId}`,
      };
    }
    if (task.status !== "running" && task.status !== "pending") {
      return {
        accepted: false,
        final: request.final,
        reason: "A paused or finished Manager cannot report.",
      };
    }
    if (task.attemptGeneration !== request.attemptGeneration) {
      return {
        accepted: false,
        final: request.final,
        reason: "Manager report came from a superseded attempt.",
      };
    }
    const message = request.message.trim();
    if (!message) {
      return {
        accepted: false,
        final: request.final,
        reason: "Manager report requires a non-empty message.",
      };
    }
    const intermediateEventId = request.final
      ? undefined
      : this.managerReportEventId(task, request.reportId);
    if (
      intermediateEventId &&
      !task.managerReportIds.has(request.reportId) &&
      this.opts.hasAgentLifecycleEvent?.(
        task.conversationId,
        intermediateEventId,
        "agent-message",
      )
    ) {
      // The hidden orchestrator update is already durable, but the process
      // failed before its acknowledgement fields were stored. Rebuild the
      // durable acknowledgement without emitting the update again.
      task.managerIntermediateReportInTurn = true;
      task.managerReportIds.add(request.reportId);
      task.managerReportSequence += 1;
      this.persistTask(task);
      return { accepted: true, final: false };
    }
    if (task.managerReportIds.has(request.reportId)) {
      if (
        (!request.final && task.managerFinalReportId !== request.reportId) ||
        (request.final &&
          task.managerFinalReportId === request.reportId &&
          task.managerFinalReport === message)
      ) {
        return { accepted: true, final: request.final };
      }
      return {
        accepted: false,
        final: true,
        reason: "This report id was already used for an intermediate update.",
      };
    }
    if (request.final && this.hasActiveManagedChildren(task.threadId)) {
      return {
        accepted: false,
        final: true,
        reason:
          "A final Manager report is accepted only after all managed children have settled.",
      };
    }
    if (task.managerFinalReport) {
      return {
        accepted: false,
        final: request.final,
        reason: "The Manager's final report was already accepted.",
      };
    }

    if (request.final) {
      // Persist before the turn can finish. A restarted worker recovers this
      // accepted payload and stable call identity into one completion event.
      task.managerFinalReport = message;
      task.managerFinalReportId = request.reportId;
      task.managerReportIds.add(request.reportId);
      task.managerIntermediateReportInTurn = false;
      this.persistTask(task);
      return { accepted: true, final: true };
    }

    task.managerIntermediateReportInTurn = true;
    const nextSequence = task.managerReportSequence + 1;
    this.opts.onAgentEvent?.({
      type: "agent-message",
      conversationId: task.conversationId,
      eventId: intermediateEventId,
      rootRunId: task.rootRunId,
      agentId: task.threadId,
      agentType: task.agentType,
      description: task.description,
      parentAgentId: task.parentAgentId,
      result: message,
      attemptGeneration: request.attemptGeneration,
    });
    // The durable hidden message is the delivery acknowledgement. Store the
    // report identity only after that append so a failed persist can be
    // repaired on retry via the stable event id above.
    task.managerReportIds.add(request.reportId);
    task.managerReportSequence = nextSequence;
    this.persistTask(task);
    return { accepted: true, final: false };
  }
}

const optsValueOrDefault = (
  value: number | undefined,
  fallback: number,
): number => (Number.isFinite(value) ? Math.floor(value!) : fallback);
