/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const mobileAuth = (
  internal as unknown as {
    mobile_auth: {
      createPendingLinkRequest: FunctionReference<
        "mutation",
        "internal",
        {
          email: string;
          requestId: string;
          fromOwnerId?: string;
          expiresAt: number;
          createdAt: number;
          claimHash: string;
        },
        null
      >;
      completeLinkRequest: FunctionReference<
        "mutation",
        "internal",
        {
          requestId: string;
          tokenEnc: string;
          toOwnerId: string;
        },
        | {
            ok: true;
            replayed: boolean;
            migrationStatus?: "pending" | "running" | "failed" | "complete";
          }
        | {
            ok: false;
            reason:
              | "not_found"
              | "expired"
              | "identity_mismatch"
              | "owner_fenced";
          }
      >;
      claimLinkRequest: FunctionReference<
        "mutation",
        "internal",
        { requestId: string; claimHash: string; nowMs: number },
        { ok: true; tokenEnc: string } | { ok: false }
      >;
      getLinkRequestStatus: FunctionReference<
        "query",
        "internal",
        { requestId: string; nowMs: number },
        | null
        | { status: "expired" | "pending" }
        | {
            status: "completed";
            migrationStatus?: "pending" | "running" | "failed" | "complete";
            migrationError?: string;
          }
      >;
    };
  }
).mobile_auth;

const requestId = "request_12345678901234567890123456789012";
const fromOwnerId = "https://issuer.test|anonymous-owner";
const toOwnerId = "https://issuer.test|connected-owner";
const claimHash = "Zm9yLXRoZS10ZXN0LWNsYWltLXNlY3JldC1oYXNo";
const tokenEnc = "enc:connected-bearer";

