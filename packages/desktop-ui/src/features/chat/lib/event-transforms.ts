import {
  AGENT_IDS,
  type TaskLifecycleStatus,
  type TaskToolActivity,
} from "@stella/contracts/agent-runtime"
import type { AgentModelConfigSnapshot } from "@stella/contracts/agent-engine"
import { normalizeDisplayStatusText } from '../status-utils'
import type {
  Attachment,
  ChannelEnvelope,
  EventRecord,
  MessageMetadata,
  MessagePayload,
  ToolRequestPayload,
  ToolResultPayload,
} from "@stella/contracts/local-chat"
import type { DesktopThreadActivityRecord as ThreadActivityRecord } from "@/features/chat/thread-activity-types"
import { selectLatestAgentAssistantMessage } from './agent-assistant-summary'
import {
  deriveLatestAgentPresentationStatus,
  deriveOwnedAgentPresentationStatus,
  latestAttemptSupersedesAuthoritative,
} from './agent-activity-presentation'

export type {
  Attachment,
  ChannelEnvelope,
  EventRecord,
  MessageMetadata,
  MessagePayload,
}

interface StepItem {
  id: string
  tool: string
  title?: string
  subtitle?: string
  status: 'pending' | 'running' | 'completed' | 'error'
}

export const getEventText = (event: EventRecord): string => {
  if (!event.payload || typeof event.payload !== 'object') return ''
  const payload = event.payload as MessagePayload
  if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
    return payload.text
  }
  return ''
}

type AgentLifecycleFields = {

  rootRunId?: string

  attemptGeneration?: number
}

type AgentStartedEventPayload = AgentLifecycleFields & {
  agentId: string
  description: string
  agentType: string
  parentAgentId?: string
  agentDepth?: number
  maxAgentDepth?: number
  statusText?: string

  isFollowUp?: boolean
}

type AgentCompletedEventPayload = AgentLifecycleFields & {
  agentId: string
  result?: string
}

type AgentFailedEventPayload = AgentLifecycleFields & {
  agentId: string
  error?: string
}

type AgentCanceledEventPayload = AgentLifecycleFields & {
  agentId: string
  error?: string
}

type AgentProgressEventPayload = AgentLifecycleFields & {
  agentId: string
  statusText: string
  toolActivity?: TaskToolActivity
}

export type TaskItem = {
  id: string
  description: string
  agentType: string

  source: ThreadActivityRecord['source']
  readOnly: boolean
  status: TaskLifecycleStatus

  attemptGeneration?: number

  runId?: string

  modelConfigSnapshot?: AgentModelConfigSnapshot
  anchorTurnId?: string
  parentAgentId?: string
  statusText?: string
  toolActivity?: TaskToolActivity
  reasoningText?: string
  startedAtMs: number
  completedAtMs?: number
  lastUpdatedAtMs: number
  outputPreview?: string
  assistantMessages?: string[]
  assistantMessagesUpdatedAtMs?: number
  assistantMessagesUpdatedSequence?: number
}

export const TASK_COMPLETION_INDICATOR_MS = 3000

export type TaskLiveDecoration = {
  runId?: string

  status?: TaskLifecycleStatus

  attemptGeneration?: number

  startedAtMs?: number

  observedAtMs?: number

  lifecycleSequence?: number
  anchorTurnId?: string
  statusText?: string
  toolActivity?: TaskToolActivity
  reasoningText?: string
}

export function selectFreshActivityTasks(
  tasks: readonly TaskItem[],
  nowMs = Date.now(),
): TaskItem[] {
  return tasks.filter(
    (task) =>
      isManagedActivityTask(task) &&
      (task.status === 'running' ||
        (typeof task.completedAtMs === 'number' &&
          nowMs - task.completedAtMs <= TASK_COMPLETION_INDICATOR_MS)),
  )
}

