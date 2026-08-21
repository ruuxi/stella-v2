import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  InAppBrowserCdpAdapter,
  type InAppBrowserDebuggerController,
  type InAppBrowserDebuggerEvent,
} from "@stella/desktop/electron/services/in-app-browser-cdp-adapter.js";

const connect = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

const request = (
  socket: WebSocket,
  id: number,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData) => {
      const payload = JSON.parse(raw.toString()) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (payload.id !== id) return;
      socket.off("message", onMessage);
      if (payload.error) {
        reject(new Error(payload.error.message));
      } else {
        resolve(payload.result ?? {});
      }
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

const adapters: InAppBrowserCdpAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
});

const createController = () => {
  const listeners = new Set<(event: InAppBrowserDebuggerEvent) => void>();
  const targetsByOwner = new Map([
    ["manual", [{ id: "tab-1", url: "https://example.com", title: "Example" }]],
    [
      "owner-test",
      [{ id: "tab-1", url: "https://example.com", title: "Example" }],
    ],
  ]);
  const targetsFor = (ownerId?: string) => {
    const key = ownerId ?? "manual";
    let targets = targetsByOwner.get(key);
    if (!targets) {
      targets = [];
      targetsByOwner.set(key, targets);
    }
    return targets;
  };
  const sendDebuggerCommand = vi.fn(async (_tabId: string, method: string) =>
    method === "Page.getNavigationHistory"
      ? { currentIndex: 0, entries: [] }
      : {},
  );
  const recoverDebuggerTarget = vi.fn(async () => "terminated" as const);
  const controller: InAppBrowserDebuggerController = {
    getDebuggerUserAgent: () => "runtime-derived-user-agent",
    listDebuggerTargets: (ownerId) => targetsFor(ownerId),
    createDebuggerTarget: (url, ownerId) => {
      const targets = targetsFor(ownerId);
      const target = {
        id: `${ownerId ?? "tab"}-${targets.length + 1}`,
        url,
        title: "",
      };
      targets.push(target);
      return target;
    },
    closeDebuggerTarget: (tabId, ownerId) => {
      const targets = targetsFor(ownerId);
      const index = targets.findIndex((target) => target.id === tabId);
      if (index === -1) return false;
      targets.splice(index, 1);
      return true;
    },
    activateDebuggerTarget: vi.fn(),
    sendDebuggerCommand,
    recoverDebuggerTarget,
    subscribeDebuggerEvents: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    controller,
    sendDebuggerCommand,
    recoverDebuggerTarget,
    listeners,
  };
};

