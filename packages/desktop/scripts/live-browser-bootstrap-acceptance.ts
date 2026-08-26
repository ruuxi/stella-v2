import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";

import { InAppBrowserBootstrapServer } from "../electron/services/in-app-browser-bootstrap-server.ts";

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
  sessionId: "live-bootstrap-acceptance",
  turnId: "turn-1",
  ownerLeaseId: "lease-1",
  ownerLeaseIssuedAt: 1_000,
});

if (process.platform === "win32") {
  throw new Error(
    "The live bootstrap ownership acceptance exercises Unix socket pathname replacement.",
  );
}

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "stella-bootstrap-live-"),
);
const endpoint = { path: path.join(tempRoot, "init.sock") } as const;
const tokenPath = `${endpoint.path}.token`;
const first = new InAppBrowserBootstrapServer({
  endpoint,
  tokenPath,
  token: "first-token",
  ensureReady: async () => ({
    bridgeSessionId: "first-owner",
    capabilityExpiresAt: 10_000,
  }),
});
const challenger = new InAppBrowserBootstrapServer({
  endpoint,
  tokenPath,
  token: "challenger-token",
  ensureReady: async () => ({
    bridgeSessionId: "challenger",
    capabilityExpiresAt: 20_000,
  }),
});
const replacement = new InAppBrowserBootstrapServer({
  endpoint,
  tokenPath,
  token: "replacement-token",
  ensureReady: async () => ({
    bridgeSessionId: "replacement-owner",
    capabilityExpiresAt: 30_000,
  }),
});
const staleEndpoint = {
  path: path.join(tempRoot, "stale.sock"),
} as const;
const staleTokenPath = `${staleEndpoint.path}.token`;
const staleReplacement = new InAppBrowserBootstrapServer({
  endpoint: staleEndpoint,
  tokenPath: staleTokenPath,
  token: "stale-replacement-token",
  ensureReady: async () => ({
    bridgeSessionId: "stale-replacement-owner",
    capabilityExpiresAt: 40_000,
  }),
});

const report: Record<string, unknown> = {};

try {
  await first.start();
  await assert.rejects(challenger.start(), (error: unknown) => {
    return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
  });
  await challenger.stop();
  assert.equal(await readFile(tokenPath, "utf8"), "first-token");
  const firstReceipt = await sendRequest(
    endpoint,
    capabilityRequest("first-token"),
  );
  assert.deepEqual(firstReceipt, {
    success: true,
    data: {
      bridgeSessionId: "first-owner",
      capabilityExpiresAt: 10_000,
    },
  });
  report.liveEndpointRejectedChallenger = true;

  // Reproduce the legacy takeover that originally exposed the race: unlink a
  // still-live owner's pathname, bind a replacement, then stop the old owner.
  await unlink(endpoint.path);
  await replacement.start();
  await first.stop();
  assert.equal(await readFile(tokenPath, "utf8"), "replacement-token");
  const replacementReceipt = await sendRequest(
    endpoint,
    capabilityRequest("replacement-token"),
  );
  assert.deepEqual(replacementReceipt, {
    success: true,
    data: {
      bridgeSessionId: "replacement-owner",
      capabilityExpiresAt: 30_000,
    },
  });
  report.oldCleanupPreservedReplacement = true;

  await writeFile(staleEndpoint.path, "unreachable stale endpoint", "utf8");
  await staleReplacement.start();
  assert.equal(
    await readFile(staleTokenPath, "utf8"),
    "stale-replacement-token",
  );
  const staleReceipt = await sendRequest(
    staleEndpoint,
    capabilityRequest("stale-replacement-token"),
  );
  assert.deepEqual(staleReceipt, {
    success: true,
    data: {
      bridgeSessionId: "stale-replacement-owner",
      capabilityExpiresAt: 40_000,
    },
  });
  report.unreachableEndpointReclaimed = true;

  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  await Promise.allSettled([
    first.stop(),
    challenger.stop(),
    replacement.stop(),
    staleReplacement.stop(),
  ]);
  await rm(tempRoot, { recursive: true, force: true });
}
