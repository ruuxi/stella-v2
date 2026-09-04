/**
 * Companion window — the floating desktop Stella.
 *
 * A small frameless, transparent, always-on-top window that holds the
 * animated mark. The mark is anchored to a screen point the user can drag it
 * to; everything else (arc of buttons, mini composer, message bubbles) stacks
 * upward from that anchor inside the same window.
 *
 * Pass-through model: rather than juggling `setIgnoreMouseEvents` (whose
 * `forward` option is unsupported on Linux, and whose cursor polling fallback
 * is unreliable under XWayland), the window is *resized* between two layouts:
 *
 *   - `compact`: the window is just the mark. Nothing else can intercept
 *     clicks meant for the apps below.
 *   - `full`: the window grows to hold the arc / composer / bubbles while the
 *     mark keeps its exact screen position. The renderer asks for this on
 *     hover, when the composer opens, or while bubbles show, and drops back
 *     to `compact` when idle.
 *
 * The window never has to stay on screen-spanning bounds, so it costs the
 * compositor almost nothing while idle.
 */
import {
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  type IpcMainEvent,
  type Rectangle,
} from "electron";
import {
  COMPANION_COMPACT_SIZE,
  COMPANION_FULL_SIZE,
  COMPANION_MARK_BOTTOM_INSET,
  COMPANION_MARK_SIZE,
  EMPTY_COMPANION_STATE,
  type CompanionAnchor,
  type CompanionEdgeH,
  type CompanionEdgeV,
  type CompanionDragMove,
  type CompanionLayout,
  type CompanionLayoutMode,
  type CompanionState,
} from "@stella/contracts/desktop/companion";
import {
  IPC_COMPANION_DRAG_END,
  IPC_COMPANION_DRAG_MOVE,
  IPC_COMPANION_DRAG_START,
  IPC_COMPANION_FOCUS,
  IPC_COMPANION_LAYOUT,
  IPC_COMPANION_OPEN_MAIN,
  IPC_COMPANION_SET_LAYOUT,
  IPC_COMPANION_SHOW_CONTEXT_MENU,
  IPC_COMPANION_STATE,
} from "@stella/contracts/desktop/ipc-channels";
import {
  getCompanionAnchor,
  setCompanionAnchor,
  setCompanionEnabled,
} from "@stella/runtime/kernel/preferences/local-preferences";
import { t } from "../services/i18n-service.js";
import { STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES } from "../window-capture.js";
import { createSharedWebPreferences } from "./shared-window-preferences.js";
import { loadWindow } from "./window-load.js";

export type CompanionWindowOptions = {
  preloadPath: string;
  sessionPartition: string;
  electronDir: string;
  isDev: boolean;
  getDevServerUrl: () => string;
  isQuitting: () => boolean;
  getStellaDataDir: () => string | null;
  /** Bring the full shell forward (context menu "Open Stella", bubble click). */
  onOpenMain: () => void;
  /** True while a full shell window exists (hidden or not). */
  hasMainWindow: () => boolean;
  onQuit: () => void;
  onVisibleChanged: (visible: boolean) => void;
};

const READY_TIMEOUT_MS = 4_000;
/** Keep this much of the mark inside the work area when clamping. */
const EDGE_MARGIN = 6;

const layoutSize = (mode: CompanionLayoutMode) =>
  mode === "compact" ? COMPANION_COMPACT_SIZE : COMPANION_FULL_SIZE;

/**
 * Linux (X11/XWayland) and Windows can shape a window: the region outside
 * the shape is neither drawn nor hit-testable. There the window keeps the
 * full box permanently and only the *shape* toggles between the mark's
 * corner and the whole box. That avoids resizing entirely — XWayland shows
 * the stale buffer at the window origin for a frame after a resize, which
 * made the mark flash in the wrong corner. macOS has no shape API; it resizes
 * atomically, so the resize path stays.
 */
const USES_WINDOW_SHAPE = process.platform !== "darwin";

export class CompanionWindowController {
  private readonly options: CompanionWindowOptions;
  private window: BrowserWindow | null = null;
  private ready = false;
  private destroyed = false;
  /** Resolves once the renderer has mounted and sent its first layout. */
  private rendererReady: Promise<void>;
  private resolveRendererReady: (() => void) | null = null;
  private layoutMode: CompanionLayoutMode = "compact";
  private anchor: CompanionAnchor | null = null;
  private drag: { offsetX: number; offsetY: number } | null = null;
  private state: CompanionState = EMPTY_COMPANION_STATE;
  private visible = false;
  private displayHandler: (() => void) | null = null;
  /** Bounds we last asked for; a window manager may still override them. */
  private expectedBounds: Rectangle | null = null;
  private boundsRepairTimer: ReturnType<typeof setTimeout> | null = null;
  private boundsRepairs: number[] = [];

