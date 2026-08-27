/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { MOBILE_BRIDGE_LEASE_MS } from "./mobile_bridge";
import { hashSha256Hex, hmacSha256Hex } from "./lib/crypto_utils";
import { buildMobileBridgePairProofMessage } from "./mobile_access";

const modules = import.meta.glob("./**/*.ts");
const ownerId = "https://issuer.test|bridge-owner";
const desktopDeviceId = "desktop-bridge-test";
const tunnelUrl = "https://bridge-test.example.com";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};
const ownerSessionId = "session-bridge-owner";
/**
 * `sessionId: null` omits the claim entirely (modelling a token that predates
 * or loses it). Note it must be `null`, not `undefined` — passing `undefined`
 * for an optional parameter selects its default value in JS.
 */
const asOwner = (
  t: ReturnType<typeof createTest>,
  sessionId: string | null = ownerSessionId,
) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "bridge-owner",
    tokenIdentifier: ownerId,
    // Mirrors the real token: the Convex plugin stamps `sessionId` on every
    // JWT and Convex surfaces it (`iat` is stripped by the customJwt decoder,
    // which is why revocation keys on this claim instead).
    ...(sessionId === null ? {} : { sessionId }),
  });

const registrationArgs = {
  deviceId: desktopDeviceId,
  baseUrls: [`${tunnelUrl}/`],
  platform: "macOS",
  desktopPublicKey: "desktop_public_key",
};

