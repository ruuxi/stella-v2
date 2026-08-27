import { BrowserWindow, ipcMain, screen, } from 'electron';
import { loadWindow } from './window-load.js';
import { createSharedWebPreferences } from './shared-window-preferences.js';
import { STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES, getWindowInfoAtPoint, } from '../window-capture.js';
const getAllDisplaysBounds = () => {
    const displays = screen.getAllDisplays();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of displays) {
        minX = Math.min(minX, d.bounds.x);
        minY = Math.min(minY, d.bounds.y);
        maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
        maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

class OverlayWindow {
    options;
    window = null;
    displayListenersRegistered = false;
    respanHandler = null;
    ready = false;
    destroyed = false;
    overlayOrigin = { x: 0, y: 0 };
    reloadTimer = null;
    concealOnWarmPresent = false;
    constructor(options) {
        this.options = options;
    }
    getWindow() {
        return this.window;
    }
    getOverlayOrigin() {
        return this.overlayOrigin;
    }

    refreshOverlayOriginFromContentBounds() {
        if (!this.window || this.window.isDestroyed())
            return;
        const cb = this.window.getContentBounds();
        this.overlayOrigin = { x: cb.x, y: cb.y };
    }
    isReady() {
        return this.ready;
    }
    isDestroyed() {
        return this.destroyed;
    }
    async ensureReady(timeoutMs = 1_500) {
        const win = this.create();
        if (!win || win.isDestroyed()) {
            return false;
        }
        if (this.ready) {
            return true;
        }
        return await new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                win.removeListener('ready-to-show', handleReady);
                win.removeListener('closed', handleClosed);
                win.webContents.removeListener('did-finish-load', handleReady);
                resolve(value);
            };
            const handleReady = () => {
                this.ready = true;
                finish(true);
            };
            const handleClosed = () => finish(false);
            const timer = setTimeout(() => finish(this.ready), timeoutMs);
            win.once('ready-to-show', handleReady);
            win.once('closed', handleClosed);
            win.webContents.once('did-finish-load', handleReady);
        });
    }
    create() {
        if (this.destroyed)
            return null;
        if (this.window && !this.window.isDestroyed()) {
            return this.window;
        }
        const bounds = getAllDisplaysBounds();
        this.overlayOrigin = { x: bounds.x, y: bounds.y };
        this.window = new BrowserWindow({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
            frame: false,
            transparent: true,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            closable: false,
            skipTaskbar: true,

            fullscreenable: false,
            ...(process.platform === 'darwin'
                ? { hiddenInMissionControl: true }
                : {}),
            hasShadow: false,
            title: STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES[0],
            focusable: false,
            show: false,
            backgroundColor: '#00000000',
            webPreferences: createSharedWebPreferences({
                preloadPath: this.options.preloadPath,
                sessionPartition: this.options.sessionPartition,
                backgroundThrottling: false,
            }),
        });
        this.window.setTitle(STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES[0]);
        this.window.setAlwaysOnTop(true, 'screen-saver');

        this.window.setContentProtection(true);
        if (process.platform === 'darwin') {

            this.window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                skipTransformProcessType: true,
            });
            this.window.excludedFromShownWindowsMenu = true;
        }
        else {
            this.window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
            });
        }
        this.window.setIgnoreMouseEvents(true, { forward: true });
        this.window.once('ready-to-show', () => {
            this.ready = true;
            if (this.window && !this.window.isDestroyed()) {
                this.respanDisplays();
                this.window.setOpacity(0);
                if (process.platform !== 'darwin') {
                    this.window.showInactive();

                    if (this.concealOnWarmPresent) {
                        this.concealOnWarmPresent = false;
                        this.window.hide();
                    }
                }
                this.window.setIgnoreMouseEvents(true, { forward: true });
            }
        });
        this.window.webContents.once('did-finish-load', () => {
            this.ready = true;
        });
        this.window.webContents.on('render-process-gone', (_event, details) => {
            this.handleRenderProcessGone(details);
        });
        this.window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame || errorCode === -3) {
                return;
            }
            console.error('Overlay failed to load:', errorCode, errorDescription, validatedURL);
            this.scheduleReload();
        });
        loadWindow(this.window, {
            electronDir: this.options.electronDir,
            isDev: this.options.isDev,
            mode: 'overlay',
            getDevServerUrl: this.options.getDevServerUrl,
        });
        this.window.on('closed', () => {
            this.window = null;
            this.ready = false;
            this.concealOnWarmPresent = false;
            this.clearReloadTimer();
        });
        this.window.on('close', (e) => {
            if (this.options.isQuitting?.())
                return;
            e.preventDefault();
        });
        if (!this.displayListenersRegistered) {
            this.displayListenersRegistered = true;
            this.respanHandler = () => this.respanDisplays();
            screen.on('display-added', this.respanHandler);
            screen.on('display-removed', this.respanHandler);
            screen.on('display-metrics-changed', this.respanHandler);
        }
        return this.window;
    }
    respanDisplays() {
        if (!this.window)
            return;
        const bounds = getAllDisplaysBounds();
        this.overlayOrigin = { x: bounds.x, y: bounds.y };
        this.window.setBounds(bounds);
        this.window.webContents.send('overlay:displayChange', {
            origin: this.overlayOrigin,
            bounds,
        });
    }
    show(options) {
        if (!this.window || !this.ready)
            return;
        this.concealOnWarmPresent = false;
        if (!this.window.isVisible()) {
            this.respanDisplays();
            if (options?.inactive) {
                this.window.showInactive();
            }
            else {
                this.window.show();
            }
        }

        this.refreshOverlayOriginFromContentBounds();

        this.window.setOpacity(0.99);

        if (!options?.focus) {
            this.window.setIgnoreMouseEvents(true, { forward: true });
            this.window.setFocusable(false);
        }
        if (options?.focus) {
            this.window.focus();
        }
    }

    fadeOut() {
        if (!this.window || !this.ready)
            return;
        this.window.setIgnoreMouseEvents(true, { forward: true });
        this.window.setFocusable(false);
        this.window.setOpacity(0);
        this.window.hide();
    }

    concealAfterWarm() {
        if (!this.window || this.window.isDestroyed())
            return;
        if (this.window.isVisible()) {
            this.fadeOut();
            return;
        }
        this.concealOnWarmPresent = true;
    }
    setIgnoreMouseEvents(ignore) {
        if (!this.window)
            return;
        if (ignore) {
            this.window.setIgnoreMouseEvents(true, { forward: true });
        }
        else {
            this.window.setIgnoreMouseEvents(false);
        }
    }
    setFocusable(focusable) {
        if (!this.window)
            return;
        this.window.setFocusable(focusable);
        if (!focusable)
            this.window.blur();
    }
    send(channel, ...args) {
        this.window?.webContents.send(channel, ...args);
    }
    handleRenderProcessGone(details) {
        console.error('Overlay renderer process gone:', details.reason);
        this.scheduleReload();
    }
    scheduleReload(delayMs = 250) {
        if (this.reloadTimer) {
            return;
        }
        this.ready = false;
        this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null;
            if (!this.window || this.window.isDestroyed()) {
                return;
            }
            loadWindow(this.window, {
                electronDir: this.options.electronDir,
                isDev: this.options.isDev,
                mode: 'overlay',
                getDevServerUrl: this.options.getDevServerUrl,
            });
        }, delayMs);
    }
    clearReloadTimer() {
        if (!this.reloadTimer) {
            return;
        }
        clearTimeout(this.reloadTimer);
        this.reloadTimer = null;
    }

    reclaimForIdle() {
        if (this.destroyed)
            return;
        this.clearReloadTimer();
        if (this.window) {
            this.window.removeAllListeners('close');
            if (!this.window.isDestroyed()) {
                this.window.destroy();
            }
            this.window = null;
        }
        this.ready = false;
    }

    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.clearReloadTimer();
        if (this.respanHandler) {
            screen.removeListener('display-added', this.respanHandler);
            screen.removeListener('display-removed', this.respanHandler);
            screen.removeListener('display-metrics-changed', this.respanHandler);
            this.respanHandler = null;
            this.displayListenersRegistered = false;
        }
        if (this.window) {
            this.window.removeAllListeners('close');
            if (!this.window.isDestroyed()) {
                this.window.destroy();
            }
            this.window = null;
        }
        this.ready = false;
    }
}

