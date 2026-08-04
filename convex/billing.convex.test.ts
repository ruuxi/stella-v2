/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

beforeAll(() => {
  const values: Record<string, string> = {
    STELLA_INCLUDED_USAGE_UTILIZATION_RATE: "0.5",
    STELLA_FREE_ROLLING_LIMIT_USD: "1",
    STELLA_FREE_ROLLING_WINDOW_HOURS: "5",
    STELLA_FREE_WEEKLY_LIMIT_USD: "1",
    STELLA_FREE_MONTHLY_LIMIT_USD: "1",
    STELLA_GO_PRICE_CENTS: "1000",
    STELLA_PRO_PRICE_CENTS: "2000",
    STELLA_PLUS_PRICE_CENTS: "3000",
    STELLA_ULTRA_PRICE_CENTS: "4000",
    STELLA_MAX_PRICE_CENTS: "5000",
    STELLA_ANON_MAX_REQUESTS: "100",
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  delete process.env.STELLA_ANON_MAX_REQUESTS_PER_IP;
});

describe("billing subscription status", () => {
  it("reports anonymous request policy without dollar usage windows", async () => {
    const t = convexTest(schema, modules);

    const signedOut = await t.query(api.billing.getSubscriptionStatus, {});
    expect(signedOut).toMatchObject({
      authenticated: false,
      isAnonymous: true,
      usage: null,
      usagePolicy: {
        kind: "anonymous_requests",
        requestLimit: 100,
        perIpRequestLimit: 1000,
        resetAfterInactivityDays: 7,
      },
    });

    const anonymous = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "anonymous-user",
      tokenIdentifier: "https://issuer.test|anonymous-user",
      isAnonymous: true,
    });
    expect(await anonymous.query(api.billing.getSubscriptionStatus, {})).toMatchObject({
      authenticated: true,
      isAnonymous: true,
      usagePolicy: { kind: "anonymous_requests", requestLimit: 100 },
    });
  });

  it("reports the one-dollar cost windows for signed-in Free users", async () => {
    const t = convexTest(schema, modules);
    const signedIn = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "free-user",
      tokenIdentifier: "https://issuer.test|free-user",
    });

    expect(await signedIn.query(api.billing.getSubscriptionStatus, {})).toMatchObject({
      authenticated: true,
      isAnonymous: false,
      plan: "free",
      usage: {
        rollingLimitUsd: 1,
        weeklyLimitUsd: 1,
        monthlyLimitUsd: 1,
      },
      usagePolicy: { kind: "managed_cost" },
    });
  });
});
