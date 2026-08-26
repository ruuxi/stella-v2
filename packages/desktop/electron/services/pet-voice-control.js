import { IPC_PET_SET_OPEN } from "@stella/contracts/desktop/ipc-channels";
import { selectedCloudConversationId } from "../cloud-conversation-mode.js";
let petOpenedByCurrentVoiceSession = false;
const broadcastPetOpen = (windowManager, open) => {
    for (const window of windowManager.getAllWindows()) {
        if (window.isDestroyed())
            continue;
        window.webContents.send(IPC_PET_SET_OPEN, open);
    }
};
export const cleanupPetVoiceSession = ({ getPetController, windowManager, }) => {
    if (!petOpenedByCurrentVoiceSession)
        return;
    petOpenedByCurrentVoiceSession = false;
    getPetController()?.setOpen(false);
    broadcastPetOpen(windowManager, false);
};
/**
 * Single source of truth for "go to voice mode now".
 *
 * Voice no longer has its own creature overlay — instead, we always
 * open the floating pet (whose sprite animates listening / speaking
 * from `voice:runtimeState`) and toggle the realtime voice session.
 * Every activation path routes through this function so behavior stays
 * identical.
 */
export const togglePetVoice = (deps) => {
    const { uiStateService: ui, getPetController, windowManager } = deps;
    if (ui.state.isVoiceRtcActive) {
        ui.deactivateVoiceModes();
        return;
    }
    const conversationId = selectedCloudConversationId(ui.state.conversationId);
    if (!conversationId) {
        // The renderer publishes only an owner-validated cloud id. Voice waits
        // for that selection instead of inventing a local/default conversation.
        return;
    }
    // Show the pet first so the user has something to look at the
    // moment voice activates (and so the renderer's voice-state
    // subscription is mounted by the time runtime events start
    // arriving).
    const pet = getPetController();
    if (pet) {
        petOpenedByCurrentVoiceSession = !pet.isVisible();
        pet.setOpen(true);
        // Broadcast so any other window's `pet:setOpen` subscribers
        // (e.g. the settings page toggle button) see the new state.
        broadcastPetOpen(windowManager, true);
    }
    else {
        petOpenedByCurrentVoiceSession = false;
    }
    ui.activateVoiceRtc(conversationId);
};
