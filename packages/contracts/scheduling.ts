export type LocalCronSchedule =
  | {
      kind: 'at'
      atMs: number
    }
  | {
      kind: 'every'
      everyMs: number
      anchorMs?: number
    }
  | {
      kind: 'cron'
      expr: string
      tz?: string
    }

/**
 * Delivery contract for cron fires, organized around three trigger kinds
 * (plus two legacy payload shapes kept for backward compatibility):
 *
 *  - `notify` — the **Reminder** trigger. The scheduler delivers `text`
 *    directly as an assistant message and an OS notification. No worker
 *    turn, no LLM, no tokens. Use for fixed reminders whose body is fully
 *    knowable at schedule-creation time.
 *  - `task` — the **Task** trigger. The scheduler delivers the stored
 *    intent `prompt` as a turn to the orchestrator (the main assistant),
 *    which answers directly or spawns agents as it normally would. The
 *    turn's final text is delivered as an assistant message + OS
 *    notification.
 *  - `watch` — the **Watch (sensor)** trigger. The scheduler runs the
 *    verified-at-birth check script at `scriptPath` with `bun run`. Empty
 *    stdout + exit 0 means "no change": nothing happens. Non-empty stdout
 *    means the sensor detected a change: the scheduler fires an
 *    orchestrator turn carrying the change details. A non-zero exit fires
 *    an orchestrator turn flagging the sensor failure so it can be
 *    investigated and repaired (self-healing) instead of dying silently.
 *    The script may write a sidecar `<scriptPath>.state.json` for its
 *    last-seen baseline state.
 *  - `script` — legacy programmatic payload. Runs `scriptPath`, captures
 *    trimmed stdout as the message body, and only delivers when stdout is
 *    non-empty. Existing jobs keep executing; new sensor-style jobs should
 *    use `watch`.
 *  - `agent` — legacy agent-turn payload. Runs an isolated worker turn
 *    against `agentType` (defaults to general) with the fixed `prompt`.
 *    Existing jobs keep executing; new jobs should use `task`.
 */
export type LocalCronPayload =
  | {
      kind: 'notify'
      text: string
    }
  | {
      kind: 'task'
      prompt: string
    }
  | {
      kind: 'watch'
      scriptPath: string
    }
  | {
      kind: 'script'
      scriptPath: string
    }
  | {
      kind: 'agent'
      prompt: string
      agentType?: string
    }

/**
 * User-facing trigger kind for a cron payload. `reminder` / `task` /
 * `watch` are the three supported trigger kinds; `script` and `agent`
 * payloads surface as `legacy-script` / `legacy-agent` until replaced.
 */
export type LocalCronTriggerKind =
  | 'reminder'
  | 'task'
  | 'watch'
  | 'legacy-script'
  | 'legacy-agent'

export const getCronTriggerKind = (
  payload: LocalCronPayload,
): LocalCronTriggerKind => {
  switch (payload.kind) {
    case 'notify':
      return 'reminder'
    case 'task':
      return 'task'
    case 'watch':
      return 'watch'
    case 'script':
      return 'legacy-script'
    case 'agent':
      return 'legacy-agent'
  }
}

export type LocalHeartbeatActiveHours = {
  start: string
  end: string
  timezone?: string
}

export type LocalCronJobRecord = {
  id: string
  conversationId: string
  name: string
  description?: string
  enabled: boolean
  schedule: LocalCronSchedule
  payload: LocalCronPayload
  /**
   * Whether the cron should deliver an assistant message + OS notification
   * when its fire produces text. Defaults to `true`. Heartbeats and most
   * crons want this on; some "background bookkeeping" crons (e.g. silent
   * polling that only logs to lastError) can set it false.
   */
  deliver?: boolean
  deleteAfterRun?: boolean
  nextRunAtMs: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastStatus?: string
  lastError?: string
  lastDurationMs?: number
  lastOutputPreview?: string
  /**
   * Watch-only: a detected change or sensor failure that could not be
   * escalated to the orchestrator yet (worker busy). Drained on the next
   * tick without re-running the script, so a diff whose baseline was
   * already advanced is never silently lost.
   */
  pendingEscalation?: {
    reason: 'change' | 'sensor-error'
    summary: string
    atMs: number
  }
  createdAt: number
  updatedAt: number
}

export type LocalHeartbeatConfigRecord = {
  id: string
  conversationId: string
  enabled: boolean
  intervalMs: number
  prompt?: string
  checklist?: string
  ackMaxChars?: number
  deliver?: boolean
  agentType?: string
  activeHours?: LocalHeartbeatActiveHours
  targetDeviceId?: string
  runningAtMs?: number
  lastRunAtMs?: number
  nextRunAtMs: number
  lastStatus?: string
  lastError?: string
  lastSentText?: string
  lastSentAtMs?: number
  createdAt: number
  updatedAt: number
}

export type ScheduledConversationEvent = {
  _id: string
  conversationId: string
  timestamp: number
  type: 'assistant_message'
  payload: Record<string, unknown>
}

export type LocalSchedulerSnapshot = {
  cronJobs: LocalCronJobRecord[]
  heartbeats: LocalHeartbeatConfigRecord[]
}

export type LocalCronJobCreateInput = {
  name: string
  schedule: LocalCronSchedule
  payload: LocalCronPayload
  conversationId: string
  description?: string
  enabled?: boolean
  deliver?: boolean
  deleteAfterRun?: boolean
}

export type LocalCronJobUpdatePatch = {
  name?: string
  schedule?: LocalCronSchedule
  payload?: LocalCronPayload
  conversationId?: string
  description?: string
  enabled?: boolean
  deliver?: boolean
  deleteAfterRun?: boolean
}

export type LocalHeartbeatUpsertInput = {
  conversationId: string
  enabled?: boolean
  intervalMs?: number
  prompt?: string
  checklist?: string
  ackMaxChars?: number
  deliver?: boolean
  agentType?: string
  activeHours?: LocalHeartbeatActiveHours
  targetDeviceId?: string
}

/**
 * Structured side-channel returned by the direct scheduling tools
 * (`schedule_add` / `schedule_update` / `schedule_remove`) alongside their
 * plain-text summaries. The chat UI uses this to render the inline
 * "Scheduled" receipt chip and link it back to the affected cron /
 * heartbeat rows.
 */
export type ScheduleToolAffectedRef = {
  kind: 'cron' | 'heartbeat'
  id: string
  conversationId: string
  /** Display label: cron `name` or "Check-in" / first ~60 chars of heartbeat prompt. */
  name: string
  enabled: boolean
  nextRunAtMs: number
}

export type ScheduleToolChangeSet = {
  added: Array<{ kind: 'cron' | 'heartbeat'; id: string }>
  updated: Array<{ kind: 'cron' | 'heartbeat'; id: string }>
  removed: Array<{ kind: 'cron' | 'heartbeat'; id: string }>
}

export type ScheduleToolDetails = {
  schedule: {
    /**
     * Snapshot of every entry that was added or updated by this run, taken
     * after the schedule subagent returned. The chip uses this to render
     * one row per affected schedule with current `name` / `nextRunAtMs`.
     */
    affected: ScheduleToolAffectedRef[]
    /** Categorized id-only deltas. `removed` is reported here only. */
    changes: ScheduleToolChangeSet
  }
}

export type LocalAutomationRunResult =
  | {
      status: 'ok'
      finalText: string
    }
  | {
      status: 'busy'
      finalText: ''
      error: string
    }
  | {
      status: 'error'
      finalText: ''
      error: string
    }
