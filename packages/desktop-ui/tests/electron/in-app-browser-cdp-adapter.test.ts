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
  const targets = [
    { id: "tab-1", url: "https://example.com", title: "Example" },
  ];
  const sendDebuggerCommand = vi.fn(
    async (_tabId: string, method: string) =>
      method === "Page.getNavigationHistory"
        ? { currentIndex: 0, entries: [] }
        : {},
  );
  const controller: InAppBrowserDebuggerController = {
    listDebuggerTargets: () => targets,
    createDebuggerTarget: (url) => {
      const target = { id: `tab-${targets.length + 1}`, url, title: "" };
      targets.push(target);
      return target;
    },
    closeDebuggerTarget: (tabId) => {
      const index = targets.findIndex((target) => target.id === tabId);
      if (index === -1) return false;
      targets.splice(index, 1);
      return true;
    },
    activateDebuggerTarget: vi.fn(),
    sendDebuggerCommand,
    subscribeDebuggerEvents: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { controller, sendDebuggerCommand, listeners };
};

describe("InAppBrowserCdpAdapter", () => {
  it("publishes only controller-owned targets and forwards page commands", async () => {
    const { controller, sendDebuggerCommand } = createController();
    const adapter = new InAppBrowserCdpAdapter(controller);
    adapters.push(adapter);
    const socket = await connect(await adapter.start());

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
      request(
        socket,
        3,
        "Page.getNavigationHistory",
        {},
        sessionId,
      ),
    ).resolves.toEqual({ currentIndex: 0, entries: [] });
    expect(sendDebuggerCommand).toHaveBeenLastCalledWith(
      "tab-1",
      "Page.getNavigationHistory",
      {},
    );

    socket.close();
  });

  it("rejects unsafe created targets and presents a cursor before a click", async () => {
    const { controller, sendDebuggerCommand } = createController();
    const adapter = new InAppBrowserCdpAdapter(controller);
    adapters.push(adapter);
    const socket = await connect(await adapter.start());

    await expect(
      request(socket, 1, "Target.createTarget", { url: "file:///tmp/a" }),
    ).rejects.toThrow("Only http, https, and about:blank URLs are allowed");

    await expect(
      request(socket, 4, "Target.createTarget", { url: "about:blank" }),
    ).resolves.toEqual({ targetId: "tab-2" });

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
    ]);

    socket.close();
  });
});
