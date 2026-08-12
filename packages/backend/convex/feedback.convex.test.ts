/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import { FEEDBACK_MAX_LENGTH } from "./feedback";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

describe("feedback submissions", () => {
  it("stores diagnostic reports longer than the legacy 4,000-character cap intact", async () => {
    const t = createTest();
    const report = `Browser bridge diagnostic\n${"x".repeat(8_000)}`;

    await expect(
      t.mutation(api.feedback.submitFeedback, { message: report }),
    ).resolves.toBeNull();

    const stored = await t.run(
      async (ctx) =>
        await ctx.db
          .query("user_feedback")
          .withIndex("by_createdAt")
          .order("desc")
          .first(),
    );
    expect(stored?.message).toBe(report);
    expect(stored?.message).toHaveLength(report.length);
  });

  it("rejects reports beyond the documented limit instead of truncating them", async () => {
    const t = createTest();

    await expect(
      t.mutation(api.feedback.submitFeedback, {
        message: "x".repeat(FEEDBACK_MAX_LENGTH + 1),
      }),
    ).rejects.toThrow(`limited to ${FEEDBACK_MAX_LENGTH} characters`);
  });
});
