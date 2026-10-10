import { BrowserWindow, type Rectangle, type WebContentsView } from "electron";
import type {
  InAppBrowserDebuggerEvent,
  InAppBrowserDebuggerRecovery,
  InAppBrowserDebuggerTarget,
} from "../in-app-browser-cdp-adapter.js";
import type { InAppBrowserDrawableLease } from "../in-app-browser-service.js";
import { RENDERER_ORIGIN } from "../../source/origin.js";
import {
  readTabUrl,
  resolveOwnerId,
  type BrowserTabRegistry,
  type ManagedTab,
} from "./tab-registry.js";

type DrawableLease = {
  count: number;
  mountedInHiddenHost: boolean;
};

type DebuggerTargetProxyOptions = {
  tabs: BrowserTabRegistry;
  /** The tab view currently mounted in the visible window, if any. */
  getAttachedView: () => WebContentsView | null;
  getPageBounds: () => Rectangle | undefined;
  /** Re-mounts the visible tab once a lease no longer holds it. */
  attachActiveView: () => void;
  createDrawableHost?: () => BrowserWindow;
  /** Keep the drawable host unmapped and force frames on demand. */
  hideDrawableHost: boolean;
  wait?: (delayMs: number) => Promise<void>;
  debuggerRecoveryTimeoutMs?: number;
};

export const isRendererUrl = (value: string) =>
  value.startsWith(`${RENDERER_ORIGIN}/`);
const DRAWABLE_HOST_BOUNDS: Rectangle = {
  x: -100_000,
  y: -100_000,
  width: 1280,
  height: 720,
};
// Gap between forced frames while a command waits on an unmapped host.
const DRAWABLE_HOST_FRAME_PUMP_MS = 16;
const DEFAULT_DEBUGGER_RECOVERY_TIMEOUT_MS = 1_000;

/**
 * Routes CDP commands and events between agents and the in-app tabs, and keeps
 * a tab drawable while a command runs against it: a tab that is not the
 * visible one is mounted in a hidden host window under a counted lease.
 */
export class DebuggerTargetProxy {
  private readonly options: DebuggerTargetProxyOptions;
  private readonly drawableLeases = new Map<string, DrawableLease>();
  private readonly debuggerListeners = new Set<
    (event: InAppBrowserDebuggerEvent) => void
  >();
  private drawableHost: BrowserWindow | null = null;

  constructor(options: DebuggerTargetProxyOptions) {
    this.options = options;
  }

  listTargets(ownerId?: string): InAppBrowserDebuggerTarget[] {
    const tabIds = this.options.tabs.ownerTabIds(resolveOwnerId(ownerId));
    if (!tabIds) return [];
    return tabIds.flatMap((tabId) => {
      const tab = this.options.tabs.get(tabId);
      if (!tab || tab.view.webContents.isDestroyed()) return [];
      return [{ id: tab.id, url: readTabUrl(tab), title: tab.title }];
    });
  }

  async sendCommand(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    ownerId?: string,
    debuggerSessionId?: string,
  ): Promise<unknown> {
    const resolvedOwnerId = resolveOwnerId(ownerId);
    const tab = this.options.tabs.require(tabId, resolvedOwnerId);
    if (
      tab.preview &&
      method === "Page.navigate" &&
      !isRendererUrl(String(params?.url ?? ""))
    ) {
      throw new Error(
        "A Stella preview tab only shows Stella. Open web pages in a new tab.",
      );
    }
    const tabDebugger = tab.view.webContents.debugger;
    if (!tabDebugger.isAttached()) tabDebugger.attach();
    // Electron gives an unattached WebContentsView a 0x0 layout viewport. CDP
    // Runtime queries and Input commands need the same drawable mount as
    // screenshots; otherwise discovery succeeds but actionability/scrolling
    // fails against viewport=0x0. The hidden host never replaces the visible
    // manual view, and the scoped lease restores the prior mount after every
    // command (including failures).
    const lease = this.acquireDrawableHost(tabId, resolvedOwnerId);
    try {
      await this.settleDrawableHost(tabId);
      const command = Promise.resolve(
        tabDebugger.sendCommand(method, params, debuggerSessionId),
      );
      if (
        this.options.hideDrawableHost &&
        this.drawableLeases.get(tabId)?.mountedInHiddenHost
      ) {
        this.pumpFramesUntilSettled(tab, command);
      }
      return await command;
    } finally {
      lease.release();
    }
  }