export function buildActivityTasks(
  records: readonly ThreadActivityRecord[],
  decorations?: Record<string, TaskLiveDecoration>,
): TaskItem[] {
  return records
    .filter((record) => isActivityFeedTask(record))
    .map((record) => {
      const candidateDecoration = decorations?.[record.threadId]
      const authoritative = {
        status: record.status,
        attemptGeneration: record.attemptGeneration,
        rootRunId: record.rootRunId,
        updatedAtMs: record.updatedAt,
        completedAtMs: record.completedAt,
      }
      const latestAttempt = candidateDecoration
        ? {
            status: candidateDecoration.status,
            attemptGeneration: candidateDecoration.attemptGeneration,
            rootRunId: candidateDecoration.runId,
            startedAtMs: candidateDecoration.startedAtMs,
            observedAtMs: candidateDecoration.observedAtMs,
          }
        : undefined
      const status = deriveLatestAgentPresentationStatus(
        authoritative,
        latestAttempt,
      )
      const running = status === 'running'
      const decoration = running ? candidateDecoration : undefined
      const latestAttemptOwns = latestAttemptSupersedesAuthoritative(
        authoritative,
        latestAttempt,
      )
      const recordOwnsAttempt = !latestAttemptOwns
      return {
        id: record.threadId,

        description: record.description,
        agentType: record.agentType,
        source: record.source,
        readOnly: record.source === 'claude-native' || record.readOnly === true,
        status,
        attemptGeneration:
          (latestAttemptOwns
            ? candidateDecoration?.attemptGeneration
            : undefined) ?? record.attemptGeneration,
        runId:
          (latestAttemptOwns ? candidateDecoration?.runId : undefined) ??
          record.rootRunId,
        ...(record.modelConfigSnapshot
          ? { modelConfigSnapshot: record.modelConfigSnapshot }
          : {}),
        anchorTurnId: decoration?.anchorTurnId,
        parentAgentId: record.parentAgentId,
        statusText: running
          ? (normalizeTaskDisplayStatusText(decoration?.statusText) ??
            (isGenericTaskDescription(record.description)
              ? undefined
              : record.description))
          : undefined,
        toolActivity: running ? decoration?.toolActivity : undefined,
        reasoningText: running ? decoration?.reasoningText : undefined,
        startedAtMs: record.startedAt,
        completedAtMs: running
          ? undefined
          : latestAttemptOwns
            ? candidateDecoration?.observedAtMs
            : record.completedAt,
        lastUpdatedAtMs:
          (latestAttemptOwns ? candidateDecoration?.observedAtMs : undefined) ??
          record.updatedAt,
        outputPreview:
          running || !recordOwnsAttempt
            ? undefined
            : (record.result ?? record.error),
        assistantMessages: recordOwnsAttempt
          ? record.assistantMessages
          : undefined,
        assistantMessagesUpdatedAtMs: recordOwnsAttempt
          ? record.assistantMessagesUpdatedAt
          : undefined,
        assistantMessagesUpdatedSequence: recordOwnsAttempt
          ? record.assistantMessagesUpdatedSequence
          : undefined,
      }
    })
    .sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id))
}

const STANDALONE_STATUS_TEXT = new Set(['Pausing'])
const GENERIC_TASK_DESCRIPTION_PATTERN =
  /^(task|agent|work|help|do this|follow up)$/i

export function isGenericTaskDescription(
  description: string | undefined,
): boolean {
  return (
    !description || GENERIC_TASK_DESCRIPTION_PATTERN.test(description.trim())
  )
}

