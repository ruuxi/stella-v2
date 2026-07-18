import { app, crashReporter, Menu } from "electron";
import path from "path";
import {
  AUTH_PROTOCOL,
  HARD_RESET_MUTABLE_HOME_PATHS,
  STARTUP_FIRST_PAINT_FALLBACK_MS,
  STARTUP_RUNTIME_WARMUP_DELAY_MS,
  STARTUP_STAGE_DELAY_MS,
  STELLA_APP_NAME,
  STELLA_DEV_APP_NAME,
  STELLA_SESSION_PARTITION,
  STELLA_WINDOWS_APP_USER_MODEL_ID,
} from "./bootstrap/constants.js";
import { createBootstrapContext } from "./bootstrap/context.js";
import { initMainProcessLogging } from "./observability/main-logger.js";
import {
  getTotalSystemMemoryMb,
  isLowMemoryWindowsDevice,
} from "./resource-profile.js";
import { resolveRuntimeStatePath } from "@stella/runtime/kernel/home/stella-home";
import {
  initializeBootstrapSingleInstance,
  registerBootstrapLifecycle,
} from "./bootstrap/lifecycle.js";
import { resolvePackagedPromptSiteUrl } from "./prompt-site-config.js";
import { resolveDesktopDataPaths } from "./data-paths.js";
const __dirname = import.meta.dirname;
// app.isPackaged is the authority. Inherited environment variables must never
// turn a signed build back into a Vite client.
const isDev = !app.isPackaged;
// macOS derives safeStorage's Keychain service from app.name. Keep unpackaged
// v2 development in its own namespace while v1 remains installed under
// "Stella Safe Storage". Signed production builds retain the clean name.
app.setName(isDev ? STELLA_DEV_APP_NAME : STELLA_APP_NAME);

const desktopDataPaths = resolveDesktopDataPaths({
  isPackaged: app.isPackaged,
  appDataDir: app.getPath("appData"),
  devHomeOverride: isDev
    ? process.env.STELLA_V2_DEV_DATA_DIR?.trim()
    : undefined,
});
// Electron's Library/AppData root is runtime state only. Durable, user-facing
// Stella data lives in desktopDataPaths.stellaHomeDir.
app.setPath("userData", desktopDataPaths.electronUserDataDir);
// The detached worker inherits this explicit ephemeral root. Host and worker
// lifecycle files/logs must never fall back to the durable Stella home.
process.env.STELLA_RUNTIME_STATE_DIR = desktopDataPaths.electronUserDataDir;

const stellaAppDir = app.isPackaged
  ? app.getAppPath()
  : path.resolve(__dirname, "..", "..", "..", "..");
const stellaDataDirPath = resolveRuntimeStatePath(
  app,
  stellaAppDir,
  desktopDataPaths.stellaHomeDir,
);
const useDevServer = isDev;
const installDevBrokenPipeGuards = () => {
  if (!isDev) {
    return;
  }

  const swallowBrokenPipe = (_error: Error & { code?: string }) => {
    // Dev-mode Electron inherits stdio from the runner process. If that parent
    // pipe disappears, logging should not crash the app.
  };

  process.stdout.on("error", swallowBrokenPipe);
  process.stderr.on("error", swallowBrokenPipe);
};

const startLocalCrashReporter = () => {
  try {
    crashReporter.start({
      uploadToServer: false,
      compress: true,
      globalExtra: {
        app: "stella",
      },
    });
  } catch {
    // Crash reporting is best-effort diagnostics only.
  }
};

export const bootstrapMainProcess = () => {
  initMainProcessLogging(stellaAppDir, desktopDataPaths.electronUserDataDir);
  installDevBrokenPipeGuards();
  startLocalCrashReporter();
  // Stella ships its own chrome (custom top bar, custom window controls on
  // Windows). Electron's default application menu otherwise renders an
  // in-window File/Edit/View/Window/Help bar on Windows/Linux directly below
  // the native title bar, doubling up with our top bar. Keep macOS' native
  // app menu so standard Edit roles continue to provide Cmd+C/Cmd+V/etc.
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
  }
  if (process.platform === "win32") {
    app.setAppUserModelId(STELLA_WINDOWS_APP_USER_MODEL_ID);
  }
  if (isLowMemoryWindowsDevice()) {
    console.log(
      `[resource] Low-memory Windows profile enabled (${getTotalSystemMemoryMb()} MB total)`,
    );
  }

  const context = createBootstrapContext({
    authProtocol: AUTH_PROTOCOL,
    electronDir: __dirname,
    stellaAppDir,
    stellaDataDirPath,
    promptSiteUrl: resolvePackagedPromptSiteUrl(),
    hardResetMutableHomePaths: HARD_RESET_MUTABLE_HOME_PATHS,
    isDev,
    useDevServer,
    sessionPartition: STELLA_SESSION_PARTITION,
    startupStageDelayMs: STARTUP_STAGE_DELAY_MS,
    startupFirstPaintFallbackMs: STARTUP_FIRST_PAINT_FALLBACK_MS,
    startupRuntimeWarmupDelayMs: STARTUP_RUNTIME_WARMUP_DELAY_MS,
  });

  if (!initializeBootstrapSingleInstance(context)) {
    return;
  }

  registerBootstrapLifecycle(context);
};
