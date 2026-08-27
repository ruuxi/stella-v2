import type { MessageRecord } from '@stella/contracts/local-chat'
import { useLocale } from '@/shared/i18n'
import { useTierRestrictedModelToast } from './use-tier-restricted-model-toast'
import {
  useStreamingChatCore,
} from './use-streaming-chat-core'
import type { QueuedUserMessage } from './queued-user-messages'

export type { QueuedUserMessage }

type UseStreamingChatOptions = {
  conversationId: string | null

  persistedMessages: MessageRecord[]
}

export function useStreamingChat({
  conversationId,
  persistedMessages,
}: UseStreamingChatOptions) {
  const locale = useLocale()
  const notifyTierRestrictedModel = useTierRestrictedModelToast()

  return useStreamingChatCore({
    conversationId,
    locale,
    notifyTierRestrictedModel,
    persistedMessages,
  })
}
