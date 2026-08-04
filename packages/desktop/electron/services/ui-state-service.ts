export class UiStateService {
    state = {
        mode: 'chat',
        conversationId: null,
        isVoiceRtcActive: false,
    };
    deps = null;
    voiceActiveListeners = new Set();
    bind(deps) {
        this.deps = deps;
    }
    update(partial) {
        Object.assign(this.state, partial);
        this.broadcast();
    }
    broadcast() {
        if (!this.deps)
            return;
        const targets = this.deps.broadcastTarget.getAllWindows();
        for (const window of targets) {
            window.webContents.send('ui:state', this.state);
        }
        this.deps.getBroadcastToMobile?.()?.('ui:state', this.state);
    }
    onVoiceActiveChanged(listener) {
        this.voiceActiveListeners.add(listener);
        return () => {
            this.voiceActiveListeners.delete(listener);
        };
    }
    notifyVoiceActive() {
        for (const listener of this.voiceActiveListeners) {
            try {
                listener(this.state.isVoiceRtcActive);
            }
            catch (error) {
                console.warn('[ui-state] voice listener threw:', error);
            }
        }
    }
    deactivateVoiceModes() {
        if (!this.state.isVoiceRtcActive) {
            return false;
        }
        this.state.isVoiceRtcActive = false;
        this.broadcast();
        this.notifyVoiceActive();
        return true;
    }
    activateVoiceRtc(conversationId) {
        const wasActive = this.state.isVoiceRtcActive;
        this.state.isVoiceRtcActive = true;
        this.state.mode = 'voice';
        this.state.conversationId = conversationId ?? this.state.conversationId;
        this.broadcast();
        if (!wasActive)
            this.notifyVoiceActive();
    }
}
