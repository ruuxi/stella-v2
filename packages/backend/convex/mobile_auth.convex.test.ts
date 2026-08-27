/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const REQUEST_ID = "11111111-2222-3333-4444-555555555555";
const CLAIM_HASH = "Zm9vYmFyLWNsYWltLWhhc2gtdmFsdWUtZm9yLXRlc3Rz";
const OTHER_HASH = "b3RoZXItY2xhaW0taGFzaC12YWx1ZS1mb3ItdGVzdGluZw";
const TOKEN_ENC = "encrypted-bearer-token-blob";

const MINUTE = 60_000;

/**
 * Covers the browser -> app session handoff.
 *
 * These live in a Convex test rather than the live shell scripts because the
 * flow needs a *completed* handoff to claim, and the only endpoint that could
 * complete one synchronously was the App Review sign-in backdoor, which has
 * been removed. Driving the internal mutations directly is both deterministic
 * and covers cases the HTTP path could not reach (expiry, attempt cap).
 */
const seedCompleted = async (
  t: ReturnType<typeof convexTest>,
  overrides: Partial<{
    completedAt: number;
    expiresAt: number;
    claimAttempts: number;
    tokenEnc: string;
    claimHash: string;
  }> = {},
) => {
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("auth_link_requests", {
      email: "someone@example.test",
      requestId: REQUEST_ID,
      status: "completed",
      claimHash: overrides.claimHash ?? CLAIM_HASH,
      tokenEnc: overrides.tokenEnc ?? TOKEN_ENC,
      completedAt: overrides.completedAt ?? now,
      expiresAt: overrides.expiresAt ?? now + 10 * MINUTE,
      createdAt: now,
      ...(overrides.claimAttempts !== undefined
        ? { claimAttempts: overrides.claimAttempts }
        : {}),
    });
  });
  return now;
};

const claim = (
  t: ReturnType<typeof convexTest>,
  claimHash: string,
  nowMs: number,
) =>
  t.mutation(internal.mobile_auth.claimLinkRequest, {
    requestId: REQUEST_ID,
    claimHash,
    nowMs,
  });

describe("auth handoff claim", () => {
  it("returns the encrypted token for the correct claim secret", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t);

    const result = await claim(t, CLAIM_HASH, now);
    expect(result.ok).toBe(true);
    expect(result.tokenEnc).toBe(TOKEN_ENC);
  });

  it("is single-use — the row is consumed on success", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t);

    expect((await claim(t, CLAIM_HASH, now)).ok).toBe(true);
    // Replay must fail, and the row must be gone rather than merely flagged.
    expect((await claim(t, CLAIM_HASH, now)).ok).toBe(false);
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", REQUEST_ID))
        .unique(),
    );
    expect(remaining).toBeNull();
  });

  it("rejects a wrong claim secret without consuming the handoff", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t);

    expect((await claim(t, OTHER_HASH, now)).ok).toBe(false);
    // The legitimate client must still be able to claim afterwards.
    expect((await claim(t, CLAIM_HASH, now)).ok).toBe(true);
  });

  it("rejects a claim outside the three-minute window", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t);

    const result = await claim(t, CLAIM_HASH, now + 3 * MINUTE + 1);
    expect(result.ok).toBe(false);
  });

  it("rejects a claim after the request itself expires", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t, { expiresAt: Date.now() - 1 });

    expect((await claim(t, CLAIM_HASH, now)).ok).toBe(false);
  });

  it("destroys the handoff after too many wrong attempts", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await claim(t, OTHER_HASH, now)).ok).toBe(false);
    }
    // The cap has been consumed: even the CORRECT secret no longer works,
    // and the row is gone so a brute force cannot resume.
    expect((await claim(t, CLAIM_HASH, now)).ok).toBe(false);
    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query("auth_link_requests")
        .withIndex("by_requestId", (q) => q.eq("requestId", REQUEST_ID))
        .unique(),
    );
    expect(remaining).toBeNull();
  });

  it("rejects an unknown requestId", async () => {
    const t = convexTest(schema, modules);
    expect((await claim(t, CLAIM_HASH, Date.now())).ok).toBe(false);
  });

  it("never returns a credential from the status query", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t);

    const status = await t.query(internal.mobile_auth.getLinkRequestStatus, {
      requestId: REQUEST_ID,
      nowMs: now,
    });
    expect(status).toEqual({ status: "completed" });
    expect(JSON.stringify(status)).not.toContain(TOKEN_ENC);
  });

  it("reports an expired handoff as expired", async () => {
    const t = convexTest(schema, modules);
    const now = await seedCompleted(t, { expiresAt: Date.now() - 1 });

    const status = await t.query(internal.mobile_auth.getLinkRequestStatus, {
      requestId: REQUEST_ID,
      nowMs: now,
    });
    expect(status).toEqual({ status: "expired" });
  });
});
