import { ipcMain } from "electron";
import { IPC_PET_OPEN_CHAT, IPC_PET_GET_STATE, IPC_PET_MOVE_WINDOW, IPC_PET_REQUEST_DICTATION, IPC_PET_REQUEST_VOICE, IPC_PET_SEND_MESSAGE, IPC_PET_SET_COMPOSER_ACTIVE, IPC_PET_SET_INTERACTIVE, IPC_PET_SET_OPEN, IPC_PET_STATUS, } from "@stella/contracts/desktop/ipc-channels";
const DEFAULT_STATUS = {
    state: "idle",
    title: "",
    message: "",
    isLoading: false,
};
let latestStatus = DEFAULT_STATUS;
/**
 * Single live registration. We refuse to register twice because the
 * first call already grabbed `ipcMain.handle("pet:getState")` — calling
 * `handle` a second time on the same channel throws.
 */
let activeDisposer = null;
const PET_OVERLAY_STATES = new Set([
    "idle",
    "running",
    "waiting",
    "review",
    "failed",
    "waving",
]);
const isPetOverlayStatus = (value) => {
    if (typeof value !== "object" || value === null)
        return false;
    const candidate = value;
    return (typeof candidate.state === "string" &&
        PET_OVERLAY_STATES.has(candidate.state) &&
        typeof candidate.title === "string" &&
        typeof candidate.message === "string" &&
        typeof candidate.isLoading === "boolean");
};
const broadcast = (windowManager, channel, payload) => {
    for (const window of windowManager.getAllWindows()) {
        if (window.isDestroyed())
            continue;
        window.webContents.send(channel, payload);
    }
};
/**
 * Pet IPC handlers — main process owns the canonical visibility +
 * status broadcast so any window can toggle the pet and any window can
 * push status updates that every renderer (including the dedicated
 * pet window) sees instantly. Mirrors the same fan-out pattern
 * UiStateService uses.
 *
 * Returns a disposer that removes every registered handler/listener
 * and resets the module-level state caches. The bootstrap quit-cleanup
 * calls it on app shutdown; it's also safe to call manually for
 * testing or before re-registering on a fresh `ipcMain` (e.g. in a
 * test harness). Calling `registerPetHandlers` while a previous
 * registration is still live is treated as a programmer error and
 * throws — `ipcMain.handle` would throw on its own anyway because
 * `pet:getState` is an `invoke` channel that can only have one
 * handler.
 */
