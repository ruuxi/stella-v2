import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_SESSION_CLIENT_METHODS,
  BrowserSession,
  BrowserSessionCommandError,
  BrowserSessionDisposedError,
  getBrowserDaemonPort,
  MAX_BROWSER_CHAIN_STEPS,
} from "@stella/runtime/kernel/browser-use/client";

type RequestRecord = Record<string, unknown>;
type ResponseRecord = Record<string, unknown> | undefined;
type RequestHandler = (
  request: RequestRecord,
  context: { connection: number; socket: Socket },
) => ResponseRecord | Promise<ResponseRecord>;

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createTestDaemon = (
  handler: RequestHandler,
  sharedSocketDir?: string,
) => {
  const tempRoot = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const socketDir = sharedSocketDir ?? mkdtempSync(path.join(tempRoot, "sb-"));
  const sessionId = `t-${randomUUID().slice(0, 8)}`;
  const socketPath = path.join(socketDir, `${sessionId}.sock`);
  const sockets = new Set<Socket>();
  const requests: RequestRecord[] = [];
  let connections = 0;
  let listening = false;

  const server: Server = createServer((socket) => {
    connections += 1;
    const connection = connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let work = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line) as RequestRecord;
        requests.push(request);
        work = work.then(async () => {
          const response = await handler(request, { connection, socket });
          if (response !== undefined && !socket.destroyed) {
            socket.write(`${JSON.stringify(response)}\n`);
          }
        });
      }
    });
  });

  const start = async () => {
    if (listening) return;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        process.platform === "win32"
          ? { host: "127.0.0.1", port: getBrowserDaemonPort(sessionId) }
          : { path: socketPath },
        () => {
          server.removeListener("error", reject);
          listening = true;
          resolve();
        },
      );
    });
  };

  const disconnect = () => {
    for (const socket of sockets) socket.destroy();
  };

  const stop = async () => {
    disconnect();
    if (listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      listening = false;
    }
  };

  const close = async () => {
    await stop();
    if (!sharedSocketDir) {
      rmSync(socketDir, { recursive: true, force: true });
    }
  };

  return {
    start,
    disconnect,
    stop,
    close,
    requests,
    sessionId,
    socketDir,
    get connections() {
      return connections;
    },
  };
};

const createClient = (
  daemon: ReturnType<typeof createTestDaemon>,
  overrides: Partial<ConstructorParameters<typeof BrowserSession>[0]> = {},
) =>
  new BrowserSession({
    binaryPath: "/tmp/stella-browser.js",
    sessionId: "node-repl-session-1",
    cwd: process.cwd(),
    env: { STELLA_BROWSER_SOCKET_DIR: daemon.socketDir },
    getBridgeEnv: () => ({
      STELLA_BROWSER_PROVIDER: "extension",
      STELLA_BROWSER_SESSION: daemon.sessionId,
      STELLA_BROWSER_EXT_PORT: "39040",
      STELLA_BROWSER_EXT_TOKEN: "test-token",
    }),
    runner: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    turnId: "test-turn-1",
    ...overrides,
  });

