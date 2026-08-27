import { app, BrowserWindow, ipcMain, screen } from "electron";
import { writeFileSync } from "node:fs";
import { IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE } from "@stella/contracts/desktop/ipc-channels";
const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 940;
export const applyOnboardingWindowPresentation = ({ win, active, platform, getDisplayMatching, }) => {

    if (platform === "linux")
        return;
    const display = getDisplayMatching(win.getBounds());
    const work = display.workArea;
    if (active) {
        if (platform === "darwin") {

            win.setBounds(work, false);
            win.setWindowButtonVisibility(false);
        }
        else if (platform === "win32") {

            win.setBounds(work, false);
        }
        else {
            win.setBounds(display.bounds, false);
        }
    }
    else {
        if (platform === "darwin") {
            win.setWindowButtonVisibility(true);
        }
        const width = Math.min(DEFAULT_WIDTH, work.width);
        const height = Math.min(DEFAULT_HEIGHT, work.height);
        const x = work.x + Math.round((work.width - width) / 2);
        const y = work.y + Math.round((work.height - height) / 2);

        win.setBounds({ x, y, width, height }, platform === "darwin");
    }
};
export const registerUiHandlers = (options) => {
    const requirePrivileged = (event, channel) => {
        if (!options.assertPrivilegedSender(event, channel)) {
            throw new Error(`Blocked untrusted ${channel} request.`);
        }
    };
    const requirePrivilegedSender = (event, channel) => options.assertPrivilegedSender(event, channel);
    ipcMain.on("app:setReady", (event, ready) => {
        if (!requirePrivilegedSender(event, "app:setReady"))
            return;
        options.setAppReady(!!ready);
    });
    ipcMain.on("window:minimize", (event) => {
        if (!requirePrivilegedSender(event, "window:minimize"))
            return;
        const win = BrowserWindow.fromWebContents(event.sender);
        win?.minimize();
    });
    ipcMain.on("window:maximize", (event) => {
        if (!requirePrivilegedSender(event, "window:maximize"))
            return;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win?.isMaximized()) {
            win.unmaximize();
        }
        else {
            win?.maximize();
        }
    });
    ipcMain.on("window:close", (event) => {
        if (!requirePrivilegedSender(event, "window:close"))
            return;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return;
        win.close();
    });
    ipcMain.handle("window:isMaximized", (event) => {
        requirePrivileged(event, "window:isMaximized");
        const win = BrowserWindow.fromWebContents(event.sender);
        return win?.isMaximized() ?? false;
    });
    ipcMain.on(IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE, (event, visible) => {
        if (!requirePrivilegedSender(event, IPC_WINDOW_SET_NATIVE_BUTTONS_VISIBLE))
            return;
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || process.platform !== "darwin")
            return;
        win.setWindowButtonVisibility(Boolean(visible));
    });

    ipcMain.handle("window:setOnboardingPresentation", (event, active) => {
        requirePrivileged(event, "window:setOnboardingPresentation");
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return { ok: false };
        applyOnboardingWindowPresentation({
            win,
            active,
            platform: process.platform,
            getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
        });
        return { ok: true };
    });
    ipcMain.handle("ui:getState", (event) => {
        requirePrivileged(event, "ui:getState");
        return options.uiState;
    });
    ipcMain.handle("ui:setState", (event, partial) => {
        requirePrivileged(event, "ui:setState");
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
        if (!requirePrivilegedSender(event, "window:show"))
            return;
        options.windowManager.showWindow();
    });
    ipcMain.on("app:reload", (event) => {
        if (!requirePrivilegedSender(event, "app:reload"))
            return;
        options.windowManager.reloadFullWindow();
    });

    ipcMain.on("app:relaunch", (event) => {
        if (!requirePrivilegedSender(event, "app:relaunch"))
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
