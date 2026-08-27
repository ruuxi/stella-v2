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
import { applyWindowsCompositionWorkarounds } from "./windows-composition.js";
import {
  getTotalSystemMemoryMb,
  isLowMemoryWindowsDevice,
} from "./resource-profile.js";
import {
  resolveDesktopStellaDataDirPath,
  resolvePackagedStellaAppDirPath,
} from "./data-paths.js";
import {
  initializeBootstrapSingleInstance,
  registerBootstrapLifecycle,
} from "./bootstrap/lifecycle.js";
const __dirname = import.meta.dirname;

const isDev = !app.isPackaged;

app.setName(isDev ? STELLA_DEV_APP_NAME : STELLA_APP_NAME);

if (isDev) {
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "Stella Development"),
  );
}

const stellaAppDir = app.isPackaged
  ? resolvePackagedStellaAppDirPath(app.getAppPath())
  : path.resolve(__dirname, "..", "..", "..", "..");
const configuredStatePath = isDev
  ? process.env.STELLA_V2_DEV_DATA_DIR?.trim()
  : process.env.STELLA_DATA_DIR?.trim();

const stellaDataDirPath = resolveDesktopStellaDataDirPath({
  configuredStatePath,
});
const useDevServer = isDev;
const installDevBrokenPipeGuards = () => {
  if (!isDev) {
    return;
  }

  const swallowBrokenPipe = (_error: Error & { code?: string }) => {

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

  }
};

export const bootstrapMainProcess = () => {

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  initMainProcessLogging(stellaAppDir);
  installDevBrokenPipeGuards();
  startLocalCrashReporter();

  applyWindowsCompositionWorkarounds();

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
    hardResetMutableHomePaths: HARD_RESET_MUTABLE_HOME_PATHS,
    isDev,
    useDevServer,
    sessionPartition: STELLA_SESSION_PARTITION,
    startupStageDelayMs: STARTUP_STAGE_DELAY_MS,
    startupFirstPaintFallbackMs: STARTUP_FIRST_PAINT_FALLBACK_MS,
    startupRuntimeWarmupDelayMs: STARTUP_RUNTIME_WARMUP_DELAY_MS,
  });

  initializeBootstrapSingleInstance(context);
  registerBootstrapLifecycle(context);
};
