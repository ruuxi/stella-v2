import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRememberTool } from "@stella/runtime/kernel/tools/defs/remember";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

describe("Remember", () => {
  it("keeps explicit durable writes in profile.md", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-remember-tool-"));
    roots.add(root);
    const tool = createRememberTool({ stellaDataDir: root });

    const response = await tool.execute({
      action: "add",
      content: "The user prefers metric units",
    });

    expect(response.error).toBeUndefined();
    expect(JSON.parse(response.result ?? "{}")).toMatchObject({
      success: true,
      entryCount: 1,
    });
    await expect(
      readFile(path.join(root, "memories", "profile.md"), "utf-8"),
    ).resolves.toContain("The user prefers metric units");
    await expect(
      readFile(path.join(root, "memories", "MEMORY.md"), "utf-8"),
    ).rejects.toThrow();
  });
});
