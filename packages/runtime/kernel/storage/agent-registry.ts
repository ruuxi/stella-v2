/**
 * Durable agent (task) records and thread-activity projections.
 */

import { normalizeRetiredAgentType } from "@stella/contracts/agent-runtime";
import {
  asFiniteNumber,
  asTrimmedString,
  toJsonValueString,
  type SqliteDatabase,
} from "./shared.js";
import {
  AGENT_ASSISTANT_UPDATE_LIMITS,
  RECALL_THREAD_ERROR_EXCERPT_CHARS,
  RECALL_THREAD_RESULT_EXCERPT_CHARS,
  authoredTextFromAssistantPayload,
  parseJsonValue,
  truncateAuthoredUpdate,
} from "./view.js";
import { MAX_ACTIVE_RUNTIME_THREADS } from "../runtime-threads.js";

const DESKTOP_THREAD_ACTIVITY_HYDRATION_LIMIT = 500;

export const RUNTIME_THREAD_SELECT = `
  SELECT
    thread.id AS threadId,
    thread.conversation_id AS conversationId,
    thread.name AS name,
    thread.agent_type AS agentType,
    thread.status AS status,
    thread.created_at AS createdAt,
    thread.last_used_at AS lastUsedAt,
    thread.summary AS summary,
    agent.description AS description,
    agent.status AS agentStatus,
    agent.updated_at AS agentUpdatedAt
  FROM thread
  LEFT JOIN agent ON agent.thread_id = thread.id
`;

export type RuntimeThreadListing = {
  threadId: string;
  conversationId: string;
  name: string;
  agentType: string;
  status: string;
  createdAt: number;
  lastUsedAt: number;
  agentStatus?: string;
  agentUpdatedAt?: number;
  description?: string;
  summary?: string;
};

export const deserializeRuntimeThread = (row: any): RuntimeThreadListing => ({
  threadId: row.threadId,
  conversationId: row.conversationId,
  name: row.name,
  agentType: row.agentType,
  status: row.status,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  ...(row.agentStatus ? { agentStatus: row.agentStatus } : {}),
  ...(typeof row.agentUpdatedAt === "number"
    ? { agentUpdatedAt: row.agentUpdatedAt }
    : {}),
  ...(row.description ? { description: row.description } : {}),
  ...(row.summary ? { summary: row.summary } : {}),
});

export type AgentRecordInput = {
  threadId: string;
  conversationId: string;
  agentType: string;
  description: string;
  prompt?: string;
  promptCreatedAt?: number;
  agentDepth: number;
  maxAgentDepth?: number;
  parentAgentId?: string;
  modelConfigSnapshot?: unknown;
  toolWorkspaceRoot?: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  updatedAt: number;
  rootRunId?: string;
  attemptGeneration?: number;
};