describe("desktop bridge registration", () => {
  it("requires a connected account", async () => {
    const t = createTest();

    await expect(
      t.mutation(api.mobile_bridge.registerDesktopBridge, registrationArgs),
    ).rejects.toThrow("Authentication required");

    const anonymous = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "anonymous-bridge-owner",
      tokenIdentifier: "https://issuer.test|anonymous-bridge-owner",
      isAnonymous: true,
    });
    await expect(
      anonymous.mutation(
        api.mobile_bridge.registerDesktopBridge,
        registrationArgs,
      ),
    ).rejects.toThrow("Sign in with an account");
  });

  it("rejects a revoked session", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId,
        sessionId: ownerSessionId,
        revokedAt: Date.now(),
        expiresAt: Date.now() + 30 * 60_000,
      });
    });

    await expect(
      asOwner(t).mutation(
        api.mobile_bridge.registerDesktopBridge,
        registrationArgs,
      ),
    ).rejects.toThrow("Session has been revoked");
  });

  // The old `iat`-based test only covered the reject path, so a mechanism
  // that rejected *everything* would still have passed. These three pin the
  // allow paths that actually matter.
  it("allows a session that was never revoked", async () => {
    const t = createTest();
    const result = await asOwner(t).mutation(
      api.mobile_bridge.registerDesktopBridge,
      registrationArgs,
    );
    expect(result.ok).toBe(true);
  });

  it("allows a different session on an account with other revocations", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId,
        sessionId: "some-other-device-session",
        revokedAt: Date.now(),
        expiresAt: Date.now() + 30 * 60_000,
      });
    });

    const result = await asOwner(t).mutation(
      api.mobile_bridge.registerDesktopBridge,
      registrationArgs,
    );
    expect(result.ok).toBe(true);
  });

  it("ignores a tombstone whose covered JWT has already expired", async () => {
    const t = createTest();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId,
        sessionId: ownerSessionId,
        revokedAt: Date.now() - 60 * 60_000,
        expiresAt: Date.now() - 60_000,
      });
    });

    const result = await asOwner(t).mutation(
      api.mobile_bridge.registerDesktopBridge,
      registrationArgs,
    );
    expect(result.ok).toBe(true);
  });

  it("denies an unidentifiable session only when revocations exist", async () => {
    const t = createTest();

    // No tombstones: a token without `sessionId` still works, so a future
    // regression in the claim cannot mass-lock accounts.
    const before = await asOwner(t, null).mutation(
      api.mobile_bridge.registerDesktopBridge,
      registrationArgs,
    );
    expect(before.ok).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId,
        sessionId: "any-session",
        revokedAt: Date.now(),
        expiresAt: Date.now() + 30 * 60_000,
      });
    });

    await expect(
      asOwner(t, null).mutation(
        api.mobile_bridge.registerDesktopBridge,
        registrationArgs,
      ),
    ).rejects.toThrow("Session has been revoked");
  });

  it("allows 60 registrations per owner and rejects the 61st", async () => {
    const t = createTest();
    const owner = asOwner(t);

    for (let request = 0; request < 60; request += 1) {
      const result = await owner.mutation(
        api.mobile_bridge.registerDesktopBridge,
        registrationArgs,
      );
      expect(result.ok).toBe(true);
    }

    await expect(
      owner.mutation(api.mobile_bridge.registerDesktopBridge, registrationArgs),
    ).rejects.toThrow("Too many desktop bridge registrations");

    const limit = await t.run(async (ctx) =>
      ctx.db
        .query("mobile_bridge_registration_limits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    );
    expect(limit?.count).toBe(60);
  });

  it("resets the registration limit after the fixed window", async () => {
    const t = createTest();
    const expiredWindowStartedAt = Date.now() - 60_001;
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_bridge_registration_limits", {
        ownerId,
        windowStartedAt: expiredWindowStartedAt,
        count: 60,
      });
    });

    const result = await asOwner(t).mutation(
      api.mobile_bridge.registerDesktopBridge,
      registrationArgs,
    );
    expect(result).toMatchObject({ ok: true, written: true });

    const limit = await t.run(async (ctx) =>
      ctx.db
        .query("mobile_bridge_registration_limits")
        .withIndex("by_ownerId", (q) => q.eq("ownerId", ownerId))
        .unique(),
    );
    expect(limit?.count).toBe(1);
    expect(limit?.windowStartedAt).toBeGreaterThan(expiredWindowStartedAt);
  });

  it("registers in one mutation and makes redundant refreshes no-ops", async () => {
    const t = createTest();
    const owner = asOwner(t);

    const first = await owner.mutation(
      api.mobile_bridge.registerDesktopBridge,
      registrationArgs,
    );
    expect(first).toMatchObject({
      ok: true,
      written: true,
      leaseDurationMs: 15 * 60_000,
    });
    expect(first.leaseExpiresAt).toBeGreaterThan(Date.now());

    const duplicate = await owner.mutation(
      api.mobile_bridge.registerDesktopBridge,
      registrationArgs,
    );
    expect(duplicate).toEqual({ ...first, written: false });

    const storedAfterDuplicate = await t.run(async (ctx) =>
      ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", desktopDeviceId),
        )
        .unique(),
    );
    expect(storedAfterDuplicate).toMatchObject({
      ownerId,
      deviceId: desktopDeviceId,
      baseUrls: [tunnelUrl],
      platform: "macOS",
      desktopPublicKey: "desktop_public_key",
    });
    expect(storedAfterDuplicate?.updatedAt).toBe(
      first.leaseExpiresAt - MOBILE_BRIDGE_LEASE_MS,
    );

    const rotatedUrl = "https://rotated-bridge-test.example.com";
    const updated = await owner.mutation(
      api.mobile_bridge.registerDesktopBridge,
      { ...registrationArgs, baseUrls: [rotatedUrl] },
    );
    expect(updated).toMatchObject({ ok: true, written: true });
    const storedAfterUpdate = await t.run(async (ctx) =>
      ctx.db
        .query("mobile_bridge_registrations")
        .withIndex("by_ownerId_and_deviceId", (q) =>
          q.eq("ownerId", ownerId).eq("deviceId", desktopDeviceId),
        )
        .unique(),
    );
    expect(storedAfterUpdate?.baseUrls).toEqual([rotatedUrl]);
    expect(storedAfterUpdate?.updatedAt).toBe(
      updated.leaseExpiresAt - MOBILE_BRIDGE_LEASE_MS,
    );
  });

  it("refreshes unchanged registrations after five minutes", async () => {
    const t = createTest();
    const initialUpdatedAt = 10_000;

    const first = await t.mutation(internal.mobile_bridge.upsertRegistration, {
      ownerId,
      ...registrationArgs,
      updatedAt: initialUpdatedAt,
    });
    expect(first).toEqual({ written: true, updatedAt: initialUpdatedAt });

    const early = await t.mutation(internal.mobile_bridge.upsertRegistration, {
      ownerId,
      ...registrationArgs,
      updatedAt: initialUpdatedAt + MOBILE_BRIDGE_LEASE_MS / 3 - 1,
    });
    expect(early).toEqual({ written: false, updatedAt: initialUpdatedAt });

    const dueAt = initialUpdatedAt + MOBILE_BRIDGE_LEASE_MS / 3;
    const due = await t.mutation(internal.mobile_bridge.upsertRegistration, {
      ownerId,
      ...registrationArgs,
      updatedAt: dueAt,
    });
    expect(due).toEqual({ written: true, updatedAt: dueAt });
  });
});

