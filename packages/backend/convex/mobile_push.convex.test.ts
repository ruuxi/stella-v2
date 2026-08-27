import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const OWNER = "owner-1";
const DEVICE = "device-1";
const TOKEN = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

const readRows = (t: ReturnType<typeof createTest>) =>
  t.run(async (ctx) =>
    ctx.db
      .query("mobile_push_tokens")
      .withIndex("by_ownerId_and_mobileDeviceId", (q) =>
        q.eq("ownerId", OWNER).eq("mobileDeviceId", DEVICE),
      )
      .collect(),
  );

describe("mobile_push.upsertToken idempotency", () => {
  it("does not rewrite the row when nothing changed within the refresh window", async () => {
    const t = createTest();
    const t0 = 1_000_000;

    await t.mutation(internal.mobile_push.upsertToken, {
      ownerId: OWNER,
      mobileDeviceId: DEVICE,
      expoPushToken: TOKEN,
      platform: "ios",
      nowMs: t0,
    });

    await t.mutation(internal.mobile_push.upsertToken, {
      ownerId: OWNER,
      mobileDeviceId: DEVICE,
      expoPushToken: TOKEN,
      platform: "ios",
      nowMs: t0 + 5_000,
    });

    const rows = await readRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt).toBe(t0);
    expect(rows[0]?.expoPushToken).toBe(TOKEN);
  });

  it("patches when the token rotates", async () => {
    const t = createTest();
    const t0 = 1_000_000;
    const rotated = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

    await t.mutation(internal.mobile_push.upsertToken, {
      ownerId: OWNER,
      mobileDeviceId: DEVICE,
      expoPushToken: TOKEN,
      platform: "ios",
      nowMs: t0,
    });
    await t.mutation(internal.mobile_push.upsertToken, {
      ownerId: OWNER,
      mobileDeviceId: DEVICE,
      expoPushToken: rotated,
      platform: "ios",
      nowMs: t0 + 5_000,
    });

    const rows = await readRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expoPushToken).toBe(rotated);
    expect(rows[0]?.updatedAt).toBe(t0 + 5_000);
  });

  it("refreshes the stamp once it goes stale even if the token is unchanged", async () => {
    const t = createTest();
    const t0 = 1_000_000;
    const stale = t0 + 7 * 60 * 60 * 1000;

    await t.mutation(internal.mobile_push.upsertToken, {
      ownerId: OWNER,
      mobileDeviceId: DEVICE,
      expoPushToken: TOKEN,
      platform: "ios",
      nowMs: t0,
    });
    await t.mutation(internal.mobile_push.upsertToken, {
      ownerId: OWNER,
      mobileDeviceId: DEVICE,
      expoPushToken: TOKEN,
      platform: "ios",
      nowMs: stale,
    });

    const rows = await readRows(t);
    expect(rows[0]?.updatedAt).toBe(stale);
  });

  it("keeps a single row when the same registration is replayed concurrently", async () => {
    const t = createTest();
    const t0 = 1_000_000;

    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        t.mutation(internal.mobile_push.upsertToken, {
          ownerId: OWNER,
          mobileDeviceId: DEVICE,
          expoPushToken: TOKEN,
          platform: "ios",
          nowMs: t0 + i,
        }),
      ),
    );

    const rows = await readRows(t);
    expect(rows).toHaveLength(1);
  });
});