const OVERLAY_IDLE_DESTROY_DELAY_MS = 5 * 60 * 1000;
export class OverlayWindowController {
    overlayWindow;
    destroyed = false;

    activeRegionCapture = false;
    activeDictation = false;
    activeScreenGuide = false;
    activeWindowHighlight = false;
    windowHighlightRequestId = 0;

    idleDestroyTimer = null;
    handleOverlaySetInteractive = (_event, interactive) => {
        if (this.activeRegionCapture && !interactive) {
            return;
        }
        this.overlayWindow.setIgnoreMouseEvents(!interactive);
    };
    handleOverlayShowWindowHighlight = (_event, payload) => {
        this.windowHighlightRequestId += 1;
        if (!payload) {
            void this.setWindowHighlight(null);
            return;
        }
        if ('bounds' in payload) {
            void this.setWindowHighlight(payload.bounds, payload.tone ?? 'default');
            return;
        }
        void this.setWindowHighlight(payload, 'default');
    };
    handleOverlayHideWindowHighlight = () => {
        this.windowHighlightRequestId += 1;
        this.clearWindowHighlight();
    };
    handleOverlayPreviewWindowHighlightAtPoint = (_event, point) => {
        const origin = this.overlayWindow.getOverlayOrigin();
        this.previewWindowHighlightAtScreenPoint({
            x: Math.round(point.x + origin.x),
            y: Math.round(point.y + origin.y),
        });
    };
    previewWindowHighlightAtScreenPoint(screenPoint) {

        if (!this.activeRegionCapture)
            return;
        const requestId = ++this.windowHighlightRequestId;
        void getWindowInfoAtPoint(screenPoint.x, screenPoint.y, {
            excludePids: [process.pid],
            excludeTitlePrefixes: STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES,
        }).then((info) => {
            if (requestId !== this.windowHighlightRequestId)
                return;
            void this.setWindowHighlight(info?.bounds ?? null, 'default');
        });
    }
    constructor(options) {
        this.overlayWindow = new OverlayWindow(options);
        ipcMain.on('overlay:setInteractive', this.handleOverlaySetInteractive);
        ipcMain.on('overlay:showWindowHighlight', this.handleOverlayShowWindowHighlight);
        ipcMain.on('overlay:hideWindowHighlight', this.handleOverlayHideWindowHighlight);
        ipcMain.on('overlay:previewWindowHighlightAtPoint', this.handleOverlayPreviewWindowHighlightAtPoint);
    }
    getWindow() {
        return this.overlayWindow.getWindow();
    }
    getOverlayOrigin() {
        return this.overlayWindow.getOverlayOrigin();
    }
    create() {
        return this.overlayWindow.create();
    }
    ensureReadyForDictation(timeoutMs) {

        return this.ensureReady(timeoutMs);
    }
    async warmForStartup(timeoutMs) {
        const warmed = await this.ensureReady(timeoutMs);

        if (warmed && process.platform !== 'darwin' && !this.isAnyActive) {
            this.overlayWindow.concealAfterWarm();
        }
        return warmed;
    }