  constructor(options: CompanionWindowOptions) {
    this.options = options;
    this.rendererReady = new Promise((resolve) => {
      this.resolveRendererReady = resolve;
    });
    ipcMain.on(IPC_COMPANION_SET_LAYOUT, this.handleSetLayout);
    ipcMain.on(IPC_COMPANION_DRAG_START, this.handleDragStart);
    ipcMain.on(IPC_COMPANION_DRAG_MOVE, this.handleDragMove);
    ipcMain.on(IPC_COMPANION_DRAG_END, this.handleDragEnd);
    ipcMain.on(IPC_COMPANION_FOCUS, this.handleFocus);
    ipcMain.on(IPC_COMPANION_OPEN_MAIN, this.handleOpenMain);
    ipcMain.on(IPC_COMPANION_SHOW_CONTEXT_MENU, this.handleShowContextMenu);
  }

  // ── Public API ────────────────────────────────────────────────────────

  getWindow(): BrowserWindow | null {
    return this.window;
  }

  isVisible(): boolean {
    return Boolean(
      this.visible &&
        this.window &&
        !this.window.isDestroyed() &&
        this.window.isVisible(),
    );
  }

  /** True when `sender` is this window's renderer. */
  isSender(sender: Electron.WebContents): boolean {
    return Boolean(
      this.window &&
        !this.window.isDestroyed() &&
        this.window.webContents === sender,
    );
  }

  getState(): CompanionState {
    return this.state;
  }

  /** Cache + forward the full shell's snapshot to the companion renderer. */
  setState(state: CompanionState): void {
    this.state = state;
    this.send(IPC_COMPANION_STATE, state);
  }

