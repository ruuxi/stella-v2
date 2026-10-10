import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import {
  IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE,
  IPC_APP_SET_READY,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_MAXIMIZE,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_IS_MAXIMIZED,
  IPC_UI_GET_STATE,
  IPC_UI_SET_STATE,
  IPC_WINDOW_SHOW,
  IPC_APP_RELOAD,
  IPC_APP_RELAUNCH,
} from "@stella/contracts/desktop/ipc-channels";
import { relaunchApp } from "../launcher-client.js";
import {
  handleIpc,
  onIpc,
} from "./typed-ipc.js";
export const registerUiHandlers = (options) => {
    onIpc(IPC_APP_SET_READY, (_event, ready) => {
        options.setAppReady(!!ready);
    });
    onIpc(IPC_WINDOW_MINIMIZE, (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.minimize();
    });
    onIpc(IPC_WINDOW_MAXIMIZE, (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win?.isMaximized()) {
            win.unmaximize();
        }
        else {
            win?.maximize();
        }
    });
    onIpc(IPC_WINDOW_CLOSE, (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return;
        win.close();
    });
    handleIpc(IPC_WINDOW_IS_MAXIMIZED, (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win?.isMaximized() ?? false;
    });
    onIpc(IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE, (event, visible) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || process.platform !== "darwin")
            return;
        win.setWindowButtonVisibility(Boolean(visible));
    });
    handleIpc(IPC_UI_GET_STATE, () => options.uiState);
    handleIpc(IPC_UI_SET_STATE, (event, partial) => {
        if (!options.assertPrivilegedSender(event, IPC_UI_SET_STATE))
            return options.uiState;
        const { isVoiceRtcActive, ...rest } = partial;
        if (isVoiceRtcActive !== undefined) {
            if (isVoiceRtcActive) {
                options.uiState.isVoiceRtcActive = true;
            }
            else {
                options.deactivateVoiceModes();
            }
        }
        if (Object.keys(rest).length > 0) {
            options.updateUiState(rest);
        }
        if (isVoiceRtcActive !== undefined) {
            if (isVoiceRtcActive) {
                options.broadcastUiState();
            }
        }
        return options.uiState;
    });
    onIpc(IPC_WINDOW_SHOW, (event) => {
        if (!options.assertPrivilegedSender(event, IPC_WINDOW_SHOW))
            return;
        options.windowManager.showWindow();
    });
    onIpc(IPC_APP_RELOAD, (event) => {
        if (!options.assertPrivilegedSender(event, IPC_APP_RELOAD))
            return;
        options.windowManager.reloadFullWindow();
    });
    // Used by the static launch splash (`desktop/index.html`) when the renderer
    // has been stuck on the splash long enough that a plain reload is unlikely
    // to help. Packaged builds re-exec Electron; dev builds ask the supervisor
    // to spawn a fresh Electron process without tearing down Vite.
    onIpc(IPC_APP_RELAUNCH, (event) => {
        if (!options.assertPrivilegedSender(event, IPC_APP_RELAUNCH))
            return;
        const devRestartRequestFile = process.env.STELLA_DEV_RESTART_REQUEST_FILE;
        if (process.env.NODE_ENV === "development" && devRestartRequestFile) {
            try {
                writeFileSync(devRestartRequestFile, String(Date.now()), "utf8");
            }
            catch (error) {
                console.error("Failed to request dev relaunch:", error);
            }
            app.quit();
            return;
        }
        relaunchApp();
    });
};
