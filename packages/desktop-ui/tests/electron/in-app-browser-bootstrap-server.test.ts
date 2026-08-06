import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InAppBrowserBootstrapServer } from "@stella/desktop/electron/services/in-app-browser-bootstrap-server.js";

const servers: InAppBrowserBootstrapServer[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const createEndpoint = () => {
  if (process.platform === "win32") {
    return { path: `\\\\.\\pipe\\stella-in-app-${randomUUID()}` } as const;
  }
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "stella-in-app-"));
  tempDirs.push(tempDir);
  return { path: path.join(tempDir, "init.sock") } as const;
};

const sendRequest = (
  endpoint: Readonly<{ path: string }>,
  payload: Record<string, unknown>,
) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
  });

describe("InAppBrowserBootstrapServer", () => {
  it("authenticates local requests and invokes only the hidden readiness callback", async () => {
    const endpoint = createEndpoint();
    const ensureReady = vi.fn(async () => {});
    const server = new InAppBrowserBootstrapServer({
      endpoint,
      tokenPath: `${endpoint.path}.token`,
      token: "secret-token",
      ensureReady,
    });
    servers.push(server);
    await server.start();

    await expect(
      sendRequest(endpoint, { action: "ensure", token: "wrong-token" }),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized browser initialization request.",
    });
    expect(ensureReady).not.toHaveBeenCalled();

    await expect(
      sendRequest(endpoint, { action: "ensure", token: "secret-token" }),
    ).resolves.toEqual({ success: true });
    expect(ensureReady).toHaveBeenCalledOnce();
  });

  it("returns readiness failures without exposing another control surface", async () => {
    const endpoint = createEndpoint();
    const server = new InAppBrowserBootstrapServer({
      endpoint,
      tokenPath: `${endpoint.path}.token`,
      token: "secret-token",
      ensureReady: vi.fn(async () => {
        throw new Error("Connect the Stella browser extension first.");
      }),
    });
    servers.push(server);
    await server.start();

    await expect(
      sendRequest(endpoint, { action: "ensure", token: "secret-token" }),
    ).resolves.toEqual({
      success: false,
      error: "Connect the Stella browser extension first.",
    });
  });
});
