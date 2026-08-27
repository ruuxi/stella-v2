import { useCallback, type Dispatch, type MutableRefObject } from 'react'
import { showToast } from '@/ui/toast'
import {
  decorateTask,
  settleTaskDecoration,
} from './task-decoration-store'
import {
  AGENT_IDS,
  AGENT_RUN_FINISH_OUTCOMES,
  AGENT_STREAM_EVENT_TYPES,
  nextAgentRecorderSeqCursor,
} from "@stella/contracts/agent-runtime"
import type { StreamStoreAction } from './store'
import {
  isStellaLimitOrAuthReason,
  resolveStellaProviderErrorToast,
} from './stella-provider-error-toast'
import type {
  AgentResponseTarget,
  AgentStreamEvent as BaseAgentStreamEvent,
} from './streaming-types'

type AgentStreamEvent = BaseAgentStreamEvent & {
  attemptGeneration?: number
}

type ReasoningQueueEntry = {
  agentId: string
  conversationId: string
  runId?: string
  attemptGeneration?: number
  lifecycleSequence?: number
  chunk: string
}

type UseAgentEventHandlerOptions = {
  dispatch: Dispatch<StreamStoreAction>
  refs: {
    activeConversationIdRef: MutableRefObject<string | null>
    activeRunIdByConversationRef: MutableRefObject<
      Record<string, string | null>
    >
    lastSeqByConversationRef: MutableRefObject<Map<string, number>>
    terminalRunIdsRef: MutableRefObject<Set<string>>
    pendingRequestIdsRef: MutableRefObject<Set<string>>
    resumeSeqByConversationRef: MutableRefObject<Map<string, number>>
    resumeSourceSeqByConversationRef: MutableRefObject<Map<string, number>>
    seenSourceEventKeysRef: MutableRefObject<Set<string>>
  }
  streaming: {
    setPendingUserMessageId: Dispatch<React.SetStateAction<string | null>>

    beginStreamingRun: (args: {
      runId: string
      userMessageId: string | null
      workingMode?: 'direct' | 'orchestrated'
    }) => void
    finalizeMessageBoundary: (args: {
      runId: string
      userMessageId: string | null
      responseTarget?: AgentResponseTarget | null
      canonicalMessageId?: string
      canonicalText?: string
      workingMode?: 'direct' | 'orchestrated'
    }) => void
    finalizeRunOnFinish: (args: { runId: string }) => void
  }
  reasoning: {
    queueAgentReasoningChunk: (entry: ReasoningQueueEntry) => void
    flushPendingReasoningChunks: (onlyAgentId?: string) => void
    discardPendingReasoningChunks: (agentId: string) => void
  }
  lifecycle?: {
    onRunStarted?: (event: {
      runId: string
      conversationId: string
      userMessageId?: string
    }) => void
    onRunFinished?: (event: {
      runId: string
      conversationId: string
      userMessageId?: string
      outcome: 'completed' | 'error' | 'canceled'
    }) => void
  }
}

type AgentEventSource = 'live' | 'replay'

export const acceptConversationAgentEventSequence = (
  lastSeqByConversation: Map<string, number>,
  conversationId: string,
  seq: number,
): boolean => {
  if (!Number.isFinite(seq) || seq <= 0) return true
  const previousSeq = lastSeqByConversation.get(conversationId) ?? 0
  if (seq <= previousSeq) return false
  lastSeqByConversation.set(conversationId, seq)
  return true
}

export const acceptAgentEventSourceIdentity = (
  seenKeys: Set<string>,
  event: Pick<AgentStreamEvent, 'type' | 'runId' | 'seq' | 'sourceSeq'>,
): boolean => {
  const sourceSeq = event.sourceSeq ?? event.seq
  if (!Number.isFinite(sourceSeq) || sourceSeq <= 0) return true
  const key = `${event.runId}:${sourceSeq}:${event.type}`
  if (seenKeys.has(key)) return false
  seenKeys.add(key)
  return true
}

const readToolExitCode = (event: AgentStreamEvent): number | undefined => {
  const details =
    event.details && typeof event.details === 'object'
      ? (event.details as Record<string, unknown>)
      : null
  const value = details?.exitCode ?? details?.exit_code
  return typeof value === 'number' ? value : undefined
}

