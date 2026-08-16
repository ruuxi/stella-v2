import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPath: vi.fn() },
  WebContentsView: class {},
}));

import {
  importBrowserProfileSnapshot,
  readBrowserHistoryUrls,
} from "@stella/desktop/electron/services/in-app-browser-profile.js";
import {
  InAppBrowserService,
  type StellaBrowserExportedCookie,
} from "@stella/desktop/electron/services/in-app-browser-service.js";

class FakeDebugger extends EventEmitter {
  attached = false;
  readonly attach = vi.fn(() => {
    this.attached = true;
  });
  readonly detach = vi.fn(() => {
    this.attached = false;
  });
  readonly isAttached = vi.fn(() => this.attached);
  readonly sendCommand = vi.fn(async () => ({}));
}

class FakeWebContents extends EventEmitter {
  url = "";
  title = "";
  destroyed = false;
  windowOpenHandler: ((details: { url: string }) => { action: "deny" }) | null =
    null;
  readonly debugger = new FakeDebugger();
  readonly navigationHistory = {
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  readonly loadURL = vi.fn(async (url: string) => {
    this.emit("did-start-loading");
    this.url = url;
    this.emit("did-navigate", {}, url);
    this.emit("did-stop-loading");
  });
  readonly reload = vi.fn();
  readonly getURL = vi.fn(() => this.url);
  readonly getTitle = vi.fn(() => this.title);
  readonly isDestroyed = vi.fn(() => this.destroyed);
  readonly close = vi.fn(() => {
    this.destroyed = true;
    this.emit("destroyed");
  });
  readonly setWindowOpenHandler = vi.fn(
    (handler: (details: { url: string }) => { action: "deny" }) => {
      this.windowOpenHandler = handler;
    },
  );
}

class FakeView {
  readonly webContents = new FakeWebContents();
  readonly setBounds = vi.fn();
}

class FakeWindow extends EventEmitter {
  destroyed = false;
  readonly addChildView = vi.fn();
  readonly removeChildView = vi.fn();
  readonly contentView = {
    addChildView: this.addChildView,
    removeChildView: this.removeChildView,
  };
  readonly isDestroyed = vi.fn(() => this.destroyed);
  readonly getContentSize = vi.fn(() => [800, 600]);
  readonly setBounds = vi.fn();
  readonly setFocusable = vi.fn();
  readonly setOpacity = vi.fn();
  readonly setSkipTaskbar = vi.fn();
  readonly showInactive = vi.fn();
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("closed");
  });

  constructor() {
    super();
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createHarness = (
  status: () => Promise<boolean>,
  options: {
    debuggerRecoveryTimeoutMs?: number;
    cookieMirrorIntervalMs?: number;
    navigationReseedThrottleMs?: number;
  } = {},
) => {
  const root = path.join(os.tmpdir(), `stella-browser-test-${Date.now()}`);
  const views: FakeView[] = [];
  const cookieSet = vi.fn(async () => undefined);
  const fakeSession = {
    cookies: {
      set: cookieSet,
      flushStore: vi.fn(async () => undefined),
    },
    flushStorageData: vi.fn(),
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  };
  const fakeWindow = new FakeWindow();
  const drawableHost = new FakeWindow();
  const createDrawableHost = vi.fn(() => drawableHost as never);
  const onStateChanged = vi.fn();
  const ensureBrowserBridgeStarted = vi.fn(async () => undefined);
  const openExtensionStore = vi.fn(async () => undefined);
  const exportAllCookies = vi.fn(
    async (): Promise<StellaBrowserExportedCookie[]> => [
      {
        name: "host",
        value: "one",
        domain: "example.com",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: true,
        session: false,
        storeId: "0",
        sameSite: "lax",
        expirationDate: 2_000_000_000,
      },
      {
        name: "domain",
        value: "two",
        domain: ".example.org",
        path: "/app",
        secure: false,
        httpOnly: false,
        hostOnly: false,
        session: true,
        storeId: "0",
        sameSite: "strict",
      },
      {
        name: "partitioned",
        value: "three",
        domain: ".example.net",
        path: "/",
        secure: true,
        httpOnly: true,
        hostOnly: false,
        session: true,
        storeId: "0",
        sameSite: "no_restriction",
        partitionKey: { topLevelSite: "https://top.example" },
      },
    ],
  );
  const exportCookiesForUrls = vi.fn(
    async (): Promise<StellaBrowserExportedCookie[]> => [],
  );
  const wait = vi.fn(async () => undefined);
  const service = new InAppBrowserService({
    stellaDataDir: root,
    getWindow: () => fakeWindow as never,
    ensureBrowserBridgeStarted,
    openExtensionStore,
    getExtensionStatus: status,
    exportAllCookies,
    exportCookiesForUrls,
    onStateChanged,
    resolveProfile: async () => ({
      browserType: "brave",
      profileId: "Default",
      profileName: "Personal",
      sourcePath: "/browser/Default",
    }),
    importProfile: async ({ destinationPath, selection }) => ({
      ...selection,
      destinationPath,
      copied: true,
      skipped: false,
      copiedEntries: ["Local Storage"],
      failedEntries: [],
    }),
    sessionFromPath: vi.fn(() => fakeSession as never),
    createView: () => {
      const view = new FakeView();
      views.push(view);
      return view as never;
    },
    createDrawableHost,
    createId: () => `tab-${views.length + 1}`,
    wait,
    connectionTimeoutMs: 50,
    connectionPollMs: 1,
    automaticConnectionTimeoutMs: 0,
    ...(options.cookieMirrorIntervalMs !== undefined
      ? { cookieMirrorIntervalMs: options.cookieMirrorIntervalMs }
      : {}),
    ...(options.navigationReseedThrottleMs !== undefined
      ? { navigationReseedThrottleMs: options.navigationReseedThrottleMs }
      : {}),
    debuggerRecoveryTimeoutMs: options.debuggerRecoveryTimeoutMs,
  });
  return {
    service,
    views,
    fakeSession,
    cookieSet,
    fakeWindow,
    addChildView: fakeWindow.addChildView,
    removeChildView: fakeWindow.removeChildView,
    drawableHost,
    createDrawableHost,
    onStateChanged,
    ensureBrowserBridgeStarted,
    openExtensionStore,
    exportAllCookies,
    exportCookiesForUrls,
    wait,
  };
};

describe("InAppBrowserService", () => {
  it("prepares an isolated profile, seeds cookies, and manages native tabs", async () => {
    const harness = createHarness(async () => true);

    await expect(
      harness.service.connect({ browserType: "brave", profileId: "Default" }),
    ).resolves.toMatchObject({
      connection: "connected",
      profileName: "Personal",
      tabs: [],
    });
    expect(harness.cookieSet).toHaveBeenCalledTimes(2);
    expect(harness.cookieSet.mock.calls[0]?.[0]).not.toHaveProperty("domain");
    expect(harness.cookieSet.mock.calls[1]?.[0]).toMatchObject({
      domain: ".example.org",
    });
    await harness.service.getState();
    await harness.service.connect();
    await harness.service.requestExtensionConnect();
    expect(harness.exportAllCookies).toHaveBeenCalledOnce();
    expect(harness.openExtensionStore).not.toHaveBeenCalled();

    const created = await harness.service.createTab({
      url: "https://example.com",
    });
    expect(created).toMatchObject({
      activeTabId: "tab-1",
      tabs: [{ id: "tab-1", url: "https://example.com/" }],
    });
    expect(
      harness.views[0]?.webContents.debugger.sendCommand,
    ).toHaveBeenCalledWith(
      "Network.setCookies",
      expect.objectContaining({
        cookies: [expect.objectContaining({ name: "partitioned" })],
      }),
    );

    await harness.service.show({
      surfaceBounds: { x: 10, y: 20, width: 790, height: 580 },
      pageBounds: { x: 30, y: 80, width: 900, height: 700 },
    });
    expect(harness.addChildView).toHaveBeenCalledWith(harness.views[0]);
    expect(harness.views[0]?.setBounds).toHaveBeenLastCalledWith({
      x: 30,
      y: 80,
      width: 770,
      height: 520,
    });

    await harness.service.hide();
    expect(harness.removeChildView).toHaveBeenCalledWith(harness.views[0]);
    await expect(
      harness.service.navigate({ tabId: "tab-1", url: "file:///tmp/secret" }),
    ).rejects.toThrow("Only http, https, and about:blank URLs are allowed");

    expect(harness.service.listDebuggerTargets()).toEqual([
      {
        id: "tab-1",
        url: "https://example.com/",
        title: "New Tab",
      },
    ]);
    await expect(harness.service.closeDebuggerTarget("missing")).resolves.toBe(
      false,
    );
    await expect(harness.service.closeDebuggerTarget("tab-1")).resolves.toBe(
      true,
    );
  });

  it("keeps automatic connect quiet and makes only the explicit CTA open the store", async () => {
    const status = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("socket not ready"))
      .mockRejectedValueOnce(new Error("still starting"))
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const harness = createHarness(status);

    const initial = await harness.service.getState();
    expect(initial).toMatchObject({ connection: "disconnected", tabs: [] });
    const automatic = await harness.service.connect();
    expect(automatic).toMatchObject({ connection: "disconnected", tabs: [] });
    expect(harness.openExtensionStore).not.toHaveBeenCalled();

    const explicit = await harness.service.requestExtensionConnect();
    expect(explicit.connection).toBe("checking");
    expect(harness.openExtensionStore).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledTimes(4);
  });

  it("falls back to URL-scoped cookie export for older extensions", async () => {
    const harness = createHarness(async () => true);
    harness.exportAllCookies.mockRejectedValueOnce(
      new Error("Unknown command: cookies_export_all"),
    );

    await expect(harness.service.connect()).resolves.toMatchObject({
      connection: "connected",
    });
    expect(harness.exportCookiesForUrls).toHaveBeenCalledWith([]);
  });

  it("seeds on a plain getState once the extension is present (connect-race fix)", async () => {
    const harness = createHarness(async () => true);
    // No explicit connect(): a state poll alone must drive the seed when the
    // extension is available, so an extension that woke after the first
    // automatic-connect window is still picked up on the next poll.
    await harness.service.getState();
    await vi.waitFor(() => expect(harness.exportAllCookies).toHaveBeenCalled());
    expect((await harness.service.getState()).connection).toBe("connected");
  });

  it("re-mirrors cookies on navigation (reconcile-on-navigation)", async () => {
    const harness = createHarness(async () => true, {
      navigationReseedThrottleMs: 0,
    });
    await harness.service.connect();
    expect(harness.exportAllCookies).toHaveBeenCalledTimes(1);
    const seedsAfterConnect = harness.cookieSet.mock.calls.length;
    // createTab's loadURL emits did-navigate, which triggers a throttled reseed.
    await harness.service.createTab({ url: "https://example.com" });
    await vi.waitFor(() =>
      expect(harness.exportAllCookies.mock.calls.length).toBeGreaterThan(1),
    );
    expect(harness.cookieSet.mock.calls.length).toBeGreaterThan(
      seedsAfterConnect,
    );
  });

  it("keeps mirroring on a cadence and never latches, then stops on dispose (staleness fix)", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(async () => true, {
        cookieMirrorIntervalMs: 5_000,
      });
      await harness.service.connect();
      expect(harness.exportAllCookies).toHaveBeenCalledTimes(1);
      // The one-shot latch is gone: the mirror refreshes every interval.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.exportAllCookies).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.exportAllCookies).toHaveBeenCalledTimes(3);
      // dispose() must tear the mirror down: no further passes.
      harness.service.dispose();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.exportAllCookies).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns safe popups into managed tabs and forwards debugger events", async () => {
    const harness = createHarness(async () => true);
    const listener = vi.fn();
    harness.service.subscribeDebuggerEvents(listener);
    await harness.service.createTab({});

    expect(
      harness.views[0]?.webContents.windowOpenHandler?.({
        url: "https://popup.example",
      }),
    ).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(harness.views).toHaveLength(2));
    expect(harness.views[1]?.webContents.url).toBe("https://popup.example/");

    harness.views[0]?.webContents.debugger.emit(
      "message",
      {},
      "Page.loadEventFired",
      { timestamp: 1 },
      "session-1",
    );
    expect(listener).toHaveBeenCalledWith({
      tabId: "tab-1",
      method: "Page.loadEventFired",
      params: { timestamp: 1 },
    });
  });

  it("isolates tabs by owner without letting background activation steal the visible surface", async () => {
    const harness = createHarness(async () => true);
    const manual = await harness.service.createTab({
      url: "https://manual.example",
    });
    await harness.service.show({
      surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
      pageBounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    const ownerATarget = await harness.service.createDebuggerTarget(
      "https://agent-a.example",
      "owner-a",
    );
    const ownerBTarget = await harness.service.createDebuggerTarget(
      "https://agent-b.example",
      "owner-b",
    );

    expect(harness.service.listDebuggerTargets()).toEqual([
      expect.objectContaining({ id: manual.activeTabId }),
    ]);
    expect(harness.service.listDebuggerTargets("owner-a")).toEqual([
      expect.objectContaining({ id: ownerATarget.id }),
    ]);
    expect(harness.service.listDebuggerTargets("owner-b")).toEqual([
      expect.objectContaining({ id: ownerBTarget.id }),
    ]);
    expect(await harness.service.getState()).toMatchObject({
      visibleOwnerId: "stella:manual",
      owners: [
        expect.objectContaining({
          id: "stella:manual",
          kind: "manual",
          tabCount: 1,
        }),
        expect.objectContaining({ id: "owner-a", kind: "agent", tabCount: 1 }),
        expect.objectContaining({
          id: "owner-b",
          kind: "agent",
          tabCount: 1,
          latest: true,
        }),
      ],
    });
    expect(harness.addChildView).toHaveBeenCalledTimes(1);
    expect(harness.addChildView).toHaveBeenLastCalledWith(harness.views[0]);

    await harness.service.activateDebuggerTarget(ownerBTarget.id, "owner-b");
    expect(harness.addChildView).toHaveBeenCalledTimes(1);
    await expect(
      harness.service.sendDebuggerCommand(
        ownerBTarget.id,
        "Runtime.evaluate",
        {},
        "owner-a",
      ),
    ).rejects.toThrow("Browser tab not found for owner");
    await expect(
      harness.service.closeDebuggerTarget(ownerBTarget.id, "owner-a"),
    ).resolves.toBe(false);

    expect(
      harness.views[1]?.webContents.windowOpenHandler?.({
        url: "https://agent-a-popup.example",
      }),
    ).toEqual({ action: "deny" });
    await vi.waitFor(() =>
      expect(harness.service.listDebuggerTargets("owner-a")).toHaveLength(2),
    );
    expect(harness.service.listDebuggerTargets("owner-b")).toHaveLength(1);
  });

  it("aggregates every owner for orchestrator mode and pins direct mode to one owner", async () => {
    const harness = createHarness(async () => true);
    const manual = await harness.service.createTab({
      url: "https://manual.example",
    });
    const ownerA = await harness.service.createDebuggerTarget(
      "https://agent-a.example",
      "owner-a",
    );
    const ownerB = await harness.service.createDebuggerTarget(
      "https://agent-b.example",
      "owner-b",
    );

    const allOwners = harness.service.setOwnerScope();
    expect(allOwners.tabs).toEqual([
      expect.objectContaining({
        id: manual.activeTabId,
        ownerId: "stella:manual",
      }),
      expect.objectContaining({ id: ownerA.id, ownerId: "owner-a" }),
      expect.objectContaining({ id: ownerB.id, ownerId: "owner-b" }),
    ]);
    expect(allOwners.activeTabId).toBe(manual.activeTabId);

    const selected = await harness.service.selectTab({
      tabId: ownerB.id,
      ownerId: "owner-b",
      activate: true,
    });
    expect(selected).toMatchObject({
      visibleOwnerId: "owner-b",
      activeTabId: ownerB.id,
    });
    expect((await harness.service.getState()).tabs).toHaveLength(3);

    const directOwner = harness.service.setOwnerScope("owner-a");
    expect(directOwner).toMatchObject({
      visibleOwnerId: "owner-a",
      activeTabId: ownerA.id,
    });
    expect(directOwner.tabs).toEqual([
      expect.objectContaining({ id: ownerA.id, ownerId: "owner-a" }),
    ]);
  });

  it("shows the latest agent owner only when the manual owner has no tabs", async () => {
    const harness = createHarness(async () => true);
    const agent = await harness.service.createDebuggerTarget(
      "https://agent.example",
      "owner-a",
    );
    const shown = await harness.service.show({
      surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
      pageBounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(shown.activeTabId).toBe(agent.id);
    expect(shown.visibleOwnerId).toBe("owner-a");
    expect(harness.addChildView).toHaveBeenLastCalledWith(harness.views[0]);

    const manual = await harness.service.createTab({
      url: "https://manual.example",
    });
    expect(manual.activeTabId).toBe("tab-2");
    expect(harness.addChildView).toHaveBeenLastCalledWith(harness.views[1]);
  });

  it("keeps an explicitly selected agent owner visible across panel reopen", async () => {
    const harness = createHarness(async () => true);
    const ownerA = await harness.service.createDebuggerTarget(
      "https://agent-a.example",
      "owner-a",
    );
    await harness.service.createDebuggerTarget(
      "https://agent-b.example",
      "owner-b",
    );
    const layout = {
      surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
      pageBounds: { x: 0, y: 0, width: 800, height: 600 },
    };
    expect((await harness.service.show(layout)).visibleOwnerId).toBe("owner-b");

    expect(harness.service.setVisibleOwner("owner-a")).toMatchObject({
      visibleOwnerId: "owner-a",
      activeTabId: ownerA.id,
    });
    await harness.service.hide();
    expect(await harness.service.show(layout)).toMatchObject({
      visibleOwnerId: "owner-a",
      activeTabId: ownerA.id,
    });
  });

  it("scopes page errors to their browser owner", async () => {
    const harness = createHarness(async () => true);
    await harness.service.connect();
    await harness.service.createDebuggerTarget(
      "https://agent-a.example",
      "owner-a",
    );
    await harness.service.createDebuggerTarget(
      "https://agent-b.example",
      "owner-b",
    );
    harness.service.setVisibleOwner("owner-a");

    harness.views[0]?.webContents.emit(
      "render-process-gone",
      {},
      {
        reason: "crashed",
      },
    );
    expect(await harness.service.getState()).toMatchObject({
      visibleOwnerId: "owner-a",
      error: "Browser page stopped: crashed.",
    });

    const ownerB = harness.service.setVisibleOwner("owner-b");
    expect(ownerB.visibleOwnerId).toBe("owner-b");
    expect(ownerB.error).toBeUndefined();
    expect(harness.service.setVisibleOwner("owner-a").error).toBe(
      "Browser page stopped: crashed.",
    );

    harness.views[0]?.webContents.emit("did-start-loading");
    expect((await harness.service.getState()).error).toBeUndefined();
  });

  it("reference-counts hidden drawable mounts and restores visible mounts safely", async () => {
    const harness = createHarness(async () => true);
    const first = await harness.service.createTab({
      url: "https://one.example",
    });
    await harness.service.show({
      surfaceBounds: { x: 0, y: 0, width: 800, height: 600 },
      pageBounds: { x: 20, y: 40, width: 640, height: 480 },
    });
    const second = await harness.service.createTab({
      url: "https://two.example",
    });
    await harness.service.selectTab({ tabId: first.activeTabId! });
    const visibleLease = harness.service.acquireDrawableHost(
      first.activeTabId!,
    );

    await harness.service.selectTab({ tabId: second.activeTabId! });
    expect(harness.drawableHost.addChildView).toHaveBeenCalledWith(
      harness.views[0],
    );
    expect(harness.drawableHost.showInactive).toHaveBeenCalledOnce();
    expect(harness.drawableHost.setBounds).toHaveBeenCalledWith(
      { x: -100_000, y: -100_000, width: 1280, height: 720 },
      false,
    );
    expect(harness.drawableHost.setFocusable).toHaveBeenCalledWith(false);
    expect(harness.drawableHost.setOpacity).toHaveBeenCalledWith(0);
    expect(harness.drawableHost.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(harness.addChildView).toHaveBeenLastCalledWith(harness.views[1]);

    const nestedLease = harness.service.acquireDrawableHost(first.activeTabId!);
    visibleLease.release();
    expect(harness.drawableHost.removeChildView).not.toHaveBeenCalled();
    nestedLease.release();
    expect(harness.drawableHost.removeChildView).toHaveBeenCalledOnce();
    expect(harness.addChildView).toHaveBeenLastCalledWith(harness.views[1]);

    const agent = await harness.service.createDebuggerTarget(
      "https://background.example",
      "background-owner",
    );
    await harness.service.sendDebuggerCommand(
      agent.id,
      "Page.captureScreenshot",
      {},
      "background-owner",
    );
    expect(harness.drawableHost.addChildView).toHaveBeenLastCalledWith(
      harness.views[2],
    );
    expect(harness.drawableHost.removeChildView).toHaveBeenCalledTimes(2);
    expect(harness.addChildView).toHaveBeenLastCalledWith(harness.views[1]);
    expect(harness.wait).toHaveBeenCalledWith(16);

    harness.service.closeOwnerTabs("background-owner");
    expect(harness.service.listDebuggerTargets("background-owner")).toEqual([]);
    harness.service.dispose();
    expect(harness.drawableHost.destroy).toHaveBeenCalledOnce();
  });

  it("remounts an active drawable lease if the hidden host is destroyed", async () => {
    const harness = createHarness(async () => true);
    const target = await harness.service.createDebuggerTarget(
      "https://background.example",
      "owner-a",
    );
    const lease = harness.service.acquireDrawableHost(target.id, "owner-a");
    const replacementHost = new FakeWindow();
    harness.createDrawableHost.mockReturnValue(replacementHost as never);

    harness.drawableHost.destroy();
    await harness.service.sendDebuggerCommand(
      target.id,
      "Page.printToPDF",
      {},
      "owner-a",
    );

    expect(replacementHost.addChildView).toHaveBeenCalledWith(harness.views[0]);
    expect(harness.wait).toHaveBeenCalledWith(16);
    lease.release();
    expect(replacementHost.removeChildView).toHaveBeenCalledWith(
      harness.views[0],
    );
    harness.service.dispose();
    expect(replacementHost.destroy).toHaveBeenCalledOnce();
  });

  it("terminates timed-out page execution and reloads only as a fallback", async () => {
    const harness = createHarness(async () => true, {
      debuggerRecoveryTimeoutMs: 10,
    });
    const target = await harness.service.createDebuggerTarget(
      "https://recover.example",
      "owner-a",
    );
    const contents = harness.views[0]!.webContents;

    await expect(
      harness.service.recoverDebuggerTarget(target.id, "owner-a"),
    ).resolves.toBe("terminated");
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Runtime.terminateExecution",
    );
    expect(contents.reload).not.toHaveBeenCalled();

    contents.debugger.sendCommand.mockImplementationOnce(
      async () => await new Promise<never>(() => undefined),
    );
    await expect(
      harness.service.recoverDebuggerTarget(target.id, "owner-a"),
    ).resolves.toBe("reloaded");
    expect(contents.reload).toHaveBeenCalledOnce();
  });
});

describe("importBrowserProfileSnapshot", () => {
  it("reads recent HTTP history URLs for compatibility cookie export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-history-read-"));
    tempRoots.push(root);
    const database = new DatabaseSync(path.join(root, "History"));
    database.exec(
      "CREATE TABLE urls (url TEXT, last_visit_time INTEGER);" +
        "INSERT INTO urls VALUES ('https://recent.example/app', 3);" +
        "INSERT INTO urls VALUES ('file:///tmp/private', 2);" +
        "INSERT INTO urls VALUES ('http://older.example/', 1);",
    );
    database.close();

    expect(readBrowserHistoryUrls(root)).toEqual([
      "https://recent.example/app",
      "http://older.example/",
    ]);
  });

  it("copies only allowlisted storage once and leaves credentials behind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-profile-copy-"));
    tempRoots.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await mkdir(path.join(source, "Local Storage"), { recursive: true });
    await writeFile(path.join(source, "Local Storage", "state"), "first");
    await writeFile(path.join(source, "History"), "history");
    await writeFile(path.join(source, "Cookies"), "secret-cookie-db");
    await writeFile(path.join(source, "Login Data"), "secret-password-db");

    const first = await importBrowserProfileSnapshot({
      destinationPath: destination,
      selection: {
        browserType: "brave",
        profileId: "Default",
        profileName: "Personal",
        sourcePath: source,
      },
    });
    expect(first.copiedEntries).toEqual(["Local Storage", "History"]);
    await expect(
      readFile(path.join(destination, "Local Storage", "state"), "utf8"),
    ).resolves.toBe("first");
    await expect(
      readFile(path.join(destination, "Cookies"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(destination, "Login Data"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(path.join(source, "Local Storage", "state"), "second");
    const second = await importBrowserProfileSnapshot({
      destinationPath: destination,
      selection: { sourcePath: source },
    });
    expect(second.skipped).toBe(true);
    await expect(
      readFile(path.join(destination, "Local Storage", "state"), "utf8"),
    ).resolves.toBe("first");
  });
});