const SPAWN_SLUG_MAX_LENGTH = 48
const SPAWN_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function fallbackTaskDescription(agentId: string | undefined): string {
  const slug = (agentId ?? '').trim()
  if (!slug || /^(task|legacy)-/i.test(slug)) return 'Task'
  if (slug.length > SPAWN_SLUG_MAX_LENGTH || !SPAWN_SLUG_PATTERN.test(slug)) {
    return 'Task'
  }
  const words = slug.split('-')
  const letterCount = (words.join('').match(/[a-z]/gi) ?? []).length

  if (words.length < 2 && letterCount < 4) return 'Task'
  if (letterCount === 0) return 'Task'
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function isActivityFeedTask(
  task: Pick<TaskItem, 'agentType' | 'source'>,
): boolean {
  return task.source === 'claude-native' || task.agentType === AGENT_IDS.GENERAL
}

export function isManagedActivityTask(task: Pick<TaskItem, 'source'>): boolean {
  return task.source === 'stella'
}

export function isStandaloneTaskStatusText(
  statusText: string | undefined,
): boolean {
  const normalized = normalizeTaskDisplayStatusText(statusText)
  return Boolean(normalized && STANDALONE_STATUS_TEXT.has(normalized))
}

export function normalizeTaskDisplayStatusText(
  statusText: string | undefined,
): string | undefined {
  return normalizeDisplayStatusText(statusText)
}

export function getTaskDisplayText(task: TaskItem): string {
  const description = isGenericTaskDescription(task.description)
    ? ''
    : task.description

  if (task.status === 'running') {
    const statusText = normalizeTaskDisplayStatusText(task.statusText)
    if (statusText && !isStandaloneTaskStatusText(statusText)) {
      return statusText
    }
    return description
  }
  return description
}

export function getTaskWorkingIndicatorText(task: TaskItem): string {
  const statusText = normalizeTaskDisplayStatusText(task.statusText)
  if (
    task.status === 'running' &&
    statusText &&
    isStandaloneTaskStatusText(statusText)
  ) {
    const description = isGenericTaskDescription(task.description)
      ? ''
      : task.description
    return description ? `${statusText} · ${description}` : statusText
  }
  return getTaskDisplayText(task)
}

function createEventGuard<T extends Record<string, unknown>>(
  type: string,
  requiredFields?: (keyof T)[],
) {
  return (event: EventRecord): event is EventRecord & { payload: T } =>
    event.type === type &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    (requiredFields === undefined ||
      requiredFields.every((field) => field in (event.payload as object)))
}

export const isToolRequest = createEventGuard<ToolRequestPayload>(
  'tool_request',
  ['toolName'],
)

export const isToolResult = createEventGuard<ToolResultPayload>('tool_result')

export function isUserMessage(event: EventRecord): boolean {
  return event.type === 'user_message'
}

export function isAssistantMessage(event: EventRecord): boolean {
  return event.type === 'assistant_message'
}

export const isAgentStartedEvent = createEventGuard<AgentStartedEventPayload>(
  'agent-started',
  ['agentId'],
)

export const isAgentCompletedEvent =
  createEventGuard<AgentCompletedEventPayload>('agent-completed', ['agentId'])

export const isAgentFailedEvent = createEventGuard<AgentFailedEventPayload>(
  'agent-failed',
  ['agentId'],
)

export const isAgentCanceledEvent = createEventGuard<AgentCanceledEventPayload>(
  'agent-canceled',
  ['agentId'],
)

export const isAgentProgressEvent = createEventGuard<AgentProgressEventPayload>(
  'agent-progress',
  ['agentId', 'statusText'],
)

export function extractToolTitle(event: EventRecord): string {
  if (!isToolRequest(event)) return ''

  const { toolName, args } = event.payload

  const str = (v: unknown) => v as string

  switch (toolName.toLowerCase()) {
    case 'read':
      return args?.path ? str(args.path).split('/').pop()! : 'Reading file'
    case 'write':
      return args?.path ? str(args.path).split('/').pop()! : 'Writing file'
    case 'edit':
      return args?.path ? str(args.path).split('/').pop()! : 'Editing file'
    case 'grep':
      return args?.pattern ? `"${str(args.pattern).slice(0, 30)}"` : 'Searching'
    case 'executetypescript':
      return args?.summary
        ? str(args.summary).slice(0, 40)
        : 'Running code mode'
    case 'glob':
      return args?.pattern ? str(args.pattern) : 'Finding files'
    case 'bash':
      return args?.command
        ? str(args.command).slice(0, 40) +
            (str(args.command).length > 40 ? '...' : '')
        : 'Running command'
    case 'webfetch':
      return args?.url ? new URL(str(args.url)).hostname : 'Fetching'
    case 'web':
      if (args?.url) {
        try {
          return new URL(str(args.url)).hostname
        } catch {
          return 'Fetching'
        }
      }
      return args?.query
        ? `"${str(args.query).slice(0, 40)}${str(args.query).length > 40 ? '…' : ''}"`
        : 'Searching the web'
    case 'task':
      return args?.description
        ? str(args.description).slice(0, 40)
        : 'Delegating'
    default:
      return toolName
  }
}

function getRequestId(event: EventRecord): string | undefined {

  if (event.requestId) return event.requestId

  if (event.payload && typeof event.payload === 'object') {
    const payload = event.payload as { requestId?: string }
    if (payload.requestId) return payload.requestId
  }
  return undefined
}

export function extractStepsFromEvents(events: EventRecord[]): StepItem[] {
  const steps: StepItem[] = []
  const stepIndexByRequestId = new Map<string, number>()

  for (const event of events) {
    if (isToolRequest(event)) {
      const requestId = getRequestId(event) ?? event._id
      const toolName = event.payload.toolName
      const stepIndex = steps.length
      steps.push({
        id: requestId,
        tool: toolName,
        title: extractToolTitle(event),
        status: 'running',
      })
      stepIndexByRequestId.set(requestId, stepIndex)
      continue
    }

    if (!isToolResult(event)) {
      continue
    }

    const status: StepItem['status'] = event.payload.error
      ? 'error'
      : 'completed'
    const requestId = getRequestId(event)

    if (requestId) {
      const directIndex = stepIndexByRequestId.get(requestId)
      if (
        directIndex !== undefined &&
        steps[directIndex]?.status === 'running'
      ) {
        steps[directIndex] = { ...steps[directIndex], status }
        continue
      }
    }
  }

  return steps
}

export function getCurrentRunningTool(
  messages: { toolEvents: EventRecord[] }[],
): { tool: string; id: string } | undefined {
  const events: EventRecord[] = []
  for (const message of messages) {
    if (message.toolEvents.length === 0) continue
    for (const toolEvent of message.toolEvents) events.push(toolEvent)
  }
  const running = extractStepsFromEvents(events).find(
    (s) => s.status === 'running',
  )
  return running ? { tool: running.tool, id: running.id } : undefined
}

export type TaskHierarchy = {
  owner: TaskItem
  children: ActivityRow[]

  descendantCount: number

  status: TaskLifecycleStatus
}

export type ActivityRow =
  | { kind: 'task'; task: TaskItem }
  | { kind: 'hierarchy'; hierarchy: TaskHierarchy }

export const COMPACT_ACTIVITY_CELL_LIMIT = 16

export type CompactActivitySummary = {
  tasks: TaskItem[]
  totalCount: number
  runningCount: number
  completedCount: number
  errorCount: number
  canceledCount: number
  latestTask?: TaskItem
  latestText?: string
  failureTask?: TaskItem
  usesProgressBar: boolean
}

export const flattenActivityTasks = (
  rows: readonly ActivityRow[],
): TaskItem[] => {
  const tasks: TaskItem[] = []
  const append = (row: ActivityRow): void => {
    if (row.kind === 'task') {
      tasks.push(row.task)
      return
    }
    tasks.push(row.hierarchy.owner)
    for (const child of row.hierarchy.children) append(child)
  }
  for (const row of rows) append(row)
  return tasks
}

const compareCompactTaskRecency = (a: TaskItem, b: TaskItem): number =>
  b.lastUpdatedAtMs - a.lastUpdatedAtMs ||
  (b.completedAtMs ?? 0) - (a.completedAtMs ?? 0) ||
  b.startedAtMs - a.startedAtMs ||
  a.id.localeCompare(b.id)

const compactLatestText = (task: TaskItem): string => {
  const assistantText = selectLatestAgentAssistantMessage(
    task.assistantMessages,
  )
  if (assistantText) return assistantText
  switch (task.status) {
    case 'running':
      return 'Working…'
    case 'completed':
      return 'Completed'
    case 'error':
      return 'Failed'
    case 'canceled':
      return 'Paused'
  }
}

const compareCompactAssistantRecency = (a: TaskItem, b: TaskItem): number => {
  const aHasText = Boolean(
    selectLatestAgentAssistantMessage(a.assistantMessages),
  )
  const bHasText = Boolean(
    selectLatestAgentAssistantMessage(b.assistantMessages),
  )
  if (aHasText !== bHasText) return Number(bHasText) - Number(aHasText)
  if (aHasText && bHasText) {
    const aSequence = a.assistantMessagesUpdatedSequence
    const bSequence = b.assistantMessagesUpdatedSequence
    if (
      aSequence !== undefined &&
      bSequence !== undefined &&
      aSequence !== bSequence
    ) {
      return bSequence - aSequence
    }
    const byTimestamp =
      (b.assistantMessagesUpdatedAtMs ?? 0) -
      (a.assistantMessagesUpdatedAtMs ?? 0)
    if (byTimestamp !== 0) return byTimestamp
  }
  return compareCompactTaskRecency(a, b)
}

export function summarizeCompactActivity(
  tasks: readonly TaskItem[],
): CompactActivitySummary {
  const ordered = [...tasks].sort(compareCompactAssistantRecency)
  const latestTask = ordered[0]
  const failureTask = ordered.find((task) => task.status === 'error')
  return {
    tasks: [...tasks],
    totalCount: tasks.length,
    runningCount: tasks.filter((task) => task.status === 'running').length,
    completedCount: tasks.filter((task) => task.status === 'completed').length,
    errorCount: tasks.filter((task) => task.status === 'error').length,
    canceledCount: tasks.filter((task) => task.status === 'canceled').length,
    latestTask,
    latestText: latestTask ? compactLatestText(latestTask) : undefined,
    failureTask,
    usesProgressBar: tasks.length > COMPACT_ACTIVITY_CELL_LIMIT,
  }
}

export function getCompactActivityStatusText(
  summary: CompactActivitySummary,
  prioritizeFailure: boolean,
): string {
  const tally = `${summary.runningCount} running · ${summary.completedCount} done`
  const stopped =
    summary.canceledCount > 0 ? ` · ${summary.canceledCount} stopped` : ''
  if (prioritizeFailure && summary.failureTask) {
    const name = summary.failureTask.description.trim() || 'Agent'
    return `${summary.errorCount} failed — ${name} · ${tally}${stopped}`
  }
  const failed = summary.errorCount > 0 ? ` · ${summary.errorCount} failed` : ''
  return `${tally}${failed}${stopped}`
}

export const activityRowKey = (row: ActivityRow): string =>
  row.kind === 'task'
    ? `task:${row.task.id}`
    : `hierarchy:${row.hierarchy.owner.id}`

export type TopLevelActivityWorkUnit = {
  id: string
  status: TaskLifecycleStatus
}

export const deriveTopLevelActivityWorkUnits = (
  tasks: readonly TaskItem[],
): TopLevelActivityWorkUnit[] => {
  const latestById = new Map<string, TaskItem>()
  for (const task of tasks) {
    if (!isActivityFeedTask(task) || !isManagedActivityTask(task)) continue
    const current = latestById.get(task.id)
    if (
      !current ||
      (task.attemptGeneration ?? 0) > (current.attemptGeneration ?? 0) ||
      ((task.attemptGeneration ?? 0) === (current.attemptGeneration ?? 0) &&
        (task.lastUpdatedAtMs > current.lastUpdatedAtMs ||
          (task.lastUpdatedAtMs === current.lastUpdatedAtMs &&
            task.startedAtMs > current.startedAtMs)))
    ) {
      latestById.set(task.id, task)
    }
  }
  return groupActivityTasks([...latestById.values()]).map((row) => ({
    id: activityRowKey(row),
    status: getActivityRowStatus(row),
  }))
}

export const countActiveTopLevelActivityWorkUnits = (
  tasks: readonly TaskItem[],
): number =>
  deriveTopLevelActivityWorkUnits(tasks).filter(
    (unit) => unit.status === 'running',
  ).length

export const getActivityRowStatus = (row: ActivityRow): TaskLifecycleStatus =>
  row.kind === 'task' ? row.task.status : row.hierarchy.status

export const getActivityRowCompletedAtMs = (row: ActivityRow): number => {
  const entry = row.kind === 'task' ? row.task : row.hierarchy.owner
  return entry.completedAtMs ?? entry.lastUpdatedAtMs ?? entry.startedAtMs
}

export const compareActivityRowsByLifecycleStart = (
  a: ActivityRow,
  b: ActivityRow,
): number => {
  const aEntry = a.kind === 'task' ? a.task : a.hierarchy.owner
  const bEntry = b.kind === 'task' ? b.task : b.hierarchy.owner
  return (
    bEntry.startedAtMs - aEntry.startedAtMs ||
    activityRowKey(a).localeCompare(activityRowKey(b))
  )
}

export const getActivityRowSearchText = (row: ActivityRow): string => {
  if (row.kind === 'task') {
    return [row.task.description, row.task.statusText, row.task.outputPreview]
      .filter(Boolean)
      .join(' ')
  }
  return [
    row.hierarchy.owner.description,
    row.hierarchy.owner.statusText,
    row.hierarchy.owner.outputPreview,
    ...row.hierarchy.children.map(getActivityRowSearchText),
  ]
    .filter(Boolean)
    .join(' ')
}

export function groupActivityTasks(tasks: readonly TaskItem[]): ActivityRow[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParentId = new Map<string, TaskItem[]>()
  const ownedTaskIds = new Set<string>()
  for (const task of tasks) {
    const parentId = task.parentAgentId
    if (!parentId || parentId === task.id || !taskById.has(parentId)) continue
    const children = childrenByParentId.get(parentId)
    if (children) children.push(task)
    else childrenByParentId.set(parentId, [task])
    ownedTaskIds.add(task.id)
  }

  const visited = new Set<string>()
  const buildRows = (
    siblings: readonly TaskItem[],
    ancestors: ReadonlySet<string>,
  ): ActivityRow[] => {
    const visibleChildren = (task: TaskItem): TaskItem[] =>
      (childrenByParentId.get(task.id) ?? []).filter(
        (child) => !ancestors.has(child.id) && child.id !== task.id,
      )

    const rows: ActivityRow[] = []
    for (const task of siblings) {
      if (visited.has(task.id)) continue
      const children = visibleChildren(task)
      if (children.length > 0) {
        visited.add(task.id)
        const nextAncestors = new Set(ancestors)
        nextAncestors.add(task.id)
        const childRows = buildRows(children, nextAncestors)
        const managedChildStatuses = childRows.flatMap((row) => {
          const child = row.kind === 'task' ? row.task : row.hierarchy.owner
          return isManagedActivityTask(child) ? [getActivityRowStatus(row)] : []
        })
        const status = isManagedActivityTask(task)
          ? deriveOwnedAgentPresentationStatus(
              task.status,
              managedChildStatuses,
            )
          : task.status
        rows.push({
          kind: 'hierarchy',
          hierarchy: {
            owner: task,
            children: childRows,
            descendantCount: countActivityTasks(childRows),
            status,
          },
        })
        continue
      }

      visited.add(task.id)
      rows.push({ kind: 'task', task })
    }
    return rows
  }

  const roots = tasks.filter((task) => !ownedTaskIds.has(task.id))
  const rows = buildRows(roots, new Set())

  const unvisited = tasks.filter((task) => !visited.has(task.id))
  if (unvisited.length > 0) rows.push(...buildRows(unvisited, new Set()))
  return rows
}

const countActivityTasks = (rows: readonly ActivityRow[]): number =>
  rows.reduce((total, row) => {
    if (row.kind === 'task') return total + 1
    return total + 1 + row.hierarchy.descendantCount
  }, 0)

export function getTaskHierarchyStatusText(hierarchy: TaskHierarchy): string {
  return hierarchy.descendantCount === 1
    ? '1 agent'
    : `${hierarchy.descendantCount} agents`
}

export function getTaskAgentUpdates(
  task: Pick<TaskItem, 'status' | 'agentType' | 'assistantMessages'>,
): readonly string[] {
  return (task.assistantMessages ?? []).filter((message) => message.trim())
}

export function updateSeenRunningTaskIds(
  seen: ReadonlySet<string>,
  tasks: readonly TaskItem[],
): ReadonlySet<string> {
  let changed = false
  const present = new Set<string>()
  for (const task of tasks) present.add(task.id)
  const next = new Set<string>()
  for (const id of seen) {
    if (present.has(id)) next.add(id)
    else changed = true
  }
  for (const task of tasks) {
    if (task.status === 'running' && !next.has(task.id)) {
      next.add(task.id)
      changed = true
    }
  }
  return changed ? next : seen
}
