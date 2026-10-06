import fs from 'fs';
import path from 'path';
import { loadWindow } from './window-load.js';
// Explicit opt-in, available in any install: there is no packaging step whose
// absence could stand in for "a human is debugging this".
const shouldOpenDevTools = process.env.STELLA_OPEN_DEVTOOLS === '1';
const loadShellMainWindow = (window, options) => {
    loadWindow(window, { mode: options.mode });
};
export const createShellWindow = (options) => {
    const window = options.createWindow();
    options.setupExternalLinkHandlers(window);
    if (shouldOpenDevTools) {
        window.webContents.openDevTools();
    }
    window.webContents.on('did-start-loading', () => {
        options.onDidStartLoading?.();
    });
    window.webContents.on('did-finish-load', () => {
        options.onDidFinishLoad?.();
    });
    window.webContents.on('render-process-gone', (_event, details) => {
        options.onRenderProcessGone?.(details, window);
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        options.onDidFailLoad?.({
            errorCode,
            errorDescription,
            validatedURL,
            isMainFrame,
        }, window);
    });
    window.on('unresponsive', () => {
        options.onUnresponsive?.(window);
    });
    window.on('responsive', () => {
        options.onResponsive?.(window);
    });
    window.on('closed', () => {
        options.onClosed?.(window);
    });
    loadShellMainWindow(window, options);
    return window;
};
export const reloadShellMainWindow = (window, options) => {
    if (!window || window.isDestroyed()) {
        return;
    }
    loadShellMainWindow(window, options);
};
/**
 * Resolves `recovery.html` from the source tree. The esbuild bundle does not
 * copy static assets, and `electronDir` is
 * `packages/desktop/dist-electron/electron`, so the source file is
 * `../../electron/recovery.html`.
 */
const resolveRecoveryHtmlPath = (electronDir) => {
    const candidates = [
        path.join(electronDir, 'recovery.html'),
        path.resolve(electronDir, '../../electron/recovery.html'),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) {
                return candidate;
            }
        }
        catch {
            /* try next */
        }
    }
    return null;
};
/**
 * Loads the recovery surface into a window. Reads `recovery.html` from disk
 * and serves it via a `data:` URL so we never have to do a `file://`
 * navigation from an `http://` (dev) origin — Chromium blocks that as
 * "Not allowed to load local resource", which used to leave the window blank.
 */
export const loadShellRecoveryPage = (window, electronDir) => {
    if (!window || window.isDestroyed()) {
        return;
    }
    const recoveryPath = resolveRecoveryHtmlPath(electronDir);
    if (!recoveryPath) {
        console.error('[recovery] Could not locate recovery.html relative to', electronDir);
        return;
    }
    try {
        const html = fs.readFileSync(recoveryPath, 'utf-8');
        const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf-8').toString('base64')}`;
        void window.loadURL(dataUrl);
    }
    catch (error) {
        console.error('[recovery] Failed to load recovery surface:', error);
    }
};
