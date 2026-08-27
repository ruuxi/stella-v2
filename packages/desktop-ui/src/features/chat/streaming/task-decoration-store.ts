import {
  normalizeTaskDisplayStatusText,
  type TaskLiveDecoration,
} from '@/features/chat/lib/event-transforms'

export type TaskDecoration = TaskLiveDecoration & {
  agentId: string
  conversationId: string
  lastUpdatedAtMs: number
}

export const MAX_AGENT_REASONING_CHARS = 8_000

export const MAX_TASK_DECORATIONS = 64

const decorations = new Map<string, TaskDecoration>()

let snapshot: Record<string, TaskDecoration> = {}

const globalListeners = new Set<() => void>()
const agentListeners = new Map<string, Set<() => void>>()

const notify = (agentIds: Iterable<string>) => {
  snapshot = Object.fromEntries(decorations)
  for (const listener of globalListeners) listener()
  for (const agentId of agentIds) {
    const listeners = agentListeners.get(agentId)
    if (!listeners) continue
    for (const listener of listeners) listener()
  }
}

const setDecoration = (next: TaskDecoration) => {
  const isNew = !decorations.has(next.agentId)
  decorations.set(next.agentId, next)

  if (isNew && decorations.size > MAX_TASK_DECORATIONS) {
    let oldestId: string | undefined
    let oldestAtMs = Infinity
    for (const [agentId, decoration] of decorations) {
      if (decoration.lastUpdatedAtMs < oldestAtMs) {
        oldestAtMs = decoration.lastUpdatedAtMs
        oldestId = agentId
      }
    }
    if (oldestId !== undefined && oldestId !== next.agentId) {
      decorations.delete(oldestId)
      notify([next.agentId, oldestId])
      return
    }
  }
  notify([next.agentId])
}

type DecorationLifecycleSignal = {
  runId?: string
  attemptGeneration?: number
  lifecycleSequence?: number
  startsAttempt?: boolean
  settlesAttempt?: boolean
}

const isOlderLifecycleSignal = (
  existing: TaskDecoration,
  signal: DecorationLifecycleSignal,
): boolean => {
  if (
    existing.attemptGeneration !== undefined &&
    signal.attemptGeneration !== undefined &&
    existing.attemptGeneration !== signal.attemptGeneration
  ) {
    return signal.attemptGeneration < existing.attemptGeneration
  }
  if (
    existing.runId &&
    signal.runId &&
    existing.runId !== signal.runId &&
    existing.attemptGeneration === signal.attemptGeneration
  ) {
    return signal.startsAttempt !== true
  }
  if (
    existing.status !== undefined &&
    existing.status !== 'running' &&
    signal.startsAttempt !== true &&
    signal.settlesAttempt !== true &&
    existing.attemptGeneration === signal.attemptGeneration
  ) {
    return true
  }
  return (
    existing.lifecycleSequence !== undefined &&
    signal.lifecycleSequence !== undefined &&
    signal.lifecycleSequence < existing.lifecycleSequence
  )
}

export const decorateTask = (input: {
  agentId: string
  conversationId: string
  runId?: string
  attemptGeneration?: number
  lifecycleSequence?: number

  startsAttempt?: boolean
  anchorTurnId?: string
  statusText?: string
  toolActivity?: TaskDecoration['toolActivity']
}): void => {
  const existing = decorations.get(input.agentId)
  if (existing && isOlderLifecycleSignal(existing, input)) return
  const now = Date.now()
  const retained = input.startsAttempt ? undefined : existing
  setDecoration({
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId: input.runId ?? retained?.runId,
    status: 'running',
    attemptGeneration: input.attemptGeneration ?? retained?.attemptGeneration,
    lifecycleSequence: input.lifecycleSequence ?? retained?.lifecycleSequence,
    startedAtMs: input.startsAttempt ? now : (retained?.startedAtMs ?? now),
    observedAtMs: now,
    anchorTurnId: input.anchorTurnId ?? retained?.anchorTurnId,
    statusText:
      normalizeTaskDisplayStatusText(input.statusText) ?? retained?.statusText,
    toolActivity: input.toolActivity ?? retained?.toolActivity,
    reasoningText: retained?.reasoningText,
    lastUpdatedAtMs: now,
  })
}

export const appendTaskReasoning = (input: {
  agentId: string
  conversationId: string
  runId?: string
  attemptGeneration?: number
  lifecycleSequence?: number
  chunk: string
}): void => {
  if (!input.chunk) return
  const existing = decorations.get(input.agentId)
  if (existing && isOlderLifecycleSignal(existing, input)) return
  const now = Date.now()
  const nextReasoningText = `${existing?.reasoningText ?? ''}${input.chunk}`
  setDecoration({
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId: input.runId ?? existing?.runId,
    status: 'running',
    attemptGeneration: input.attemptGeneration ?? existing?.attemptGeneration,
    lifecycleSequence: input.lifecycleSequence ?? existing?.lifecycleSequence,
    startedAtMs: existing?.startedAtMs ?? now,
    observedAtMs: now,
    anchorTurnId: existing?.anchorTurnId,
    statusText: existing?.statusText,
    toolActivity: existing?.toolActivity,
    reasoningText:
      nextReasoningText.length > MAX_AGENT_REASONING_CHARS
        ? nextReasoningText.slice(-MAX_AGENT_REASONING_CHARS)
        : nextReasoningText,
    lastUpdatedAtMs: now,
  })
}

export const settleTaskDecoration = (input: {
  agentId: string
  conversationId: string
  runId?: string
  attemptGeneration?: number
  lifecycleSequence?: number
  status: Exclude<NonNullable<TaskDecoration['status']>, 'running'>
}): void => {
  const existing = decorations.get(input.agentId)
  if (
    existing &&
    isOlderLifecycleSignal(existing, { ...input, settlesAttempt: true })
  ) {
    return
  }
  const now = Date.now()
  setDecoration({
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId: input.runId ?? existing?.runId,
    status: input.status,
    attemptGeneration: input.attemptGeneration ?? existing?.attemptGeneration,
    lifecycleSequence: input.lifecycleSequence ?? existing?.lifecycleSequence,
    startedAtMs: existing?.startedAtMs ?? now,
    observedAtMs: now,
    anchorTurnId: existing?.anchorTurnId,
    statusText: existing?.statusText,
    lastUpdatedAtMs: now,
  })
}

export const clearTaskDecoration = (agentId: string): void => {
  if (!decorations.delete(agentId)) return
  notify([agentId])
}

export const clearConversationTaskDecorations = (
  conversationId: string,
): void => {
  const removed: string[] = []
  for (const [agentId, decoration] of decorations) {
    if (decoration.conversationId === conversationId) {
      decorations.delete(agentId)
      removed.push(agentId)
    }
  }
  if (removed.length > 0) notify(removed)
}

export const getTaskDecorationsSnapshot = (): Record<string, TaskDecoration> =>
  snapshot

export const getTaskDecoration = (
  agentId: string,
): TaskDecoration | undefined => snapshot[agentId]

export const subscribeTaskDecorations = (listener: () => void): (() => void) => {
  globalListeners.add(listener)
  return () => {
    globalListeners.delete(listener)
  }
}

export const subscribeTaskDecoration = (
  agentId: string,
  listener: () => void,
): (() => void) => {
  let listeners = agentListeners.get(agentId)
  if (!listeners) {
    listeners = new Set()
    agentListeners.set(agentId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      agentListeners.delete(agentId)
    }
  }
}

export const __privateTaskDecorationStore = {
  resetForTests() {
    decorations.clear()
    snapshot = {}
    globalListeners.clear()
    agentListeners.clear()
  },
}
