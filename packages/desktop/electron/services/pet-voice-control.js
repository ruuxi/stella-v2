import { IPC_PET_SET_OPEN } from "@stella/contracts/desktop/ipc-channels";
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

export const togglePetVoice = (deps) => {
    const { uiStateService: ui, getPetController, windowManager } = deps;
    if (ui.state.isVoiceRtcActive) {
        ui.deactivateVoiceModes();
        return;
    }

    const pet = getPetController();
    if (pet) {
        petOpenedByCurrentVoiceSession = !pet.isVisible();
        pet.setOpen(true);

        broadcastPetOpen(windowManager, true);
    }
    else {
        petOpenedByCurrentVoiceSession = false;
    }
    ui.activateVoiceRtc(ui.state.conversationId);
};