describe("desktop bridge last-known descriptor", () => {
  it("keeps legacy expired availability while returning the descriptor", async () => {
    const t = createTest();
    await t.mutation(internal.mobile_bridge.upsertRegistration, {
      ownerId,
      ...registrationArgs,
      updatedAt: 1,
    });

    const response = await asOwner(t).fetch(
      `/api/mobile/desktop-bridge?desktopDeviceId=${desktopDeviceId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      baseUrls: [],
      platform: "macOS",
      updatedAt: 1,
      lastKnownRegistration: {
        desktopDeviceId,
        baseUrls: [tunnelUrl],
        platform: "macOS",
        desktopPublicKey: "desktop_public_key",
        updatedAt: 1,
      },
    });
  });

  it("returns a null descriptor when no registration exists", async () => {
    const t = createTest();
    const response = await asOwner(t).fetch(
      `/api/mobile/desktop-bridge?desktopDeviceId=${desktopDeviceId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      baseUrls: [],
      platform: null,
      updatedAt: null,
      lastKnownRegistration: null,
    });
  });

  it("mints a paired session from a directly reached expired descriptor", async () => {
    const t = createTest();
    const mobileDeviceId = "mobile-bridge-test";
    const pairSecret = "paired_mobile_secret";
    const pairSecretHash = await hashSha256Hex(pairSecret);
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_bridge_registrations", {
        ownerId,
        deviceId: desktopDeviceId,
        baseUrls: [tunnelUrl],
        updatedAt: 1,
        platform: "macOS",
        desktopPublicKey: "desktop_public_key",
      });
      await ctx.db.insert("paired_mobile_devices", {
        ownerId,
        desktopDeviceId,
        mobileDeviceId,
        pairSecretHash,
        approvedAt: 1,
        lastSeenAt: 1,
      });
    });

    const desktopChallenge = "desktop_challenge";
    const mobilePublicKey = "mobile_public_key";
    const issuedAt = Date.now();
    const proof = await hmacSha256Hex(
      pairSecretHash,
      buildMobileBridgePairProofMessage({
        desktopDeviceId,
        mobileDeviceId,
        challenge: desktopChallenge,
        mobilePublicKey,
        issuedAt,
      }),
    );

    const response = await asOwner(t).fetch(
      "/api/mobile/desktop-bridge/session",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Stella-Mobile-Device-Id": mobileDeviceId,
          "X-Stella-Mobile-Pair-Proof": proof,
          "X-Stella-Mobile-Pair-Proof-Issued-At": String(issuedAt),
        },
        body: JSON.stringify({
          desktopDeviceId,
          desktopChallenge,
          mobilePublicKey,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      protocol: "x25519-hkdf-sha256-aes-256-gcm-v1",
      desktopPublicKey: "desktop_public_key",
    });
  });
});
