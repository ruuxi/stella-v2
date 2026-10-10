/**
 * Dictation IPC handlers.
 *
 * Owns the global speech-to-text shortcut. Every trigger is toggle-based: one
 * press starts recording, the next finishes it. Where the transcript lands
 * depends on focus — the full shell's composer when Stella is frontmost,
 * otherwise the floating companion, which is summoned if it is not showing
 * and sends the transcript as a message when the shortcut stops it.
 *
 * Bare Option/Alt cannot be registered through Electron's globalShortcut, so
 * on macOS a short tap of Option is recognised by the low-level input hook
 * (see input/mouse-hook.js) and routed to the same toggle.
 */
import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { getDictationSoundEffectsEnabled, loadLocalPreferences, saveLocalPreferences, } from "@stella/runtime/kernel/preferences/local-preferences";
import { runNativeHelper } from "../native-helper.js";
import { hasOpenRouterDictationKey, transcribeWithOpenRouter, } from "../services/dictation-openrouter.js";
import { applyShortcutRegistration, } from "./shortcut-registration.js";
import {
  IPC_DICTATION_TOGGLE,
  IPC_DICTATION_SET_SHORTCUT,
  IPC_DICTATION_GET_SHORTCUT,
  IPC_DICTATION_HAS_OPENROUTER_KEY,
  IPC_DICTATION_TRANSCRIBE_WITH_OPENROUTER,
  IPC_DICTATION_CANCEL_OPENROUTER,
  IPC_DICTATION_GET_SOUND_EFFECTS_ENABLED,
  IPC_DICTATION_SET_SOUND_EFFECTS_ENABLED,
  IPC_DICTATION_ACTIVE_CHANGED,
  IPC_DICTATION_PLAY_SOUND,
} from "@stella/contracts/desktop/ipc-channels";
import {
  handleIpc,
  onIpc,
} from "./typed-ipc.js";
const DEFAULT_DICTATION_SHORTCUT = "Alt";
const DEFAULT_NON_MAC_DICTATION_SHORTCUT = "Control+M";
const LEGACY_DEFAULT_DICTATION_SHORTCUT = "Control+M";
/** Bare Option on macOS; recognised as a tap by the input hook. */
const TAP_DICTATION_SHORTCUT = "Alt";
const DICTATION_SOUND_VOLUME_BY_SOUND = {
    startRecording: "0.2",
    stopRecording: "0.45",
    cancel: "0.35",
};
const DICTATION_START_SOUND_MUTE_DELAY_MS = 220;
const DICTATION_BRIDGE_TIMEOUT_MS = 2_000;
const dictationBridgeIsSupported = () => process.platform === "darwin" || process.platform === "win32";
const isUsableWindow = (window) => Boolean(window && !window.isDestroyed());
/** The app runs from its source tree, which carries the sounds. */
const soundPath = (stellaAppDir, sound) => path.join(stellaAppDir, "packages", "desktop", "resources", "audio", `${sound}.mp3`);
const playDictationSound = (stellaAppDir, sound) => {
    if (process.platform !== "darwin")
        return;
    execFile("/usr/bin/afplay", ["-v", DICTATION_SOUND_VOLUME_BY_SOUND[sound], soundPath(stellaAppDir, sound)], (error) => {
        if (error) {
            console.debug("[dictation] sound failed:", error.message);
        }
    });
};
export const registerDictationHandlers = (options) => {
    const { windowManager } = options;
    let currentShortcut = "";
    let mutedOutputVolume = null;
    let mutedOutputPreviousMuted = null;
    let outputMutePromise = null;
    let outputMuteActive = false;
    let outputMuteDelayTimer = null;
    const activeDictationSources = new Set();
    let dictationActive = false;
    const areDictationSoundsEnabled = () => {
        const stellaDataDir = options.getStellaDataDir();
        return stellaDataDir ? getDictationSoundEffectsEnabled(stellaDataDir) : true;
    };
    const playEnabledDictationSound = (sound) => {
        if (!areDictationSoundsEnabled())
            return;
        playDictationSound(options.stellaAppDir, sound);
    };
    // ── System audio ducking (macOS/Windows native helper) ─────────────────
    // Recording while Stella (or anything else) plays audio pollutes the
    // transcript, so system output is muted for the duration of a recording
    // and restored afterwards. Driven off the renderer's active/inactive
    // reports so every dictation surface gets it.
    const muteOutputForDictation = () => {
        if (!dictationBridgeIsSupported())
            return;
        if (outputMuteDelayTimer) {
            clearTimeout(outputMuteDelayTimer);
            outputMuteDelayTimer = null;
        }
        if (mutedOutputVolume !== null) {
            outputMuteActive = true;
            return;
        }
        outputMuteActive = true;
        if (outputMutePromise)
            return;
        outputMutePromise = runNativeHelper("dictation_bridge", ["mute-output"], {
            timeout: DICTATION_BRIDGE_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
            onError: (error) => {
                console.debug("[dictation] output mute failed:", error.message);
            },
        })
            .then((raw) => {
            if (!raw)
                return;
            const result = JSON.parse(raw);
            if (result.ok === true && typeof result.previousVolume === "number") {
                mutedOutputVolume = result.previousVolume;
                mutedOutputPreviousMuted =
                    typeof result.previousMuted === "boolean"
                        ? result.previousMuted
                        : null;
                if (!outputMuteActive) {
                    restoreOutputAfterDictation();
                }
            }
        })
            .catch((error) => {
            console.debug("[dictation] output mute failed:", error);
        })
            .finally(() => {
            outputMutePromise = null;
        });
    };
    /** Mute after the start cue has had a moment to play. */
    const muteOutputForDictationAfterStartCue = () => {
        if (!dictationBridgeIsSupported())
            return;
        outputMuteActive = true;
        if (mutedOutputVolume !== null || outputMutePromise)
            return;
        if (outputMuteDelayTimer) {
            clearTimeout(outputMuteDelayTimer);
        }
        outputMuteDelayTimer = setTimeout(() => {
            outputMuteDelayTimer = null;
            if (!outputMuteActive)
                return;
            muteOutputForDictation();
        }, DICTATION_START_SOUND_MUTE_DELAY_MS);
    };
    const restoreOutputAfterDictation = () => {
        if (!dictationBridgeIsSupported())
            return;
        if (outputMuteDelayTimer) {
            clearTimeout(outputMuteDelayTimer);
            outputMuteDelayTimer = null;
        }
        outputMuteActive = false;
        const previousVolume = mutedOutputVolume;
        const previousMuted = mutedOutputPreviousMuted;
        mutedOutputVolume = null;
        mutedOutputPreviousMuted = null;
        if (typeof previousVolume !== "number")
            return;
        const args = ["restore-output", String(previousVolume)];
        if (typeof previousMuted === "boolean") {
            args.push(previousMuted ? "true" : "false");
        }
        runNativeHelper("dictation_bridge", args, {
            timeout: DICTATION_BRIDGE_TIMEOUT_MS,
            maxBuffer: 64 * 1024,
            onError: (error) => {
                console.debug("[dictation] output restore failed:", error.message);
            },
        }).catch((error) => {
            console.debug("[dictation] output restore failed:", error);
        });
    };
    const setDictationSourceActive = (source, active) => {
        const previous = dictationActive;
        if (active) {
            activeDictationSources.add(source);
        }
        else {
            activeDictationSources.delete(source);
        }
        dictationActive = activeDictationSources.size > 0;
        if (dictationActive !== previous) {
            if (dictationActive) {
                muteOutputForDictationAfterStartCue();
            }
            else {
                restoreOutputAfterDictation();
            }
            options.onDictationActiveChanged?.(dictationActive);
        }
    };
    const isRendererRecording = (window) => isUsableWindow(window) &&
        activeDictationSources.has(`renderer:${window.webContents.id}`);
    const pickFocusedStellaWindow = () => {
        // Only the full shell counts as "in app". Anything else — another app,
        // the desktop, or the companion itself — routes to the companion.
        if (process.platform === "darwin" && !app.isActive())
            return null;
        const focused = BrowserWindow.getFocusedWindow();
        if (!isUsableWindow(focused))
            return null;
        if (focused === windowManager.getFullWindow())
            return focused;
        return null;
    };
    const toggleDictation = () => {
        const target = pickFocusedStellaWindow();
        if (target) {
            playEnabledDictationSound(isRendererRecording(target) ? "stopRecording" : "startRecording");
            target.webContents.send(IPC_DICTATION_TOGGLE, { startId: randomUUID() });
            return;
        }
        const companion = options.getCompanionController();
        if (!companion)
            return;
        playEnabledDictationSound(isRendererRecording(companion.getPanelWindow()) ? "stopRecording" : "startRecording");
        // `show` resolves once the companion renderer is mounted, so the toggle
        // reaches a listening `useDictation` even on a cold first summon.
        void companion
            .show({ focus: true })
            .then((shown) => {
            if (!shown)
                return;
            companion.sendToPanel(IPC_DICTATION_TOGGLE, {
                startId: randomUUID(),
                source: "companion",
            });
        })
            .catch((error) => {
            console.warn("[dictation] companion summon failed:", error);
        });
    };
    const applyDictationShortcutRegistration = (requestedShortcut) => {
        if (currentShortcut && currentShortcut !== TAP_DICTATION_SHORTCUT) {
            applyShortcutRegistration({
                label: "Dictation",
                requestedShortcut: "",
                currentShortcut,
                callback: toggleDictation,
                onActiveShortcutChange: (shortcut) => {
                    currentShortcut = shortcut;
                },
            });
        }
        if (requestedShortcut === TAP_DICTATION_SHORTCUT) {
            currentShortcut = requestedShortcut;
            return {
                ok: true,
                requestedShortcut,
                activeShortcut: requestedShortcut,
            };
        }
        return applyShortcutRegistration({
            label: "Dictation",
            requestedShortcut,
            currentShortcut: currentShortcut === TAP_DICTATION_SHORTCUT ? "" : currentShortcut,
            callback: toggleDictation,
            onActiveShortcutChange: (shortcut) => {
                currentShortcut = shortcut;
            },
        });
    };
    const loadConfiguredShortcut = () => {
        const platformDefault = process.platform === "darwin"
            ? DEFAULT_DICTATION_SHORTCUT
            : DEFAULT_NON_MAC_DICTATION_SHORTCUT;
        const stellaDataDir = options.getStellaDataDir();
        if (!stellaDataDir)
            return platformDefault;
        const shortcut = loadLocalPreferences(stellaDataDir).dictationShortcut;
        if (process.platform !== "darwin" && shortcut === TAP_DICTATION_SHORTCUT) {
            return DEFAULT_NON_MAC_DICTATION_SHORTCUT;
        }
        return shortcut === LEGACY_DEFAULT_DICTATION_SHORTCUT
            ? platformDefault
            : shortcut;
    };
    const saveConfiguredShortcut = (shortcut) => {
        const stellaDataDir = options.getStellaDataDir();
        if (!stellaDataDir)
            return;
        const prefs = loadLocalPreferences(stellaDataDir);
        prefs.dictationShortcut = shortcut;
        saveLocalPreferences(stellaDataDir, prefs);
    };
    const initial = applyDictationShortcutRegistration(loadConfiguredShortcut());
    if (!initial.ok) {
        console.warn("[dictation]", initial.error);
    }
    handleIpc(IPC_DICTATION_SET_SHORTCUT, (_event, shortcut) => {
        const result = applyDictationShortcutRegistration(shortcut);
        if (!result.ok) {
            console.warn("[dictation]", result.error);
        }
        else {
            saveConfiguredShortcut(result.activeShortcut);
        }
        return result;
    });
    handleIpc(IPC_DICTATION_GET_SHORTCUT, () => currentShortcut);
    let openRouterTranscription = null;
    handleIpc(IPC_DICTATION_HAS_OPENROUTER_KEY, (event) => {
        if (!options.assertPrivilegedSender(event, IPC_DICTATION_HAS_OPENROUTER_KEY)) {
            throw new Error("Blocked untrusted dictation request.");
        }
        return hasOpenRouterDictationKey(options.getStellaDataDir());
    });
    handleIpc(IPC_DICTATION_TRANSCRIBE_WITH_OPENROUTER, async (event, payload) => {
        if (!options.assertPrivilegedSender(event, IPC_DICTATION_TRANSCRIBE_WITH_OPENROUTER)) {
            throw new Error("Blocked untrusted dictation request.");
        }
        const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
        const wav = payload?.wav;
        if (!requestId || (!(wav instanceof ArrayBuffer) && !(wav instanceof Uint8Array))) {
            throw new Error("Dictation audio was empty.");
        }
        if (openRouterTranscription) {
            throw new Error("Dictation is already transcribing a recording.");
        }
        const controller = new AbortController();
        openRouterTranscription = { requestId, controller };
        try {
            return await transcribeWithOpenRouter(options.getStellaDataDir(), wav, controller.signal);
        }
        finally {
            if (openRouterTranscription?.requestId === requestId)
                openRouterTranscription = null;
        }
    });
    onIpc(IPC_DICTATION_CANCEL_OPENROUTER, (event, payload) => {
        if (!options.assertPrivilegedSender(event, IPC_DICTATION_CANCEL_OPENROUTER))
            return;
        if (openRouterTranscription && openRouterTranscription.requestId === payload?.requestId) {
            openRouterTranscription.controller.abort();
            openRouterTranscription = null;
        }
    });
    handleIpc(IPC_DICTATION_GET_SOUND_EFFECTS_ENABLED, () => areDictationSoundsEnabled());
    handleIpc(IPC_DICTATION_SET_SOUND_EFFECTS_ENABLED, (_event, enabled) => {
        const nextEnabled = enabled === true;
        const stellaDataDir = options.getStellaDataDir();
        if (stellaDataDir) {
            const prefs = loadLocalPreferences(stellaDataDir);
            prefs.dictationSoundEffectsEnabled = nextEnabled;
            saveLocalPreferences(stellaDataDir, prefs);
        }
        return { enabled: nextEnabled };
    });
    onIpc(IPC_DICTATION_ACTIVE_CHANGED, (event, payload) => {
        const source = `renderer:${event.sender.id}`;
        setDictationSourceActive(source, payload?.active === true);
        if (payload?.active === true) {
            event.sender.once("destroyed", () => setDictationSourceActive(source, false));
        }
    });
    onIpc(IPC_DICTATION_PLAY_SOUND, (_event, payload) => {
        if (payload?.sound !== "startRecording" &&
            payload?.sound !== "stopRecording" &&
            payload?.sound !== "cancel") {
            return;
        }
        playEnabledDictationSound(payload.sound);
    });
    return {
        /** Whether bare-Option taps should drive dictation (macOS only). */
        isEnabled: () => dictationBridgeIsSupported() &&
            process.platform === "darwin" &&
            currentShortcut === TAP_DICTATION_SHORTCUT,
        toggle: toggleDictation,
    };
};
