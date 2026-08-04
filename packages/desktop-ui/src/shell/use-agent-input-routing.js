import { useCallback, useEffect, useRef } from 'react';
const NO_OP = () => { };
/**
 * Three thin sugar wrappers around `useStreamingChat`'s `sendMessage`
 * that the shell uses to fan out IPC / window-event sends into the
 * conversation. Routes messages with `targetAgentId` to that agent's
 * input bus instead of the active conversation.
 */
export function useAgentInputRouting({ activeConversationId, sendMessage, enterChatSurfaceForInteraction, }) {
    const sendMessageRef = useRef(sendMessage);
    useEffect(() => {
        sendMessageRef.current = sendMessage;
    }, [sendMessage]);
    const sendContextlessMessage = useCallback((text, metadata) => {
        enterChatSurfaceForInteraction();
        void sendMessageRef.current({
            text,
            selectedText: null,
            chatContext: null,
            onClear: NO_OP,
            metadata,
        });
    }, [enterChatSurfaceForInteraction]);
    const sendAgentInputMessage = useCallback((detail, metadata) => {
        const threadId = detail.targetAgentId?.trim();
        if (!threadId ||
            !activeConversationId ||
            !window.electronAPI?.agent?.sendInput) {
            sendContextlessMessage(detail.text, metadata);
            return;
        }
        enterChatSurfaceForInteraction();
        void window.electronAPI.agent
            .sendInput({
            conversationId: activeConversationId,
            threadId,
            message: detail.text,
            ...(metadata ? { metadata } : {}),
        })
            .catch((error) => {
            console.error('Failed to send routed agent input:', error.message);
            sendContextlessMessage(detail.text, metadata);
        });
    }, [activeConversationId, enterChatSurfaceForInteraction, sendContextlessMessage]);
    const sendMessageWithContext = useCallback((text, chatCtx, selectedTextCtx) => {
        enterChatSurfaceForInteraction();
        void sendMessageRef.current({
            text,
            selectedText: selectedTextCtx ?? null,
            chatContext: chatCtx ?? null,
            onClear: NO_OP,
        });
    }, [enterChatSurfaceForInteraction]);
    return {
        sendContextlessMessage,
        sendAgentInputMessage,
        sendMessageWithContext,
    };
}
