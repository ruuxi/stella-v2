import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyUserProfileOperation,
  MAX_USER_PROFILE_CHARS,
  parseUserProfileEntries,
  readUserProfile,
  userProfilePath,
} from "@stella/runtime/kernel/memory/user-profile-store";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "stella-user-profile-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const entries = async (): Promise<string[]> => {
  const content = await readUserProfile(dir);
  return content ? parseUserProfileEntries(content) : [];
};

describe("user-profile-store", () => {
  it("adds a durable fact and persists it under memories/profile.md", async () => {
    const result = await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user goes by Bob",
    });
    expect(result.ok).toBe(true);
    expect(result.entryCount).toBe(1);
    expect(userProfilePath(dir)).toBe(
      path.join(dir, "memories", "profile.md"),
    );
    expect(await entries()).toEqual(["The user goes by Bob"]);
  });

  it("dedupes case-insensitively without erroring", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user lives in Berlin",
    });
    const dup = await applyUserProfileOperation(dir, {
      action: "add",
      content: "the user lives in berlin",
    });
    expect(dup.ok).toBe(true);
    expect(dup.message).toMatch(/already/i);
    expect(await entries()).toHaveLength(1);
  });

  it("replaces an outdated fact matched loosely", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user lives in Berlin",
    });
    const replaced = await applyUserProfileOperation(dir, {
      action: "replace",
      oldContent: "lives in Berlin",
      content: "The user lives in Lisbon",
    });
    expect(replaced.ok).toBe(true);
    expect(await entries()).toEqual(["The user lives in Lisbon"]);
  });

  it("removes a fact", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user dislikes phone calls",
    });
    const removed = await applyUserProfileOperation(dir, {
      action: "remove",
      content: "dislikes phone calls",
    });
    expect(removed.ok).toBe(true);
    expect(await entries()).toEqual([]);
  });

  it("reports a clear error when there is nothing to replace", async () => {
    const result = await applyUserProfileOperation(dir, {
      action: "replace",
      oldContent: "nonexistent",
      content: "whatever",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no matching/i);
  });

  it("preserves a long entry instead of silently truncating it", async () => {
    const content = `A durable fact with a long tail: ${"detail ".repeat(80)}finished.`;

    const result = await applyUserProfileOperation(dir, {
      action: "add",
      content,
    });

    expect(result.ok).toBe(true);
    expect(await entries()).toEqual([content]);
  });

  it("allows ten lean facts within the doubled aggregate size cap", async () => {
    const entry = "x".repeat(390);

    for (let index = 0; index < 10; index += 1) {
      const result = await applyUserProfileOperation(dir, {
        action: "add",
        content: `${index}:${entry}`,
      });
      expect(result.ok).toBe(true);
    }

    expect(await entries()).toHaveLength(10);
    expect(MAX_USER_PROFILE_CHARS).toBe(8_000);
  });

  it("evicts oldest facts to stay within the cap instead of wedging", async () => {
    let lastCount = 0;
    for (let i = 0; i < 200; i += 1) {
      const result = await applyUserProfileOperation(dir, {
        action: "add",
        content: `Durable fact number ${i} about the user and their stable long-running preferences`,
      });
      // Every add must succeed — the store must never wedge above its cap.
      expect(result.ok).toBe(true);
      lastCount = result.entryCount;
    }

    // The store bounded itself by evicting oldest facts rather than rejecting.
    expect(lastCount).toBeGreaterThan(0);
    expect(lastCount).toBeLessThan(200);

    // The persisted body is at or under the hard cap.
    const stored = await entries();
    const bodyLength = stored.reduce((sum, e) => sum + e.length + 3, 0);
    expect(bodyLength).toBeLessThanOrEqual(MAX_USER_PROFILE_CHARS);

    // The newest fact survived; the oldest were the ones evicted (FIFO).
    expect(stored[stored.length - 1]).toContain("number 199");
    expect(stored.some((e) => e.includes("number 0 "))).toBe(false);
  });

  it("never wedges: adds still succeed when the on-disk file starts over cap", async () => {
    // Simulate a hand-edited / legacy over-cap profile.md.
    const oversized = Array.from(
      { length: 40 },
      (_, i) => `- Legacy durable fact ${i} ${"padding ".repeat(30)}`,
    ).join("\n");
    await fs.mkdir(path.join(dir, "memories"), { recursive: true });
    await fs.writeFile(userProfilePath(dir), `# User Profile\n\n${oversized}\n`);

    const result = await applyUserProfileOperation(dir, {
      action: "add",
      content: "A fresh fact that must be accepted",
    });
    expect(result.ok).toBe(true);

    const stored = await entries();
    const bodyLength = stored.reduce((sum, e) => sum + e.length + 3, 0);
    expect(bodyLength).toBeLessThanOrEqual(MAX_USER_PROFILE_CHARS);
    expect(stored[stored.length - 1]).toBe("A fresh fact that must be accepted");
  });

  it("keeps both facts when two adds run concurrently", async () => {
    const [first, second] = await Promise.all([
      applyUserProfileOperation(dir, {
        action: "add",
        content: "The user goes by Bob",
      }),
      applyUserProfileOperation(dir, {
        action: "add",
        content: "The user lives in Berlin",
      }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const stored = await entries();
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(
      expect.arrayContaining([
        "The user goes by Bob",
        "The user lives in Berlin",
      ]),
    );
  });

  it("redacts secrets in stored facts", async () => {
    await applyUserProfileOperation(dir, {
      action: "add",
      content: "The user's API key is sk-abcdef0123456789abcdef0123456789",
    });
    const stored = (await readUserProfile(dir)) ?? "";
    expect(stored).not.toContain("sk-abcdef0123456789abcdef0123456789");
  });
});
