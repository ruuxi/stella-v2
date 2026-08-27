import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { resolveShardCount } from "./rate_limits";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const createTest = () => {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
};

describe("webhook rate-limit sharding", () => {
  it("never shards a low-limit bucket below a full-capacity single doc", () => {

    expect(resolveShardCount(1)).toBe(1);
    expect(resolveShardCount(4)).toBe(1);
    expect(resolveShardCount(5)).toBe(1);
    expect(resolveShardCount(9)).toBe(1);
  });

  it("spreads busier buckets across more docs, capped so shards stay useful", () => {
    expect(resolveShardCount(10)).toBe(2);
    expect(resolveShardCount(30)).toBe(6);
    expect(resolveShardCount(40)).toBe(8);

    expect(resolveShardCount(1000)).toBe(8);
  });

  it("still enforces the ceiling on a single-shard bucket", async () => {
    const t = createTest();
    const call = () =>
      t.mutation(internal.rate_limits.consumeWebhookRateLimit, {
        scope: "test_scope",
        key: "owner-a",
        limit: 3,
        windowMs: 60_000,
      });

    expect((await call()).allowed).toBe(true);
    expect((await call()).allowed).toBe(true);
    expect((await call()).allowed).toBe(true);

    const blocked = await call();
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("keeps separate keys in independent buckets", async () => {
    const t = createTest();
    const consume = (key: string) =>
      t.mutation(internal.rate_limits.consumeWebhookRateLimit, {
        scope: "test_scope",
        key,
        limit: 1,
        windowMs: 60_000,
      });

    expect((await consume("owner-a")).allowed).toBe(true);

    expect((await consume("owner-b")).allowed).toBe(true);

    expect((await consume("owner-a")).allowed).toBe(false);
  });
});