  async recoverTarget(
    tabId: string,
    ownerId?: string,
    debuggerSessionId?: string,
  ): Promise<InAppBrowserDebuggerRecovery> {
    const tab = this.options.tabs.require(tabId, resolveOwnerId(ownerId));
    const contents = tab.view.webContents;
    const tabDebugger = contents.debugger;
    const timeoutMs =
      this.options.debuggerRecoveryTimeoutMs ??
      DEFAULT_DEBUGGER_RECOVERY_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    let terminated = false;

    try {
      if (!tabDebugger.isAttached()) tabDebugger.attach();
      terminated = await Promise.race([
        Promise.resolve(
          tabDebugger.sendCommand(
            "Runtime.terminateExecution",
            {},
            debuggerSessionId,
          ),
        ).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch {
      terminated = false;
    } finally {
      clearTimeout(timer);
    }

    if (terminated) return "terminated";
    if (contents.isDestroyed()) {
      throw new Error("Browser tab was destroyed during page recovery.");
    }
    contents.reload();
    return "reloaded";
  }

  acquireDrawableHost(
    tabId: string,
    ownerId?: string,
  ): InAppBrowserDrawableLease {
    const tab = this.options.tabs.require(tabId, resolveOwnerId(ownerId));
    const attachedView = this.options.getAttachedView();
    let lease = this.drawableLeases.get(tabId);
    if (lease) {
      lease.count += 1;
      if (
        attachedView !== tab.view &&
        (!lease.mountedInHiddenHost || this.drawableHost?.isDestroyed())
      ) {
        lease.mountedInHiddenHost = false;
        this.mountLeaseInHiddenHost(tab, lease);
      }
    } else {
      lease = { count: 1, mountedInHiddenHost: false };
      this.drawableLeases.set(tabId, lease);
      if (attachedView !== tab.view) this.mountLeaseInHiddenHost(tab, lease);
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releaseDrawableHost(tabId);
      },
    };
  }

  subscribe(listener: (event: InAppBrowserDebuggerEvent) => void): () => void {
    this.debuggerListeners.add(listener);
    return () => this.debuggerListeners.delete(listener);
  }

  /** Fans a tab's CDP events out to every subscriber. */
  forwardEvents(tab: ManagedTab) {
    tab.view.webContents.debugger.on(
      "message",
      (_event, method, params, sessionId) => {
        const debuggerEvent: InAppBrowserDebuggerEvent = {
          tabId: tab.id,
          method,
          ...(sessionId ? { sessionId } : {}),
          ...(params && typeof params === "object"
            ? { params: params as Record<string, unknown> }
            : {}),
        };
        for (const listener of this.debuggerListeners) listener(debuggerEvent);
      },
    );
  }

  /** A leased tab stays drawable in the hidden host while it is not shown. */
  isMountedInHiddenHost(tabId: string) {
    return this.drawableLeases.get(tabId)?.mountedInHiddenHost === true;
  }

  /** Called when a view leaves the visible window: keep it drawable if leased. */
  remountLeased(tab: ManagedTab) {
    const lease = this.drawableLeases.get(tab.id);
    if (lease && lease.count > 0) this.mountLeaseInHiddenHost(tab, lease);
  }

  resizeHiddenMounts() {
    for (const [tabId, lease] of this.drawableLeases) {
      if (!lease.mountedInHiddenHost) continue;
      this.options.tabs.get(tabId)?.view.setBounds(this.drawableBounds());
    }
  }

  /** Unmounts and drops a closing tab's lease. */
  releaseTab(tab: ManagedTab) {
    this.unmountDrawableLease(tab);
    this.drawableLeases.delete(tab.id);
  }

  forgetTab(tabId: string) {
    this.drawableLeases.delete(tabId);
  }

  dispose() {
    this.drawableLeases.clear();
    const drawableHost = this.drawableHost;
    this.drawableHost = null;
    if (drawableHost && !drawableHost.isDestroyed()) drawableHost.destroy();
    this.debuggerListeners.clear();
  }

  private ensureDrawableHost() {
    if (this.drawableHost && !this.drawableHost.isDestroyed()) {
      return this.drawableHost;
    }
    const host =
      this.options.createDrawableHost?.() ??
      new BrowserWindow({
        ...DRAWABLE_HOST_BOUNDS,
        show: false,
        frame: false,
        focusable: false,
        opacity: 0,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });
    host.setBounds(DRAWABLE_HOST_BOUNDS, false);
    host.setFocusable(false);
    host.setOpacity(0);
    host.setSkipTaskbar(true);
    host.once("closed", () => {
      if (this.drawableHost !== host) return;
      this.drawableHost = null;
      for (const lease of this.drawableLeases.values()) {
        lease.mountedInHiddenHost = false;
      }
    });
    // Linux never maps the host: Wayland compositors ignore client positions,
    // setOpacity is a no-op there and focusable:false isn't honored, so a shown
    // host is an empty floating window that takes focus (X11 WMs may clamp it
    // on screen too). Unmapped, the mounted tab still gets a real viewport and
    // script, DOM, clicks and keys work, but its compositor never ticks, so
    // whatever waits on the next frame (mouseMoved and mouseWheel acks, every
    // other Page.captureScreenshot, rAF) stalls. `pumpFramesUntilSettled`
    // forces frames while a command is pending. The cost is ~16-30 ms of
    // latency on those commands and a page that reads
    // `visibilityState: "hidden"` during agent commands instead of "visible".
    if (!this.options.hideDrawableHost) host.showInactive();
    this.drawableHost = host;
    return host;
  }

  private delay(delayMs: number) {
    return (
      this.options.wait?.(delayMs) ??
      new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    );
  }

  /**
   * Forces frames for a tab mounted in the unmapped host until `command`
   * settles. Page.captureScreenshot renders a frame even for a hidden widget,
   * which delivers acks (and rAF callbacks) that were waiting on one.
   */
  private pumpFramesUntilSettled(tab: ManagedTab, command: Promise<unknown>) {
    let settled = false;
    command.then(
      () => (settled = true),
      () => (settled = true),
    );
    const tabDebugger = tab.view.webContents.debugger;
    void (async () => {
      await this.delay(DRAWABLE_HOST_FRAME_PUMP_MS);
      while (
        !settled &&
        !tab.view.webContents.isDestroyed() &&
        tabDebugger.isAttached() &&
        this.drawableLeases.get(tab.id)?.mountedInHiddenHost
      ) {
        await Promise.race([
          Promise.resolve(
            tabDebugger.sendCommand("Page.captureScreenshot", {
              format: "jpeg",
              quality: 1,
              optimizeForSpeed: true,
            }),
          ).catch(() => {}),
          this.delay(250),
        ]);
        if (!settled) await this.delay(DRAWABLE_HOST_FRAME_PUMP_MS);
      }
    })();
  }

  private drawableBounds(): Rectangle {
    const requested = this.options.getPageBounds();
    return {
      x: 0,
      y: 0,
      width: Math.max(1, requested?.width ?? DRAWABLE_HOST_BOUNDS.width),
      height: Math.max(1, requested?.height ?? DRAWABLE_HOST_BOUNDS.height),
    };
  }

  private mountLeaseInHiddenHost(tab: ManagedTab, lease: DrawableLease) {
    if (lease.mountedInHiddenHost || tab.view.webContents.isDestroyed()) return;
    const host = this.ensureDrawableHost();
    host.contentView.addChildView(tab.view);
    tab.view.setBounds(this.drawableBounds());
    lease.mountedInHiddenHost = true;
  }

  private unmountDrawableLease(tab: ManagedTab) {
    const lease = this.drawableLeases.get(tab.id);
    const host = this.drawableHost;
    if (!lease?.mountedInHiddenHost || !host || host.isDestroyed()) return;
    lease.mountedInHiddenHost = false;
    try {
      host.contentView.removeChildView(tab.view);
    } catch {
      // Host teardown can race tab cleanup.
    }
  }

  private releaseDrawableHost(tabId: string) {
    const lease = this.drawableLeases.get(tabId);
    if (!lease) return;
    lease.count -= 1;
    if (lease.count > 0) return;
    const tab = this.options.tabs.get(tabId);
    if (tab) this.unmountDrawableLease(tab);
    this.drawableLeases.delete(tabId);
    this.options.attachActiveView();
  }

  private async settleDrawableHost(tabId: string) {
    const wait = (delayMs: number) => this.delay(delayMs);
    await wait(16);
    const tab = this.options.tabs.get(tabId);
    const lease = this.drawableLeases.get(tabId);
    if (!tab || !lease || this.options.getAttachedView() === tab.view) return;
    if (!lease.mountedInHiddenHost || this.drawableHost?.isDestroyed()) {
      lease.mountedInHiddenHost = false;
      this.mountLeaseInHiddenHost(tab, lease);
      await wait(16);
    }
  }
}
