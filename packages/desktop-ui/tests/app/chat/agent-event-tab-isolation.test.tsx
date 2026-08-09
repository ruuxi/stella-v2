// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STREAM_EVENT_TYPES } from '@stella/contracts/agent-runtime'
import { useAgentEventHandler } from '@/features/chat/streaming/use-agent-event-handler'

type Handler = ReturnType<typeof useAgentEventHandler>

type ProbeApi = {
  current: Handler | null
  beginStreamingRun?: ReturnType<typeof vi.fn>
  acceptStreamChunk?: ReturnType<typeof vi.fn>
  activeRunIdByConversationRef?: {
    current: Record<string, string | null>
  }
  terminalRunIdsRef?: { current: Set<string> }
}

function Probe({ api }: { api: ProbeApi }) {
  const activeConversationIdRef = { current: 'conversation-b' }
  const activeRunIdByConversationRef = {
    current: {
      'conversation-a': 'run-a',
      'conversation-b': 'run-b',
    },
  }
  const terminalRunIdsRef = { current: new Set<string>() }
  const beginStreamingRun = vi.fn()
  const acceptStreamChunk = vi.fn()

  api.current = useAgentEventHandler({
    dispatch: vi.fn(),
    refs: {
      activeConversationIdRef,
      activeRunIdByConversationRef,
      lastSeqByConversationRef: { current: new Map() },
      resumeSeqByConversationRef: { current: new Map() },
      seenSourceEventKeysRef: { current: new Set() },
      terminalRunIdsRef,
      pendingRequestIdsRef: { current: new Set() },
    },
    streaming: {
      setPendingUserMessageId: vi.fn(),
      beginStreamingRun,
      acceptStreamChunk,
      finalizeMessageBoundary: vi.fn(),
      finalizeRunOnFinish: vi.fn(),
    },
    reasoning: {
      queueAgentReasoningChunk: vi.fn(),
      flushPendingReasoningChunks: vi.fn(),
      discardPendingReasoningChunks: vi.fn(),
    },
  })

  api.beginStreamingRun = beginStreamingRun
  api.acceptStreamChunk = acceptStreamChunk
  api.activeRunIdByConversationRef = activeRunIdByConversationRef
  api.terminalRunIdsRef = terminalRunIdsRef
  return null
}

describe('agent stream tab isolation', () => {
  let container: HTMLDivElement
  let root: Root
  const api: ProbeApi = { current: null }

  beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(<Probe api={api} />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    api.current = null
    api.beginStreamingRun = undefined
    api.acceptStreamChunk = undefined
    api.activeRunIdByConversationRef = undefined
    api.terminalRunIdsRef = undefined
  })

  it('does not paint a background conversation stream into the active tab', () => {
    act(() => {
      api.current?.({
        type: AGENT_STREAM_EVENT_TYPES.STREAM,
        conversationId: 'conversation-a',
        runId: 'run-a',
        userMessageId: 'user-a',
        agentType: 'orchestrator',
        chunk: 'background response',
        seq: 1,
      })
    })

    expect(api.acceptStreamChunk).not.toHaveBeenCalled()
    expect(api.beginStreamingRun).not.toHaveBeenCalled()
  })

  it('continues painting the active conversation stream', () => {
    act(() => {
      api.current?.({
        type: AGENT_STREAM_EVENT_TYPES.STREAM,
        conversationId: 'conversation-b',
        runId: 'run-b',
        userMessageId: 'user-b',
        agentType: 'orchestrator',
        chunk: 'visible response',
        seq: 1,
      })
    })

    expect(api.acceptStreamChunk).toHaveBeenCalledWith({
      runId: 'run-b',
      userMessageId: 'user-b',
      chunk: 'visible response',
    })
  })

  it('does not reactivate a background run in the active tab overlay', () => {
    api.activeRunIdByConversationRef!.current['conversation-a'] = null
    api.terminalRunIdsRef!.current.add('run-a')

    act(() => {
      api.current?.({
        type: AGENT_STREAM_EVENT_TYPES.STREAM,
        conversationId: 'conversation-a',
        runId: 'run-a',
        userMessageId: 'user-a',
        agentType: 'orchestrator',
        chunk: 'reactivated background response',
        seq: 1,
      })
    })

    expect(api.beginStreamingRun).not.toHaveBeenCalled()
    expect(api.acceptStreamChunk).not.toHaveBeenCalled()
  })
})
