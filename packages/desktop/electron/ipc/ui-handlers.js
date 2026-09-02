import { app, BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE } from "@stella/contracts/desktop/ipc-channels";
export const registerUiHandlers = (options) => {
    ipcMain.on("app:setReady", (_event, ready) => {
        options.setAppReady(!!ready);
    });
    ipcMain.on("window:minimize", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.minimize();
    });
    ipcMain.on("window:maximize", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win?.isMaximized()) {
            win.unmaximize();
        }
        else {
            win?.maximize();
        }
    });
    ipcMain.on("window:close", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return;
        win.close();
    });
    ipcMain.handle("window:isMaximized", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return win?.isMaximized() ?? false;
    });
    ipcMain.on(IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE, (event, visible) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || process.platform !== "darwin")
            return;
        win.setWindowButtonVisibility(Boolean(visible));
    });
    ipcMain.handle("ui:getState", () => options.uiState);
    ipcMain.handle("ui:setState", (event, partial) => {
        if (!options.assertPrivilegedSender(event, "ui:setState"))
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
    ipcMain.on("window:show", (event) => {
        if (!options.assertPrivilegedSender(event, "window:show"))
            return;
        options.windowManager.showWindow();
    });
    ipcMain.on("app:reload", (event) => {
        if (!options.assertPrivilegedSender(event, "app:reload"))
            return;
        options.windowManager.reloadFullWindow();
    });
    // Used by the static launch splash (`desktop/index.html`) when the renderer
    // has been stuck on the splash long enough that a plain reload is unlikely
    // to help. Packaged builds re-exec Electron; dev builds ask the supervisor
    // to spawn a fresh Electron process without tearing down Vite.
    ipcMain.on("app:relaunch", (event) => {
        if (!options.assertPrivilegedSender(event, "app:relaunch"))
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
        app.relaunch();
        app.quit();
    });
};