    async ensureReady(timeoutMs) {
        this.cancelIdleDestroy();
        return this.overlayWindow.ensureReady(timeoutMs);
    }
    cancelIdleDestroy() {
        if (!this.idleDestroyTimer) {
            return;
        }
        clearTimeout(this.idleDestroyTimer);
        this.idleDestroyTimer = null;
    }
    scheduleIdleDestroy() {
        this.cancelIdleDestroy();
        this.idleDestroyTimer = setTimeout(() => {
            this.idleDestroyTimer = null;

            if (this.isAnyActive) {
                return;
            }
            this.overlayWindow.reclaimForIdle();
        }, OVERLAY_IDLE_DESTROY_DELAY_MS);
    }
    get isAnyActive() {
        return (this.activeRegionCapture ||
            this.activeDictation ||
            this.activeScreenGuide ||
            this.activeWindowHighlight);
    }
    async setWindowHighlight(bounds, tone = 'default') {
        if (!bounds) {
            this.clearWindowHighlight();
            return;
        }
        this.activeWindowHighlight = true;
        const reqId = this.windowHighlightRequestId;

        if (!(await this.ensureReady()))
            return;

        if (reqId !== this.windowHighlightRequestId || !this.activeWindowHighlight)
            return;
        this.overlayWindow.show({ inactive: true });
        if (this.activeRegionCapture) {
            this.overlayWindow.setFocusable(true);
            this.overlayWindow.setIgnoreMouseEvents(false);
        }
        else {
            this.overlayWindow.setIgnoreMouseEvents(true);
            this.overlayWindow.setFocusable(false);
        }
        const origin = this.overlayWindow.getOverlayOrigin();
        this.overlayWindow.send('overlay:windowHighlight', {
            x: bounds.x - origin.x,
            y: bounds.y - origin.y,
            width: bounds.width,
            height: bounds.height,
            tone,
        });
    }
    clearWindowHighlight() {
        this.activeWindowHighlight = false;
        this.overlayWindow.send('overlay:windowHighlight', null);
        this.hideOverlayIfIdle();
    }
    hideOverlayIfIdle() {
        if (this.isAnyActive)
            return;
        this.overlayWindow.fadeOut();

        this.scheduleIdleDestroy();
    }
    async showSurface(options) {
        options.setActive();

        if (!(await this.ensureReady()))
            return;
        if (options.focusable !== undefined) {
            this.overlayWindow.setFocusable(options.focusable);
        }
        if (options.sendBeforeShow) {
            this.overlayWindow.send(options.channel, options.payload);
        }
        this.overlayWindow.show(options.showOptions);
        if (options.interactive !== undefined) {
            this.overlayWindow.setIgnoreMouseEvents(!options.interactive);
        }
        if (!options.sendBeforeShow) {
            this.overlayWindow.send(options.channel, options.payload);
        }
    }
    hideSurface(options) {
        options.setInactive();
        if (options.restoreIgnoreMouseEvents && !this.isAnyActive) {
            this.overlayWindow.setIgnoreMouseEvents(true);
        }
        if (options.focusable !== undefined) {
            this.overlayWindow.setFocusable(options.focusable);
        }
        this.overlayWindow.send(options.channel, options.payload);
        this.hideOverlayIfIdle();
    }

