import { describe, expect, test } from "bun:test";
import { clearAccountChatData } from "../chat-account-cleanup";

function operations(log: string[]) {
  return {
    beginCleanupIntent: async () => {
      log.push("account-intent");
      return "cleanup-token";
    },
    invalidateMountedOwners: () => {
      log.push("invalidate-mounted");
    },
    beginIndexRebuild: async () => {
      log.push("index-intent");
    },
    clearCanonicalStorage: async () => {
      log.push("canonical-cleanup");
    },
    markCanonicalCleared: async (token: string) => {
      log.push(`canonical-cleared:${token}`);
    },
    rebuildIndex: async () => {
      log.push("index-rebuild");
    },
    clearIndex: async () => {
      log.push("index-clear");
    },
    markIndexCleared: async (token: string) => {
      log.push(`index-cleared:${token}`);
    },
    finalizeCleanup: async (token: string) => {
      log.push(`finalize:${token}`);
      return true;
    },
  };
}

describe("account chat cleanup sequencing", () => {
  test("does not mutate canonical data when durable index intent fails", async () => {
    const log: string[] = [];
    const ops = operations(log);
    ops.beginIndexRebuild = async () => {
      log.push("index-intent");
      throw new Error("intent failed");
    };

    await expect(clearAccountChatData(ops)).rejects.toThrow("intent failed");
    expect(log).toEqual([
      "account-intent",
      "invalidate-mounted",
      "index-intent",
      "index-rebuild",
    ]);
    expect(log.includes("canonical-cleanup")).toBe(false);
  });

  test("rebuilds surviving canonical data before surfacing cleanup failure", async () => {
    const log: string[] = [];
    const ops = operations(log);
    ops.clearCanonicalStorage = async () => {
      log.push("canonical-cleanup");
      throw new Error("cleanup failed");
    };

    await expect(clearAccountChatData(ops)).rejects.toThrow("cleanup failed");
    expect(log).toEqual([
      "account-intent",
      "invalidate-mounted",
      "index-intent",
      "canonical-cleanup",
      "index-rebuild",
    ]);
  });

  test("retains the canonical error if best-effort rebuild also fails", async () => {
    const log: string[] = [];
    const ops = operations(log);
    ops.clearCanonicalStorage = async () => {
      log.push("canonical-cleanup");
      throw new Error("canonical failure");
    };
    ops.rebuildIndex = async () => {
      log.push("index-rebuild");
      throw new Error("rebuild failure");
    };

    await expect(clearAccountChatData(ops)).rejects.toThrow(
      "canonical failure",
    );
    expect(log).toEqual([
      "account-intent",
      "invalidate-mounted",
      "index-intent",
      "canonical-cleanup",
      "index-rebuild",
    ]);
  });

  test("clears derived rows only after canonical cleanup succeeds", async () => {
    const log: string[] = [];
    await clearAccountChatData(operations(log));
    expect(log).toEqual([
      "account-intent",
      "invalidate-mounted",
      "index-intent",
      "canonical-cleanup",
      "canonical-cleared:cleanup-token",
      "index-clear",
      "index-cleared:cleanup-token",
      "finalize:cleanup-token",
    ]);
  });

  test("keeps the cross-store owner durable when finalization is incomplete", async () => {
    const log: string[] = [];
    const ops = operations(log);
    ops.finalizeCleanup = async (token: string) => {
      log.push(`finalize:${token}`);
      return false;
    };

    await expect(clearAccountChatData(ops)).rejects.toThrow("did not finalize");
    expect(log.at(-1)).toBe("finalize:cleanup-token");
  });
});
