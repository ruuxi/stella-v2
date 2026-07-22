import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ELECTRON_USER_DATA_DIRNAME,
  PACKAGED_STELLA_HOME_DIRNAME,
  resolveDesktopDataPaths,
  resolveLifecycleVerificationHome,
} from "../../../desktop/electron/data-paths";
import { getDesktopDatabasePath } from "@stella/runtime/kernel/storage/database-init";

const tempRoots = new Set<string>();

const makeTempHome = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-home-paths-"));
  tempRoots.add(root);
  return path.join(root, "home");
};

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("desktop Stella home resolution", () => {
  it("uses the normal Stella home and v1-compatible userData in both modes", async () => {
    const homeDir = await makeTempHome();
    const expectedHome = path.join(homeDir, PACKAGED_STELLA_HOME_DIRNAME);
    const expectedUserData = path.join(
      expectedHome,
      ELECTRON_USER_DATA_DIRNAME,
    );

    const packaged = resolveDesktopDataPaths({
      isPackaged: true,
      homeDir,
    });
    const development = resolveDesktopDataPaths({
      isPackaged: false,
      homeDir,
    });

    expect(packaged).toEqual({
      stellaHomeDir: expectedHome,
      electronUserDataDir: expectedUserData,
    });
    expect(development).toEqual(packaged);
    expect(getDesktopDatabasePath(development.stellaHomeDir)).toBe(
      path.join(expectedHome, "stella.sqlite"),
    );
  });

  it("takes the shared process lock before bootstrap services can open SQLite", async () => {
    const bootstrapSource = await readFile(
      new URL("../../../desktop/electron/bootstrap.ts", import.meta.url),
      "utf8",
    );
    const lockIndex = bootstrapSource.indexOf(
      "app.requestSingleInstanceLock()",
    );
    const serviceConstructionIndex = bootstrapSource.indexOf(
      "createBootstrapContext({",
    );

    expect(lockIndex).toBeGreaterThan(-1);
    expect(serviceConstructionIndex).toBeGreaterThan(lockIndex);
  });

  it("keeps durable config and content consumers under the shared home", async () => {
    const homeDir = await makeTempHome();
    const paths = resolveDesktopDataPaths({ isPackaged: false, homeDir });

    for (const relativePath of [
      "stella.sqlite",
      "preferences.json",
      "connectors",
      "extensions",
      "prompts",
      "skills",
      "media",
    ]) {
      expect(path.join(paths.stellaHomeDir, relativePath)).toBe(
        path.join(homeDir, ".stella", relativePath),
      );
    }
    expect(paths.electronUserDataDir).toBe(
      path.join(homeDir, ".stella", "electron-user-data"),
    );
  });

  it("ignores generic STELLA_DATA_DIR and accepts an explicit isolated override", async () => {
    const homeDir = await makeTempHome();
    const previousGenericDataDir = process.env.STELLA_DATA_DIR;
    process.env.STELLA_DATA_DIR = path.join(homeDir, "generic-override");
    const isolatedOverride = path.join(homeDir, "intentional-v2-isolation");

    try {
      expect(
        resolveDesktopDataPaths({ isPackaged: false, homeDir }).stellaHomeDir,
      ).toBe(path.join(homeDir, ".stella"));
      expect(
        resolveDesktopDataPaths({
          isPackaged: false,
          homeDir,
          devHomeOverride: isolatedOverride,
        }),
      ).toEqual({
        stellaHomeDir: isolatedOverride,
        electronUserDataDir: path.join(
          isolatedOverride,
          ELECTRON_USER_DATA_DIRNAME,
        ),
      });
    } finally {
      if (previousGenericDataDir === undefined)
        delete process.env.STELLA_DATA_DIR;
      else process.env.STELLA_DATA_DIR = previousGenericDataDir;
    }
  });

  it("rejects explicit overrides that overlap or alias the shared home", async () => {
    const homeDir = await makeTempHome();
    const sharedHome = path.join(homeDir, PACKAGED_STELLA_HOME_DIRNAME);
    const symlinkAlias = path.join(homeDir, "v2-dev-alias");
    await mkdir(sharedHome, { recursive: true });
    await symlink(sharedHome, symlinkAlias, "dir");

    for (const devHomeOverride of [
      sharedHome,
      path.join(sharedHome, "dev"),
      homeDir,
      path.dirname(homeDir),
      path.join(homeDir, ".STELLA"),
    ]) {
      expect(() =>
        resolveDesktopDataPaths({
          isPackaged: false,
          homeDir,
          devHomeOverride,
        }),
      ).toThrow("Development Stella home must not overlap the packaged home");
    }
    for (const devHomeOverride of [
      symlinkAlias,
      path.join(symlinkAlias, "nested"),
    ]) {
      expect(() =>
        resolveDesktopDataPaths({
          isPackaged: false,
          homeDir,
          devHomeOverride,
        }),
      ).toThrow("Development Stella home must not use symlink aliases");
    }
  });

  it("rejects explicit overrides outside the user home or OS temp", async () => {
    const homeDir = await makeTempHome();
    expect(() =>
      resolveDesktopDataPaths({
        isPackaged: false,
        homeDir,
        devHomeOverride: "/opt/stella-v2-dev-test",
      }),
    ).toThrow(
      "Development Stella home must stay within the user home or OS temp",
    );
  });

  it("keeps lifecycle verification explicitly isolated from the shared home", async () => {
    const homeDir = await makeTempHome();
    expect(() => resolveLifecycleVerificationHome({ homeDir })).toThrow(
      "STELLA_V2_LIFECYCLE_VERIFY_DATA_DIR",
    );
    expect(() =>
      resolveLifecycleVerificationHome({
        homeDir,
        explicitPath: path.join(homeDir, PACKAGED_STELLA_HOME_DIRNAME),
      }),
    ).toThrow("Lifecycle verification home must not overlap the packaged home");
    expect(
      resolveLifecycleVerificationHome({
        homeDir,
        explicitPath: path.join(homeDir, "lifecycle-verification"),
      }),
    ).toBe(path.join(homeDir, "lifecycle-verification"));
  });

  it("rejects a symlinked inherited temp boundary", async () => {
    const homeDir = await makeTempHome();
    const sharedHome = path.join(homeDir, PACKAGED_STELLA_HOME_DIRNAME);
    const tempAlias = path.join(path.dirname(homeDir), "tmp-alias");
    await mkdir(sharedHome, { recursive: true });
    await symlink(sharedHome, tempAlias, "dir");
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = tempAlias;
    try {
      expect(() =>
        resolveLifecycleVerificationHome({
          homeDir: "/Users/test",
          explicitPath: path.join(tempAlias, "verification"),
        }),
      ).toThrow("Lifecycle verification home must not use symlink aliases");
    } finally {
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }
  });
});
