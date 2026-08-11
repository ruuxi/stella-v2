import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  resolveDesktopStellaDataDirPath,
  resolvePackagedStellaAppDirPath,
} from "@stella/desktop/electron/data-paths.js";

const HOME = path.join(path.sep, "Users", "tester");

describe("resolveDesktopStellaDataDirPath", () => {
  it("uses the Resources directory rather than packaged app.asar as the app root", () => {
    const appAsar = path.join(
      path.sep,
      "Applications",
      "Stella.app",
      "Contents",
      "Resources",
      "app.asar",
    );

    expect(resolvePackagedStellaAppDirPath(appAsar)).toBe(
      path.dirname(appAsar),
    );
  });

  it("defaults packaged and development durable data to ~/.stella", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        homeDir: HOME,
      }),
    ).toBe(path.join(HOME, ".stella"));
  });

  it("dev defaults to the real home directory when none is supplied", () => {
    expect(resolveDesktopStellaDataDirPath({})).toBe(
      path.join(os.homedir(), ".stella"),
    );
  });

  it("honors the mode-specific override selected by bootstrap", () => {
    const override = path.join(HOME, "stella-dev-home");
    expect(
      resolveDesktopStellaDataDirPath({
        configuredStatePath: override,
        homeDir: HOME,
      }),
    ).toBe(override);
  });

  it("blank overrides fall through to the mode default", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        configuredStatePath: "   ",
        homeDir: HOME,
      }),
    ).toBe(path.join(HOME, ".stella"));
  });

  it("resolves relative overrides to absolute paths", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        configuredStatePath: "relative-dir",
        homeDir: HOME,
      }),
    ).toBe(path.resolve("relative-dir"));
  });

  it("takes the process lock before bootstrap services can open SQLite", async () => {
    const bootstrapSource = await readFile(
      new URL("../../../desktop/electron/bootstrap.ts", import.meta.url),
      "utf8",
    );
    const lockIndex = bootstrapSource.indexOf("app.requestSingleInstanceLock()");
    const serviceConstructionIndex = bootstrapSource.indexOf(
      "createBootstrapContext({",
    );

    expect(lockIndex).toBeGreaterThan(-1);
    expect(serviceConstructionIndex).toBeGreaterThan(lockIndex);
  });
});
