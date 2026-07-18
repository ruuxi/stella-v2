import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveViteDevStellaHome } from "../../vite/dev-home";

const tempRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("Vite dev home isolation", () => {
  it("ignores generic STELLA_DATA_DIR and shares the v2-only dev home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-vite-home-"));
    tempRoots.add(root);
    const homeDir = path.join(root, "home");
    const liveHome = path.join(homeDir, ".stella");
    const previousGenericDataDir = process.env.STELLA_DATA_DIR;
    process.env.STELLA_DATA_DIR = liveHome;

    try {
      const resolved = resolveViteDevStellaHome({ homeDir });
      expect(resolved).toBe(path.join(homeDir, ".stella-v2-dev"));
      expect(resolved).not.toBe(liveHome);
    } finally {
      if (previousGenericDataDir === undefined) {
        delete process.env.STELLA_DATA_DIR;
      } else {
        process.env.STELLA_DATA_DIR = previousGenericDataDir;
      }
    }
  });
});