  send(channel: string, payload?: unknown): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(channel, payload);
  }

  /**
   * Show the companion, creating the window on first use. Resolves once the
   * renderer is mounted so callers can immediately send it a message (the
   * dictation shortcut relies on this).
   */
  async show(
    options: { focus?: boolean; persist?: boolean } = {},
  ): Promise<boolean> {
    if (this.destroyed) return false;
    const persist = options.persist ?? true;
    const win = this.create();
    if (!win) return false;
    if (!(await this.waitForReady(win))) return false;
    if (!this.window || this.window.isDestroyed()) return false;
    this.visible = true;
    this.applyLayout(this.layoutMode);
    if (!this.window.isVisible()) {
      if (options.focus) {
        this.window.show();
      } else {
        this.window.showInactive();
      }
    }
    if (options.focus) {
      this.window.focus();
    }
    if (persist) {
      const dir = this.options.getStellaDataDir();
      if (dir) setCompanionEnabled(dir, true);
    }
    this.options.onVisibleChanged(true);
    await Promise.race([
      this.rendererReady,
      new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS)),
    ]);
    return true;
  }

  hide(options: { persist?: boolean } = {}): void {
    const persist = options.persist ?? true;
    this.visible = false;
    this.drag = null;
    if (persist) {
      const dir = this.options.getStellaDataDir();
      if (dir) setCompanionEnabled(dir, false);
    }
    if (this.window && !this.window.isDestroyed()) {
      // With no full shell left, a hidden companion would keep the process
      // alive invisibly on Linux (no tray). Let `window-all-closed` decide.
      if (!this.options.hasMainWindow() && process.platform === "linux") {
        this.destroyWindow();
      } else {
        this.window.hide();
      }
    }
    this.options.onVisibleChanged(false);
  }

  async toggle(): Promise<void> {
    if (this.isVisible()) {
      this.hide();
    } else {
      await this.show({ focus: false });
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    ipcMain.removeListener(IPC_COMPANION_SET_LAYOUT, this.handleSetLayout);
    ipcMain.removeListener(IPC_COMPANION_DRAG_START, this.handleDragStart);
    ipcMain.removeListener(IPC_COMPANION_DRAG_MOVE, this.handleDragMove);
    ipcMain.removeListener(IPC_COMPANION_DRAG_END, this.handleDragEnd);
    ipcMain.removeListener(IPC_COMPANION_FOCUS, this.handleFocus);
    ipcMain.removeListener(IPC_COMPANION_OPEN_MAIN, this.handleOpenMain);
    ipcMain.removeListener(
      IPC_COMPANION_SHOW_CONTEXT_MENU,
      this.handleShowContextMenu,
    );
    this.detachDisplayListeners();
    this.destroyWindow();
  }

  // ── Window lifecycle ──────────────────────────────────────────────────

  private create(): BrowserWindow | null {
    if (this.destroyed) return null;
    if (this.window && !this.window.isDestroyed()) return this.window;

    this.ready = false;
    this.rendererReady = new Promise((resolve) => {
      this.resolveRendererReady = resolve;
    });
    this.layoutMode = "compact";
    const bounds = this.computeBounds("compact", this.resolveAnchor()).bounds;

    const win = new BrowserWindow({
      ...bounds,
      // macOS: a non-activating panel takes keyboard focus for the composer
      // without activating the app or stealing the menu bar — the same
      // treatment the utility overlay uses.
      ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: false,
      title: STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES[0],
      backgroundColor: "#00000000",
      webPreferences: createSharedWebPreferences({
        preloadPath: this.options.preloadPath,
        sessionPartition: this.options.sessionPartition,
        // Always visible on top of everything, so throttling would only ever
        // freeze the mark while a fullscreen app briefly covers it.
        backgroundThrottling: false,
      }),
    });
    this.window = win;
    win.setTitle(STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES[0]);
    win.setAlwaysOnTop(true, "floating");
    win.setContentProtection(true);
    if (process.platform === "darwin") {
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      win.excludedFromShownWindowsMenu = true;
      // The panel must not show up in Mission Control / hidden-window menus.
      win.setHiddenInMissionControl?.(true);
    } else {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    win.once("ready-to-show", () => {
      this.ready = true;
    });
    win.webContents.once("did-finish-load", () => {
      this.ready = true;
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[companion] renderer gone:", details.reason);
      this.ready = false;
      this.scheduleReload();
    });
    win.webContents.on(
      "did-fail-load",
      (_event, errorCode, description, url, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        console.error(
          "[companion] failed to load:",
          errorCode,
          description,
          url,
        );
        this.scheduleReload();
      },
    );
    // The renderer's <title> must not replace the capture-exclusion title.
    win.on("page-title-updated", (event) => {
      event.preventDefault();
    });
    // Tiling window managers (Hyprland, i3, …) may apply size/position rules
    // when the window maps. Re-assert our bounds if they diverge.
    win.on("resize", () => this.scheduleBoundsRepair());
    win.on("move", () => this.scheduleBoundsRepair());
    win.on("close", (event) => {
      if (this.options.isQuitting()) return;
      event.preventDefault();
      this.hide();
    });
    win.on("closed", () => {
      this.window = null;
      this.ready = false;
      this.drag = null;
    });

    loadWindow(win, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: "companion",
      getDevServerUrl: this.options.getDevServerUrl,
    });
    this.attachDisplayListeners();
    return win;
  }

  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleReload(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (!this.window || this.window.isDestroyed()) return;
      loadWindow(this.window, {
        electronDir: this.options.electronDir,
        isDev: this.options.isDev,
        mode: "companion",
        getDevServerUrl: this.options.getDevServerUrl,
      });
    }, 300);
  }

  private waitForReady(
    win: BrowserWindow,
    timeoutMs = READY_TIMEOUT_MS,
  ): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        win.removeListener("ready-to-show", onReady);
        win.removeListener("closed", onClosed);
        win.webContents.removeListener("did-finish-load", onReady);
        resolve(value);
      };
      const onReady = () => {
        this.ready = true;
        finish(true);
      };
      const onClosed = () => finish(false);
      const timer = setTimeout(() => finish(this.ready), timeoutMs);
      win.once("ready-to-show", onReady);
      win.once("closed", onClosed);
      win.webContents.once("did-finish-load", onReady);
    });
  }

  /**
   * If the window manager overrode the bounds we asked for, ask again — but
   * only a few times per second so a WM that refuses never starts a loop.
   */
  private scheduleBoundsRepair(): void {
    if (this.boundsRepairTimer || this.drag) return;
    this.boundsRepairTimer = setTimeout(() => {
      this.boundsRepairTimer = null;
      const win = this.window;
      const expected = this.expectedBounds;
      if (!win || win.isDestroyed() || !expected || this.drag) return;
      const actual = win.getBounds();
      if (
        actual.x === expected.x &&
        actual.y === expected.y &&
        actual.width === expected.width &&
        actual.height === expected.height
      ) {
        return;
      }
      const now = Date.now();
      this.boundsRepairs = this.boundsRepairs.filter((at) => now - at < 1_000);
      if (this.boundsRepairs.length >= 3) return;
      this.boundsRepairs.push(now);
      win.setBounds(expected, false);
    }, 120);
  }

  private destroyWindow(): void {
    if (this.boundsRepairTimer) {
      clearTimeout(this.boundsRepairTimer);
      this.boundsRepairTimer = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.window) {
      this.window.removeAllListeners("close");
      if (!this.window.isDestroyed()) this.window.destroy();
      this.window = null;
    }
    this.ready = false;
  }

  private attachDisplayListeners(): void {
    if (this.displayHandler) return;
    this.displayHandler = () => {
      if (!this.window || this.window.isDestroyed()) return;
      this.anchor = this.clampAnchor(this.resolveAnchor());
      this.applyLayout(this.layoutMode);
    };
    screen.on("display-added", this.displayHandler);
    screen.on("display-removed", this.displayHandler);
    screen.on("display-metrics-changed", this.displayHandler);
  }

  private detachDisplayListeners(): void {
    if (!this.displayHandler) return;
    screen.removeListener("display-added", this.displayHandler);
    screen.removeListener("display-removed", this.displayHandler);
    screen.removeListener("display-metrics-changed", this.displayHandler);
    this.displayHandler = null;
  }

  // ── Geometry ──────────────────────────────────────────────────────────

  private resolveAnchor(): CompanionAnchor {
    if (this.anchor) return this.anchor;
    const dir = this.options.getStellaDataDir();
    const saved = dir ? getCompanionAnchor(dir) : null;
    if (saved) {
      this.anchor = this.clampAnchor(saved);
      return this.anchor;
    }
    const area = screen.getPrimaryDisplay().workArea;
    this.anchor = {
      x: area.x + area.width - 32 - COMPANION_MARK_SIZE / 2,
      y: area.y + area.height - 28,
    };
    return this.anchor;
  }

  /** Keep the mark itself fully inside the work area of its display. */
  private clampAnchor(anchor: CompanionAnchor): CompanionAnchor {
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    const half = COMPANION_MARK_SIZE / 2;
    return {
      x: Math.round(
        Math.min(
          Math.max(anchor.x, area.x + half + EDGE_MARGIN),
          area.x + area.width - half - EDGE_MARGIN,
        ),
      ),
      y: Math.round(
        Math.min(
          Math.max(anchor.y, area.y + COMPANION_MARK_SIZE + EDGE_MARGIN),
          area.y + area.height - EDGE_MARGIN,
        ),
      ),
    };
  }

  /**
   * Window bounds for a layout, with the mark pinned at `anchor`.
   *
   * The compact box is centered on the mark. The full box keeps the compact
   * box's edges that face the nearer screen borders fixed and grows toward
   * the screen center, so the mark's position relative to those edges is the
   * same in both layouts and the renderer can pin it with plain CSS — no
   * frame ever shows the mark somewhere else while the window resizes.
   */
  private computeBounds(
    mode: CompanionLayoutMode,
    anchor: CompanionAnchor,
  ): { bounds: Rectangle; layout: CompanionLayout } {
    const area = screen.getDisplayNearestPoint(anchor).workArea;
    const compact = COMPANION_COMPACT_SIZE;
    const compactX = Math.round(anchor.x - compact.width / 2);
    const compactY = Math.round(
      anchor.y + COMPANION_MARK_BOTTOM_INSET - compact.height,
    );
    const edgeH: CompanionEdgeH =
      anchor.x > area.x + area.width / 2 ? "right" : "left";
    const edgeV: CompanionEdgeV =
      anchor.y > area.y + area.height / 2 ? "bottom" : "top";
    const size = layoutSize(USES_WINDOW_SHAPE ? "full" : mode);
    let x =
      edgeH === "right" ? compactX + compact.width - size.width : compactX;
    let y =
      edgeV === "bottom" ? compactY + compact.height - size.height : compactY;
    x = Math.min(Math.max(x, area.x), area.x + area.width - size.width);
    y = Math.min(Math.max(y, area.y), area.y + area.height - size.height);
    return {
      bounds: { x, y, width: size.width, height: size.height },
      layout: { mode, width: size.width, height: size.height, edgeH, edgeV },
    };
  }

  private applyLayout(mode: CompanionLayoutMode): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.layoutMode = mode;
    const { bounds, layout } = this.computeBounds(mode, this.resolveAnchor());
    this.expectedBounds = bounds;
    this.window.setBounds(bounds, false);
    this.applyShape(layout);
    this.lastLayout = layout;
    this.send(IPC_COMPANION_LAYOUT, layout);
  }

  private lastLayout: CompanionLayout | null = null;

  /** Restrict the drawn + hit-testable region to the mark's corner while compact. */
  private applyShape(layout: CompanionLayout): void {
    if (!USES_WINDOW_SHAPE || !this.window || this.window.isDestroyed()) return;
    if (layout.mode === "full") {
      this.window.setShape([]);
      return;
    }
    const compact = COMPANION_COMPACT_SIZE;
    this.window.setShape([
      {
        x: layout.edgeH === "right" ? layout.width - compact.width : 0,
        y: layout.edgeV === "bottom" ? layout.height - compact.height : 0,
        width: compact.width,
        height: compact.height,
      },
    ]);
  }

  // ── IPC from the companion renderer ───────────────────────────────────

  private handleSetLayout = (
    event: IpcMainEvent,
    mode: CompanionLayoutMode,
  ) => {
    if (!this.isSender(event.sender)) return;
    if (mode !== "compact" && mode !== "full") return;
    this.resolveRendererReady?.();
    this.resolveRendererReady = null;
    // Dragging always happens in the compact box; a layout change mid-drag
    // would move the mark under the cursor.
    if (this.drag && mode !== "compact") return;
    this.applyLayout(mode);
  };

  private handleDragStart = (
    event: IpcMainEvent,
    cursor: CompanionDragMove,
  ) => {
    if (!this.isSender(event.sender)) return;
    if (
      !cursor ||
      typeof cursor.screenX !== "number" ||
      typeof cursor.screenY !== "number"
    )
      return;
    const anchor = this.resolveAnchor();
    this.drag = {
      offsetX: cursor.screenX - anchor.x,
      offsetY: cursor.screenY - anchor.y,
    };
    if (this.layoutMode !== "compact") this.applyLayout("compact");
  };

  private handleDragMove = (event: IpcMainEvent, cursor: CompanionDragMove) => {
    if (!this.isSender(event.sender) || !this.drag) return;
    if (
      !cursor ||
      typeof cursor.screenX !== "number" ||
      typeof cursor.screenY !== "number"
    )
      return;
    this.anchor = this.clampAnchor({
      x: cursor.screenX - this.drag.offsetX,
      y: cursor.screenY - this.drag.offsetY,
    });
    if (!this.window || this.window.isDestroyed()) return;
    const { bounds, layout } = this.computeBounds("compact", this.anchor);
    this.expectedBounds = bounds;
    this.window.setPosition(bounds.x, bounds.y, false);
    // Crossing the screen center flips which edges the box hangs from; the
    // renderer must re-pin the mark (and the shape must follow) right away.
    if (
      this.lastLayout &&
      (this.lastLayout.edgeH !== layout.edgeH ||
        this.lastLayout.edgeV !== layout.edgeV)
    ) {
      this.applyShape(layout);
      this.lastLayout = layout;
      this.send(IPC_COMPANION_LAYOUT, layout);
    }
  };

  private handleDragEnd = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    this.drag = null;
    const dir = this.options.getStellaDataDir();
    if (dir && this.anchor) setCompanionAnchor(dir, this.anchor);
    // Re-send the layout: the clamp may have shifted the window relative to
    // where the renderer believes the mark sits.
    this.applyLayout("compact");
  };

  private handleFocus = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    if (!this.window || this.window.isDestroyed()) return;
    if (!this.window.isFocused()) this.window.focus();
  };

  private handleOpenMain = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    this.options.onOpenMain();
  };

  private handleShowContextMenu = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    if (!this.window || this.window.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      {
        label: t("companion.menu.openStella"),
        click: () => this.options.onOpenMain(),
      },
      { type: "separator" },
      { label: t("companion.menu.hide"), click: () => this.hide() },
      { label: t("companion.menu.quit"), click: () => this.options.onQuit() },
    ]);
    menu.popup({ window: this.window });
  };
}
