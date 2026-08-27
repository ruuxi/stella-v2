import { BrowserWindow, screen } from 'electron';
import { loadWindow } from './window-load.js';
import { createSharedWebPreferences } from './shared-window-preferences.js';

const PET_WINDOW_WIDTH = 280;
const PET_WINDOW_HEIGHT = 240;

const PET_WINDOW_COMPOSER_WIDTH = 540;

const DEFAULT_EDGE_MARGIN = 24;
const pickDefaultPosition = () => {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor) ?? screen.getPrimaryDisplay();
    const work = display.workArea;
    return {
        x: work.x + work.width - PET_WINDOW_WIDTH - DEFAULT_EDGE_MARGIN,
        y: work.y + work.height - PET_WINDOW_HEIGHT - DEFAULT_EDGE_MARGIN,
    };
};

const PET_FADE_MS = 200;
const PET_FADE_FPS = 60;
class PetWindow {
    options;
    window = null;
    ready = false;
    destroyed = false;
    composerActive = false;
    position = pickDefaultPosition();
    fadeTimer = null;

    readyToShowHandler = null;
    didFinishLoadHandler = null;
    movedHandler = null;
    closedHandler = null;
    closeHandler = null;
    constructor(options) {
        this.options = options;
    }
    getWindow() {
        return this.window;
    }
    isReady() {
        return this.ready;
    }

