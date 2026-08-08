import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopStellaDataDirPath } from "@stella/desktop/electron/data-paths.js";

const HOME = path.join(path.sep, "Users", "tester");
const USER_DATA = path.join(HOME, "Library", "Application Support", "Stella Development");

describe("resolveDesktopStellaDataDirPath", () => {
  it("dev shares the packaged ~/.stella home instead of Electron userData", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: false,
        userDataPath: USER_DATA,
        homeDir: HOME,
      }),
    ).toBe(path.join(HOME, ".stella"));
  });

  it("dev defaults to the real home directory when none is supplied", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: false,
        userDataPath: USER_DATA,
      }),
    ).toBe(path.join(os.homedir(), ".stella"));
  });

  it("dev honors the mode-specific override", () => {
    const override = path.join(HOME, "stella-dev-home");
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: false,
        configuredStatePath: override,
        userDataPath: USER_DATA,
        homeDir: HOME,
      }),
    ).toBe(override);
  });

  it("blank overrides fall through to the mode default", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: false,
        configuredStatePath: "   ",
        userDataPath: USER_DATA,
        homeDir: HOME,
      }),
    ).toBe(path.join(HOME, ".stella"));
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: true,
        configuredStatePath: "",
        userDataPath: USER_DATA,
        homeDir: HOME,
      }),
    ).toBe(path.resolve(USER_DATA));
  });

  it("packaged keeps Electron userData as the fallback", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: true,
        userDataPath: USER_DATA,
        homeDir: HOME,
      }),
    ).toBe(path.resolve(USER_DATA));
  });

  it("packaged honors the STELLA_DATA_DIR-style override", () => {
    const override = path.join(HOME, "custom-stella-data");
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: true,
        configuredStatePath: override,
        userDataPath: USER_DATA,
        homeDir: HOME,
      }),
    ).toBe(override);
  });

  it("resolves relative overrides to absolute paths", () => {
    expect(
      resolveDesktopStellaDataDirPath({
        isPackaged: false,
        configuredStatePath: "relative-dir",
        userDataPath: USER_DATA,
        homeDir: HOME,
      }),
    ).toBe(path.resolve("relative-dir"));
  });
});
