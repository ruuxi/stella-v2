import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEV_ELECTRON_USER_DATA_DIRNAME,
  DEV_STELLA_HOME_DIRNAME,
  PACKAGED_ELECTRON_USER_DATA_DIRNAME,
  PACKAGED_STELLA_HOME_DIRNAME,
  resolveDesktopDataPaths,
  resolveLifecycleVerificationHome,
} from "../../../desktop/electron/data-paths";
import { getDesktopDatabasePath } from "@stella/runtime/kernel/storage/database-init";

const tempRoots = new Set<string>();

const makeTempHome = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stella-v2-home-paths-"));
  tempRoots.add(root);
  return {
    home: path.join(root, "home"),
    appData: path.join(root, "Library", "Application Support"),
  };
};

afterEach(async () => {
  await Promise.all(
    [...tempRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots.clear();
});

describe("desktop Stella home isolation", () => {
  it("puts a packaged build's durable home and DB beside the v1 home data", async () => {
    const temp = await makeTempHome();
    const paths = resolveDesktopDataPaths({
      isPackaged: true,
      homeDir: temp.home,
      appDataDir: temp.appData,
    });

    expect(paths).toEqual({
      stellaHomeDir: path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME),
      electronUserDataDir: path.join(
        temp.appData,
        PACKAGED_ELECTRON_USER_DATA_DIRNAME,
      ),
    });
    expect(getDesktopDatabasePath(paths.stellaHomeDir)).toBe(
      path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME, "stella.sqlite"),
    );
    for (const userDataPath of [
      "memories",
      "skills",
      "prompts",
      "connectors",
      "agents",
      "models.json",
      "preferences.json",
    ]) {
      expect(path.join(paths.stellaHomeDir, userDataPath)).not.toContain(
        paths.electronUserDataDir,
      );
    }
  });

  it("keeps an unpackaged build out of the packaged ~/.stella home", async () => {
    const temp = await makeTempHome();
    const liveHome = path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME);
    const previousGenericDataDir = process.env.STELLA_DATA_DIR;
    process.env.STELLA_DATA_DIR = liveHome;

    try {
      const paths = resolveDesktopDataPaths({
        isPackaged: false,
        homeDir: temp.home,
        appDataDir: temp.appData,
      });

      expect(paths.stellaHomeDir).toBe(
        path.join(temp.home, DEV_STELLA_HOME_DIRNAME),
      );
      expect(paths.stellaHomeDir).not.toBe(liveHome);
      expect(getDesktopDatabasePath(paths.stellaHomeDir)).toBe(
        path.join(temp.home, DEV_STELLA_HOME_DIRNAME, "stella.sqlite"),
      );
      expect(paths.electronUserDataDir).toBe(
        path.join(temp.appData, DEV_ELECTRON_USER_DATA_DIRNAME),
      );
    } finally {
      if (previousGenericDataDir === undefined) {
        delete process.env.STELLA_DATA_DIR;
      } else {
        process.env.STELLA_DATA_DIR = previousGenericDataDir;
      }
    }
  });

  it("accepts only the v2-specific dev-home override for development", async () => {
    const temp = await makeTempHome();
    const isolatedOverride = path.join(temp.home, "custom-v2-dev-home");
    const paths = resolveDesktopDataPaths({
      isPackaged: false,
      homeDir: temp.home,
      appDataDir: temp.appData,
      devHomeOverride: isolatedOverride,
    });

    expect(paths.stellaHomeDir).toBe(isolatedOverride);
    expect(paths.stellaHomeDir).not.toBe(
      path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME),
    );
  });

  it("rejects dev overrides that target the packaged home or its descendants", async () => {
    const temp = await makeTempHome();
    const liveHome = path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME);

    for (const devHomeOverride of [liveHome, path.join(liveHome, "dev")]) {
      expect(() =>
        resolveDesktopDataPaths({
          isPackaged: false,
          homeDir: temp.home,
          appDataDir: temp.appData,
          devHomeOverride,
        }),
      ).toThrow("Development Stella home must not overlap the packaged home");
    }
  });

  it("rejects symlink and case aliases of the packaged home", async () => {
    const temp = await makeTempHome();
    const liveHome = path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME);
    const symlinkAlias = path.join(temp.home, "v2-dev-alias");
    await mkdir(liveHome, { recursive: true });
    await symlink(liveHome, symlinkAlias, "dir");

    for (const devHomeOverride of [path.join(temp.home, ".STELLA")]) {
      expect(() =>
        resolveDesktopDataPaths({
          isPackaged: false,
          homeDir: temp.home,
          appDataDir: temp.appData,
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
          homeDir: temp.home,
          appDataDir: temp.appData,
          devHomeOverride,
        }),
      ).toThrow("Development Stella home must not use symlink aliases");
    }
  });

  it("rejects a default dev-home symlink without following it", async () => {
    const temp = await makeTempHome();
    const liveHome = path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME);
    const defaultDevHome = path.join(temp.home, DEV_STELLA_HOME_DIRNAME);
    await mkdir(liveHome, { recursive: true });
    await symlink(liveHome, defaultDevHome, "dir");

    expect(() =>
      resolveDesktopDataPaths({
        isPackaged: false,
        homeDir: temp.home,
        appDataDir: temp.appData,
      }),
    ).toThrow("Development Stella home must not use symlink aliases");
  });

  it("rejects a symlinked inherited temp boundary", async () => {
    const temp = await makeTempHome();
    const liveHome = path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME);
    const tempAlias = path.join(path.dirname(temp.home), "tmp-alias");
    await mkdir(liveHome, { recursive: true });
    await symlink(liveHome, tempAlias, "dir");
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

  it("rejects dev overrides that are ancestors of the packaged home", async () => {
    const temp = await makeTempHome();

    for (const devHomeOverride of [temp.home, path.dirname(temp.home)]) {
      expect(() =>
        resolveDesktopDataPaths({
          isPackaged: false,
          homeDir: temp.home,
          appDataDir: temp.appData,
          devHomeOverride,
        }),
      ).toThrow("Development Stella home must not overlap the packaged home");
    }
  });

  it("rejects dev overrides outside the user home", async () => {
    const temp = await makeTempHome();
    expect(() =>
      resolveDesktopDataPaths({
        isPackaged: false,
        homeDir: temp.home,
        appDataDir: temp.appData,
        devHomeOverride: "/opt/stella-v2-dev-test",
      }),
    ).toThrow(
      "Development Stella home must stay within the user home or OS temp",
    );
  });

  it("rejects dev Electron userData paths that overlap or alias the packaged home", async () => {
    const temp = await makeTempHome();
    const liveHome = path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME);
    await mkdir(liveHome, { recursive: true });

    expect(() =>
      resolveDesktopDataPaths({
        isPackaged: false,
        homeDir: temp.home,
        appDataDir: liveHome,
      }),
    ).toThrow("Development Electron userData must not overlap");

    const appDataDir = path.join(temp.home, "Library", "Application Support");
    await mkdir(appDataDir, { recursive: true });
    await symlink(
      liveHome,
      path.join(appDataDir, DEV_ELECTRON_USER_DATA_DIRNAME),
      "dir",
    );
    expect(() =>
      resolveDesktopDataPaths({
        isPackaged: false,
        homeDir: temp.home,
        appDataDir,
      }),
    ).toThrow("Development Electron userData must not use symlink aliases");
  });

  it("requires lifecycle verification to name a non-live isolated home", async () => {
    const temp = await makeTempHome();
    expect(() =>
      resolveLifecycleVerificationHome({ homeDir: temp.home }),
    ).toThrow("STELLA_V2_LIFECYCLE_VERIFY_DATA_DIR");
    expect(() =>
      resolveLifecycleVerificationHome({
        homeDir: temp.home,
        explicitPath: path.join(temp.home, PACKAGED_STELLA_HOME_DIRNAME),
      }),
    ).toThrow("Lifecycle verification home must not overlap the packaged home");
    expect(
      resolveLifecycleVerificationHome({
        homeDir: temp.home,
        explicitPath: path.join(temp.home, "lifecycle-verification"),
      }),
    ).toBe(path.join(temp.home, "lifecycle-verification"));
    const actualStyleTempPath = path.join(
      os.tmpdir(),
      `stella-v2-lifecycle-${process.pid}`,
    );
    expect(
      resolveLifecycleVerificationHome({
        homeDir: "/Users/test",
        explicitPath: actualStyleTempPath,
      }),
    ).toBe(actualStyleTempPath);
  });
});
