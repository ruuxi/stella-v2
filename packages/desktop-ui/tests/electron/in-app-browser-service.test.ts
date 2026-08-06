import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
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

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const createHarness = (status: () => Promise<boolean>) => {
  const root = path.join(os.tmpdir(), `stella-browser-test-${Date.now()}`);
  const views: FakeView[] = [];
  const cookieSet = vi.fn(async () => undefined);
  const fakeSession = {
    cookies: {
      set: cookieSet,
      flushStore: vi.fn(async () => undefined),
    },
    flushStorageData: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
  };
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  const fakeWindow = {
    isDestroyed: vi.fn(() => false),
    getContentSize: vi.fn(() => [800, 600]),
    contentView: { addChildView, removeChildView },
  };
  const onStateChanged = vi.fn();
  const ensureBrowserBridgeStarted = vi.fn(async () => undefined);
  const openExtensionStore = vi.fn(async () => undefined);
  const exportAllCookies = vi.fn(async (): Promise<StellaBrowserExportedCookie[]> => [
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
  ]);
  const exportCookiesForUrls = vi.fn(
    async (): Promise<StellaBrowserExportedCookie[]> => [],
  );
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
    createId: () => `tab-${views.length + 1}`,
    wait: async () => undefined,
    connectionTimeoutMs: 50,
    connectionPollMs: 1,
    automaticConnectionTimeoutMs: 0,
  });
  return {
    service,
    views,
    fakeSession,
    cookieSet,
    fakeWindow,
    addChildView,
    removeChildView,
    onStateChanged,
    ensureBrowserBridgeStarted,
    openExtensionStore,
    exportAllCookies,
    exportCookiesForUrls,
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
      expect.objectContaining({ cookies: [expect.objectContaining({ name: "partitioned" })] }),
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
    expect(initial).toEqual({ connection: "disconnected", tabs: [] });
    const automatic = await harness.service.connect();
    expect(automatic).toEqual({ connection: "disconnected", tabs: [] });
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
