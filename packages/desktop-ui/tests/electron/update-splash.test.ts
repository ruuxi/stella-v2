import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  launchWindowsUpdateSplash,
  UPDATE_SPLASH_HELPER_BASE_NAME,
  UPDATE_SPLASH_TIMEOUT_MS,
  type UpdateSplashDeps,
} from "../../../desktop/electron/updates/update-splash";

const win = (...segments: string[]) => path.join(...segments);

const makeDeps = (
  overrides: Partial<UpdateSplashDeps> = {},
): UpdateSplashDeps & {
  mkdirSync: ReturnType<typeof vi.fn>;
  copyFileSync: ReturnType<typeof vi.fn>;
  spawnDetached: ReturnType<typeof vi.fn>;
} => ({
  platform: "win32",
  resolveHelperPath: (baseName: string) =>
    win("C:", "app", "resources", "native", "out", "win32", `${baseName}.exe`),
  resourcesPath: win("C:", "app", "resources"),
  stagingRoot: win("C:", "temp"),
  execPath: win("C:", "app", "Stella.exe"),
  pid: 4242,
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn(),
  spawnDetached: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn() },
  ...overrides,
});

describe("launchWindowsUpdateSplash", () => {
  it("stages the helper plus brand assets and spawns it detached", () => {
    const deps = makeDeps();
    expect(launchWindowsUpdateSplash(deps)).toBe(true);

    const stagingDir = win("C:", "temp", "stella-update-splash");
    expect(deps.mkdirSync).toHaveBeenCalledWith(stagingDir);

    const stagedExe = win(
      stagingDir,
      `${UPDATE_SPLASH_HELPER_BASE_NAME}.exe`,
    );
    expect(deps.copyFileSync).toHaveBeenCalledWith(
      win(
        "C:",
        "app",
        "resources",
        "native",
        "out",
        "win32",
        `${UPDATE_SPLASH_HELPER_BASE_NAME}.exe`,
      ),
      stagedExe,
    );
    expect(deps.copyFileSync).toHaveBeenCalledWith(
      win("C:", "app", "resources", "update-splash", "stella-logo.png"),
      win(stagingDir, "stella-logo.png"),
    );
    expect(deps.copyFileSync).toHaveBeenCalledWith(
      win(
        "C:",
        "app",
        "resources",
        "update-splash",
        "cormorant-garamond-italic.ttf",
      ),
      win(stagingDir, "cormorant-garamond-italic.ttf"),
    );

    expect(deps.spawnDetached).toHaveBeenCalledTimes(1);
    const [command, args] = deps.spawnDetached.mock.calls[0] as [
      string,
      string[],
    ];
    expect(command).toBe(stagedExe);

    expect(args).toEqual([
      "--parent-pid",
      "4242",
      "--watch-exe",
      "Stella.exe",
      "--watch-dir",
      win("C:", "app"),
      "--timeout-ms",
      String(UPDATE_SPLASH_TIMEOUT_MS),
      "--logo",
      win(stagingDir, "stella-logo.png"),
      "--font",
      win(stagingDir, "cormorant-garamond-italic.ttf"),
    ]);
  });

  it("does nothing off Windows", () => {
    const deps = makeDeps({ platform: "darwin" });
    expect(launchWindowsUpdateSplash(deps)).toBe(false);
    expect(deps.mkdirSync).not.toHaveBeenCalled();
    expect(deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("warns and skips when the helper binary is missing", () => {
    const deps = makeDeps({ resolveHelperPath: () => null });
    expect(launchWindowsUpdateSplash(deps)).toBe(false);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it("still launches without brand assets when their copies fail", () => {
    const deps = makeDeps();
    deps.copyFileSync.mockImplementation((source: string) => {
      if (source.includes(win("resources", "update-splash"))) {
        throw new Error("asset missing");
      }
    });
    expect(launchWindowsUpdateSplash(deps)).toBe(true);
    const [, args] = deps.spawnDetached.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--logo");
    expect(args).not.toContain("--font");
    expect(deps.log.warn).toHaveBeenCalledTimes(2);
  });

  it("never throws when staging the helper itself fails", () => {
    const deps = makeDeps({
      mkdirSync: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    expect(launchWindowsUpdateSplash(deps)).toBe(false);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
    expect(deps.log.warn).toHaveBeenCalled();
  });
});
