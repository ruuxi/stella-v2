import { useCallback, useEffect, useRef } from 'react'
import type { MessageMetadata } from '@/features/chat/lib/event-transforms'
import type { ChatContext } from '@/shared/types/electron'
import type { SendMessageArgs } from '@/features/chat/streaming/chat-types'
import type { StellaSendMessageDetail } from '@/shared/lib/stella-send-message'

const NO_OP = () => {}

type UseAgentInputRoutingOptions = {
  activeConversationId: string | null

  sendMessage: (args: SendMessageArgs) => Promise<boolean>
  enterChatSurfaceForInteraction: () => void
}

type UseAgentInputRoutingResult = {

  sendContextlessMessage: (text: string, metadata?: MessageMetadata) => void

  sendAgentInputMessage: (
    detail: StellaSendMessageDetail,
    metadata?: MessageMetadata,
  ) => void

  sendMessageWithContext: (
    text: string,
    chatCtx?: ChatContext | null,
    selectedTextCtx?: string | null,
  ) => Promise<boolean>
}

export function useAgentInputRouting({
  activeConversationId,
  sendMessage,
  enterChatSurfaceForInteraction,
}: UseAgentInputRoutingOptions): UseAgentInputRoutingResult {
  const sendMessageRef = useRef(sendMessage)
  useEffect(() => {
    sendMessageRef.current = sendMessage
  }, [sendMessage])

  const sendContextlessMessage = useCallback(
    (text: string, metadata?: MessageMetadata) => {
      void sendMessageRef
        .current({
          text,
          selectedText: null,
          chatContext: null,
          onClear: NO_OP,
          metadata,
        })
        .then((accepted) => {
          if (accepted) enterChatSurfaceForInteraction()
        })
    },
    [enterChatSurfaceForInteraction],
  )

  const sendAgentInputMessage = useCallback(
    (detail: StellaSendMessageDetail, metadata?: MessageMetadata) => {
      const threadId = detail.targetAgentId?.trim()
      if (
        !threadId ||
        !activeConversationId ||
        !window.electronAPI?.agent?.sendInput
      ) {
        sendContextlessMessage(detail.text, metadata)
        return
      }
      enterChatSurfaceForInteraction()
      void window.electronAPI.agent
        .sendInput({
          conversationId: activeConversationId,
          threadId,
          message: detail.text,
          ...(metadata ? { metadata } : {}),
        })
        .catch((error) => {
          console.error(
            'Failed to send routed agent input:',
            (error as Error).message,
          )
          sendContextlessMessage(detail.text, metadata)
        })
    },
    [activeConversationId, enterChatSurfaceForInteraction, sendContextlessMessage],
  )

  const sendMessageWithContext = useCallback(
    async (
      text: string,
      chatCtx?: ChatContext | null,
      selectedTextCtx?: string | null,
    ) => {
      const accepted = await sendMessageRef.current({
        text,
        selectedText: selectedTextCtx ?? null,
        chatContext: chatCtx ?? null,
        onClear: NO_OP,
      })
      if (accepted) enterChatSurfaceForInteraction()
      return accepted
    },
    [enterChatSurfaceForInteraction],
  )

  return {
    sendContextlessMessage,
    sendAgentInputMessage,
    sendMessageWithContext,
  }
}
