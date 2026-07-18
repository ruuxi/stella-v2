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

describe("v2 dev-tool path isolation", () => {
  it("ignores generic STELLA_DATA_DIR for reset targets", async () => {
    const homeDir = await makeTempHome();
    const previousGenericDataDir = process.env.STELLA_DATA_DIR;
    process.env.STELLA_DATA_DIR = path.join(homeDir, ".stella");
    try {
      expect(resolveDevStellaHome({ homeDir })).toBe(
        path.join(homeDir, ".stella-v2-dev"),
      );
    } finally {
      if (previousGenericDataDir === undefined) {
        delete process.env.STELLA_DATA_DIR;
      } else {
        process.env.STELLA_DATA_DIR = previousGenericDataDir;
      }
    }
  });

  it("rejects direct, ancestor, case, and symlink aliases of the packaged home", async () => {
    const homeDir = await makeTempHome();
    const packagedHome = path.join(homeDir, ".stella");
    const alias = path.join(homeDir, "dev-alias");
    await mkdir(packagedHome, { recursive: true });
    await symlink(packagedHome, alias, "dir");

    for (const devHomeOverride of [
      packagedHome,
      path.join(packagedHome, "nested"),
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

  it("resolves dev logs under Electron's isolated userData root", async () => {
    const homeDir = await makeTempHome();
    expect(
      resolveDevElectronUserDataDir({
        platform: "darwin",
        homeDir,
      }),
    ).toBe(
      path.join(
        homeDir,
        "Library",
        "Application Support",
        "Stella Development",
      ),
    );
  });

  it("rejects reset targets outside the user home", async () => {
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

  it("rejects dev log userData paths that overlap or alias the packaged home", async () => {
    const homeDir = await makeTempHome();
    const packagedHome = path.join(homeDir, ".stella");
    await mkdir(packagedHome, { recursive: true });

    expect(() =>
      resolveDevElectronUserDataDir({
        homeDir,
        appDataDir: packagedHome,
      }),
    ).toThrow("Development Electron userData must not overlap");

    const appDataDir = path.join(homeDir, "Library", "Application Support");
    await mkdir(appDataDir, { recursive: true });
    await symlink(
      packagedHome,
      path.join(appDataDir, "Stella Development"),
      "dir",
    );
    expect(() =>
      resolveDevElectronUserDataDir({ homeDir, appDataDir }),
    ).toThrow("Development Electron userData must not use symlink aliases");
  });

  it("rejects a default dev-home symlink", async () => {
    const homeDir = await makeTempHome();
    const packagedHome = path.join(homeDir, ".stella");
    const defaultDevHome = path.join(homeDir, ".stella-v2-dev");
    await mkdir(packagedHome, { recursive: true });
    await symlink(packagedHome, defaultDevHome, "dir");

    expect(() => resolveDevStellaHome({ homeDir })).toThrow(
      "Development Stella home must not use symlink aliases",
    );
  });

  it("rejects a symlinked inherited temp boundary", async () => {
    const homeDir = await makeTempHome();
    const packagedHome = path.join(homeDir, ".stella");
    const tempAlias = path.join(path.dirname(homeDir), "tmp-alias");
    await mkdir(packagedHome, { recursive: true });
    await symlink(packagedHome, tempAlias, "dir");
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
