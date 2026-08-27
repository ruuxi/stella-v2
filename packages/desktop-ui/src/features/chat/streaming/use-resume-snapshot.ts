import { useCallback, type Dispatch, type MutableRefObject } from 'react'
import type { ActiveRunSnapshot, StreamStoreAction } from './store'

type UseResumeSnapshotOptions = {
  dispatch: Dispatch<StreamStoreAction>
  refs: {
    activeConversationIdRef: MutableRefObject<string | null>
  }
  streaming: {
    setPendingUserMessageId: Dispatch<React.SetStateAction<string | null>>
  }
}

export function useApplyResumeSnapshot({
  dispatch,
  refs,
  streaming,
}: UseResumeSnapshotOptions) {
  const { activeConversationIdRef } = refs
  const { setPendingUserMessageId } = streaming

  return useCallback(
    (args: { conversationId: string; activeRun: ActiveRunSnapshot }) => {
      dispatch({
        type: 'hydrate-conversation',
        conversationId: args.conversationId,
        activeRun:
          args.activeRun?.uiVisibility === 'hidden' ? null : args.activeRun,
      })
      if (args.conversationId === activeConversationIdRef.current) {
        setPendingUserMessageId(
          args.activeRun?.uiVisibility === 'hidden'
            ? null
            : (args.activeRun?.userMessageId ?? null),
        )
      }
    },
    [activeConversationIdRef, dispatch, setPendingUserMessageId],
  )
}
