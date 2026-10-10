import { BrowserWindow, screen, shell } from "electron";
import { hasMacPermission, requestMacPermission, } from "../utils/macos-permissions.js";
import {
  IPC_CHAT_CONTEXT_GET,
  IPC_CHAT_CONTEXT_SET,
  IPC_CHAT_CONTEXT_REMOVE_SCREENSHOT,
  IPC_REGION_SELECT,
  IPC_REGION_COMMIT_PREPARED,
  IPC_REGION_CANCEL,
  IPC_REGION_PREPARE_SELECTION,
  IPC_REGION_GET_WINDOW_CAPTURE,
  IPC_REGION_CLICK,
  IPC_SCREENSHOT_CAPTURE,
  IPC_SCREENSHOT_CAPTURE_VISION,
  IPC_CAPTURE_CURSOR_DISPLAY_INFO,
  IPC_CAPTURE_PAGE_DATA_URL,
  IPC_CAPTURE_BEGIN_REGION_CAPTURE,
} from "@stella/contracts/desktop/ipc-channels";
import {
  handleIpc,
  onIpc,
} from "./typed-ipc.js";
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
    handleIpc(IPC_CHAT_CONTEXT_GET, () => options.captureService.getChatContextSnapshot());
    onIpc(IPC_CHAT_CONTEXT_SET, (_event, context) => {
        options.captureService.setPendingChatContext(context ?? null);
        options.captureService.broadcastChatContext();
    });
    onIpc(IPC_CHAT_CONTEXT_REMOVE_SCREENSHOT, (_event, index) => {
        options.captureService.removeScreenshot(index);
        options.captureService.broadcastChatContext();
    });
    onIpc(IPC_REGION_SELECT, (_event, selection) => {
        void options.captureService.finalizeRegionCapture(selection);
    });
    onIpc(IPC_REGION_COMMIT_PREPARED, (_event, result) => {
        options.captureService.commitPreparedRegionCapture(result);
    });
    onIpc(IPC_REGION_CANCEL, () => {
        options.captureService.cancelRegionCapture();
    });
    handleIpc(IPC_REGION_PREPARE_SELECTION, async (_event, selection) => {
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.prepareRegionSelection(selection);
    });
    handleIpc(IPC_REGION_GET_WINDOW_CAPTURE, async (_event, point) => {
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.getRegionWindowCapture(point);
    });
    onIpc(IPC_REGION_CLICK, async (_event, point) => {
        await options.captureService.handleRegionClick(point);
    });
    handleIpc(IPC_SCREENSHOT_CAPTURE, async (event, point) => {
        if (!options.assertPrivilegedSender(event, IPC_SCREENSHOT_CAPTURE)) {
            throw new Error("Blocked untrusted request.");
        }
        if (!(await ensureScreenCapturePermission())) {
            return null;
        }
        return options.captureService.captureScreenshot(point);
    });
    handleIpc(IPC_SCREENSHOT_CAPTURE_VISION, async (event, point) => {
        if (!options.assertPrivilegedSender(event, IPC_SCREENSHOT_CAPTURE_VISION)) {
            throw new Error("Blocked untrusted request.");
        }
        if (!(await ensureScreenCapturePermission())) {
            return [];
        }
        return options.captureService.captureVisionScreenshots(point);
    });
    handleIpc(IPC_CAPTURE_CURSOR_DISPLAY_INFO, () => {
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
    handleIpc(IPC_CAPTURE_PAGE_DATA_URL, async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win)
            return null;
        const image = await win.webContents.capturePage();
        return image.toDataURL();
    });
    // Composer capture entry point: hide the full shell, run the overlay, merge
    // any capture, then restore the shell's previous visibility/focus state.
    handleIpc(IPC_CAPTURE_BEGIN_REGION_CAPTURE, async (event) => {
        if (!options.assertPrivilegedSender(event, IPC_CAPTURE_BEGIN_REGION_CAPTURE)) {
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
