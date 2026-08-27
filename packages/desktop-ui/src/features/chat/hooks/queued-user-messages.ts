import type { ChatContext } from '@stella/contracts'
import type { MessageMetadata } from '@stella/contracts/local-chat'

export type QueuedUserMessage = {
  id: string
  text: string
  timestamp: number

  queueOrder: number
}

export type CombinableQueuedSendPayload = {
  id: string
  queueOrder: number
  userPrompt: string
  selectedText: string | null
  chatContext: ChatContext | null
  messageMetadata?: MessageMetadata
  attachments: unknown[]
}

export const orderQueuedMessages = <
  T extends Pick<CombinableQueuedSendPayload, 'id' | 'queueOrder'>,
>(messages: readonly T[]): T[] =>
  messages
    .map((message, insertionIndex) => ({ message, insertionIndex }))
    .sort(
      (left, right) =>
        left.message.queueOrder - right.message.queueOrder
        || left.insertionIndex - right.insertionIndex,
    )
    .map(({ message }) => message)

export const timestampQueuedOptimisticEventForDrain = <
  T extends { timestamp: number },
>(event: T, dequeuedAtMs: number): T => ({
  ...event,
  timestamp: dequeuedAtMs,
})

export type QueuedDequeueClock = {
  userTimestamp: number

  nextTimelineFloor: number
}

export const issueQueuedDequeueTimestamp = (
  wallClockMs: number,
  previousTimelineFloor: number,
  transcriptFloor: number,
): QueuedDequeueClock => {
  const floor = Math.max(previousTimelineFloor, transcriptFloor)
  const userTimestamp = Math.max(wallClockMs, floor + 1)
  return {
    userTimestamp,
    nextTimelineFloor: userTimestamp + 1,
  }
}

export const restoreQueuedMessagesAfterFailedDrain = <
  T extends Pick<CombinableQueuedSendPayload, 'id' | 'queueOrder'>,
>(current: readonly T[], drained: readonly T[]): T[] => {
  const byId = new Map<string, T>()
  for (const message of drained) byId.set(message.id, message)
  for (const message of current) byId.set(message.id, message)
  return orderQueuedMessages([...byId.values()])
}

const definedEntries = (value: object) =>
  Object.entries(value).filter(([, entry]) => entry !== undefined)

const mergeChatContexts = (contexts: ChatContext[]): ChatContext => {
  const merged: Record<string, unknown> = {}
  const pastedTexts: string[] = []
  const regionScreenshots: NonNullable<ChatContext['regionScreenshots']> = []
  const files: NonNullable<ChatContext['files']> = []
  for (const context of contexts) {
    for (const [key, value] of definedEntries(context)) {
      merged[key] = value
    }
    if (context.pastedTexts?.length) pastedTexts.push(...context.pastedTexts)
    if (context.regionScreenshots?.length) {
      regionScreenshots.push(...context.regionScreenshots)
    }
    if (context.files?.length) files.push(...context.files)
  }
  if (pastedTexts.length > 0) merged.pastedTexts = pastedTexts
  if (regionScreenshots.length > 0) merged.regionScreenshots = regionScreenshots
  if (files.length > 0) merged.files = files
  return merged as ChatContext
}

const mergeMessageMetadata = (
  metadatas: MessageMetadata[],
): MessageMetadata | undefined => {
  if (metadatas.length === 0) return undefined
  const merged: Record<string, unknown> = {}
  const context: Record<string, unknown> = {}
  const pastedTexts: NonNullable<
    NonNullable<MessageMetadata['context']>['pastedTexts']
  > = []
  for (const metadata of metadatas) {
    for (const [key, value] of definedEntries(metadata)) {
      if (key === 'context') continue
      merged[key] = value
    }
    if (!metadata.context) continue
    for (const [key, value] of definedEntries(metadata.context)) {
      if (key === 'pastedTexts') continue
      context[key] = value
    }
    if (metadata.context.pastedTexts?.length) {
      pastedTexts.push(...metadata.context.pastedTexts)
    }
  }
  if (pastedTexts.length > 0) context.pastedTexts = pastedTexts
  if (Object.keys(context).length > 0) merged.context = context
  return merged as MessageMetadata
}

export const combineQueuedSendPayloads = <
  T extends CombinableQueuedSendPayload,
>(
  payloads: readonly T[],
): T | null => {
  if (payloads.length === 0) return null
  const ordered = orderQueuedMessages(payloads)
  const first = ordered[0]
  if (payloads.length === 1) return first

  const prompts = ordered
    .map((payload) => payload.userPrompt.trim())
    .filter((prompt) => prompt.length > 0)
  const selectedText =
    [...ordered]
      .reverse()
      .find(
        (payload) =>
          typeof payload.selectedText === 'string'
          && payload.selectedText.trim().length > 0,
      )?.selectedText ?? null
  const chatContexts = ordered
    .map((payload) => payload.chatContext)
    .filter((context): context is ChatContext => context != null)
  const mergedMetadata = mergeMessageMetadata(
    ordered
      .map((payload) => payload.messageMetadata)
      .filter((metadata): metadata is MessageMetadata => metadata != null),
  )

  const combined: CombinableQueuedSendPayload = {
    ...(first as CombinableQueuedSendPayload),
    userPrompt: prompts.join('\n\n'),
    selectedText,
    chatContext: chatContexts.length > 0 ? mergeChatContexts(chatContexts) : null,
    attachments: ordered.flatMap((payload) => payload.attachments),
  }
  if (mergedMetadata) {
    combined.messageMetadata = mergedMetadata
  } else {
    delete combined.messageMetadata
  }
  return combined as T
}

export const removeQueuedUserMessageById = (
  messages: QueuedUserMessage[],
  messageId: string,
) => messages.filter((message) => message.id !== messageId)

export const restoreQueuedTextToComposer = (
  currentComposerText: string,
  restoredText: string,
) => {
  const restored = restoredText.trim()
  if (restored.length === 0) return currentComposerText
  if (currentComposerText.trim().length === 0) return restored
  return `${currentComposerText.replace(/\s+$/, '')}\n\n${restored}`
}
