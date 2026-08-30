import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ bridge: vi.fn() }));

vi.mock("@/platform/interior/interior-bridge", () => ({
  getStellaInteriorBridge: mocks.bridge,
}));

import { ConversationSocket } from "@/features/cloud/conversation-socket";

const originalWebSocket = globalThis.WebSocket;

class CapturingWebSocket {
  static readonly OPEN = 1;
  static instances: CapturingWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;

  constructor(url: string | URL) {
    this.url = String(url);
    CapturingWebSocket.instances.push(this);
  }

  send(): void {}
  close(): void {}
}

const startSocket = async (): Promise<URL> => {
  const socket = new ConversationSocket({
    conversationId: "conversation/one",
    baseUrl: "https://builder.example.test",
    getToken: async () => "opaque-scoped-token",
    onEvent: () => undefined,
  });
  socket.start();
  await Promise.resolve();
  await Promise.resolve();
  const transport = CapturingWebSocket.instances[0];
  socket.stop();
  if (!transport) throw new Error("socket was not created");
  return new URL(transport.url);
};

afterEach(() => {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: originalWebSocket,
  });
  CapturingWebSocket.instances = [];
  mocks.bridge.mockReset();
});

describe("interior conversation socket routing", () => {
  it("routes the conversation socket through the validated trusted gateway", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: CapturingWebSocket,
    });
    mocks.bridge.mockReturnValue({
      protocol: 1,
      gatewayOrigin: "https://apps-auth.example.test",
    });
    const url = await startSocket();
    expect(url.origin).toBe("wss://apps-auth.example.test");
    expect(url.pathname).toBe("/conversations/conversation%2Fone/socket");
  });

  it("preserves the configured Builder socket for normal shells", async () => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: CapturingWebSocket,
    });
    mocks.bridge.mockReturnValue(null);
    const url = await startSocket();
    expect(url.origin).toBe("wss://builder.example.test");
  });
});
