/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER_ID = "https://stella.test|revocation-owner";
const DESKTOP = "desktop-1";

const asOwner = (t: ReturnType<typeof convexTest>, sessionId?: string) =>
  t.withIdentity({
    tokenIdentifier: OWNER_ID,
    subject: "revocation-owner",
    issuer: "https://stella.test",
    ...(sessionId ? { sessionId } : {}),
  });

describe("session revocation tombstones", () => {
  it("records every session id in one pass, de-duplicating and refreshing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.auth.recordRevokedSessionsInternal, {
      ownerId: OWNER_ID,
      sessionIds: ["a", "b"],
      expiresAt: 1_000,
    });
    await t.mutation(internal.auth.recordRevokedSessionsInternal, {
      ownerId: OWNER_ID,
      sessionIds: ["b", "c", "c"],
      expiresAt: 2_000,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("auth_revoked_sessions").collect(),
    );
    expect(
      rows.map((row) => [row.sessionId, row.expiresAt]).sort(),
    ).toEqual([
      ["a", 1_000],
      ["b", 2_000],
      ["c", 2_000],
    ]);
  });

  it("hides the pairing code from a revoked session without reading the clock", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId: OWNER_ID,
        sessionId: "revoked",
        revokedAt: 1,
        // Already past: queries treat any unpurged tombstone as revoked.
        expiresAt: 2,
      });
      await ctx.db.insert("mobile_pairing_sessions", {
        ownerId: OWNER_ID,
        desktopDeviceId: DESKTOP,
        pairingCode: "PAIR42",
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      } as never);
    });
    const revoked = await asOwner(t, "revoked").query(
      api.mobile_access.getPhoneAccessState,
      { desktopDeviceId: DESKTOP },
    );
    expect(revoked.activePairing).toBeNull();
    const live = await asOwner(t, "other").query(
      api.mobile_access.getPhoneAccessState,
      { desktopDeviceId: DESKTOP },
    );
    expect(live.activePairing?.pairingCode).toBe("PAIR42");
  });

  it("only denies a session-less token while a live tombstone exists (mutation path)", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId: OWNER_ID,
        sessionId: "old",
        revokedAt: 1,
        expiresAt: now - 1,
      });
    });
    await expect(
      t.query(internal.auth.isSessionRevokedInternal, {
        ownerId: OWNER_ID,
        sessionId: null,
        nowMs: now,
      }),
    ).resolves.toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_revoked_sessions", {
        ownerId: OWNER_ID,
        sessionId: "new",
        revokedAt: now,
        expiresAt: now + 60_000,
      });
    });
    await expect(
      t.query(internal.auth.isSessionRevokedInternal, {
        ownerId: OWNER_ID,
        sessionId: null,
        nowMs: now,
      }),
    ).resolves.toBe(true);
  });
});

describe("watchIncomingConnectIntent", () => {
  it("finds a live intent behind many newer acknowledged ones", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("mobile_connect_intents", {
        ownerId: OWNER_ID,
        desktopDeviceId: DESKTOP,
        mobileDeviceId: "live-phone",
        createdAt: now,
        expiresAt: now + 60_000,
      });
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("mobile_connect_intents", {
          ownerId: OWNER_ID,
          desktopDeviceId: DESKTOP,
          mobileDeviceId: `acked-${i}`,
          createdAt: now + 1 + i,
          expiresAt: now + 60_001 + i,
          acknowledgedAt: now + 2 + i,
        });
      }
    });
    const intent = await asOwner(t).query(
      api.mobile_access.watchIncomingConnectIntent,
      { desktopDeviceId: DESKTOP, nowMs: now },
    );
    expect(intent?.mobileDeviceId).toBe("live-phone");
  });
});