export function useAgentEventHandler({
  dispatch,
  refs,
  streaming,
  reasoning,
  lifecycle,
}: UseAgentEventHandlerOptions) {
  const {
    activeConversationIdRef,
    activeRunIdByConversationRef,
    lastSeqByConversationRef,
    resumeSeqByConversationRef,
    resumeSourceSeqByConversationRef,
    seenSourceEventKeysRef,
    terminalRunIdsRef,
    pendingRequestIdsRef,
  } = refs
  const {
    setPendingUserMessageId,
    beginStreamingRun,
    finalizeMessageBoundary,
    finalizeRunOnFinish,
  } = streaming
  const {
    queueAgentReasoningChunk,
    flushPendingReasoningChunks,
    discardPendingReasoningChunks,
  } = reasoning

  return useCallback(
    (event: AgentStreamEvent, source: AgentEventSource = 'live') => {
      const conversationId =
        event.conversationId ?? activeConversationIdRef.current ?? null
      if (!conversationId) {
        return
      }

      const seq = Number.isFinite(event.seq) ? event.seq : 0
      if (!acceptAgentEventSourceIdentity(seenSourceEventKeysRef.current, event)) {
        return
      }
      if (seq > 0) {
        const previousResumeSeq =
          resumeSeqByConversationRef.current.get(conversationId) ?? 0
        if (seq > previousResumeSeq) {
          resumeSeqByConversationRef.current.set(conversationId, seq)
        }
        const previousSourceSeq =
          resumeSourceSeqByConversationRef.current.get(conversationId) ?? 0
        const nextSourceSeq = nextAgentRecorderSeqCursor(previousSourceSeq, event)
        if (nextSourceSeq > previousSourceSeq) {
          resumeSourceSeqByConversationRef.current.set(
            conversationId,
            nextSourceSeq,
          )
        }
      }
      if (
        !acceptConversationAgentEventSequence(
          lastSeqByConversationRef.current,
          conversationId,
          seq,
        )
      ) {
        return
      }

      if (event.requestId) {
        pendingRequestIdsRef.current.delete(event.requestId)
      }

      const isOrchestratorEvent =
        (event.agentType ?? AGENT_IDS.ORCHESTRATOR) === AGENT_IDS.ORCHESTRATOR
      const activeRunForConversation =
        activeRunIdByConversationRef.current[conversationId] ?? null
      const isActiveConversation =
        conversationId === activeConversationIdRef.current
      const isPrimaryRun =
        Boolean(activeRunForConversation) &&
        activeRunForConversation === event.runId

      const applyRunFinished = (args: {
        outcome: 'completed' | 'error' | 'canceled'
        reason?: string
      }) => {
        if (terminalRunIdsRef.current.has(event.runId)) {
          return
        }
        terminalRunIdsRef.current.add(event.runId)
        dispatch({
          type: 'run-finished',
          runId: event.runId,
          conversationId,
          outcome: args.outcome,
        })
        lifecycle?.onRunFinished?.({
          runId: event.runId,
          conversationId,
          ...(event.userMessageId
            ? { userMessageId: event.userMessageId }
            : {}),
          outcome: args.outcome,
        })
        if (
          conversationId === activeConversationIdRef.current &&
          source === 'live'
        ) {
          const finishReason = args.reason || event.error
          if (args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR) {
            showToast(resolveStellaProviderErrorToast(finishReason))
          } else if (
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.CANCELED &&
            isStellaLimitOrAuthReason(finishReason)
          ) {

            showToast(resolveStellaProviderErrorToast(finishReason))
          }
        }
        if (
          conversationId === activeConversationIdRef.current &&
          (args.outcome === AGENT_RUN_FINISH_OUTCOMES.COMPLETED ||
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.ERROR ||
            args.outcome === AGENT_RUN_FINISH_OUTCOMES.CANCELED)
        ) {

          finalizeRunOnFinish({ runId: event.runId })
          setPendingUserMessageId(null)
        }

      }

      switch (event.type) {
        case AGENT_STREAM_EVENT_TYPES.RUN_STARTED: {
          if (event.uiVisibility === 'hidden') {
            break
          }
          if (event.requestId) {
            pendingRequestIdsRef.current.delete(event.requestId)
          }
          terminalRunIdsRef.current.delete(event.runId)
          dispatch({
            type: 'run-started',
            runId: event.runId,
            conversationId,
            requestId: event.requestId,
            userMessageId: event.userMessageId,
            uiVisibility: event.uiVisibility,
          })
          lifecycle?.onRunStarted?.({
            runId: event.runId,
            conversationId,
            ...(event.userMessageId
              ? { userMessageId: event.userMessageId }
              : {}),
          })
          if (conversationId === activeConversationIdRef.current) {
            const anchorUserMessageId =
              event.responseTarget && event.responseTarget.type !== 'user_turn'
                ? null
                : (event.userMessageId ?? null)
            beginStreamingRun({
              runId: event.runId,
              userMessageId: anchorUserMessageId,
              ...(event.workingMode ? { workingMode: event.workingMode } : {}),
            })
            setPendingUserMessageId(anchorUserMessageId)
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.ASSISTANT_MESSAGE: {

          const isReactivation =
            !isPrimaryRun &&
            isOrchestratorEvent &&
            terminalRunIdsRef.current.has(event.runId)
          if (isReactivation) {
            terminalRunIdsRef.current.delete(event.runId)
            dispatch({
              type: 'run-started',
              runId: event.runId,
              conversationId,
              requestId: event.requestId,
            })
            if (isActiveConversation) {
              beginStreamingRun({
                runId: event.runId,
                userMessageId: event.userMessageId ?? null,
                ...(event.workingMode
                  ? { workingMode: event.workingMode }
                  : {}),
              })
            }
          }
          dispatch({
            type: 'run-status',
            runId: event.runId,
            statusText: null,
          })

          if ((isPrimaryRun || isOrchestratorEvent) && isActiveConversation) {
            finalizeMessageBoundary({
              runId: event.runId,
              userMessageId: event.userMessageId ?? null,
              ...(event.responseTarget
                ? { responseTarget: event.responseTarget }
                : {}),
              ...(event.assistantMessageEventId
                ? { canonicalMessageId: event.assistantMessageEventId }
                : {}),
              ...(event.assistantMessageText !== undefined
                ? { canonicalText: event.assistantMessageText }
                : {}),
              ...(event.workingMode ? { workingMode: event.workingMode } : {}),
            })

            if (event.followedByToolCall) {
              dispatch({
                type: 'assistant-message-boundary',
                runId: event.runId,
                followedByToolCall: true,
              })
            }
          }
          break
        }
        case AGENT_STREAM_EVENT_TYPES.STATUS: {
          if (event.statusState === 'model-fallback') {

            if (conversationId === activeConversationIdRef.current) {
              showToast({
                title: 'Switched to a fallback model',
                description:
                  event.statusText ||
                  'The configured model was unavailable, so this session switched to a fallback model.',
                variant: 'error',
                duration: 10000,
              })
            }
            break
          }
          if (event.statusState === 'provider-retry') {
            if (conversationId === activeConversationIdRef.current) {
              showToast({
                title: 'Reconnecting to Stella',
                description: event.statusText || 'Trying again in a moment.',
                variant: 'default',
                duration: 4000,
              })
            }
            break
          }
          dispatch({
            type: 'run-status',
            runId: event.runId,
            statusText: event.statusText
              ? event.statusState === 'compacting'
                ? event.statusText || 'Compacting context'
                : event.statusText
              : null,
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.AGENT_STARTED:
        case AGENT_STREAM_EVENT_TYPES.AGENT_REASONING:
        case AGENT_STREAM_EVENT_TYPES.AGENT_PROGRESS:
        case AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED:
        case AGENT_STREAM_EVENT_TYPES.AGENT_FAILED:
        case AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED: {
          const runId = event.rootRunId ?? event.runId
          if (!event.agentId) {
            return
          }
          if (runId) {
            dispatch({
              type: 'tool-activity-observed',
              runId,
            })
          }

          if (
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED ||
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_FAILED ||
            event.type === AGENT_STREAM_EVENT_TYPES.AGENT_CANCELED
          ) {
            discardPendingReasoningChunks(event.agentId)
            settleTaskDecoration({
              agentId: event.agentId,
              conversationId,
              runId,
              attemptGeneration: event.attemptGeneration,
              lifecycleSequence: event.sourceSeq ?? event.seq,
              status:
                event.type === AGENT_STREAM_EVENT_TYPES.AGENT_COMPLETED
                  ? 'completed'
                  : event.type === AGENT_STREAM_EVENT_TYPES.AGENT_FAILED
                    ? 'error'
                    : 'canceled',
            })
            break
          }

          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_REASONING) {
            if (!event.chunk) {
              return
            }
            queueAgentReasoningChunk({
              agentId: event.agentId,
              conversationId,
              runId,
              attemptGeneration: event.attemptGeneration,
              lifecycleSequence: event.sourceSeq ?? event.seq,
              chunk: event.chunk,
            })
            break
          }

          if (event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED) {

            discardPendingReasoningChunks(event.agentId)
          }

          flushPendingReasoningChunks(event.agentId)
          decorateTask({
            agentId: event.agentId,
            conversationId,
            runId,
            attemptGeneration: event.attemptGeneration,
            lifecycleSequence: event.sourceSeq ?? event.seq,
            startsAttempt:
              event.type === AGENT_STREAM_EVENT_TYPES.AGENT_STARTED,
            anchorTurnId: event.userMessageId,
            statusText: event.statusText,
            toolActivity: event.toolActivity,
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.TOOL_START: {
          dispatch({
            type: 'tool-start',
            runId: event.runId,
            conversationId,
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.toolName ? { toolName: event.toolName } : {}),
            statusText: event.statusText ?? null,
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.TOOL_END: {
          const exitCode = readToolExitCode(event)
          dispatch({
            type: 'tool-end',
            runId: event.runId,
            ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
            ...(event.toolName ? { toolName: event.toolName } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
          })
          break
        }
        case AGENT_STREAM_EVENT_TYPES.RUN_FINISHED: {
          applyRunFinished({
            outcome: event.outcome ?? AGENT_RUN_FINISH_OUTCOMES.ERROR,
            reason: event.reason ?? event.error,
          })
          break
        }
        default:
          break
      }
    },
    [
      activeConversationIdRef,
      activeRunIdByConversationRef,
      beginStreamingRun,
      discardPendingReasoningChunks,
      dispatch,
      finalizeMessageBoundary,
      finalizeRunOnFinish,
      flushPendingReasoningChunks,
      lastSeqByConversationRef,
      lifecycle,
      pendingRequestIdsRef,
      queueAgentReasoningChunk,
      resumeSeqByConversationRef,
      resumeSourceSeqByConversationRef,
      seenSourceEventKeysRef,
      setPendingUserMessageId,
      terminalRunIdsRef,
    ],
  )
}
