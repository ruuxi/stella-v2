/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { components, internal } from "./_generated/api";
import { tokenIdentifierForBetterAuthUserId } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import { dollarsToMicroCents } from "./lib/billing_money";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");
const GENERATION = "identity-level-generation";

beforeAll(() => {
  const values: Record<string, string> = {
    CONVEX_SITE_URL: "https://convex.test",
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "100",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "200",
    STELLA_FREE_MONTHLY_LIMIT_USD: "300",
    STELLA_FREE_LIFETIME_LIMIT_USD: "8",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_ANON_MAX_REQUESTS: "3",
    STELLA_ANON_LIFETIME_LIMIT_USD: "0.10",
    ANON_DEVICE_ID_HASH_SALT: "identity-level-test-salt",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
});

afterEach(() => {
  process.env.STELLA_FREE_EMAIL_ALLOWANCE_SHARE = "1";
});

const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  rateLimiterTest.register(t);
  return t;
};

type Harness = ReturnType<typeof createTest>;

const seedOwner = async (
  t: Harness,
  key: string,
  options: { anonymous?: boolean; providerId?: "google" | "apple" } = {},
) => {
  const now = Date.now();
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: key,
        email: `${key}@example.com`,
        emailVerified: options.anonymous !== true,
        isAnonymous: options.anonymous === true,
        createdAt: now,
        updatedAt: now,
      },
    },
  })) as { _id: string };
  if (options.providerId) {
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "account",
        data: {
          accountId: `${options.providerId}-${key}`,
          providerId: options.providerId,
          userId: user._id,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
  }
  const ownerId = tokenIdentifierForBetterAuthUserId(user._id);
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId,
      generation: GENERATION,
      state: "open",
      createdAt: now,
      updatedAt: now,
    });
  });
  return ownerId;
};

const snapshotFields = (t: Harness, ownerId: string, isAnonymous = false) =>
  t.query(internal.owner_snapshot.getOwnerSnapshotFieldsInternal, {
    ownerId,
    isAnonymous,
  });

describe("identity ladder", () => {
  it("resolves anonymous, email, social, subscription, and credit owners", async () => {
    const t = createTest();
    const anonymous = await seedOwner(t, "anonymous", { anonymous: true });
    const email = await seedOwner(t, "email");
    const social = await seedOwner(t, "social", { providerId: "google" });
    const subscriber = await seedOwner(t, "subscriber");
    const credited = await seedOwner(t, "credited");
    const now = Date.now();
    // The owner's billing ledger reports who pays.
    await t.run(async (ctx) => {
      for (const ownerId of [subscriber, credited]) {
        await ctx.db.insert("owner_billing_plans", {
          ownerId,
          plan: ownerId === subscriber ? "go" : "free",
          paying: true,
          unlimited: false,
          updatedAt: now,
        });
      }
    });

    expect((await snapshotFields(t, anonymous, true)).identityLevel).toBe(0);
    expect((await snapshotFields(t, email)).identityLevel).toBe(1);
    expect((await snapshotFields(t, social)).identityLevel).toBe(2);
    expect((await snapshotFields(t, subscriber)).identityLevel).toBe(3);
    expect((await snapshotFields(t, credited)).identityLevel).toBe(3);
  });
});
