import { describe, expect, test } from "bun:test";

import { generateShimScript } from "../shim";

type BridgeCall = { channel: string; args: unknown[] };

type ShimHarness = {
  api: Record<string, any>;
  calls: BridgeCall[];
  nativeMessages: { type: string; [key: string]: unknown }[];
  respondWith: (value: unknown) => void;
  failWith: (status: number, error: string) => void;
};

/**
 * Evaluates the real injected shim against fake WebView globals.
 *
 * The shim ships as a generated script, so exercising the actual string is the
 * only way to prove the desktop sees the argument shapes its IPC handlers
 * destructure.
 */
function loadShim(capabilities: unknown[] = []): ShimHarness {
  const calls: BridgeCall[] = [];
  const nativeMessages: { type: string; [key: string]: unknown }[] = [];
  let nextResponse: unknown = null;
  let nextFailure: { status: number; error: string } | null = null;

  const script = generateShimScript("https://desktop.example", {
    localStorage: {},
    mobileBridgeCapabilities: { version: 1, capabilities: capabilities as any },
  });

  const win: Record<string, any> = {
    ReactNativeWebView: {
      postMessage: (raw: string) => nativeMessages.push(JSON.parse(raw)),
    },
    // The shim reconnects on close; a socket that never opens keeps the test
    // to the HTTP lane without a reconnect loop.
    WebSocket: function () {
      return { readyState: 0, send: () => {}, close: () => {} };
    } as unknown as typeof WebSocket,
  };
  win.WebSocket.OPEN = 1;
  win.WebSocket.CONNECTING = 0;

  const fakeFetch = (url: string, init: { body: string }) => {
    const channel = decodeURIComponent(
      String(url).slice("https://desktop.example/bridge/ipc/".length),
    );
    calls.push({ channel, args: JSON.parse(init.body).args });
    if (nextFailure) {
      const failure = nextFailure;
      return Promise.resolve({
        ok: false,
        status: failure.status,
        json: () => Promise.resolve({ error: failure.error }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: nextResponse }),
    });
  };

  const sandbox = {
    window: win,
    document: {
      documentElement: { setAttribute: () => {}, appendChild: () => {} },
      createElement: () => ({ setAttribute: () => {} }),
    },
    localStorage: { setItem: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: fakeFetch,
    setTimeout: () => 0,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    URL,
    Uint8Array,
    Set,
    Map,
    Object,
    Array,
    JSON,
    Promise,
    String,
    TextDecoder,
  };

  const keys = Object.keys(sandbox);
  new Function(...keys, script)(...keys.map((key) => (sandbox as any)[key]));

  return {
    api: win.electronAPI,
    calls,
    nativeMessages,
    respondWith: (value) => {
      nextFailure = null;
      nextResponse = value;
    },
    failWith: (status, error) => {
      nextFailure = { status, error };
    },
  };
}

describe("shim bridge argument shapes", () => {
  test("packs browser fetches into the { url, init } payload the handler reads", async () => {
    const shim = loadShim();
    shim.respondWith({ ok: true });

    await shim.api.browser.fetchJson("https://api.example.com/search", {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    // Forwarding these positionally left payload.url undefined on the desktop,
    // which surfaced to apps as "Cannot read properties of undefined
    // (reading 'trim')" from the URL guard.
    expect(shim.calls[0]).toEqual({
      channel: "browser:fetchJson",
      args: [
        {
          url: "https://api.example.com/search",
          init: { method: "GET", headers: { Accept: "application/json" } },
        },
      ],
    });
  });

  test("packs media saves and self-mod reverts with the desktop's field names", async () => {
    const shim = loadShim();
    shim.respondWith({ ok: true });

    await shim.api.media.saveOutput("https://x/y.png", "y.png", "image");
    await shim.api.agent.selfModRevert("abc123", 1);

    expect(shim.calls[0].args).toEqual([
      { url: "https://x/y.png", fileName: "y.png", kind: "image" },
    ]);
    expect(shim.calls[1]).toEqual({
      channel: "selfmod:revert",
      args: [{ commitHash: "abc123", steps: 1 }],
    });
  });
});

describe("shim binary payloads", () => {
  test("rebuilds tagged base64 bytes into a real Uint8Array", async () => {
    const shim = loadShim();
    const json = '{"configs":[{"config_id":"baseline"}]}';
    shim.respondWith({
      bytes: {
        __stellaBridgeBinary: "base64",
        data: Buffer.from(json).toString("base64"),
        byteLength: json.length,
      },
      mimeType: "application/json",
      missing: false,
    });

    const result = await shim.api.display.readFile("/x/index.json", {
      conversationId: null,
    });

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result.bytes)).toBe(json);
  });

  test("rebuilds the numeric-keyed bytes an un-updated desktop still sends", async () => {
    const shim = loadShim();
    shim.respondWith({ bytes: { "0": 123, "1": 125 }, missing: false });

    const result = await shim.api.display.readFile("/x/a.json", {
      conversationId: null,
    });

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(result.bytes)).toBe("{}");
  });
});

describe("shim degrades loudly", () => {
  test("reports a refused capability to the native shell instead of failing silently", async () => {
    const shim = loadShim();
    shim.failWith(403, "Disallowed IPC channel: browser:fetchJson");

    await expect(
      shim.api.browser.fetchJson("https://api.example.com"),
    ).rejects.toThrow("Disallowed IPC channel");

    expect(shim.nativeMessages).toContainEqual({
      type: "capabilityUnavailable",
      capability: "browser:fetchJson",
    });
  });

  test("reports a handler that refused because the caller is the phone", async () => {
    const shim = loadShim();
    shim.failWith(500, "Not available in phone view: reading this file needs your computer.");

    await expect(
      shim.api.display.readFile("/etc/hosts", { conversationId: null }),
    ).rejects.toThrow("Not available in phone view");

    expect(shim.nativeMessages).toContainEqual({
      type: "capabilityUnavailable",
      capability: "display:readFile",
    });
  });

  test("reports a capability the desktop does not advertise at all", async () => {
    // A manifest without display.readFile: the desktop is too old or the
    // capability was withdrawn.
    const shim = loadShim([
      { mode: "remote-request", path: "ui.getState", channel: "ui:getState" },
    ]);

    await expect(
      shim.api.display.readFile("/x/a.json", { conversationId: null }),
    ).rejects.toThrow("not available on mobile");

    expect(shim.nativeMessages).toContainEqual({
      type: "capabilityUnavailable",
      capability: "display.readFile",
    });
  });
});
