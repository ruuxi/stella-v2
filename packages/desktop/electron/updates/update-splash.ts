import path from "node:path";

export const UPDATE_SPLASH_HELPER_BASE_NAME = "stella-update-splash";
export const UPDATE_SPLASH_TIMEOUT_MS = 10 * 60 * 1_000;

const SPLASH_RESOURCE_DIR = "update-splash";
const SPLASH_LOGO_FILE = "stella-logo.png";
const SPLASH_FONT_FILE = "cormorant-garamond-italic.ttf";

export type UpdateSplashDeps = {
  platform: NodeJS.Platform;

  resolveHelperPath: (baseName: string) => string | null;

  resourcesPath: string | null;

  stagingRoot: string;

  execPath: string;
  pid: number;
  mkdirSync: (dir: string) => void;
  copyFileSync: (source: string, destination: string) => void;
  spawnDetached: (command: string, args: string[]) => void;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
};

const asErrorMessage = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

export const launchWindowsUpdateSplash = (deps: UpdateSplashDeps): boolean => {
  if (deps.platform !== "win32") return false;

  const helperPath = deps.resolveHelperPath(UPDATE_SPLASH_HELPER_BASE_NAME);
  if (!helperPath) {
    deps.log.warn(
      "Windows update splash helper is not available; the silent install will run without a cover window.",
    );
    return false;
  }

  try {
    const stagingDir = path.join(deps.stagingRoot, "stella-update-splash");
    deps.mkdirSync(stagingDir);

    const stagedExe = path.join(
      stagingDir,
      `${UPDATE_SPLASH_HELPER_BASE_NAME}.exe`,
    );
    deps.copyFileSync(helperPath, stagedExe);

    const args = [
      "--parent-pid",
      String(deps.pid),
      "--watch-exe",
      path.basename(deps.execPath),
      "--watch-dir",
      path.dirname(deps.execPath),
      "--timeout-ms",
      String(UPDATE_SPLASH_TIMEOUT_MS),
    ];

    if (deps.resourcesPath) {
      for (const [flag, fileName] of [
        ["--logo", SPLASH_LOGO_FILE],
        ["--font", SPLASH_FONT_FILE],
      ] as const) {
        try {
          const staged = path.join(stagingDir, fileName);
          deps.copyFileSync(
            path.join(deps.resourcesPath, SPLASH_RESOURCE_DIR, fileName),
            staged,
          );
          args.push(flag, staged);
        } catch (error) {
          deps.log.warn(
            `Windows update splash asset ${fileName} could not be staged: ${asErrorMessage(error)}`,
          );
        }
      }
    }

    deps.spawnDetached(stagedExe, args);
    deps.log.info(
      `Windows update splash launched from ${stagedExe} to cover the silent install.`,
    );
    return true;
  } catch (error) {
    deps.log.warn(
      `Windows update splash failed to launch: ${asErrorMessage(error)}`,
    );
    return false;
  }
};
