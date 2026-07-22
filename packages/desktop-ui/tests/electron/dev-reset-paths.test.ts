import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveDevElectronUserDataDir,
  resolveDevStellaHome,
} from "../../../desktop/scripts/lib/dev-home-paths.mjs";

const tempRoots = new Set<string>();

const makeTempHome = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-dev-tools-"));
  tempRoots.add(root);
  return path.join(root, "home");
};

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("v2 dev-tool path safety", () => {
  it("requires destructive reset tools to name an isolated root", async () => {
    const homeDir = await makeTempHome();
    expect(() => resolveDevStellaHome({ homeDir })).toThrow(
      "Dev reset requires STELLA_V2_DEV_DATA_DIR",
    );

    const isolatedHome = path.join(homeDir, "isolated-v2-reset");
    expect(
      resolveDevStellaHome({ homeDir, devHomeOverride: isolatedHome }),
    ).toBe(isolatedHome);
  });

  it("resolves normal and isolated dev logs beside their selected home", async () => {
    const homeDir = await makeTempHome();
    expect(resolveDevElectronUserDataDir({ homeDir })).toBe(
      path.join(homeDir, ".stella", "electron-user-data"),
    );
    expect(
      resolveDevElectronUserDataDir({
        homeDir,
        devHomeOverride: path.join(homeDir, "isolated-v2"),
      }),
    ).toBe(path.join(homeDir, "isolated-v2", "electron-user-data"));
  });

  it("rejects reset roots that overlap or alias the shared home", async () => {
    const homeDir = await makeTempHome();
    const sharedHome = path.join(homeDir, ".stella");
    const alias = path.join(homeDir, "dev-alias");
    await mkdir(sharedHome, { recursive: true });
    await symlink(sharedHome, alias, "dir");

    for (const devHomeOverride of [
      sharedHome,
      path.join(sharedHome, "nested"),
      homeDir,
      path.join(homeDir, ".STELLA"),
    ]) {
      expect(() => resolveDevStellaHome({ homeDir, devHomeOverride })).toThrow(
        "Development Stella home must not overlap the packaged home",
      );
    }
    for (const devHomeOverride of [alias, path.join(alias, "nested")]) {
      expect(() => resolveDevStellaHome({ homeDir, devHomeOverride })).toThrow(
        "Development Stella home must not use symlink aliases",
      );
    }
  });

  it("rejects reset roots outside the user home or OS temp", async () => {
    const homeDir = await makeTempHome();
    expect(() =>
      resolveDevStellaHome({
        homeDir,
        devHomeOverride: "/opt/stella-v2-dev-test",
      }),
    ).toThrow(
      "Development Stella home must stay within the user home or OS temp",
    );
  });

  it("rejects a symlinked inherited temp boundary", async () => {
    const homeDir = await makeTempHome();
    const sharedHome = path.join(homeDir, ".stella");
    const tempAlias = path.join(path.dirname(homeDir), "tmp-alias");
    await mkdir(sharedHome, { recursive: true });
    await symlink(sharedHome, tempAlias, "dir");
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = tempAlias;
    try {
      expect(() =>
        resolveDevStellaHome({
          homeDir: "/Users/test",
          devHomeOverride: path.join(tempAlias, "dev"),
        }),
      ).toThrow("Development Stella home must not use symlink aliases");
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }
  });
});
