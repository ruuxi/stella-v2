/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { createAuth } from "./auth";
import betterAuthSchema from "./betterAuth/schema";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.ts");

const createTest = () => {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  rateLimiterTest.register(t);
  return t;
};

const requestAuth = (
  t: ReturnType<typeof createTest>,
  path: string,
  ip: string,
  body: Record<string, unknown>,
) =>
  t.action(async (ctx) => {
    const response = await createAuth(ctx).handler(
      new Request(`https://convex.test/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status };
  });

describe("Better Auth IP hooks", () => {
  it("allows twenty anonymous sign-ins per IP per rolling day", async () => {
    const t = createTest();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        (await requestAuth(t, "/sign-in/anonymous", "203.0.113.20", {}))
          .status,
      ).toBe(200);
    }
    expect(
      (await requestAuth(t, "/sign-in/anonymous", "203.0.113.20", {}))
        .status,
    ).toBe(429);
  });

  it("allows ten magic-link attempts per IP per rolling hour", async () => {
    const t = createTest();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        (
          await requestAuth(
            t,
            "/sign-in/magic-link",
            "203.0.113.21",
            { email: "blocked@mailinator.com" },
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await requestAuth(t, "/sign-in/magic-link", "203.0.113.21", {
          email: "blocked@mailinator.com",
        })
      ).status,
    ).toBe(429);
  });
});