describe("magic-link owner transfer", () => {
  it("persists the bearer-derived source owner before sending the link", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(mobileAuth.createPendingLinkRequest, {
        email: "owner@example.com",
        requestId,
        fromOwnerId,
        createdAt: 1,
        claimHash,
        expiresAt: Date.now() + 60_000,
      }),
    ).resolves.toBeNull();

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique(),
    );
    expect(row).toMatchObject({
      requestId,
      fromOwnerId,
      claimHash,
      status: "pending",
    });
  });

  it("publishes the migration fence atomically with connected completion", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(mobileAuth.createPendingLinkRequest, {
      email: "owner@example.com",
      requestId,
      fromOwnerId,
      createdAt: 1,
      claimHash,
      expiresAt: Date.now() + 60_000,
    });

    await expect(
      t.mutation(mobileAuth.completeLinkRequest, {
        requestId,
        tokenEnc,
        toOwnerId,
      }),
    ).resolves.toEqual({
      ok: true,
      replayed: false,
      migrationStatus: "pending",
    });

    const state = await t.run(async (ctx) => {
      const request = await ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique();
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q.eq("fromOwnerId", fromOwnerId).eq("toOwnerId", toOwnerId),
        )
        .unique();
      return { request, migration };
    });
    expect(state.migration).toMatchObject({
      fromOwnerId,
      toOwnerId,
      status: "pending",
    });
    expect(state.request).toMatchObject({
      fromOwnerId,
      toOwnerId,
      status: "completed",
      ownershipMigrationId: state.migration?._id,
    });

    const pollResult = await t.query(mobileAuth.getLinkRequestStatus, {
      requestId,
      nowMs: Date.now(),
    });
    expect(pollResult).toMatchObject({
      status: "completed",
      migrationStatus: "pending",
    });
    // Polling with only the requestId must never surface a credential.
    expect(pollResult).not.toHaveProperty("ott");
    expect(pollResult).not.toHaveProperty("sessionCookie");
    expect(pollResult).not.toHaveProperty("tokenEnc");
  });

  it("releases the bearer token once, to the holder of the claim secret", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(mobileAuth.createPendingLinkRequest, {
      email: "owner@example.com",
      requestId,
      createdAt: 1,
      claimHash,
      expiresAt: Date.now() + 60_000,
    });
    await t.mutation(mobileAuth.completeLinkRequest, {
      requestId,
      tokenEnc,
      toOwnerId,
    });

    await expect(
      t.mutation(mobileAuth.claimLinkRequest, {
        requestId,
        claimHash: "d3JvbmctY2xhaW0taGFzaA",
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ ok: false });

    await expect(
      t.mutation(mobileAuth.claimLinkRequest, {
        requestId,
        claimHash,
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ ok: true, tokenEnc });

    await expect(
      t.mutation(mobileAuth.claimLinkRequest, {
        requestId,
        claimHash,
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ ok: false });
  });

  it("refuses a claim after the three-minute window closes", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(mobileAuth.createPendingLinkRequest, {
      email: "owner@example.com",
      requestId,
      createdAt: 1,
      claimHash,
      expiresAt: Date.now() + 60 * 60_000,
    });
    await t.mutation(mobileAuth.completeLinkRequest, {
      requestId,
      tokenEnc,
      toOwnerId,
    });

    await expect(
      t.mutation(mobileAuth.claimLinkRequest, {
        requestId,
        claimHash,
        nowMs: Date.now() + 4 * 60_000,
      }),
    ).resolves.toEqual({ ok: false });
  });

  it("destroys the handoff after too many wrong claim secrets", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(mobileAuth.createPendingLinkRequest, {
      email: "owner@example.com",
      requestId,
      createdAt: 1,
      claimHash,
      expiresAt: Date.now() + 60_000,
    });
    await t.mutation(mobileAuth.completeLinkRequest, {
      requestId,
      tokenEnc,
      toOwnerId,
    });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await t.mutation(mobileAuth.claimLinkRequest, {
        requestId,
        claimHash: "d3JvbmctY2xhaW0taGFzaA",
        nowMs: Date.now(),
      });
    }

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique(),
    );
    expect(row).toBeNull();
  });

  it("replays only for the same verified destination identity", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(mobileAuth.createPendingLinkRequest, {
      email: "owner@example.com",
      requestId,
      fromOwnerId,
      createdAt: 1,
      claimHash,
      expiresAt: Date.now() + 60_000,
    });
    await t.mutation(mobileAuth.completeLinkRequest, {
      requestId,
      tokenEnc,
      toOwnerId,
    });

    await expect(
      t.mutation(mobileAuth.completeLinkRequest, {
        requestId,
        tokenEnc: "enc:attacker-bearer",
        toOwnerId: "https://issuer.test|different-account",
      }),
    ).resolves.toEqual({ ok: false, reason: "identity_mismatch" });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique(),
    );
    expect(row).toMatchObject({
      toOwnerId,
      tokenEnc,
    });
    expect(row).not.toHaveProperty("ott");
    expect(row).not.toHaveProperty("sessionCookie");
  });

  it("fails closed when a completed owner binding loses its migration marker", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(mobileAuth.createPendingLinkRequest, {
      email: "owner@example.com",
      requestId,
      fromOwnerId,
      createdAt: 1,
      claimHash,
      expiresAt: Date.now() + 60_000,
    });
    await t.mutation(mobileAuth.completeLinkRequest, {
      requestId,
      tokenEnc,
      toOwnerId,
    });
    await t.run(async (ctx) => {
      const migration = await ctx.db
        .query("auth_owner_migrations")
        .withIndex("by_fromOwnerId_and_toOwnerId", (q) =>
          q.eq("fromOwnerId", fromOwnerId).eq("toOwnerId", toOwnerId),
        )
        .unique();
      if (!migration) throw new Error("Expected migration marker");
      await ctx.db.delete(migration._id);
    });

    await expect(
      t.mutation(mobileAuth.completeLinkRequest, {
        requestId,
        tokenEnc,
        toOwnerId,
      }),
    ).resolves.toEqual({ ok: false, reason: "identity_mismatch" });
  });

  it("cannot publish a bearer token after the source owner deletion fence", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(mobileAuth.createPendingLinkRequest, {
      email: "owner@example.com",
      requestId,
      fromOwnerId,
      createdAt: 1,
      claimHash,
      expiresAt: Date.now() + 60_000,
    });
    await t.mutation(internal.owner_lifecycle.beginOwnerDataPurgeInternal, {
      ownerId: fromOwnerId,
      operationId: "delete-during-magic-link",
      mode: "delete",
      now: Date.now(),
    });

    await expect(
      t.mutation(mobileAuth.completeLinkRequest, {
        requestId,
        tokenEnc: "enc:must-not-publish",
        toOwnerId,
      }),
    ).resolves.toEqual({ ok: false, reason: "owner_fenced" });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
        .unique(),
    );
    expect(row).toMatchObject({ status: "pending", fromOwnerId });
    expect(row).not.toHaveProperty("tokenEnc");
    expect(row).not.toHaveProperty("toOwnerId");
  });
});