    ensure() {
        if (this.destroyed)
            return null;
        if (this.window && !this.window.isDestroyed()) {
            return this.window;
        }
        const window = new BrowserWindow({
            x: this.position.x,
            y: this.position.y,
            width: PET_WINDOW_WIDTH,
            height: PET_WINDOW_HEIGHT,
            ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
            frame: false,
            transparent: true,
            resizable: false,
            movable: true,
            minimizable: false,
            maximizable: false,
            closable: false,
            skipTaskbar: true,
            ...(process.platform === 'darwin'
                ? { hiddenInMissionControl: true }
                : {}),
            hasShadow: false,

            focusable: false,
            acceptFirstMouse: true,
            show: false,
            backgroundColor: '#00000000',
            webPreferences: createSharedWebPreferences({
                preloadPath: this.options.preloadPath,
                sessionPartition: this.options.sessionPartition,
                backgroundThrottling: false,
            }),
        });
        this.window = window;

        window.setAlwaysOnTop(true, 'floating');
        if (process.platform === 'darwin') {
            window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                skipTransformProcessType: true,
            });
            window.excludedFromShownWindowsMenu = true;
        }
        else {
            window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
            });
        }
        this.readyToShowHandler = () => {
            this.ready = true;
        };
        this.didFinishLoadHandler = () => {
            this.ready = true;
        };
        this.movedHandler = () => {
            const current = this.window;
            if (!current || current.isDestroyed())
                return;
            const bounds = current.getBounds();
            this.position = { x: bounds.x, y: bounds.y };
        };
        this.closedHandler = () => {
            this.window = null;
            this.ready = false;
            this.readyToShowHandler = null;
            this.didFinishLoadHandler = null;
            this.movedHandler = null;
            this.closedHandler = null;
            this.closeHandler = null;
        };
        this.closeHandler = (event) => {
            if (this.options.isQuitting?.())
                return;
            event.preventDefault();
        };

        window.setIgnoreMouseEvents(true, { forward: true });
        window.once('ready-to-show', this.readyToShowHandler);
        window.webContents.once('did-finish-load', this.didFinishLoadHandler);
        window.on('moved', this.movedHandler);
        window.on('closed', this.closedHandler);
        window.on('close', this.closeHandler);
        loadWindow(window, {
            electronDir: this.options.electronDir,
            isDev: this.options.isDev,
            mode: 'pet',
            getDevServerUrl: this.options.getDevServerUrl,
        });
        return window;
    }
    show() {
        const win = this.ensure();
        if (!win || win.isDestroyed())
            return;
        this.cancelFade();
        if (!win.isVisible()) {
            win.setOpacity(0);
            win.showInactive();
        }
        this.tweenOpacity(win, win.getOpacity(), 1, null);
    }
    hide() {
        if (!this.window || this.window.isDestroyed())
            return;
        if (!this.window.isVisible())
            return;
        const target = this.window;
        this.cancelFade();
        this.tweenOpacity(target, target.getOpacity(), 0, () => {
            if (target.isDestroyed())
                return;
            target.hide();
            target.setOpacity(1);
        });
    }

    tweenOpacity(win, from, to, onDone) {
        if (win.isDestroyed()) {
            onDone?.();
            return;
        }
        if (Math.abs(from - to) < 0.01) {
            win.setOpacity(to);
            onDone?.();
            return;
        }
        const stepMs = 1000 / PET_FADE_FPS;
        const steps = Math.max(1, Math.round(PET_FADE_MS / stepMs));
        let frame = 0;
        win.setOpacity(from);
        this.fadeTimer = setInterval(() => {
            frame += 1;
            if (win.isDestroyed()) {
                this.cancelFade();
                onDone?.();
                return;
            }
            const t = Math.min(1, frame / steps);
            win.setOpacity(from + (to - from) * t);
            if (frame >= steps) {
                this.cancelFade();
                win.setOpacity(to);
                onDone?.();
            }
        }, stepMs);
    }
    cancelFade() {
        if (this.fadeTimer) {
            clearInterval(this.fadeTimer);
            this.fadeTimer = null;
        }
    }

    setPosition(x, y) {
        if (!this.window || this.window.isDestroyed())
            return;
        const rounded = { x: Math.round(x), y: Math.round(y) };
        this.position = rounded;
        const width = this.composerActive
            ? PET_WINDOW_COMPOSER_WIDTH
            : PET_WINDOW_WIDTH;
        this.window.setBounds({
            x: rounded.x,
            y: rounded.y,
            width,
            height: PET_WINDOW_HEIGHT,
        }, false);
    }

    setComposerActive(active) {
        if (!this.window || this.window.isDestroyed())
            return;
        if (active === this.composerActive)
            return;
        this.composerActive = active;
        const bounds = this.window.getBounds();
        const targetWidth = active ? PET_WINDOW_COMPOSER_WIDTH : PET_WINDOW_WIDTH;

        const rightEdge = bounds.x + bounds.width;
        const nextX = Math.round(rightEdge - targetWidth);
        if (active) {

            this.window.setIgnoreMouseEvents(false);
        }
        this.window.setBounds({
            x: nextX,
            y: bounds.y,
            width: targetWidth,
            height: PET_WINDOW_HEIGHT,
        }, false);
        this.position = { x: nextX, y: bounds.y };
        this.window.setFocusable(active);
        if (active) {

            this.window.focus();
        }
        else {

            this.window.setIgnoreMouseEvents(true, { forward: true });
        }
    }

    setInteractive(active) {
        if (!this.window || this.window.isDestroyed())
            return;
        if (this.composerActive)
            return;
        if (active) {
            this.window.setIgnoreMouseEvents(false);
        }
        else {
            this.window.setIgnoreMouseEvents(true, { forward: true });
        }
    }

    destroy() {
        this.destroyed = true;
        this.cancelFade();
        const win = this.window;
        if (!win)
            return;
        if (this.closeHandler) {
            win.removeListener('close', this.closeHandler);
            this.closeHandler = null;
        }
        if (this.movedHandler) {
            win.removeListener('moved', this.movedHandler);
            this.movedHandler = null;
        }
        if (this.closedHandler) {
            win.removeListener('closed', this.closedHandler);
            this.closedHandler = null;
        }
        if (this.readyToShowHandler) {
            win.removeListener('ready-to-show', this.readyToShowHandler);
            this.readyToShowHandler = null;
        }
        if (this.didFinishLoadHandler && !win.webContents.isDestroyed()) {
            win.webContents.removeListener('did-finish-load', this.didFinishLoadHandler);
            this.didFinishLoadHandler = null;
        }
        if (!win.isDestroyed()) {
            win.destroy();
        }
        this.window = null;
        this.ready = false;
    }
}
export class PetWindowController {
    petWindow;
    destroyed = false;
    constructor(options) {
        this.petWindow = new PetWindow(options);
    }
    setOpen(open) {
        if (this.destroyed)
            return;
        if (open) {
            this.petWindow.show();
        }
        else {
            this.petWindow.hide();
        }
    }
    isVisible() {
        if (this.destroyed)
            return false;
        const win = this.petWindow.getWindow();
        return Boolean(win && !win.isDestroyed() && win.isVisible());
    }
    getWindow() {
        if (this.destroyed)
            return null;
        const win = this.petWindow.getWindow();
        return win && !win.isDestroyed() ? win : null;
    }
    getWebContents() {
        if (this.destroyed)
            return null;
        return this.petWindow.getWindow()?.webContents ?? null;
    }
    setWindowPosition(x, y) {
        if (this.destroyed)
            return;
        this.petWindow.setPosition(x, y);
    }
    setComposerActive(active) {
        if (this.destroyed)
            return;
        this.petWindow.setComposerActive(active);
    }
    setInteractive(active) {
        if (this.destroyed)
            return;
        this.petWindow.setInteractive(active);
    }

    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.petWindow.destroy();
    }
}
export const PET_WINDOW_DIMENSIONS = {
    width: PET_WINDOW_WIDTH,
    height: PET_WINDOW_HEIGHT,
};
