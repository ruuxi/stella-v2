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

  deliver?: boolean
  deleteAfterRun?: boolean
  nextRunAtMs: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastStatus?: string
  lastError?: string
  lastDurationMs?: number
  lastOutputPreview?: string

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

export type ScheduleToolAffectedRef = {
  kind: 'cron' | 'heartbeat'
  id: string
  conversationId: string

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

    affected: ScheduleToolAffectedRef[]

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