export class AgentRegistry {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly hooks: {
      ensureConversation: (conversationId: string, updatedAt: number) => void;
      refreshThreadSearchText: (threadId: string) => void;
    },
  ) {}

  saveAgentRecord(record: AgentRecordInput): number | null {
    this.hooks.ensureConversation(record.conversationId, record.updatedAt);
    const revisionRow = this.db
      .prepare(
        `INSERT INTO agent (
           thread_id, conversation_id, agent_type, description, prompt,
           prompt_created_at, agent_depth, max_agent_depth, parent_agent_id,
           model_config_json, tool_workspace_root, status, started_at,
           completed_at, result, error, updated_at, root_run_id,
           attempt_generation, record_revision
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(thread_id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           agent_type = excluded.agent_type,
           description = excluded.description,
           prompt = COALESCE(agent.prompt, excluded.prompt),
           prompt_created_at = COALESCE(agent.prompt_created_at, excluded.prompt_created_at),
           agent_depth = excluded.agent_depth,
           max_agent_depth = excluded.max_agent_depth,
           parent_agent_id = excluded.parent_agent_id,
           model_config_json = excluded.model_config_json,
           tool_workspace_root = excluded.tool_workspace_root,
           status = excluded.status,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           result = excluded.result,
           error = excluded.error,
           updated_at = excluded.updated_at,
           root_run_id = excluded.root_run_id,
           attempt_generation = excluded.attempt_generation,
           record_revision = agent.record_revision + 1
         WHERE excluded.attempt_generation >= agent.attempt_generation
         RETURNING record_revision`,
      )
      .get(
        record.threadId,
        record.conversationId,
        record.agentType,
        record.description,
        record.prompt ?? null,
        record.promptCreatedAt ?? null,
        record.agentDepth,
        record.maxAgentDepth ?? null,
        record.parentAgentId ?? null,
        toJsonValueString(record.modelConfigSnapshot) ?? null,
        record.toolWorkspaceRoot ?? null,
        record.status,
        record.startedAt,
        record.completedAt ?? null,
        record.result ?? null,
        record.error ?? null,
        record.updatedAt,
        record.rootRunId ?? null,
        record.attemptGeneration ?? 0,
      ) as { record_revision?: number } | undefined;
    this.hooks.refreshThreadSearchText(record.threadId);
    return revisionRow?.record_revision ?? null;
  }

  private deserializeAgentRow(row: any): Record<string, unknown> {
    const modelConfigSnapshot = parseJsonValue(row.model_config_json);
    return {
      threadId: row.thread_id,
      conversationId: row.conversation_id,
      agentType: normalizeRetiredAgentType(row.agent_type),
      description: row.description,
      ...(row.prompt
        ? {
            prompt: row.prompt,
            promptCreatedAt:
              typeof row.prompt_created_at === "number"
                ? row.prompt_created_at
                : row.started_at,
          }
        : {}),
      agentDepth: row.agent_depth,
      ...(row.max_agent_depth == null
        ? {}
        : { maxAgentDepth: row.max_agent_depth }),
      ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
      ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
      ...(row.tool_workspace_root
        ? { toolWorkspaceRoot: row.tool_workspace_root }
        : {}),
      status: row.status,
      attemptGeneration: row.attempt_generation,
      recordRevision: row.record_revision,
      ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
      startedAt: row.started_at,
      completedAt: row.completed_at,
      ...(row.result ? { result: row.result } : {}),
      ...(row.error ? { error: row.error } : {}),
      updatedAt: row.updated_at,
    };
  }

  private static readonly AGENT_COLUMNS = `
    thread_id, conversation_id, agent_type, description, prompt,
    prompt_created_at, agent_depth, max_agent_depth, parent_agent_id,
    model_config_json, tool_workspace_root, status, started_at,
    completed_at, result, error, updated_at, root_run_id,
    attempt_generation, record_revision
  `;

  getAgentRecord(threadId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(
        `SELECT ${AgentRegistry.AGENT_COLUMNS} FROM agent WHERE thread_id = ? LIMIT 1`,
      )
      .get(threadId);
    if (!row) {
      return null;
    }
    return this.deserializeAgentRow(row);
  }

  listAgentRecordsByStatus(status: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT ${AgentRegistry.AGENT_COLUMNS} FROM agent
         WHERE status = ?
         ORDER BY updated_at DESC, thread_id ASC`,
      )
      .all(status);
    return rows.map((row) => this.deserializeAgentRow(row));
  }

  listActiveThreads(conversationId: string): RuntimeThreadListing[] {
    const rows = this.db
      .prepare(
        `${RUNTIME_THREAD_SELECT}
         WHERE thread.conversation_id = ? AND thread.status = 'active'
         ORDER BY thread.last_used_at DESC
         LIMIT ?`,
      )
      .all(conversationId, MAX_ACTIVE_RUNTIME_THREADS);
    return rows.map((row) => deserializeRuntimeThread(row));
  }

  listThreadResultExcerpts(
    threadIds: string[],
  ): Map<string, { resultExcerpt?: string; errorExcerpt?: string }> {
    const ids = [...new Set(threadIds)].slice(0, 64);
    const map = new Map<string, { resultExcerpt?: string; errorExcerpt?: string }>();
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(
        `SELECT thread_id AS threadId,
                substr(result, 1, ${RECALL_THREAD_RESULT_EXCERPT_CHARS}) AS resultExcerpt,
                substr(error, 1, ${RECALL_THREAD_ERROR_EXCERPT_CHARS}) AS errorExcerpt
         FROM agent
         WHERE thread_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(...ids) as Array<{
      threadId: string;
      resultExcerpt: string | null;
      errorExcerpt: string | null;
    }>;
    for (const row of rows) {
      map.set(row.threadId, {
        ...(row.resultExcerpt?.trim() ? { resultExcerpt: row.resultExcerpt } : {}),
        ...(row.errorExcerpt?.trim() ? { errorExcerpt: row.errorExcerpt } : {}),
      });
    }
    return map;
  }

  /* ------------------------------------------------------------------ */
  /* Assistant progress projections                                      */
  /* ------------------------------------------------------------------ */

  listAgentAssistantMessagesByThread(
    targetsInput: Array<{
      threadId: string;
      startedAt: number;
      attemptGeneration?: number;
    }>,
    limit = AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
  ): Map<string, Array<{ text: string; atMs: number; sequence?: number }>> {
    const seen = new Set<string>();
    const targets = targetsInput
      .flatMap((target) => {
        const threadId = target.threadId.trim();
        if (!threadId || seen.has(threadId)) return [];
        seen.add(threadId);
        return [
          {
            threadId,
            startedAt: Math.max(0, Math.floor(target.startedAt)),
            attemptGeneration: Math.max(
              0,
              Math.floor(target.attemptGeneration ?? 0),
            ),
          },
        ];
      })
      .slice(0, AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads);
    if (targets.length === 0) return new Map();
    const cappedLimit = Math.max(
      1,
      Math.min(AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread, Math.floor(limit)),
    );
    const scanLimit = cappedLimit * AGENT_ASSISTANT_UPDATE_LIMITS.scanRowsPerMessage;
    const byThread = new Map<
      string,
      Array<{ text: string; atMs: number; sequence?: number }>
    >();
    let remainingChars = AGENT_ASSISTANT_UPDATE_LIMITS.totalChars;
    let remainingBytes = AGENT_ASSISTANT_UPDATE_LIMITS.totalBytes;
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex]!;
      const rows = this.db
        .prepare(
          `SELECT created_at AS atMs, seq AS sequence, payload AS dataJson
           FROM thread_entry
           WHERE thread_id = ?
             AND created_at >= ?
             AND type = 'message'
             AND role = 'assistant'
             AND COALESCE(json_extract(payload, '$.message.stellaAttemptGeneration'), ?) = ?
           ORDER BY seq DESC
           LIMIT ?`,
        )
        .all(
          target.threadId,
          target.startedAt,
          target.attemptGeneration,
          target.attemptGeneration,
          scanLimit,
        ) as Array<{ atMs: number; sequence: number; dataJson: string | null }>;
      const candidates: Array<{ text: string; atMs: number; sequence: number }> =
        [];
      for (const row of rows) {
        let payload: any;
        try {
          payload = JSON.parse(row.dataJson ?? "null")?.message;
        } catch {
          continue;
        }
        if (payload?.role !== "assistant") continue;
        const text = truncateAuthoredUpdate(
          authoredTextFromAssistantPayload(payload),
        );
        if (text) candidates.push({ text, atMs: row.atMs, sequence: row.sequence });
        if (candidates.length >= cappedLimit) break;
      }
      if (candidates.length === 0) continue;
      const targetsRemaining = Math.max(1, targets.length - targetIndex);
      let threadChars = 0;
      let threadBytes = 0;
      const selectedNewestFirst: Array<{
        text: string;
        atMs: number;
        sequence?: number;
      }> = [];
      for (const candidate of candidates) {
        const fairChars = Math.max(1, Math.floor(remainingChars / targetsRemaining));
        const fairBytes = Math.max(1, Math.floor(remainingBytes / targetsRemaining));
        const text = truncateAuthoredUpdate(
          candidate.text,
          Math.min(
            AGENT_ASSISTANT_UPDATE_LIMITS.messageChars,
            AGENT_ASSISTANT_UPDATE_LIMITS.threadChars - threadChars,
            fairChars,
          ),
          Math.min(
            AGENT_ASSISTANT_UPDATE_LIMITS.messageBytes,
            AGENT_ASSISTANT_UPDATE_LIMITS.threadBytes - threadBytes,
            fairBytes,
          ),
        );
        if (!text) continue;
        const chars = [...text].length;
        const bytes = Buffer.byteLength(text, "utf8");
        selectedNewestFirst.push({ ...candidate, text });
        threadChars += chars;
        threadBytes += bytes;
        remainingChars -= chars;
        remainingBytes -= bytes;
        if (remainingChars <= 0 || remainingBytes <= 0) break;
      }
      if (selectedNewestFirst.length > 0)
        byThread.set(target.threadId, selectedNewestFirst.reverse());
    }
    return byThread;
  }

  listAgentAssistantMessages(
    agentId: string,
    limit = AGENT_ASSISTANT_UPDATE_LIMITS.messagesPerThread,
  ): Array<{ text: string; atMs: number }> {
    const record = this.getAgentRecord(agentId.trim());
    if (!record || record.status !== "running" || record.agentType !== "general")
      return [];
    return (
      this.listAgentAssistantMessagesByThread(
        [
          {
            threadId: record.threadId as string,
            startedAt: record.startedAt as number,
            attemptGeneration: record.attemptGeneration as number,
          },
        ],
        limit,
      ).get(record.threadId as string) ?? []
    ).map(({ text, atMs }) => ({ text, atMs }));
  }

  /* ------------------------------------------------------------------ */
  /* Thread activity views                                               */
  /* ------------------------------------------------------------------ */

  selectBoundedThreadActivityIds(
    conversationId: string,
    maxItems: number,
  ): string[] {
    const activeRows = this.db
      .prepare(
        `SELECT thread_id FROM agent
         WHERE conversation_id = ? AND status IN ('pending', 'running')
         ORDER BY updated_at DESC, thread_id ASC
         LIMIT ?`,
      )
      .all(conversationId, maxItems) as Array<{ thread_id?: unknown }>;
    const remaining = maxItems - activeRows.length;
    const terminalRows =
      remaining > 0
        ? (this.db
            .prepare(
              `SELECT thread_id FROM agent
               WHERE conversation_id = ? AND status NOT IN ('pending', 'running')
               ORDER BY updated_at DESC, thread_id ASC
               LIMIT ?`,
            )
            .all(conversationId, remaining) as Array<{ thread_id?: unknown }>)
        : [];
    return [...activeRows, ...terminalRows]
      .map((row) => row.thread_id)
      .filter((threadId): threadId is string => typeof threadId === "string");
  }

  listThreadActivity(
    conversationId: string,
    options: { view?: "mobile-summary"; maxItems?: number } = {},
  ): Array<Record<string, unknown>> {
    if (options.view === "mobile-summary") {
      const requestedMaxItems = Number.isFinite(options.maxItems)
        ? (options.maxItems as number)
        : 200;
      const maxItems = Math.min(500, Math.max(1, Math.floor(requestedMaxItems)));
      const selectedThreadIds = this.selectBoundedThreadActivityIds(
        conversationId,
        maxItems,
      );
      if (selectedThreadIds.length === 0) return [];
      const selectedPlaceholders = selectedThreadIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT
             a.thread_id, a.conversation_id, a.agent_type, a.description,
             a.status, a.attempt_generation, a.record_revision,
             a.parent_agent_id, a.started_at, a.completed_at,
             substr(a.result, 1, 512) AS result,
             substr(a.error, 1, 512) AS error,
             a.updated_at, a.root_run_id
           FROM agent a
           WHERE a.thread_id IN (${selectedPlaceholders})
           ORDER BY a.started_at ASC, a.thread_id ASC`,
        )
        .all(...selectedThreadIds) as Array<any>;
      return rows.map((row) => ({
        source: "stella",
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        agentType: normalizeRetiredAgentType(row.agent_type),
        description: row.description,
        status: row.status,
        attemptGeneration: row.attempt_generation ?? 0,
        recordRevision: row.record_revision ?? 0,
        ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
        ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
        startedAt: row.started_at,
        ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        updatedAt: row.updated_at,
      }));
    }
    const requestedMaxItems = Number.isFinite(options.maxItems)
      ? (options.maxItems as number)
      : DESKTOP_THREAD_ACTIVITY_HYDRATION_LIMIT;
    const maxItems = Math.min(
      DESKTOP_THREAD_ACTIVITY_HYDRATION_LIMIT,
      Math.max(1, Math.floor(requestedMaxItems)),
    );
    const selectedThreadIds = this.selectBoundedThreadActivityIds(
      conversationId,
      maxItems,
    );
    if (selectedThreadIds.length === 0) return [];
    const selectedPlaceholders = selectedThreadIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT
           a.thread_id, a.conversation_id, a.agent_type, a.description,
           a.status, a.attempt_generation, a.record_revision,
           a.parent_agent_id, a.model_config_json, a.started_at, a.completed_at,
           substr(a.result, 1, 2000) AS result,
           substr(a.error, 1, 2000) AS error,
           a.updated_at, a.root_run_id,
           t.group_key, t.group_label
         FROM agent a
         LEFT JOIN thread t ON t.id = a.thread_id
         WHERE a.thread_id IN (${selectedPlaceholders})
         ORDER BY a.started_at ASC, a.thread_id ASC`,
      )
      .all(...selectedThreadIds) as Array<any>;
    const assistantTargets = rows
      .filter((row) => normalizeRetiredAgentType(row.agent_type) === "general")
      .sort(
        (a, b) =>
          Number(b.status === "running") - Number(a.status === "running") ||
          b.updated_at - a.updated_at ||
          a.thread_id.localeCompare(b.thread_id),
      )
      .slice(0, AGENT_ASSISTANT_UPDATE_LIMITS.activeThreads)
      .map((row) => ({
        threadId: row.thread_id,
        startedAt: row.started_at,
        attemptGeneration: row.attempt_generation ?? 0,
      }));
    const assistantMessagesByThread =
      this.listAgentAssistantMessagesByThread(assistantTargets);
    return rows.map((row) => {
      const assistantEntries = assistantMessagesByThread.get(row.thread_id);
      const latestAssistantEntry = assistantEntries?.[assistantEntries.length - 1];
      const modelConfigSnapshot = parseJsonValue(row.model_config_json);
      return {
        source: "stella",
        threadId: row.thread_id,
        conversationId: row.conversation_id,
        agentType: normalizeRetiredAgentType(row.agent_type),
        description: row.description,
        status: row.status,
        attemptGeneration: row.attempt_generation ?? 0,
        recordRevision: row.record_revision ?? 0,
        ...(row.root_run_id ? { rootRunId: row.root_run_id } : {}),
        ...(row.parent_agent_id ? { parentAgentId: row.parent_agent_id } : {}),
        ...(modelConfigSnapshot ? { modelConfigSnapshot } : {}),
        ...(row.group_key ? { groupKey: row.group_key } : {}),
        ...(row.group_label ? { groupLabel: row.group_label } : {}),
        startedAt: row.started_at,
        ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
        ...(row.result ? { result: row.result } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(assistantEntries
          ? {
              assistantMessages: assistantEntries.map((entry) => entry.text),
              ...(latestAssistantEntry
                ? {
                    assistantMessagesUpdatedAt: latestAssistantEntry.atMs,
                    assistantMessagesUpdatedSequence: latestAssistantEntry.sequence,
                  }
                : {}),
            }
          : {}),
        updatedAt: row.updated_at,
      };
    });
  }
}
