import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

const capabilityRequest = (token: string) => ({
  action: "ensure",
  token,
  sessionId: "agent-thread-1",
  turnId: "turn-1",
  ownerLeaseId: "lease-1",
  ownerLeaseIssuedAt: 1_000,
});

describe("InAppBrowserBootstrapServer", () => {
  it.skipIf(process.platform === "win32")(
    "does not steal a live endpoint or replace its owner token",
    async () => {
      const endpoint = createEndpoint();
      const tokenPath = `${endpoint.path}.token`;
      const firstReady = vi.fn(async () => ({
        bridgeSessionId: "first-owner",
        capabilityExpiresAt: 10_000,
      }));
      const first = new InAppBrowserBootstrapServer({
        endpoint,
        tokenPath,
        token: "first-token",
        ensureReady: firstReady,
      });
      const challenger = new InAppBrowserBootstrapServer({
        endpoint,
        tokenPath,
        token: "challenger-token",
        ensureReady: vi.fn(async () => ({
          bridgeSessionId: "challenger",
          capabilityExpiresAt: 20_000,
        })),
      });
      servers.push(first, challenger);
      await first.start();

      await expect(challenger.start()).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
      await challenger.stop();

      expect(readFileSync(tokenPath, "utf8")).toBe("first-token");
      await expect(
        sendRequest(endpoint, capabilityRequest("first-token")),
      ).resolves.toMatchObject({
        success: true,
        data: { bridgeSessionId: "first-owner" },
      });
      expect(firstReady).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(process.platform === "win32")(
    "cannot unlink another owner's replacement endpoint or token during cleanup",
    async () => {
      const endpoint = createEndpoint();
      const tokenPath = `${endpoint.path}.token`;
      const first = new InAppBrowserBootstrapServer({
        endpoint,
        tokenPath,
        token: "first-token",
        ensureReady: vi.fn(async () => ({
          bridgeSessionId: "first-owner",
          capabilityExpiresAt: 10_000,
        })),
      });
      const replacementReady = vi.fn(async () => ({
        bridgeSessionId: "replacement-owner",
        capabilityExpiresAt: 20_000,
      }));
      const replacement = new InAppBrowserBootstrapServer({
        endpoint,
        tokenPath,
        token: "replacement-token",
        ensureReady: replacementReady,
      });
      servers.push(first, replacement);
      await first.start();

      // Model a legacy/external takeover: Unix permits unlinking a live socket
      // and rebinding its pathname while the old server remains open.
      unlinkSync(endpoint.path);
      await replacement.start();
      await first.stop();

      expect(existsSync(endpoint.path)).toBe(true);
      expect(readFileSync(tokenPath, "utf8")).toBe("replacement-token");
      await expect(
        sendRequest(endpoint, capabilityRequest("replacement-token")),
      ).resolves.toMatchObject({
        success: true,
        data: { bridgeSessionId: "replacement-owner" },
      });
      expect(replacementReady).toHaveBeenCalledOnce();
    },
  );

  it.skipIf(process.platform === "win32")(
    "reclaims an unreachable stale filesystem endpoint",
    async () => {
      const endpoint = createEndpoint();
      const tokenPath = `${endpoint.path}.token`;
      writeFileSync(endpoint.path, "stale");
      const server = new InAppBrowserBootstrapServer({
        endpoint,
        tokenPath,
        token: "fresh-token",
        ensureReady: vi.fn(async () => ({
          bridgeSessionId: "fresh-owner",
          capabilityExpiresAt: 10_000,
        })),
      });
      servers.push(server);

      await expect(server.start()).resolves.toBeUndefined();
      expect(readFileSync(tokenPath, "utf8")).toBe("fresh-token");
      await expect(
        sendRequest(endpoint, capabilityRequest("fresh-token")),
      ).resolves.toMatchObject({ success: true });
    },
  );

  it("authenticates local requests and invokes only the hidden readiness callback", async () => {
    const endpoint = createEndpoint();
    const ensureReady = vi.fn(async () => ({
      bridgeSessionId: "agent-backend-1",
      capabilityExpiresAt: 10_000,
    }));
    const server = new InAppBrowserBootstrapServer({
      endpoint,
      tokenPath: `${endpoint.path}.token`,
      token: "secret-token",
      ensureReady,
    });
    servers.push(server);
    await server.start();

    await expect(
      sendRequest(endpoint, capabilityRequest("wrong-token")),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized browser initialization request.",
    });
    expect(ensureReady).not.toHaveBeenCalled();

    await expect(
      sendRequest(endpoint, capabilityRequest("secret-token")),
    ).resolves.toEqual({
      success: true,
      data: {
        bridgeSessionId: "agent-backend-1",
        capabilityExpiresAt: 10_000,
      },
    });
    expect(ensureReady).toHaveBeenCalledOnce();
    expect(ensureReady).toHaveBeenCalledWith({
      sessionId: "agent-thread-1",
      turnId: "turn-1",
      ownerLeaseId: "lease-1",
      ownerLeaseIssuedAt: 1_000,
    });
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
      sendRequest(endpoint, capabilityRequest("secret-token")),
    ).resolves.toEqual({
      success: false,
      error: "Connect the Stella browser extension first.",
    });
  });

  it("forwards an authenticated backend recovery request", async () => {
    const endpoint = createEndpoint();
    const ensureReady = vi.fn(async () => ({
      bridgeSessionId: "agent-backend-2",
      capabilityExpiresAt: 20_000,
    }));
    const server = new InAppBrowserBootstrapServer({
      endpoint,
      tokenPath: `${endpoint.path}.token`,
      token: "secret-token",
      ensureReady,
    });
    servers.push(server);
    await server.start();

    await expect(
      sendRequest(endpoint, {
        ...capabilityRequest("secret-token"),
        recover: true,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(ensureReady).toHaveBeenCalledWith({
      sessionId: "agent-thread-1",
      turnId: "turn-1",
      ownerLeaseId: "lease-1",
      ownerLeaseIssuedAt: 1_000,
      recover: true,
    });
  });

  it("rejects incomplete or extra session capability metadata", async () => {
    const endpoint = createEndpoint();
    const ensureReady = vi.fn(async () => ({
      bridgeSessionId: "unused",
      capabilityExpiresAt: 10_000,
    }));
    const server = new InAppBrowserBootstrapServer({
      endpoint,
      tokenPath: `${endpoint.path}.token`,
      token: "secret-token",
      ensureReady,
    });
    servers.push(server);
    await server.start();

    const { turnId: _turnId, ...missingTurn } =
      capabilityRequest("secret-token");
    await expect(sendRequest(endpoint, missingTurn)).resolves.toEqual({
      success: false,
      error: "Unauthorized browser initialization request.",
    });
    await expect(
      sendRequest(endpoint, {
        ...capabilityRequest("secret-token"),
        ownerId: "different-owner",
      }),
    ).resolves.toEqual({
      success: false,
      error: "Unauthorized browser initialization request.",
    });
    expect(ensureReady).not.toHaveBeenCalled();
  });
});
