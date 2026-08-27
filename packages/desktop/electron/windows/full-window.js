import { BrowserWindow, screen } from 'electron';
import { resolveAppIconPath } from '../app-icon.js';
import { FULL_SHELL_MIN_SIZE } from '../layout-constants.js';
import { createSharedWebPreferences } from './shared-window-preferences.js';
import { ShellWindowController } from './shell-window-controller.js';
const FULL_SHELL_DEFAULT_SIZE = { width: 1400, height: 940 };

const resolveFullWindowInitialBounds = () => {
    const { width: dw, height: dh } = FULL_SHELL_DEFAULT_SIZE;
    if (process.platform === 'darwin') {
        return { width: dw, height: dh };
    }
    try {
        const workArea = screen.getPrimaryDisplay().workArea;
        const width = Math.max(FULL_SHELL_MIN_SIZE.width, Math.min(dw, workArea.width));
        const height = Math.max(FULL_SHELL_MIN_SIZE.height, Math.min(dh, workArea.height));
        const x = Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2));
        const y = Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2));
        return { width, height, x, y };
    }
    catch {

        return { width: dw, height: dh };
    }
};
export class FullWindowController {
    options;
    controller;
    constructor(options) {
        this.options = options;
        this.controller = new ShellWindowController(options, {
            mode: 'full',
            createWindow: () => {
                const isMac = process.platform === 'darwin';
                const useNativeVibrancy = isMac;
                const windowIcon = !isMac ? resolveAppIconPath(this.options.electronDir) : undefined;
                const initialBounds = resolveFullWindowInitialBounds();
                return new BrowserWindow({
                    width: initialBounds.width,
                    height: initialBounds.height,
                    x: initialBounds.x,
                    y: initialBounds.y,
                    minWidth: FULL_SHELL_MIN_SIZE.width,
                    minHeight: FULL_SHELL_MIN_SIZE.height,

                    frame: process.platform !== 'win32',
                    transparent: false,
                    backgroundColor: isMac ? '#f2f4f8' : '#101016',
                    hasShadow: true,
                    vibrancy: useNativeVibrancy ? 'menu' : undefined,
                    visualEffectState: useNativeVibrancy ? 'active' : undefined,
                    titleBarStyle: isMac ? 'hiddenInset' : undefined,
                    trafficLightPosition: isMac ? { x: 16, y: 13 } : undefined,
                    icon: windowIcon,
                    webPreferences: createSharedWebPreferences({
                        preloadPath: this.options.preloadPath,
                        sessionPartition: this.options.sessionPartition,
                    }),
                });
            },
        });
    }
    getWindow() {
        return this.controller.getWindow();
    }
    create() {
        return this.controller.create();
    }
    loadRecoveryPage() {
        this.controller.loadRecoveryPage();
    }
    reloadMainWindow() {
        this.controller.reloadMainWindow();
    }
}
