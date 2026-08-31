/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const serviceSecret = "execution-presence-http-secret";
const identity = {
  ownerId: "issuer|presence-http-owner",
  deviceId: "presence-http-device",
  presenceSessionId: "presence-http-session",
  connectionId: "presence-http-connection",
};

beforeEach(() => {
  process.env.BUILDER_SERVICE_SECRET = serviceSecret;
});

afterEach(() => {
  delete process.env.BUILDER_SERVICE_SECRET;
});

describe("execution presence private HTTP callbacks", () => {
  it("requires the service credential and disconnects only the exact socket", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("desktop_execution_presence", {
        ownerId: identity.ownerId,
        deviceId: identity.deviceId,
        presenceSessionId: identity.presenceSessionId,
        ownerGeneration: "generation-a",
        devicePublicKey: "test-public-key",
        deviceKeyFingerprint: "test-fingerprint",
        protocolVersion: 1,
        appVersion: "test",
        capabilities: ["chat"],
        status: "ready",
        heartbeatSeq: 2,
        proofSeq: 2,
        lastProofOperation: "presence-socket-connect",
        lastProofBodyHash: "test-body-hash",
        chatSlotCapacity: 1,
        agentSlotCapacity: 0,
        availableChatSlots: 1,
        availableAgentSlots: 0,
        presenceTransport: "socket",
        socketConnectionId: identity.connectionId,
        socketConnectedAt: now,
        socketLeaseExpiresAt: now + 30_000,
        leaseExpiresAt: now - 1,
        createdAt: now,
        updatedAt: now,
      });
    });

    const request = (
      path: "check" | "disconnect",
      body: Record<string, unknown> =
        path === "check"
          ? { ...identity, authExpiresAtMs: Date.now() + 60_000 }
          : identity,
    ) =>
      t.fetch(`/api/execution-placement/presence/socket/${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${serviceSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const unauthorized = await t.fetch(
      "/api/execution-placement/presence/socket/check",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(identity),
      },
    );
    expect(unauthorized.status).toBe(401);

    await expect((await request("check")).json()).resolves.toEqual({
      current: true,
    });
    await expect(
      (
        await request("disconnect", {
          ...identity,
          connectionId: "stale-replaced-connection",
        })
      ).json(),
    ).resolves.toEqual({ disconnected: false });
    await expect((await request("disconnect")).json()).resolves.toEqual({
      disconnected: true,
    });
    await expect((await request("check")).json()).resolves.toEqual({
      current: false,
    });
  });
});