export const registerPetHandlers = ({ windowManager, getPetController, toggleVoiceRtc, startPetDictation, assertPrivilegedSender, }) => {
    if (activeDisposer) {
        throw new Error("registerPetHandlers called twice; dispose the previous registration first");
    }
    // The pet's open state is whatever the controller's window
    // currently is. Keeping it derived (rather than caching a separate
    // `petOpen` flag) means `setOpen` calls coming from outside the
    // pet IPC plumbing — e.g. the centralized voice toggle that opens
    // the pet alongside activating voice — stay in sync without an
    // extra writeback path.
    const isPetOpen = () => Boolean(getPetController()?.isVisible());
    const onGetState = () => ({
        open: isPetOpen(),
        status: latestStatus,
    });
    const onSetOpen = (event, open) => {
        if (!assertPrivilegedSender(event, IPC_PET_SET_OPEN))
            return;
        const next = Boolean(open);
        getPetController()?.setOpen(next);
        broadcast(windowManager, IPC_PET_SET_OPEN, next);
        if (next) {
            broadcast(windowManager, IPC_PET_STATUS, latestStatus);
        }
    };
    const onMoveWindow = (event, payload) => {
        if (!assertPrivilegedSender(event, IPC_PET_MOVE_WINDOW))
            return;
        if (typeof payload !== "object" || payload === null)
            return;
        const candidate = payload;
        if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
            return;
        }
        if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y))
            return;
        getPetController()?.setWindowPosition(candidate.x, candidate.y);
    };
    const onSetComposerActive = (event, active) => {
        if (!assertPrivilegedSender(event, IPC_PET_SET_COMPOSER_ACTIVE))
            return;
        getPetController()?.setComposerActive(Boolean(active));
    };
    const onSetInteractive = (event, active) => {
        if (!assertPrivilegedSender(event, IPC_PET_SET_INTERACTIVE))
            return;
        getPetController()?.setInteractive(Boolean(active));
    };
    const onRequestVoice = (event) => {
        if (!assertPrivilegedSender(event, IPC_PET_REQUEST_VOICE))
            return;
        toggleVoiceRtc();
    };
    const onRequestDictation = (event) => {
        if (!assertPrivilegedSender(event, IPC_PET_REQUEST_DICTATION))
            return;
        startPetDictation();
    };
    const onStatus = (event, status) => {
        if (!assertPrivilegedSender(event, IPC_PET_STATUS))
            return;
        if (!isPetOverlayStatus(status))
            return;
        latestStatus = status;
        broadcast(windowManager, IPC_PET_STATUS, status);
    };
    const onOpenChat = (event) => {
        if (!assertPrivilegedSender(event, IPC_PET_OPEN_CHAT))
            return;
        windowManager.showWindow();
        const fullWindow = windowManager.getFullWindow();
        if (fullWindow && !fullWindow.isDestroyed()) {
            fullWindow.webContents.send("chat:openSidebar");
        }
    };
    const onSendMessage = (event, text) => {
        if (!assertPrivilegedSender(event, IPC_PET_SEND_MESSAGE))
            return;
        if (typeof text !== "string" || text.trim().length === 0)
            return;
        const fullWindow = windowManager.getFullWindow();
        if (fullWindow && !fullWindow.isDestroyed()) {
            fullWindow.webContents.send(IPC_PET_SEND_MESSAGE, text);
        }
    };
    ipcMain.handle(IPC_PET_GET_STATE, onGetState);
    ipcMain.on(IPC_PET_SET_OPEN, onSetOpen);
    ipcMain.on(IPC_PET_MOVE_WINDOW, onMoveWindow);
    ipcMain.on(IPC_PET_SET_COMPOSER_ACTIVE, onSetComposerActive);
    ipcMain.on(IPC_PET_SET_INTERACTIVE, onSetInteractive);
    ipcMain.on(IPC_PET_REQUEST_VOICE, onRequestVoice);
    ipcMain.on(IPC_PET_REQUEST_DICTATION, onRequestDictation);
    ipcMain.on(IPC_PET_STATUS, onStatus);
    ipcMain.on(IPC_PET_OPEN_CHAT, onOpenChat);
    ipcMain.on(IPC_PET_SEND_MESSAGE, onSendMessage);
    const dispose = () => {
        if (activeDisposer !== dispose)
            return;
        activeDisposer = null;
        ipcMain.removeHandler(IPC_PET_GET_STATE);
        ipcMain.removeListener(IPC_PET_SET_OPEN, onSetOpen);
        ipcMain.removeListener(IPC_PET_MOVE_WINDOW, onMoveWindow);
        ipcMain.removeListener(IPC_PET_SET_COMPOSER_ACTIVE, onSetComposerActive);
        ipcMain.removeListener(IPC_PET_SET_INTERACTIVE, onSetInteractive);
        ipcMain.removeListener(IPC_PET_REQUEST_VOICE, onRequestVoice);
        ipcMain.removeListener(IPC_PET_REQUEST_DICTATION, onRequestDictation);
        ipcMain.removeListener(IPC_PET_STATUS, onStatus);
        ipcMain.removeListener(IPC_PET_OPEN_CHAT, onOpenChat);
        ipcMain.removeListener(IPC_PET_SEND_MESSAGE, onSendMessage);
        latestStatus = DEFAULT_STATUS;
    };
    activeDisposer = dispose;
    return dispose;
};
/** Re-broadcast for cases (e.g. main-driven dismissal) where the renderer
 * isn't the originator. Kept tiny so the bootstrap layer can call it from
 * lifecycle hooks without re-importing the IPC constants. */
export const broadcastPetSetOpen = (windowManager, open) => {
    broadcast(windowManager, IPC_PET_SET_OPEN, open);
};
/** Convenience for testing or scheduled status pushes from main itself. */
export const broadcastPetStatus = (windowManager, status) => {
    if (!isPetOverlayStatus(status))
        return;
    broadcast(windowManager, IPC_PET_STATUS, status);
};
