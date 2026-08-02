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

describe("Vite dev home resolution", () => {
  it("shares the normal Stella home and ignores generic STELLA_DATA_DIR", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-vite-home-"));
    tempRoots.add(root);
    const homeDir = path.join(root, "home");
    const sharedHome = path.join(homeDir, ".stella");
    const previousGenericDataDir = process.env.STELLA_DATA_DIR;
    process.env.STELLA_DATA_DIR = path.join(homeDir, "generic-override");

    try {
      expect(resolveViteDevStellaHome({ homeDir })).toBe(sharedHome);
    } finally {
      if (previousGenericDataDir === undefined)
        delete process.env.STELLA_DATA_DIR;
      else process.env.STELLA_DATA_DIR = previousGenericDataDir;
    }
  });

  it("honors the explicit v2 isolation override", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-vite-home-"));
    tempRoots.add(root);
    const homeDir = path.join(root, "home");
    const isolatedHome = path.join(homeDir, "isolated-v2");
    expect(
      resolveViteDevStellaHome({
        homeDir,
        devHomeOverride: isolatedHome,
      }),
    ).toBe(isolatedHome);
  });
});