    async startRegionCapture() {
        await this.showSurface({
            setActive: () => {
                this.activeRegionCapture = true;
            },
            channel: 'overlay:startRegionCapture',
            payload: { mode: 'capture' },
            showOptions: { focus: true },
            interactive: true,
            focusable: true,
        });

        this.previewWindowHighlightAtScreenPoint(screen.getCursorScreenPoint());
    }
    suspendRegionCaptureForScreenshot() {
        if (!this.activeRegionCapture)
            return;
        this.overlayWindow.fadeOut();
    }
    restoreRegionCaptureAfterScreenshot() {
        if (!this.activeRegionCapture)
            return;
        this.overlayWindow.setFocusable(true);
        this.overlayWindow.show({ focus: true });
        this.overlayWindow.setIgnoreMouseEvents(false);
    }
    endRegionCapture() {

        this.windowHighlightRequestId += 1;
        this.clearWindowHighlight();
        this.hideSurface({
            setInactive: () => {
                this.activeRegionCapture = false;
            },
            channel: 'overlay:endRegionCapture',
            restoreIgnoreMouseEvents: true,
            focusable: false,
        });
    }
    send(channel, ...args) {
        this.overlayWindow.send(channel, ...args);
    }

    async showDictation(screenX, screenY) {
        this.activeDictation = true;

        if (!(await this.ensureReady()))
            return false;
        this.overlayWindow.show({ inactive: true });
        this.overlayWindow.refreshOverlayOriginFromContentBounds();
        const origin = this.overlayWindow.getOverlayOrigin();
        this.overlayWindow.send('overlay:showDictation', {
            x: screenX - origin.x,
            y: screenY - origin.y,
        });
        return true;
    }
    hideDictation() {
        this.activeDictation = false;
        this.overlayWindow.send('overlay:hideDictation');
        this.hideOverlayIfIdle();
    }

    async showScreenGuide(annotations) {
        this.activeScreenGuide = true;

        if (!(await this.ensureReady()))
            return;
        this.overlayWindow.show({ inactive: true });
        const origin = this.overlayWindow.getOverlayOrigin();
        const adjusted = annotations.map((a) => ({
            ...a,
            x: a.x - origin.x,
            y: a.y - origin.y,
        }));
        this.overlayWindow.send('overlay:showScreenGuide', {
            annotations: adjusted,
        });
    }
    hideScreenGuide() {
        this.activeScreenGuide = false;
        this.overlayWindow.send('overlay:hideScreenGuide');
        this.hideOverlayIfIdle();
    }

    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        ipcMain.removeListener('overlay:setInteractive', this.handleOverlaySetInteractive);
        ipcMain.removeListener('overlay:showWindowHighlight', this.handleOverlayShowWindowHighlight);
        ipcMain.removeListener('overlay:hideWindowHighlight', this.handleOverlayHideWindowHighlight);
        ipcMain.removeListener('overlay:previewWindowHighlightAtPoint', this.handleOverlayPreviewWindowHighlightAtPoint);

        this.cancelIdleDestroy();
        this.overlayWindow.destroy();
    }
}
