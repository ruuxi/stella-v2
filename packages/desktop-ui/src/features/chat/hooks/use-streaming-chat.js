import { useLocale } from '@/shared/i18n';
import { useTierRestrictedModelToast } from './use-tier-restricted-model-toast';
import { useStreamingChatCore, } from './use-streaming-chat-core';
export function useStreamingChat({ conversationId, persistedMessages, }) {
    const locale = useLocale();
    const notifyTierRestrictedModel = useTierRestrictedModelToast();
    return useStreamingChatCore({
        conversationId,
        locale,
        notifyTierRestrictedModel,
        persistedMessages,
    });
}
