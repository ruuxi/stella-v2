import { createRequire } from 'node:module';
import { areGlobalShortcutsSuspended } from '../ipc/global-shortcuts.js';
// uiohook-napi is a native addon (node-gyp-build prebuild probing + dlopen).
// A static import loaded it before `ready` on every launch and platform, yet
// the hook only ever starts on macOS with Accessibility granted, after the
// window is up. Load it on first start instead.
const requireFromMain = createRequire(import.meta.url);
let uiohookInstance = null;
const getUiohook = () => {
    uiohookInstance ??= requireFromMain('uiohook-napi').uIOhook;
    return uiohookInstance;
};
const LEFT_ALT = 56;
const RIGHT_ALT = 3640;
const ALT_KEYCODES = new Set([LEFT_ALT, RIGHT_ALT]);
/**
 * Longest press that still counts as a tap. Anything held longer is treated as
 * the user reaching for a chord they never completed, not as a request.
 */
const ALT_TAP_MAX_MS = 400;
/**
 * Owns the low-level keyboard hook that turns a bare Option tap into the
 * dictation toggle (Electron's globalShortcut cannot register a lone
 * modifier). Only the tap gesture is recognised: Option pressed and released
 * on its own within `ALT_TAP_MAX_MS`. Any chord, ordinary key, or click while
 * Option is down cancels the gesture so normal keyboard use is untouched.
 */
export class MouseHookManager {
    started = false;
    uiohookListenersAttached = false;
    uiohookStarted = false;
    pressedKeycodes = new Set();
    /** Timestamp of the bare Option press being tracked, or null. */
    altDownAt = null;
    handlers = null;
    setDictationTapHandlers(handlers) {
        this.handlers = handlers;
    }
    start() {
        if (this.started)
            return;
        this.started = true;
        try {
            this.attachUiohookListeners();
            if (!this.uiohookStarted) {
                getUiohook().start();
                this.uiohookStarted = true;
            }
        }
        catch (error) {
            console.error('[mouse-hook] Failed to start input hook:', error.message);
        }
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        this.altDownAt = null;
        this.pressedKeycodes.clear();
        if (this.uiohookStarted) {
            try {
                getUiohook().stop();
            }
            catch (error) {
                console.warn('[mouse-hook] Failed to stop input hook:', error.message);
            }
            this.uiohookStarted = false;
        }
        this.detachUiohookListeners();
    }
    isHookRunning() {
        return this.uiohookStarted;
    }
    attachUiohookListeners() {
        if (this.uiohookListenersAttached)
            return;
        const uiohook = getUiohook();
        this.uiohookListenersAttached = true;
        uiohook.on('keydown', this.handleKeydown);
        uiohook.on('keyup', this.handleKeyup);
        uiohook.on('mousedown', this.handleMousedown);
    }
    detachUiohookListeners() {
        if (!this.uiohookListenersAttached)
            return;
        this.uiohookListenersAttached = false;
        const uiohook = getUiohook();
        uiohook.off('keydown', this.handleKeydown);
        uiohook.off('keyup', this.handleKeyup);
        uiohook.off('mousedown', this.handleMousedown);
    }
    handleKeydown = (event) => {
        if (!this.started)
            return;
        if (areGlobalShortcutsSuspended()) {
            this.altDownAt = null;
            this.pressedKeycodes.clear();
            return;
        }
        const wasAlreadyDown = this.pressedKeycodes.has(event.keycode);
        const otherKeyHeld = [...this.pressedKeycodes].some((keycode) => !ALT_KEYCODES.has(keycode));
        this.pressedKeycodes.add(event.keycode);
        if (!ALT_KEYCODES.has(event.keycode)) {
            // Option + anything is a chord, never a dictation tap.
            this.altDownAt = null;
            return;
        }
        if (this.handlers?.isEnabled() !== true ||
            this.altDownAt !== null ||
            wasAlreadyDown ||
            otherKeyHeld) {
            return;
        }
        this.altDownAt = Date.now();
    };
    handleKeyup = (event) => {
        if (!this.started)
            return;
        if (areGlobalShortcutsSuspended()) {
            this.altDownAt = null;
            this.pressedKeycodes.clear();
            return;
        }
        this.pressedKeycodes.delete(event.keycode);
        if (!ALT_KEYCODES.has(event.keycode) || this.altDownAt === null) {
            return;
        }
        const durationMs = Date.now() - this.altDownAt;
        this.altDownAt = null;
        if (durationMs <= ALT_TAP_MAX_MS) {
            this.handlers?.toggle();
        }
    };
    handleMousedown = () => {
        if (!this.started)
            return;
        this.altDownAt = null;
    };
}
