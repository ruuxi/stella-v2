/// <reference types="vite/client" />

import rateLimiterTest from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => {
  const t = convexTest(schema, modules);
  rateLimiterTest.register(t);
  return t;
};

const baseRun = {
  handle: "Poster",
  mentionId: "300",
  parentId: "100",
  replyId: "400",
  summonerUsername: "1_missthesun",
  posterUsername: "Poster",
  headline: "I can set up that server for your friends.",
  reply: "I can set that up on your machine and ask before opening the port.",
  exchanges: [
    {
      user: "Set up a modded Minecraft server for my friends",
      stella: "Installing Fabric, then I will ask before opening the port.",
    },
  ],
};

describe("x_bot page data", () => {
  it("lists runs by lowercased handle, newest first, with image URLs", async () => {
    const t = createTest();
    const imageStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob([new Uint8Array([1, 2, 3])])),
    );
    await t.mutation(internal.data.x_bot.recordXBotRun, {
      ...baseRun,
      imageStorageId,
    });
    await t.mutation(internal.data.x_bot.recordXBotRun, {
      ...baseRun,
      mentionId: "301",
      replyId: "401",
      headline: "I can also do the second thing.",
    });

    const page = await t.query(api.data.x_bot.listXBotRunsByHandle, {
      handle: "@poster",
    });
    expect(page.handle).toBe("Poster");
    expect(page.runs.map((run) => run.mentionId)).toEqual(["301", "300"]);
    expect(page.runs[1]?.imageUrl).toEqual(expect.stringContaining("http"));
    expect(page.runs[0]?.imageUrl).toBeNull();
  });

  it("replaces a run recorded twice for the same mention", async () => {
    const t = createTest();
    await t.mutation(internal.data.x_bot.recordXBotRun, baseRun);
    await t.mutation(internal.data.x_bot.recordXBotRun, {
      ...baseRun,
      replyId: "402",
    });
    const page = await t.query(api.data.x_bot.listXBotRunsByHandle, {
      handle: "poster",
    });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]?.replyId).toBe("402");
  });

  it("serves the page JSON over HTTP and rejects bad handles", async () => {
    const t = createTest();
    await t.mutation(internal.data.x_bot.recordXBotRun, baseRun);

    const ok = await t.fetch("/api/x/bot/page/poster", { method: "GET" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toContain("max-age=60");
    const body = (await ok.json()) as { handle: string; runs: unknown[] };
    expect(body.handle).toBe("Poster");
    expect(body.runs).toHaveLength(1);

    const empty = await t.fetch("/api/x/bot/page/nobody", { method: "GET" });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ handle: null, runs: [] });

    const bad = await t.fetch("/api/x/bot/page/not%20a%20handle", {
      method: "GET",
    });
    expect(bad.status).toBe(400);
  });
});
