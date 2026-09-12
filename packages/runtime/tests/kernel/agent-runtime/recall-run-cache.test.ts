import { describe, expect, it, vi } from "vitest";

import {
  RecallRunCache,
  buildRecallLookupCacheKey,
  type RecallLookupStatus,
} from "@stella/runtime/kernel/agent-runtime/recall-run-cache";

describe("RecallRunCache", () => {
  it("NFKC-normalizes prompt and dedupes, normalizes, and sorts terms", () => {
    expect(
      buildRecallLookupCacheKey("  Ｐrior   Decision ", [
        "Repo",
        " path ",
        "ＲＥＰＯ",
      ]),
    ).toBe(buildRecallLookupCacheKey("prior decision", ["PATH", "repo"]));
  });

  it("collapses concurrent duplicate lookups within one orchestrator run", async () => {
    const cache = new RecallRunCache();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(async () => {
      await gate;
      return { status: "no_match" as const, brief: "Nothing relevant found." };
    });

    const first = cache.getOrCreate(
      "run-1",
      "Prior decision",
      ["repo"],
      create,
    );
    const duplicate = cache.getOrCreate(
      "run-1",
      " prior   decision ",
      ["REPO"],
      create,
    );
    release();

    await expect(first).resolves.toEqual({
      status: "no_match",
      brief: "Nothing relevant found.",
    });
    await expect(duplicate).resolves.toEqual({
      status: "no_match",
      brief: "Nothing relevant found.",
      cached: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("marks repeated settled results as cached", async () => {
    const cache = new RecallRunCache();
    const create = vi.fn(async () => ({
      status: "found" as const,
      brief: "A result.",
    }));

    await expect(
      cache.getOrCreate("run-1", "lookup", ["term"], create),
    ).resolves.toEqual({ status: "found", brief: "A result." });
    await expect(
      cache.getOrCreate("run-1", "lookup", ["term"], create),
    ).resolves.toEqual({
      status: "found",
      brief: "A result.",
      cached: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not share the cache across orchestrator runs", async () => {
    const cache = new RecallRunCache();
    const create = vi.fn(async () => ({
      status: "found" as const,
      brief: "A result.",
    }));

    await cache.getOrCreate("run-1", "lookup", ["term"], create);
    await cache.getOrCreate("run-2", "lookup", ["term"], create);

    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each<RecallLookupStatus>(["retrieval_error", "synthesis_error"])(
    "shares an in-flight %s but does not cache it after settlement",
    async (status) => {
      const cache = new RecallRunCache();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const create = vi
        .fn()
        .mockImplementationOnce(async () => {
          await gate;
          return { status, brief: "Recall failed: transient failure" };
        })
        .mockResolvedValueOnce({ status: "found", brief: "Recovered." });

      const first = cache.getOrCreate("run-1", "lookup", ["term"], create);
      const duplicate = cache.getOrCreate(
        "run-1",
        " LOOKUP ",
        ["TERM"],
        create,
      );
      release();

      await expect(first).resolves.toEqual({
        status,
        brief: "Recall failed: transient failure",
      });
      await expect(duplicate).resolves.toEqual({
        status,
        brief: "Recall failed: transient failure",
        cached: true,
      });
      await expect(
        cache.getOrCreate("run-1", "lookup", ["term"], create),
      ).resolves.toEqual({ status: "found", brief: "Recovered." });
      expect(create).toHaveBeenCalledTimes(2);
    },
  );

  it("does not cache a rejected lookup", async () => {
    const cache = new RecallRunCache();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce({ status: "found", brief: "Recovered." });

    await expect(
      cache.getOrCreate("run-1", "lookup", ["term"], create),
    ).rejects.toThrow("transport failed");
    await expect(
      cache.getOrCreate("run-1", "lookup", ["term"], create),
    ).resolves.toEqual({ status: "found", brief: "Recovered." });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("keeps message-reference case, offsets, and result limits distinct", () => {
    const key = buildRecallLookupCacheKey;
    expect(key("read", ["recall:Conv:Message:0"])).not.toBe(
      key("read", ["recall:conv:message:0"]),
    );
    expect(key("read", ["recall:Conv:Message:0"])).not.toBe(
      key("read", ["recall:Conv:Message:1500"]),
    );
    expect(key("find", ["SQLite"], 1)).not.toBe(key("find", ["SQLite"], 12));
  });
});
