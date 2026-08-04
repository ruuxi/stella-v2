import { BrowserWindow, ipcMain, screen, shell, } from "electron";
import { hasMacPermission, requestMacPermission, } from "../utils/macos-permissions.js";
export const registerCaptureHandlers = (options) => {
    const ensureScreenCapturePermission = async () => {
        if (process.platform !== "darwin") {
            return true;
        }
        if (hasMacPermission("screen", false)) {
            return true;
        }
        const result = await requestMacPermission("screen");
        if (result.granted) {
            return true;
        }
        await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
        return false;
    };
    ipcMain.handle("chatContext:get", () => options.captureService.getChatContextSnapshot());
    ipcMain.on("chatContext:set", (_event, context) => {
        options.captureService.setPendingChatContext(context ?? null);
        options.captureService.broadcastChatContext();
    });
    ipcMain.on("chatContext:removeScreenshot", (_event, index) => {
        options.captureService.removeScreenshot(index);
        options.captureService.broadcastChatContext();
    });
    ipcMain.on("region:select", (_event, selection) => {
        void options.captureService.finalizeRegionCapture(selection);
    });
    ipcMain.on("region:commitPrepared", (_event, result) => {
        options.captureService.commitPreparedRegionCapture(result);
    });
    ipcMain.on("region:cancel", () => {
        options.captureService.cancelRegionCapture();
    });
    ipcMain.handle("region:prepareSelection", async (_event, selection) => {
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.prepareRegionSelection(selection);
    });
    ipcMain.handle("region:getWindowCapture", async (_event, point) => {
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.getRegionWindowCapture(point);
    });
    ipcMain.on("region:click", async (_event, point) => {
        await options.captureService.handleRegionClick(point);
    });
    ipcMain.handle("screenshot:capture", async (event, point) => {
        if (!options.assertPrivilegedSender(event, "screenshot:capture")) {
            throw new Error("Blocked untrusted request.");
        }
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.captureScreenshot(point);
    });
    ipcMain.handle("screenshot:captureVision", async (event, point) => {
        if (!options.assertPrivilegedSender(event, "screenshot:captureVision")) {
            throw new Error("Blocked untrusted request.");
        }
        if (!(await ensureScreenCapturePermission())) {
            return [];
        }
        return options.captureService.captureVisionScreenshots(point);
    });
    ipcMain.handle("capture:cursorDisplayInfo", () => {
        const cursor = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursor);
        return {
            x: display.bounds.x,
            y: display.bounds.y,
            width: display.bounds.width,
            height: display.bounds.height,
            scaleFactor: display.scaleFactor ?? 1,
        };
    });
    ipcMain.handle("capture:pageDataUrl", async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return null;
        const image = await win.webContents.capturePage();
        return image.toDataURL();
    });
    // Composer capture entry point: hide the full shell, run the overlay, merge
    // any capture, then restore the shell's previous visibility/focus state.
    ipcMain.handle("capture:beginRegionCapture", async (event) => {
        if (!options.assertPrivilegedSender(event, "capture:beginRegionCapture")) {
            throw new Error("Blocked untrusted request.");
        }
        if (!(await ensureScreenCapturePermission())) {
            return { cancelled: true };
        }
        const wm = options.windowManager;
        const targetWindowWasVisible = wm.isWindowVisible();
        const targetWindowWasFocused = wm.isWindowFocused();
        wm.minimizeWindow();
        const result = await options.captureService.startRegionCapture();
        options.captureService.commitRegionCaptureResult(result);
        if (result !== null || targetWindowWasFocused) {
            wm.showWindow();
        }
        else if (targetWindowWasVisible) {
            wm.restoreWindowVisibility();
        }
        return result === null
            ? { cancelled: true }
            : { ok: true };
    });
};