describe("BrowserSession direct daemon client", () => {
  it("keeps in-app as the default and switches between its daemon and the external bridge", async () => {
    const sharedDaemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { tabs: [] },
    }));
    const inAppDaemon = createTestDaemon(
      (request) => ({
        id: request.id,
        success: true,
        data: { tabs: [] },
      }),
      sharedDaemon.socketDir,
    );
    await Promise.all([sharedDaemon.start(), inAppDaemon.start()]);
    const initializeInAppBrowser = vi.fn(async () => ({
      bridgeSessionId: inAppDaemon.sessionId,
      capabilityExpiresAt: Date.now() + 30_000,
    }));
    const client = createClient(sharedDaemon, { initializeInAppBrowser });

    try {
      await client.command("tab_list");

      expect(initializeInAppBrowser).toHaveBeenCalledOnce();
      expect(inAppDaemon.requests[0]).toMatchObject({ action: "tab_list" });
      expect(inAppDaemon.requests[0]).not.toHaveProperty("browserBackend");
      expect(sharedDaemon.requests).toHaveLength(0);

      await client.selectBackend("external");
      await client.command("tab_list");

      expect(initializeInAppBrowser).toHaveBeenCalledOnce();
      expect(inAppDaemon.requests[1]).toMatchObject({
        action: "tab_list",
        browserBackend: "extension",
      });
      expect(sharedDaemon.requests).toHaveLength(0);

      await client.selectBackend("in-app");
      await client.command("tab_list");

      expect(initializeInAppBrowser).toHaveBeenCalledOnce();
      expect(inAppDaemon.requests[2]).toMatchObject({ action: "tab_list" });
      expect(inAppDaemon.requests[2]).not.toHaveProperty("browserBackend");
    } finally {
      await client.dispose();
      await inAppDaemon.close();
      await sharedDaemon.close();
    }
  });

  it("lazily initializes the hidden in-app browser before the first agent command", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { action: request.action },
    }));
    await daemon.start();
    const releaseInitialization = deferred<boolean>();
    const initializeInAppBrowser = vi.fn(
      async () => await releaseInitialization.promise,
    );
    const client = createClient(daemon, { initializeInAppBrowser });

    try {
      const first = client.command("navigate", { url: "https://example.com" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(initializeInAppBrowser).toHaveBeenCalledOnce();
      expect(daemon.requests).toHaveLength(0);

      releaseInitialization.resolve(true);
      await first;
      await client.command("title");

      expect(initializeInAppBrowser).toHaveBeenCalledOnce();
      expect(daemon.requests.map((request) => request.action)).toEqual([
        "navigate",
        "title",
      ]);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("switches from the fixed bootstrap session to a turn capability and reboots it after socket loss", async () => {
    const daemon = createTestDaemon((request, { connection, socket }) => {
      if (connection === 1) {
        socket.destroy();
        return undefined;
      }
      return { id: request.id, success: true, data: { recovered: true } };
    });
    await daemon.start();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const initializeInAppBrowser = vi.fn(async () => ({
      bridgeSessionId: daemon.sessionId,
      capabilityExpiresAt: Date.now() + 30_000,
    }));
    const client = createClient(daemon, {
      runner,
      initializeInAppBrowser,
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: "bootstrap-session",
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
      ownerLeaseId: "lease-1",
      ownerLeaseIssuedAt: 1_000,
    });

    try {
      const receipt = await client.command<{ recovered: boolean }>("url");

      expect(receipt.bridgeSessionId).toBe(daemon.sessionId);
      expect(receipt.result.data?.recovered).toBe(true);
      expect(initializeInAppBrowser).toHaveBeenCalledTimes(2);
      expect(initializeInAppBrowser).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          sessionId: "node-repl-session-1",
          turnId: "test-turn-1",
          ownerLeaseId: "lease-1",
          ownerLeaseIssuedAt: 1_000,
          env: expect.objectContaining({
            STELLA_BROWSER_SESSION: "bootstrap-session",
            STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
          }),
        }),
      );
      expect(initializeInAppBrowser).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          env: expect.objectContaining({
            STELLA_BROWSER_SESSION: daemon.sessionId,
            STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
          }),
        }),
      );
      expect(runner).not.toHaveBeenCalled();
      expect(daemon.connections).toBe(2);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("reboots a managed capability when its initial daemon connection fails", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { recovered: true },
    }));
    await daemon.start();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const initializeInAppBrowser = vi
      .fn()
      .mockResolvedValueOnce({
        bridgeSessionId: "dead-capability",
        capabilityExpiresAt: Date.now() + 30_000,
      })
      .mockResolvedValue({
        bridgeSessionId: daemon.sessionId,
        capabilityExpiresAt: Date.now() + 30_000,
      });
    const client = createClient(daemon, {
      runner,
      initializeInAppBrowser,
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: "bootstrap-session",
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
    });

    try {
      await expect(client.command("url")).resolves.toMatchObject({
        bridgeSessionId: daemon.sessionId,
        result: { success: true },
        attempts: 2,
      });
      expect(initializeInAppBrowser).toHaveBeenCalledTimes(2);
      expect(runner).not.toHaveBeenCalled();
      expect(daemon.connections).toBe(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("replaces a managed capability after one command wedges the daemon", async () => {
    const daemon = createTestDaemon((request, { connection }) =>
      connection === 1
        ? undefined
        : { id: request.id, success: true, data: { recovered: true } },
    );
    await daemon.start();
    const initializeInAppBrowser = vi.fn(async () => ({
      bridgeSessionId: daemon.sessionId,
      capabilityExpiresAt: Date.now() + 30_000,
    }));
    const client = createClient(daemon, {
      commandTimeoutMs: 40,
      initializeInAppBrowser,
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: "bootstrap-session",
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
    });

    try {
      await expect(
        client.command("evaluate", { expression: "while(true){}" }),
      ).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("timed out after 40ms"),
      });

      await expect(client.command("url")).resolves.toMatchObject({
        result: { success: true, data: { recovered: true } },
      });
      expect(initializeInAppBrowser).toHaveBeenCalledTimes(2);
      expect(initializeInAppBrowser).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ recover: true }),
      );
      expect(daemon.connections).toBe(2);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("reuses one socket, serializes calls, and requires exact response IDs", async () => {
    const releaseFirst = deferred();
    const sawFirst = deferred();
    const daemon = createTestDaemon(async (request) => {
      if (request.action === "url") {
        sawFirst.resolve();
        await releaseFirst.promise;
      }
      return {
        id: request.id,
        success: true,
        data: { action: request.action },
      };
    });
    await daemon.start();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const client = createClient(daemon, { runner });

    try {
      const first = client.command<{ action: string }>("url");
      const second = client.command<{ action: string }>("title");
      await sawFirst.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(daemon.requests).toHaveLength(1);

      releaseFirst.resolve();
      const [firstReceipt, secondReceipt] = await Promise.all([first, second]);

      expect(daemon.connections).toBe(1);
      expect(runner).not.toHaveBeenCalled();
      expect(daemon.requests.map((request) => request.action)).toEqual([
        "url",
        "title",
      ]);
      expect(daemon.requests[0]?.ownerId).toBe("node-repl-session-1");
      expect(daemon.requests[0]?.sessionId).toBe("node-repl-session-1");
      expect(daemon.requests[0]?.turnId).toBe("test-turn-1");
      expect(daemon.requests[0]?.ownerLeaseId).toEqual(expect.any(String));
      expect(daemon.requests[0]?.ownerLeaseIssuedAt).toEqual(
        expect.any(Number),
      );
      expect(daemon.requests[1]?.ownerLeaseId).toBe(
        daemon.requests[0]?.ownerLeaseId,
      );
      expect(daemon.requests[0]?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(daemon.requests[1]?.id).not.toBe(daemon.requests[0]?.id);
      expect(firstReceipt.result.id).toBe(daemon.requests[0]?.id);
      expect(secondReceipt.result.id).toBe(daemon.requests[1]?.id);
      expect(firstReceipt.result.data).toEqual({ action: "url" });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("retries a lost response with the same ID so daemon replay executes once", async () => {
    const executed = new Map<unknown, ResponseRecord>();
    let executions = 0;
    const daemon = createTestDaemon((request, { connection, socket }) => {
      let response = executed.get(request.id);
      if (!response) {
        executions += 1;
        response = {
          id: request.id,
          success: true,
          data: { recovered: true },
        };
        executed.set(request.id, response);
      }
      if (connection === 1) {
        socket.destroy();
        return undefined;
      }
      return response;
    });
    await daemon.start();
    const client = createClient(daemon);

    try {
      const receipt = await client.command<{ recovered: boolean }>("url");
      expect(receipt.attempts).toBe(2);
      expect(daemon.connections).toBe(2);
      expect(daemon.requests).toHaveLength(2);
      expect(daemon.requests[1]?.id).toBe(daemon.requests[0]?.id);
      expect(receipt.result.data?.recovered).toBe(true);
      expect(executions).toBe(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("does not replay a click whose response was lost across managed backend recovery", async () => {
    let clickExecutions = 0;
    const daemon = createTestDaemon((request, { socket }) => {
      if (request.action === "click") {
        clickExecutions += 1;
        socket.destroy();
        return undefined;
      }
      return { id: request.id, success: true, data: { recovered: true } };
    });
    await daemon.start();
    const initializeInAppBrowser = vi.fn(async () => ({
      bridgeSessionId: daemon.sessionId,
      capabilityExpiresAt: Date.now() + 30_000,
    }));
    const client = createClient(daemon, {
      initializeInAppBrowser,
      getBridgeEnv: () => ({
        STELLA_BROWSER_SESSION: "bootstrap-session",
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
    });

    try {
      await expect(
        client.command("click", { tabId: 1, selector: "#submit" }),
      ).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining(
          "may have completed before the managed browser backend disconnected",
        ),
      });
      expect(clickExecutions).toBe(1);
      expect(
        daemon.requests.filter((request) => request.action === "click"),
      ).toHaveLength(1);

      // Recovery is still armed for the next observational command; only the
      // ambiguous mutation itself is withheld from automatic replay.
      await expect(client.command("url", { tabId: 1 })).resolves.toMatchObject({
        result: { success: true, data: { recovered: true } },
      });
      expect(initializeInAppBrowser).toHaveBeenLastCalledWith(
        expect.objectContaining({ recover: true }),
      );
      expect(clickExecutions).toBe(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("rejects missing or mismatched response IDs after one retry", async () => {
    const daemon = createTestDaemon((_request, { connection }) =>
      connection === 1
        ? { success: true, data: {} }
        : { id: "wrong-id", success: true, data: {} },
    );
    await daemon.start();
    const client = createClient(daemon);

    try {
      await expect(client.command("url")).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("response ID did not match"),
      });
      expect(daemon.requests).toHaveLength(2);
      expect(daemon.requests[1]?.id).toBe(daemon.requests[0]?.id);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("aborts an in-flight request, closes that socket, and reconnects later", async () => {
    const sawWait = deferred();
    const daemon = createTestDaemon((request) => {
      if (request.action === "wait") {
        sawWait.resolve();
        return undefined;
      }
      return { id: request.id, success: true, data: { recovered: true } };
    });
    await daemon.start();
    const client = createClient(daemon, { commandTimeoutMs: 2_000 });
    const controller = new AbortController();
    const reason = new Error("stop browser command");

    try {
      const pending = client.command("wait", {}, { signal: controller.signal });
      await sawWait.promise;
      controller.abort(reason);
      await expect(pending).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringMatching(
          /stop browser command.*browser provenance: owner=node-repl-session-1.*action=wait/,
        ),
      });

      await expect(client.command("url")).resolves.toMatchObject({
        result: { success: true },
      });
      expect(daemon.connections).toBe(2);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("enforces response-frame and command time limits", async () => {
    const daemon = createTestDaemon((request, { socket }) => {
      if (request.action === "content") {
        socket.write(`{"success":true,"data":"${"x".repeat(2_048)}`);
      }
      return undefined;
    });
    await daemon.start();
    const limitedClient = createClient(daemon, {
      commandTimeoutMs: 1_000,
      maxOutputBytes: 512,
    });

    try {
      await expect(limitedClient.command("content")).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("512-byte limit"),
      });
    } finally {
      await limitedClient.dispose();
      await daemon.close();
    }

    const timeoutDaemon = createTestDaemon(() => undefined);
    await timeoutDaemon.start();
    const timeoutClient = createClient(timeoutDaemon, { commandTimeoutMs: 40 });
    try {
      await expect(timeoutClient.command("url")).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("timed out after 40ms"),
      });
    } finally {
      await timeoutClient.dispose();
      await timeoutDaemon.close();
    }
  });

  it("honors an action timeout beyond the historical 30-second client cap", async () => {
    const daemon = createTestDaemon(async (request) => {
      if (request.action === "wait") {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return { id: request.id, success: true, data: { waited: true } };
    });
    await daemon.start();
    const client = createClient(daemon, { commandTimeoutMs: 20 });

    try {
      await expect(
        client.command("wait", { timeout: 100 }),
      ).resolves.toMatchObject({
        result: { success: true, data: { waited: true } },
      });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("fingerprints lease provenance without exposing the bearer lease id", async () => {
    const daemon = createTestDaemon(() => undefined);
    await daemon.start();
    const rawLeaseId = "raw-owner-lease-bearer-secret";
    const client = createClient(daemon, {
      commandTimeoutMs: 20,
      ownerLeaseId: rawLeaseId,
      ownerLeaseIssuedAt: 9_000,
    });

    try {
      const error = await client
        .command("url")
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(BrowserSessionCommandError);
      expect((error as Error).message).toMatch(/lease#=[a-f0-9]{12}/);
      expect((error as Error).message).not.toContain(rawLeaseId);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("encodes chain as one raw protocol request and validates it before I/O", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {
        results: [],
        completed: 2,
        total: 2,
        totalDurationMs: 3,
        receivedAction: request.action,
      },
    }));
    await daemon.start();
    const client = createClient(daemon);

    try {
      const receipt = await client.chain(
        [
          { action: "navigate", params: { url: "https://example.com" } },
          { action: "click", params: { selector: "@e1" } },
        ],
        {
          abortOnError: false,
          delay: { minMs: 10, maxMs: 20 },
          waitForSelector: true,
          waitTimeoutMs: 500,
          returnSnapshot: true,
        },
      );

      expect(receipt.action).toBe("chain");
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]).toMatchObject({
        action: "chain",
        ownerId: "node-repl-session-1",
        abortOnError: false,
        delay: { min: 10, max: 20 },
        timeout: 180_000,
        waitForSelector: true,
        waitTimeout: 500,
        returnSnapshot: true,
        steps: [
          { action: "navigate", url: "https://example.com" },
          { action: "click", selector: "@e1" },
        ],
      });

      await expect(
        client.chain(
          Array.from({ length: MAX_BROWSER_CHAIN_STEPS + 1 }, () => ({
            action: "url" as const,
          })),
        ),
      ).rejects.toThrow("at most 100");
      await expect(
        client.chain([{ action: "chain" } as never]),
      ).rejects.toThrow("not an allowed browser chain action");
      await expect(
        client.chain([{ action: "finalize_tabs" } as never]),
      ).rejects.toThrow("not an allowed browser chain action");
      await expect(
        client.chain([{ action: "close_owner" } as never]),
      ).rejects.toThrow("not an allowed browser chain action");
      await expect(
        client.command("url", { ownerId: "other" } as never),
      ).rejects.toThrow("managed by BrowserSession");
      await expect(client.command("close" as never)).rejects.toThrow(
        "not an allowed browser protocol action",
      );
      expect(daemon.requests).toHaveLength(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("extends chain deadlines from validated step, wait, and delay budgets", async () => {
    const daemon = createTestDaemon(async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      return {
        id: request.id,
        success: true,
        data: {
          results: [],
          completed: 1,
          total: 1,
          totalDurationMs: 75,
        },
      };
    });
    await daemon.start();
    const client = createClient(daemon, { commandTimeoutMs: 30 });

    try {
      await expect(
        client.chain([{ action: "click", params: { selector: "#save" } }], {
          waitTimeoutMs: 100,
          delay: { minMs: 20, maxMs: 40 },
        }),
      ).resolves.toMatchObject({ result: { success: true }, attempts: 1 });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("uses an explicit canonical chain timeout in transport and runtime execution", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { results: [], completed: 0, total: 0 },
    }));
    await daemon.start();
    const client = createClient(daemon, { commandTimeoutMs: 30 });
    try {
      await client.chain([{ action: "url" }], { timeoutMs: 120_000 });
      expect(daemon.requests.at(-1)).toMatchObject({
        action: "chain",
        timeout: 120_000,
      });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("allows owner lifecycle actions only through the top-level command surface", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {},
    }));
    await daemon.start();
    const initializeInAppBrowser = vi.fn(async () => true);
    const client = createClient(daemon, { initializeInAppBrowser });

    try {
      await client.command("finalize_tabs", { keep: [] });
      await client.command("close_owner");

      expect(BROWSER_SESSION_CLIENT_METHODS).toEqual([
        "command",
        "chain",
        "selectBackend",
        "dispose",
      ]);
      expect(daemon.requests.map((request) => request.action)).toEqual([
        "finalize_tabs",
        "close_owner",
      ]);
      expect(
        daemon.requests.every(
          (request) => request.ownerId === "node-repl-session-1",
        ),
      ).toBe(true);
      expect(initializeInAppBrowser).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("bootstraps the service once when the shared endpoint is unavailable", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { tabs: [] },
    }));
    const runner = vi.fn(async () => {
      await daemon.start();
      return { exitCode: 0, stdout: '{"success":true}\n', stderr: "" };
    });
    const client = createClient(daemon, { runner });

    try {
      await expect(client.command("tab_list")).resolves.toMatchObject({
        result: { success: true },
      });
      await expect(client.command("tab_list")).resolves.toMatchObject({
        result: { success: true },
      });

      expect(runner).toHaveBeenCalledOnce();
      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({
          command: process.execPath,
          args: [
            "/tmp/stella-browser.js",
            "service",
            "ensure",
            "--session",
            daemon.sessionId,
            "--json",
          ],
          env: expect.objectContaining({
            STELLA_BROWSER_PROVIDER: "extension",
            STELLA_BROWSER_SESSION: daemon.sessionId,
            STELLA_BROWSER_OWNER_ID: "node-repl-session-1",
            ELECTRON_RUN_AS_NODE: "1",
          }),
        }),
      );
      expect(daemon.connections).toBe(1);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("restores startup fallback eligibility after each successful connection", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { tabs: [] },
    }));
    const runner = vi.fn(async () => {
      await daemon.start();
      return { exitCode: 0, stdout: '{"success":true}\n', stderr: "" };
    });
    const client = createClient(daemon, { runner });

    try {
      await client.command("tab_list");
      await daemon.stop();
      await new Promise((resolve) => setImmediate(resolve));
      await client.command("tab_list");

      expect(runner).toHaveBeenCalledTimes(2);
      expect(daemon.connections).toBe(2);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("disposal releases only its exact lease and preserves tabs for reclaim", async () => {
    const socketClosed = deferred();
    const daemon = createTestDaemon((request, { socket }) => {
      socket.once("close", () => socketClosed.resolve());
      return { id: request.id, success: true, data: {} };
    });
    await daemon.start();
    const client = createClient(daemon);

    try {
      await client.command("url");
      await client.dispose();
      await socketClosed.promise;

      expect(daemon.requests.map((request) => request.action)).toEqual([
        "url",
        "release_owner_lease",
      ]);
      expect(client.isDisposed).toBe(true);
      await expect(client.command("title")).rejects.toBeInstanceOf(
        BrowserSessionDisposedError,
      );
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("stamps commands and dispose cleanup with the configured turn lease", async () => {
    const socketClosed = deferred();
    const daemon = createTestDaemon((request, { socket }) => {
      socket.once("close", () => socketClosed.resolve());
      return { id: request.id, success: true, data: {} };
    });
    await daemon.start();
    const client = createClient(daemon, {
      ownerLeaseId: "kernel-lease-2",
      ownerLeaseIssuedAt: 2_000,
    });

    try {
      await client.command("url");
      await client.dispose();
      await socketClosed.promise;

      expect(daemon.requests).toEqual([
        expect.objectContaining({
          action: "url",
          ownerId: "node-repl-session-1",
          sessionId: "node-repl-session-1",
          turnId: "test-turn-1",
          ownerLeaseId: "kernel-lease-2",
          ownerLeaseIssuedAt: 2_000,
        }),
        expect.objectContaining({
          action: "release_owner_lease",
          ownerId: "node-repl-session-1",
          sessionId: "node-repl-session-1",
          turnId: "test-turn-1",
          ownerLeaseId: "kernel-lease-2",
          ownerLeaseIssuedAt: 2_000,
        }),
      ]);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("allocates strictly increasing default lease timestamps in the same millisecond", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {},
    }));
    await daemon.start();
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const first = createClient(daemon, { turnId: "turn-1" });
    const second = createClient(daemon, { turnId: "turn-2" });

    try {
      await first.command("url");
      await second.command("title");

      expect(daemon.requests[1]?.ownerLeaseIssuedAt).toBeGreaterThan(
        daemon.requests[0]?.ownerLeaseIssuedAt as number,
      );
    } finally {
      now.mockRestore();
      await first.dispose();
      await second.dispose();
      await daemon.close();
    }
  });

  it("finalizes and releases each turn before rotating to a newer lease", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {},
    }));
    await daemon.start();
    const client = createClient(daemon, {
      ownerLeaseId: "turn-lease-1",
      ownerLeaseIssuedAt: 5_000,
    });

    try {
      await client.command("url");
      await client.endTurn("test-turn-1", "close-tabs");
      client.beginTurn("test-turn-2");
      await client.command("title");

      expect(daemon.requests.map((request) => request.action)).toEqual([
        "url",
        "finalize_tabs",
        "release_owner_lease",
        "title",
      ]);
      expect(daemon.requests[3]).toMatchObject({
        sessionId: "node-repl-session-1",
        turnId: "test-turn-2",
      });
      expect(daemon.requests[3]?.ownerLeaseId).not.toBe("turn-lease-1");
      expect(daemon.requests[3]?.ownerLeaseIssuedAt).toBeGreaterThan(5_000);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("rebinding after socket ENOENT uses the successor lease instead of the rediscovered shared bridge", async () => {
    const sharedDaemon = createTestDaemon((request) => ({
      id: request.id,
      success: false,
      error: "Browser daemon rejected a request outside its authorized session",
    }));
    const agentDaemon = createTestDaemon(
      (request) => ({
        id: request.id,
        success: true,
        data: { tabs: [{ tabId: 7, url: "https://ads.google.com" }] },
      }),
      sharedDaemon.socketDir,
    );
    await Promise.all([sharedDaemon.start(), agentDaemon.start()]);
    const initializeInAppBrowser = vi
      .fn()
      .mockResolvedValueOnce({
        bridgeSessionId: agentDaemon.sessionId,
        capabilityExpiresAt: Date.now() + 30_000,
      })
      .mockImplementationOnce(async () => {
        await agentDaemon.stop();
        return false;
      })
      .mockResolvedValue({
        bridgeSessionId: agentDaemon.sessionId,
        capabilityExpiresAt: Date.now() + 30_000,
      });
    const client = createClient(sharedDaemon, {
      initializeInAppBrowser,
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: sharedDaemon.sessionId,
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: sharedDaemon.sessionId,
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
      ownerLeaseId: "lease-1",
      ownerLeaseIssuedAt: 1_000,
    });

    try {
      await client.selectBackend("external");
      await expect(client.command("tab_list")).resolves.toMatchObject({
        bridgeSessionId: agentDaemon.sessionId,
        result: { success: true },
      });

      await agentDaemon.stop();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(client.command("tab_list")).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringMatching(/ENOENT|Failed to connect|did not return an authorized/),
      });

      await agentDaemon.start();
      await expect(client.command("tab_list")).resolves.toMatchObject({
        bridgeSessionId: agentDaemon.sessionId,
        result: {
          success: true,
          data: { tabs: [{ tabId: 7, url: "https://ads.google.com" }] },
        },
      });

      expect(sharedDaemon.requests).toHaveLength(0);
      expect(
        initializeInAppBrowser.mock.calls.every(
          ([{ ownerLeaseId }]) => ownerLeaseId === "lease-1",
        ),
      ).toBe(true);
      expect(agentDaemon.requests.at(-1)).toMatchObject({
        action: "tab_list",
        ownerLeaseId: "lease-1",
        browserBackend: "extension",
      });
    } finally {
      await client.dispose();
      await agentDaemon.close();
      await sharedDaemon.close();
    }
  });

  it("atomically rebinds endpoint and lease for a valid successor turn", async () => {
    const firstAgent = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { tabs: [{ tabId: 1, url: "https://ads.google.com/turn-1" }] },
    }));
    const secondAgent = createTestDaemon(
      (request) => ({
        id: request.id,
        success: true,
        data: { tabs: [{ tabId: 1, url: "https://ads.google.com/turn-2" }] },
      }),
      firstAgent.socketDir,
    );
    await Promise.all([firstAgent.start(), secondAgent.start()]);
    const initializeInAppBrowser = vi
      .fn()
      .mockResolvedValueOnce({
        bridgeSessionId: firstAgent.sessionId,
        capabilityExpiresAt: Date.now() + 30_000,
      })
      .mockResolvedValue({
        bridgeSessionId: secondAgent.sessionId,
        capabilityExpiresAt: Date.now() + 30_000,
      });
    const client = createClient(firstAgent, {
      initializeInAppBrowser,
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: "bootstrap-session",
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
      ownerLeaseId: "lease-1",
      ownerLeaseIssuedAt: 1_000,
    });

    try {
      await client.selectBackend("external");
      await client.command("tab_list");
      await client.endTurn("test-turn-1", "retain-tabs");
      client.beginTurn("test-turn-2");
      await expect(client.command("tab_list")).resolves.toMatchObject({
        bridgeSessionId: secondAgent.sessionId,
        result: {
          success: true,
          data: { tabs: [{ tabId: 1, url: "https://ads.google.com/turn-2" }] },
        },
      });

      expect(initializeInAppBrowser).toHaveBeenCalledTimes(2);
      expect(initializeInAppBrowser).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          turnId: "test-turn-1",
          ownerLeaseId: "lease-1",
          env: expect.objectContaining({
            STELLA_BROWSER_SESSION: "bootstrap-session",
          }),
        }),
      );
      expect(initializeInAppBrowser).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          turnId: "test-turn-2",
          env: expect.objectContaining({
            STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
          }),
        }),
      );
      expect(initializeInAppBrowser.mock.calls[1]?.[0]?.ownerLeaseId).not.toBe(
        "lease-1",
      );
      expect(firstAgent.requests.map((request) => request.action)).toEqual([
        "tab_list",
        "release_owner_lease",
      ]);
      expect(secondAgent.requests).toEqual([
        expect.objectContaining({
          action: "tab_list",
          turnId: "test-turn-2",
          browserBackend: "extension",
        }),
      ]);
    } finally {
      await client.dispose();
      await secondAgent.close();
      await firstAgent.close();
    }
  });

  it("single-flights a racing successor rebind onto one authorized endpoint", async () => {
    const agentDaemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: { tabs: [{ tabId: 3 }] },
    }));
    await agentDaemon.start();
    const releaseInitialization = deferred<{
      bridgeSessionId: string;
      capabilityExpiresAt: number;
    }>();
    const initializeInAppBrowser = vi.fn(
      async () => await releaseInitialization.promise,
    );
    const client = createClient(agentDaemon, {
      initializeInAppBrowser,
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: "bootstrap-session",
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: "bootstrap-session",
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
    });

    try {
      const first = client.command("tab_list");
      const second = client.command("url");
      await vi.waitFor(() =>
        expect(initializeInAppBrowser).toHaveBeenCalledOnce(),
      );
      releaseInitialization.resolve({
        bridgeSessionId: agentDaemon.sessionId,
        capabilityExpiresAt: Date.now() + 30_000,
      });
      await Promise.all([first, second]);

      expect(initializeInAppBrowser).toHaveBeenCalledOnce();
      expect(agentDaemon.connections).toBe(1);
      expect(agentDaemon.requests.map((request) => request.action)).toEqual([
        "tab_list",
        "url",
      ]);
    } finally {
      await client.dispose();
      await agentDaemon.close();
    }
  });

  it("rejects a foreign session even after rediscovering the Chrome bridge", async () => {
    const sharedDaemon = createTestDaemon((request) => ({
      id: request.id,
      success: false,
      error: "Browser daemon rejected a request outside its authorized session",
    }));
    await sharedDaemon.start();
    const initializeInAppBrowser = vi.fn(async () => ({
      bridgeSessionId: sharedDaemon.sessionId,
      capabilityExpiresAt: Date.now() + 30_000,
    }));
    const owner = createClient(sharedDaemon, {
      initializeInAppBrowser,
      sessionId: "owner-session",
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: sharedDaemon.sessionId,
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: sharedDaemon.sessionId,
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
      ownerLeaseId: "owner-lease",
      ownerLeaseIssuedAt: 1_000,
    });
    const foreign = createClient(sharedDaemon, {
      initializeInAppBrowser,
      sessionId: "foreign-session",
      getBridgeEnv: () => ({
        STELLA_BROWSER_PROVIDER: "extension",
        STELLA_BROWSER_SESSION: sharedDaemon.sessionId,
        STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION: sharedDaemon.sessionId,
        STELLA_BROWSER_MANAGED_BRIDGE: "1",
      }),
      ownerLeaseId: "foreign-lease",
      ownerLeaseIssuedAt: 2_000,
    });

    try {
      await expect(owner.command("tab_list")).rejects.toMatchObject({
        message: expect.stringContaining("outside its authorized session"),
      });
      await expect(foreign.command("tab_list")).rejects.toMatchObject({
        message: expect.stringContaining("outside its authorized session"),
      });
      expect(sharedDaemon.requests.map((request) => request.sessionId)).toEqual(
        expect.arrayContaining(["owner-session", "foreign-session"]),
      );
      expect(
        sharedDaemon.requests.every((request) =>
          ["owner-session", "foreign-session"].includes(
            request.sessionId as string,
          ),
        ),
      ).toBe(true);
    } finally {
      await owner.dispose();
      await foreign.dispose();
      await sharedDaemon.close();
    }
  });


  it("retains root tabs while releasing browser control at turn completion", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {},
    }));
    await daemon.start();
    const client = createClient(daemon, {
      ownerLeaseId: "root-turn-lease",
      ownerLeaseIssuedAt: 5_500,
    });

    try {
      await client.command("url");
      await client.endTurn("test-turn-1", "retain-tabs");

      expect(daemon.requests.map((request) => request.action)).toEqual([
        "url",
        "release_owner_lease",
      ]);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("leaves explicit deliverables released before automatic empty finalization", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: true,
      data: {},
    }));
    await daemon.start();
    const client = createClient(daemon);

    try {
      await client.command("finalize_tabs", {
        keep: [{ tabId: 7, status: "deliverable" }],
      });
      await client.endTurn("test-turn-1", "close-tabs");

      expect(daemon.requests).toEqual([
        expect.objectContaining({
          action: "finalize_tabs",
          keep: [{ tabId: 7, status: "deliverable" }],
        }),
        expect.objectContaining({ action: "finalize_tabs", keep: [] }),
        expect.objectContaining({ action: "release_owner_lease" }),
      ]);
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });

  it("preserves structured daemon failures on command errors", async () => {
    const daemon = createTestDaemon((request) => ({
      id: request.id,
      success: false,
      error: "No active tab for this owner",
    }));
    await daemon.start();
    const client = createClient(daemon);

    try {
      const error = await client
        .command("url")
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(BrowserSessionCommandError);
      expect(error).toMatchObject({
        code: "command_failed",
        message: "No active tab for this owner",
        receipt: {
          result: {
            success: false,
            error: "No active tab for this owner",
          },
        },
      });
    } finally {
      await client.dispose();
      await daemon.close();
    }
  });
});
