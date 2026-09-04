import { selectedCloudConversationId } from "../cloud-conversation-mode.js";

/** Toggle realtime voice for the selected cloud conversation. */
export const toggleRealtimeVoice = ({ uiStateService }) => {
    if (uiStateService.state.isVoiceRtcActive) {
        uiStateService.deactivateVoiceModes();
        return;
    }
    const conversationId = selectedCloudConversationId(uiStateService.state.conversationId);
    if (!conversationId) {
        return;
    }
    uiStateService.activateVoiceRtc(conversationId);
};
