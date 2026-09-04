/**
 * Companion windows — the floating desktop Stella.
 *
 * Two frameless, transparent, always-on-top windows share one screen anchor
 * (the center-bottom of the mark):
 *
 *   - the **mark** window: a small box holding the animated mark. It is the
 *     only permanent hit target and owns hover, click, drag, and the context
 *     menu. It never resizes.
 *   - the **panel** window: a fixed full-size box behind the mark that holds
 *     the arc of buttons, the mini composer, and the message bubbles. It is
 *     click-through until the mark is hovered or the panel has content to
 *     show, then it takes input; its transparent pixels never show.
 *
 * Nothing resizes and no window's input region changes while the pointer is
 * over it: the panel's input toggles while the pointer sits on the mark
 * window. That sidesteps XWayland's stale-buffer flash on resize and the
 * enter/leave storms a shape change under the pointer produces. Main holds
 * the combined interaction state (hover across both windows with a grace
 * period, panel wanted-visible) and broadcasts it to both renderers.
 */
import {
  BrowserWindow,
  ipcMain,
  Menu,
  screen,
  type IpcMainEvent,
  type Rectangle,
  type WebContents,
} from "electron";
import {
  COMPANION_COMPACT_SIZE,
  COMPANION_FULL_SIZE,
  COMPANION_MARK_BOTTOM_INSET,
  COMPANION_MARK_SIZE,
  EMPTY_COMPANION_STATE,
  type CompanionActivity,
  type CompanionAnchor,
  type CompanionDragMove,
  type CompanionEdgeH,
  type CompanionEdgeV,
  type CompanionLayout,
  type CompanionPanelStatus,
  type CompanionState,
  type CompanionWindowKind,
} from "@stella/contracts/desktop/companion";
import {
  IPC_COMPANION_ACTIVITY,
  IPC_COMPANION_DRAG_END,
  IPC_COMPANION_DRAG_MOVE,
  IPC_COMPANION_DRAG_START,
  IPC_COMPANION_FOCUS,
  IPC_COMPANION_HELLO,
  IPC_COMPANION_HOVER,
  IPC_COMPANION_LAYOUT,
  IPC_COMPANION_OPEN_MAIN,
  IPC_COMPANION_PANEL_STATUS,
  IPC_COMPANION_SET_EXPANDED,
  IPC_COMPANION_SHOW_CONTEXT_MENU,
  IPC_COMPANION_STATE,
  IPC_COMPANION_TOGGLE_EXPANDED,
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
/** Hover survives this long after the pointer leaves both windows. */
const HOVER_GRACE_MS = 340;

const IDLE_ACTIVITY: CompanionActivity = {
  hovered: false,
  panelActive: false,
  expanded: false,
  recording: false,
  transcribing: false,
};

const IDLE_PANEL_STATUS: CompanionPanelStatus = {
  expanded: false,
  recording: false,
  transcribing: false,
  wantsVisible: false,
};

type Slot = {
  kind: CompanionWindowKind;
  window: BrowserWindow | null;
  ready: boolean;
  /** Renderer mounted and said hello. */
  hello: boolean;
  reloadTimer: ReturnType<typeof setTimeout> | null;
};

const loadModeFor = (kind: CompanionWindowKind) =>
  kind === "mark" ? ("companion" as const) : ("companion-panel" as const);

const sameActivity = (a: CompanionActivity, b: CompanionActivity) =>
  a.hovered === b.hovered &&
  a.panelActive === b.panelActive &&
  a.expanded === b.expanded &&
  a.recording === b.recording &&
  a.transcribing === b.transcribing;

export class CompanionWindowController {
  private readonly options: CompanionWindowOptions;
  private readonly mark: Slot = {
    kind: "mark",
    window: null,
    ready: false,
    hello: false,
    reloadTimer: null,
  };
  private readonly panel: Slot = {
    kind: "panel",
    window: null,
    ready: false,
    hello: false,
    reloadTimer: null,
  };
  private destroyed = false;
  private visible = false;
  private anchor: CompanionAnchor | null = null;
  private drag: { offsetX: number; offsetY: number } | null = null;
  private state: CompanionState = EMPTY_COMPANION_STATE;
  private displayHandler: (() => void) | null = null;
  private lastEdges: { edgeH: CompanionEdgeH; edgeV: CompanionEdgeV } | null =
    null;
  private expectedBounds: Partial<Record<CompanionWindowKind, Rectangle>> = {};
  private boundsRepairTimer: ReturnType<typeof setTimeout> | null = null;
  private boundsRepairs: number[] = [];
  private helloWaiters = new Map<CompanionWindowKind, Array<() => void>>();

  // Interaction state.
  private markHovered = false;
  private panelHovered = false;
  private hoverGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private hovered = false;
  private panelStatus: CompanionPanelStatus = IDLE_PANEL_STATUS;
  private activity: CompanionActivity = IDLE_ACTIVITY;

  constructor(options: CompanionWindowOptions) {
    this.options = options;
    ipcMain.on(IPC_COMPANION_HELLO, this.handleHello);
    ipcMain.on(IPC_COMPANION_HOVER, this.handleHover);
    ipcMain.on(IPC_COMPANION_PANEL_STATUS, this.handlePanelStatus);
    ipcMain.on(IPC_COMPANION_TOGGLE_EXPANDED, this.handleToggleExpanded);
    ipcMain.on(IPC_COMPANION_DRAG_START, this.handleDragStart);
    ipcMain.on(IPC_COMPANION_DRAG_MOVE, this.handleDragMove);
    ipcMain.on(IPC_COMPANION_DRAG_END, this.handleDragEnd);
    ipcMain.on(IPC_COMPANION_FOCUS, this.handleFocus);
    ipcMain.on(IPC_COMPANION_OPEN_MAIN, this.handleOpenMain);
    ipcMain.on(IPC_COMPANION_SHOW_CONTEXT_MENU, this.handleShowContextMenu);
  }

  // ── Public API ────────────────────────────────────────────────────────

  /** The panel window: where dictation and the composer live. */
  getPanelWindow(): BrowserWindow | null {
    return this.live(this.panel);
  }

  getMarkWindow(): BrowserWindow | null {
    return this.live(this.mark);
  }

  isVisible(): boolean {
    const mark = this.live(this.mark);
    return Boolean(this.visible && mark && mark.isVisible());
  }

  /** True when `sender` is one of the companion renderers. */
  isSender(sender: WebContents): boolean {
    return this.kindOf(sender) !== null;
  }

  getState(): CompanionState {
    return this.state;
  }

  /** Cache + forward the full shell's snapshot to both renderers. */
  setState(state: CompanionState): void {
    this.state = state;
    this.sendToBoth(IPC_COMPANION_STATE, state);
  }

  /** Send to the panel renderer (composer, dictation). */
  sendToPanel(channel: string, payload?: unknown): void {
    this.live(this.panel)?.webContents.send(channel, payload);
  }

  /**
   * Show the companion, creating both windows on first use. Resolves once
   * the panel renderer is mounted so callers can immediately send it a
   * message (the dictation shortcut relies on this).
   */
  async show(
    options: { focus?: boolean; persist?: boolean } = {},
  ): Promise<boolean> {
    if (this.destroyed) return false;
    const persist = options.persist ?? true;
    if (!this.create(this.panel) || !this.create(this.mark)) return false;
    const ready = await Promise.all([
      this.waitForReady(this.panel),
      this.waitForReady(this.mark),
    ]);
    if (!ready.every(Boolean)) return false;
    const panel = this.live(this.panel);
    const mark = this.live(this.mark);
    if (!panel || !mark) return false;
    this.visible = true;
    this.applyBounds();
    if (!panel.isVisible()) panel.showInactive();
    if (!mark.isVisible()) mark.showInactive();
    // The mark must stack above the panel so it stays the hit target.
    mark.moveTop();
    this.applyPanelInteractivity();
    if (options.focus) panel.focus();
    if (persist) {
      const dir = this.options.getStellaDataDir();
      if (dir) setCompanionEnabled(dir, true);
    }
    this.options.onVisibleChanged(true);
    await this.waitForHello(this.panel);
    return true;
  }

  hide(options: { persist?: boolean } = {}): void {
    const persist = options.persist ?? true;
    this.visible = false;
    this.drag = null;
    this.resetInteraction();
    if (persist) {
      const dir = this.options.getStellaDataDir();
      if (dir) setCompanionEnabled(dir, false);
    }
    // With no full shell left, hidden companion windows would keep the
    // process alive invisibly on Linux (no tray). Let `window-all-closed`
    // decide.
    const destroyInstead =
      !this.options.hasMainWindow() && process.platform === "linux";
    for (const slot of [this.mark, this.panel]) {
      const win = this.live(slot);
      if (!win) continue;
      if (destroyInstead) {
        this.destroySlot(slot);
      } else {
        win.hide();
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
    ipcMain.removeListener(IPC_COMPANION_HELLO, this.handleHello);
    ipcMain.removeListener(IPC_COMPANION_HOVER, this.handleHover);
    ipcMain.removeListener(IPC_COMPANION_PANEL_STATUS, this.handlePanelStatus);
    ipcMain.removeListener(
      IPC_COMPANION_TOGGLE_EXPANDED,
      this.handleToggleExpanded,
    );
    ipcMain.removeListener(IPC_COMPANION_DRAG_START, this.handleDragStart);
    ipcMain.removeListener(IPC_COMPANION_DRAG_MOVE, this.handleDragMove);
    ipcMain.removeListener(IPC_COMPANION_DRAG_END, this.handleDragEnd);
    ipcMain.removeListener(IPC_COMPANION_FOCUS, this.handleFocus);
    ipcMain.removeListener(IPC_COMPANION_OPEN_MAIN, this.handleOpenMain);
    ipcMain.removeListener(
      IPC_COMPANION_SHOW_CONTEXT_MENU,
      this.handleShowContextMenu,
    );
    this.resetInteraction();
    this.detachDisplayListeners();
    if (this.boundsRepairTimer) {
      clearTimeout(this.boundsRepairTimer);
      this.boundsRepairTimer = null;
    }
    this.destroySlot(this.mark);
    this.destroySlot(this.panel);
  }

  // ── Window lifecycle ──────────────────────────────────────────────────

  private live(slot: Slot): BrowserWindow | null {
    return slot.window && !slot.window.isDestroyed() ? slot.window : null;
  }

  private kindOf(sender: WebContents): CompanionWindowKind | null {
    if (this.live(this.mark)?.webContents === sender) return "mark";
    if (this.live(this.panel)?.webContents === sender) return "panel";
    return null;
  }

  private slotFor(kind: CompanionWindowKind): Slot {
    return kind === "mark" ? this.mark : this.panel;
  }

  private sendToBoth(channel: string, payload?: unknown): void {
    for (const slot of [this.mark, this.panel]) {
      this.live(slot)?.webContents.send(channel, payload);
    }
  }

  private create(slot: Slot): BrowserWindow | null {
    if (this.destroyed) return null;
    const existing = this.live(slot);
    if (existing) return existing;

    slot.ready = false;
    slot.hello = false;
    const { bounds } = this.computeBounds(slot.kind, this.resolveAnchor());
    const isMark = slot.kind === "mark";

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
      // The mark never needs the keyboard; keeping it unfocusable means a
      // click on it never steals focus from the app the user is in.
      focusable: !isMark,
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
    slot.window = win;
    win.setTitle(STELLA_CAPTURE_EXCLUDED_TITLE_PREFIXES[0]);
    win.setAlwaysOnTop(true, "floating");
    win.setContentProtection(true);
    if (process.platform === "darwin") {
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
      win.excludedFromShownWindowsMenu = true;
      win.setHiddenInMissionControl?.(true);
    } else {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    if (!isMark) {
      // Click-through until hovered / wanted (see applyPanelInteractivity).
      win.setIgnoreMouseEvents(true);
    }

    win.once("ready-to-show", () => {
      slot.ready = true;
    });
    win.webContents.once("did-finish-load", () => {
      slot.ready = true;
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error(`[companion] ${slot.kind} renderer gone:`, details.reason);
      slot.ready = false;
      slot.hello = false;
      this.scheduleReload(slot);
    });
    win.webContents.on(
      "did-fail-load",
      (_event, errorCode, description, url, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return;
        console.error(
          `[companion] ${slot.kind} failed to load:`,
          errorCode,
          description,
          url,
        );
        this.scheduleReload(slot);
      },
    );
    // The renderer's <title> must not replace the capture-exclusion title.
    win.on("page-title-updated", (event) => {
      event.preventDefault();
    });
    // Tiling window managers may apply size/position rules when the window
    // maps. Re-assert our bounds if they diverge.
    win.on("resize", () => this.scheduleBoundsRepair());
    win.on("move", () => this.scheduleBoundsRepair());
    win.on("close", (event) => {
      if (this.options.isQuitting()) return;
      event.preventDefault();
      this.hide();
    });
    win.on("closed", () => {
      slot.window = null;
      slot.ready = false;
      slot.hello = false;
      this.drag = null;
    });

    loadWindow(win, {
      electronDir: this.options.electronDir,
      isDev: this.options.isDev,
      mode: loadModeFor(slot.kind),
      getDevServerUrl: this.options.getDevServerUrl,
    });
    this.attachDisplayListeners();
    return win;
  }

  private scheduleReload(slot: Slot): void {
    if (slot.reloadTimer) return;
    slot.reloadTimer = setTimeout(() => {
      slot.reloadTimer = null;
      const win = this.live(slot);
      if (!win) return;
      loadWindow(win, {
        electronDir: this.options.electronDir,
        isDev: this.options.isDev,
        mode: loadModeFor(slot.kind),
        getDevServerUrl: this.options.getDevServerUrl,
      });
    }, 300);
  }

  private waitForReady(
    slot: Slot,
    timeoutMs = READY_TIMEOUT_MS,
  ): Promise<boolean> {
    const win = this.live(slot);
    if (!win) return Promise.resolve(false);
    if (slot.ready) return Promise.resolve(true);
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
        slot.ready = true;
        finish(true);
      };
      const onClosed = () => finish(false);
      const timer = setTimeout(() => finish(slot.ready), timeoutMs);
      win.once("ready-to-show", onReady);
      win.once("closed", onClosed);
      win.webContents.once("did-finish-load", onReady);
    });
  }

  private waitForHello(
    slot: Slot,
    timeoutMs = READY_TIMEOUT_MS,
  ): Promise<void> {
    if (slot.hello) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const waiters = this.helloWaiters.get(slot.kind) ?? [];
      waiters.push(done);
      this.helloWaiters.set(slot.kind, waiters);
    });
  }

  private destroySlot(slot: Slot): void {
    if (slot.reloadTimer) {
      clearTimeout(slot.reloadTimer);
      slot.reloadTimer = null;
    }
    if (slot.window) {
      slot.window.removeAllListeners("close");
      if (!slot.window.isDestroyed()) slot.window.destroy();
      slot.window = null;
    }
    slot.ready = false;
    slot.hello = false;
  }

  private attachDisplayListeners(): void {
    if (this.displayHandler) return;
    this.displayHandler = () => {
      this.anchor = this.clampAnchor(this.resolveAnchor());
      this.applyBounds();
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
   * Bounds for one window, with the mark pinned at `anchor`.
   *
   * The mark box is centered on the mark. The panel box keeps the mark box's
   * edges that face the nearer screen borders and grows toward the screen
   * center, so the panel can pin its content relative to those edges.
   */
  private computeBounds(
    kind: CompanionWindowKind,
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
    const size = kind === "mark" ? compact : COMPANION_FULL_SIZE;
    let x =
      edgeH === "right" ? compactX + compact.width - size.width : compactX;
    let y =
      edgeV === "bottom" ? compactY + compact.height - size.height : compactY;
    x = Math.min(Math.max(x, area.x), area.x + area.width - size.width);
    y = Math.min(Math.max(y, area.y), area.y + area.height - size.height);
    return {
      bounds: { x, y, width: size.width, height: size.height },
      layout: { kind, width: size.width, height: size.height, edgeH, edgeV },
    };
  }

  /** Position both windows for the current anchor; re-send edges on change. */
  private applyBounds(): void {
    const anchor = this.resolveAnchor();
    let edges: { edgeH: CompanionEdgeH; edgeV: CompanionEdgeV } | null = null;
    for (const slot of [this.panel, this.mark]) {
      const win = this.live(slot);
      if (!win) continue;
      const { bounds, layout } = this.computeBounds(slot.kind, anchor);
      this.expectedBounds[slot.kind] = bounds;
      win.setBounds(bounds, false);
      edges = { edgeH: layout.edgeH, edgeV: layout.edgeV };
      if (
        !this.lastEdges ||
        this.lastEdges.edgeH !== layout.edgeH ||
        this.lastEdges.edgeV !== layout.edgeV
      ) {
        win.webContents.send(IPC_COMPANION_LAYOUT, layout);
      }
    }
    if (edges) this.lastEdges = edges;
  }

  private sendLayout(kind: CompanionWindowKind): void {
    const win = this.live(this.slotFor(kind));
    if (!win) return;
    const { layout } = this.computeBounds(kind, this.resolveAnchor());
    win.webContents.send(IPC_COMPANION_LAYOUT, layout);
  }

  /**
   * If the window manager overrode the bounds we asked for, ask again — but
   * only a few times per second so a WM that refuses never starts a loop.
   */
  private scheduleBoundsRepair(): void {
    if (this.boundsRepairTimer || this.drag) return;
    this.boundsRepairTimer = setTimeout(() => {
      this.boundsRepairTimer = null;
      if (this.drag) return;
      const now = Date.now();
      this.boundsRepairs = this.boundsRepairs.filter((at) => now - at < 1_000);
      for (const slot of [this.mark, this.panel]) {
        const win = this.live(slot);
        const expected = this.expectedBounds[slot.kind];
        if (!win || !expected) continue;
        const actual = win.getBounds();
        if (
          actual.x === expected.x &&
          actual.y === expected.y &&
          actual.width === expected.width &&
          actual.height === expected.height
        ) {
          continue;
        }
        if (this.boundsRepairs.length >= 3) return;
        this.boundsRepairs.push(now);
        win.setBounds(expected, false);
      }
    }, 120);
  }

  // ── Interaction state ─────────────────────────────────────────────────

  private resetInteraction(): void {
    if (this.hoverGraceTimer) {
      clearTimeout(this.hoverGraceTimer);
      this.hoverGraceTimer = null;
    }
    this.markHovered = false;
    this.panelHovered = false;
    this.hovered = false;
    this.panelStatus = IDLE_PANEL_STATUS;
    this.activity = IDLE_ACTIVITY;
  }

  private updateHover(): void {
    const raw = this.markHovered || this.panelHovered;
    if (raw) {
      if (this.hoverGraceTimer) {
        clearTimeout(this.hoverGraceTimer);
        this.hoverGraceTimer = null;
      }
      if (!this.hovered) {
        this.hovered = true;
        this.publishActivity();
      }
      return;
    }
    if (!this.hovered || this.hoverGraceTimer) return;
    // Leaving one window for the other passes through a moment with neither
    // hovered; the grace keeps the arc up across that hop.
    this.hoverGraceTimer = setTimeout(() => {
      this.hoverGraceTimer = null;
      if (this.markHovered || this.panelHovered) return;
      this.hovered = false;
      this.publishActivity();
    }, HOVER_GRACE_MS);
  }

  private publishActivity(): void {
    const next: CompanionActivity = {
      hovered: this.hovered,
      panelActive: this.hovered || this.panelStatus.wantsVisible,
      expanded: this.panelStatus.expanded,
      recording: this.panelStatus.recording,
      transcribing: this.panelStatus.transcribing,
    };
    if (sameActivity(next, this.activity)) return;
    const wasActive = this.activity.panelActive;
    this.activity = next;
    if (next.panelActive !== wasActive) this.applyPanelInteractivity();
    this.sendToBoth(IPC_COMPANION_ACTIVITY, next);
  }

  private applyPanelInteractivity(): void {
    const panel = this.live(this.panel);
    if (!panel) return;
    if (this.activity.panelActive) {
      panel.setIgnoreMouseEvents(false);
      // Keep the mark on top: it is the hit target inside the panel's box.
      this.live(this.mark)?.moveTop();
    } else {
      panel.setIgnoreMouseEvents(true);
    }
  }

  // ── IPC from the companion renderers ──────────────────────────────────

  private handleHello = (event: IpcMainEvent) => {
    const kind = this.kindOf(event.sender);
    if (!kind) return;
    this.slotFor(kind).hello = true;
    this.sendLayout(kind);
    event.sender.send(IPC_COMPANION_STATE, this.state);
    event.sender.send(IPC_COMPANION_ACTIVITY, this.activity);
    const waiters = this.helloWaiters.get(kind) ?? [];
    this.helloWaiters.delete(kind);
    for (const done of waiters) done();
  };

  private handleHover = (event: IpcMainEvent, hovered: boolean) => {
    const kind = this.kindOf(event.sender);
    if (!kind) return;
    if (kind === "mark") this.markHovered = hovered === true;
    else this.panelHovered = hovered === true;
    this.updateHover();
  };

  private handlePanelStatus = (
    event: IpcMainEvent,
    status: CompanionPanelStatus,
  ) => {
    if (this.kindOf(event.sender) !== "panel") return;
    if (!status || typeof status !== "object") return;
    this.panelStatus = {
      expanded: status.expanded === true,
      recording: status.recording === true,
      transcribing: status.transcribing === true,
      wantsVisible: status.wantsVisible === true,
    };
    this.publishActivity();
  };

  private handleToggleExpanded = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    this.sendToPanel(IPC_COMPANION_SET_EXPANDED, {
      expanded: !this.panelStatus.expanded,
    });
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
    // Dragging closes the composer: the panel follows the mark, and nothing
    // should stay open while the user is moving it.
    this.sendToPanel(IPC_COMPANION_SET_EXPANDED, { expanded: false });
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
    this.applyBounds();
  };

  private handleDragEnd = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    this.drag = null;
    const dir = this.options.getStellaDataDir();
    if (dir && this.anchor) setCompanionAnchor(dir, this.anchor);
    this.applyBounds();
  };

  private handleFocus = (event: IpcMainEvent) => {
    if (this.kindOf(event.sender) !== "panel") return;
    const panel = this.live(this.panel);
    if (panel && !panel.isFocused()) panel.focus();
  };

  private handleOpenMain = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    this.options.onOpenMain();
  };

  private handleShowContextMenu = (event: IpcMainEvent) => {
    if (!this.isSender(event.sender)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const menu = Menu.buildFromTemplate([
      {
        label: t("companion.menu.openStella"),
        click: () => this.options.onOpenMain(),
      },
      { type: "separator" },
      { label: t("companion.menu.hide"), click: () => this.hide() },
      { label: t("companion.menu.quit"), click: () => this.options.onQuit() },
    ]);
    menu.popup({ window: win });
  };
}
