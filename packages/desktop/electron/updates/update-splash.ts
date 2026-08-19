import path from "node:path";

// Launches the Stella-branded cover window for the silent Windows update
// install (packages/native/src/update_splash.cpp). The NSIS installer runs
// with /S so no native "Stella Setup" GUI ever appears; this helper is what
// the user sees instead of an empty desktop while NSIS swaps the install
// directory.
//
// The helper and its brand assets are copied to a staging directory OUTSIDE
// the install dir first: anything running from the install dir would lock
// files NSIS needs to replace, and the resources it reads are themselves
// being swapped mid-install. The staged process is spawned detached so it
// survives the app quitting, watches for the updated app to relaunch
// (--force-run), then fades out on its own; a hard timeout inside the helper
// guarantees it can never outlive a failed install.

export const UPDATE_SPLASH_HELPER_BASE_NAME = "stella-update-splash";
export const UPDATE_SPLASH_TIMEOUT_MS = 10 * 60 * 1_000;

const SPLASH_RESOURCE_DIR = "update-splash";
const SPLASH_LOGO_FILE = "stella-logo.png";
const SPLASH_FONT_FILE = "cormorant-garamond-italic.ttf";

export type UpdateSplashDeps = {
  platform: NodeJS.Platform;
  // resolveNativeHelperPath(UPDATE_SPLASH_HELPER_BASE_NAME)
  resolveHelperPath: (baseName: string) => string | null;
  // process.resourcesPath (null outside a packaged app)
  resourcesPath: string | null;
  // Staging root outside the install dir, e.g. app.getPath("temp")
  stagingRoot: string;
  // process.execPath of the running app — the relaunch to watch for
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

/**
 * Best-effort: stages and spawns the Windows update splash. Returns whether
 * the splash was launched. Never throws — a splash failure must never be able
 * to abort the actual update restart.
 */
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

    // Brand assets are optional: the helper falls back to a logo-less window
    // with a system italic serif, so a failed asset copy only degrades looks.
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