describe("InAppBrowserCdpAdapter", () => {
  it("publishes only controller-owned targets and forwards page commands", async () => {
    const { controller, sendDebuggerCommand } = createController();
    const adapter = new InAppBrowserCdpAdapter(controller);
    adapters.push(adapter);
    const socket = await connect(
      (await adapter.createOwnerCapability("owner-test")).cdpUrl,
    );

    await expect(
      request(socket, 10, "Browser.getVersion"),
    ).resolves.toMatchObject({
      userAgent: "runtime-derived-user-agent",
    });

    const targets = await request(socket, 1, "Target.getTargets");
    expect(targets).toEqual({
      targetInfos: [
        expect.objectContaining({
          targetId: "tab-1",
          type: "page",
          url: "https://example.com",
        }),
      ],
    });

    const attached = await request(socket, 2, "Target.attachToTarget", {
      targetId: "tab-1",
      flatten: true,
    });
    const sessionId = String(attached.sessionId);
    await expect(
      request(socket, 3, "Page.getNavigationHistory", {}, sessionId),
    ).resolves.toEqual({ currentIndex: 0, entries: [] });
    expect(sendDebuggerCommand).toHaveBeenLastCalledWith(
      "tab-1",
      "Page.getNavigationHistory",
      {},
      "owner-test",
    );

    socket.close();
  });

  it("rejects unsafe created targets and presents a cursor before a click", async () => {
    const { controller, sendDebuggerCommand } = createController();
    const adapter = new InAppBrowserCdpAdapter(controller);
    adapters.push(adapter);
    const socket = await connect(
      (await adapter.createOwnerCapability("owner-test")).cdpUrl,
    );

    await expect(
      request(socket, 1, "Target.createTarget", { url: "file:///tmp/a" }),
    ).rejects.toThrow("Only http, https, and about:blank URLs are allowed");

    await expect(
      request(socket, 4, "Target.createTarget", { url: "about:blank" }),
    ).resolves.toEqual({ targetId: "owner-test-2" });

    const attached = await request(socket, 2, "Target.attachToTarget", {
      targetId: "tab-1",
    });
    await request(
      socket,
      3,
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 40, y: 52, button: "left" },
      String(attached.sessionId),
    );

    expect(sendDebuggerCommand.mock.calls[0]?.[1]).toBe("Runtime.evaluate");
    expect(sendDebuggerCommand.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        expression: expect.stringContaining("__stella_agent_pointer__"),
      }),
    );
    expect(sendDebuggerCommand.mock.calls[1]).toEqual([
      "tab-1",
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: 40, y: 52, button: "left" },
      "owner-test",
    ]);

    socket.close();
  });

  it("uses expiring single-use capability URLs without advertising them", async () => {
    const { controller } = createController();
    const adapter = new InAppBrowserCdpAdapter(controller);
    adapters.push(adapter);
    const legacyUrl = await adapter.start();
    const versionUrl = new URL(
      "/json/version",
      legacyUrl.replace("ws:", "http:"),
    );
    const version = (await (await fetch(versionUrl)).json()) as Record<
      string,
      unknown
    >;
    expect(version.webSocketDebuggerUrl).toBeUndefined();
    expect(JSON.stringify(version)).not.toContain("/devtools/browser/");
    await expect(connect(legacyUrl)).rejects.toThrow();
    await expect(adapter.createOwnerCapability("  ")).rejects.toThrow(
      "ownerId must be a non-empty capability string",
    );

    // Freeze Date.now around the capability creation so the expiry math is
    // deterministic: createOwnerCapability sets expiresAt = Date.now() +
    // OWNER_CAPABILITY_TTL_MS (60_000). Reading Date.now() separately for the
    // reference lets real-clock drift between the two reads flake the delta to
    // 60_001, so pin both reads to the same instant and assert the exact TTL.
    const frozenNow = Date.now();
    const ttlNowSpy = vi.spyOn(Date, "now").mockReturnValue(frozenNow);
    const capability = await adapter.createOwnerCapability("owner-a");
    ttlNowSpy.mockRestore();
    expect(capability.expiresAt - frozenNow).toBe(60_000);
    const socket = await connect(capability.cdpUrl);
    await expect(connect(capability.cdpUrl)).rejects.toThrow();
    socket.close();

    const expired = await adapter.createOwnerCapability("owner-a");
    const now = vi.spyOn(Date, "now").mockReturnValue(expired.expiresAt + 1);
    await expect(connect(expired.cdpUrl)).rejects.toThrow();
    now.mockRestore();
  });

  it("isolates target discovery and attachment by owner capability", async () => {
    const { controller, sendDebuggerCommand } = createController();
    const adapter = new InAppBrowserCdpAdapter(controller);
    adapters.push(adapter);
    const ownerA = await adapter.createOwnerCapability("owner-a");
    const ownerB = await adapter.createOwnerCapability("owner-b");
    const socketA = await connect(ownerA.cdpUrl);
    const socketB = await connect(ownerB.cdpUrl);

    const created = await request(socketA, 1, "Target.createTarget", {
      url: "https://a.example",
    });
    expect(created.targetId).toBe("owner-a-1");
    await expect(request(socketB, 2, "Target.getTargets")).resolves.toEqual({
      targetInfos: [],
    });
    await expect(
      request(socketB, 3, "Target.attachToTarget", {
        targetId: "owner-a-1",
      }),
    ).rejects.toThrow("Browser target was not found");
    expect(sendDebuggerCommand).not.toHaveBeenCalled();

    socketA.close();
    socketB.close();
  });

  it("terminates a timed-out page evaluation without poisoning target control", async () => {
    const { controller, sendDebuggerCommand, recoverDebuggerTarget } =
      createController();
    sendDebuggerCommand.mockImplementation(
      async (_tabId: string, method: string) => {
        if (method === "Runtime.evaluate") {
          return await new Promise<never>(() => undefined);
        }
        return {};
      },
    );
    const adapter = new InAppBrowserCdpAdapter(controller, {
      commandTimeoutMs: 20,
      bootstrapCommandTimeoutMs: 10,
      recoveryTimeoutMs: 20,
    });
    adapters.push(adapter);
    const socket = await connect(
      (await adapter.createOwnerCapability("owner-test")).cdpUrl,
    );
    const attached = await request(socket, 1, "Target.attachToTarget", {
      targetId: "tab-1",
    });

    await expect(
      request(
        socket,
        2,
        "Runtime.evaluate",
        { expression: "while (true) {}", awaitPromise: true },
        String(attached.sessionId),
      ),
    ).rejects.toThrow(
      "CDP command Runtime.evaluate timed out after 20ms. Page execution was terminated.",
    );
    expect(recoverDebuggerTarget).toHaveBeenCalledWith("tab-1", "owner-test");
    await expect(
      request(socket, 3, "Target.getTargets"),
    ).resolves.toMatchObject({
      targetInfos: [expect.objectContaining({ targetId: "tab-1" })],
    });
    await expect(
      request(
        socket,
        4,
        "Page.getNavigationHistory",
        {},
        String(attached.sessionId),
      ),
    ).resolves.toEqual({});
    expect(sendDebuggerCommand).toHaveBeenLastCalledWith(
      "tab-1",
      "Page.getNavigationHistory",
      {},
      "owner-test",
    );

    socket.close();
  });

  it("recovers and retries CDP domain bootstrap on a retained poisoned tab", async () => {
    const { controller, sendDebuggerCommand, recoverDebuggerTarget } =
      createController();
    let runtimeEnableCalls = 0;
    sendDebuggerCommand.mockImplementation(
      async (_tabId: string, method: string) => {
        if (method === "Runtime.enable" && runtimeEnableCalls++ === 0) {
          return await new Promise<never>(() => undefined);
        }
        return {};
      },
    );
    const adapter = new InAppBrowserCdpAdapter(controller, {
      commandTimeoutMs: 40,
      bootstrapCommandTimeoutMs: 20,
      recoveryTimeoutMs: 20,
    });
    adapters.push(adapter);
    const socket = await connect(
      (await adapter.createOwnerCapability("owner-test")).cdpUrl,
    );
    const attached = await request(socket, 1, "Target.attachToTarget", {
      targetId: "tab-1",
    });

    await expect(
      request(socket, 2, "Runtime.enable", {}, String(attached.sessionId)),
    ).resolves.toEqual({});
    expect(recoverDebuggerTarget).toHaveBeenCalledWith("tab-1", "owner-test");
    expect(
      sendDebuggerCommand.mock.calls.filter(
        (call) => call[1] === "Runtime.enable",
      ),
    ).toHaveLength(2);

    socket.close();
  });
});
