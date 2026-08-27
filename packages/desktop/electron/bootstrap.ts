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
import {
  applyDevHarnessOptions,
  resolveDevHarnessOptions,
} from "./bootstrap/dev-harness-options.js";
const __dirname = import.meta.dirname;
// app.isPackaged is the authority. Inherited environment variables must never
// turn a signed build back into a Vite client.
const isDev = !app.isPackaged;
const stellaAppDir = app.isPackaged
  ? resolvePackagedStellaAppDirPath(app.getAppPath())
  : path.resolve(__dirname, "..", "..", "..", "..");
const devHarnessOptions = resolveDevHarnessOptions({
  isPackaged: app.isPackaged,
  workspaceDir: stellaAppDir,
});

if (isDev) {
  if (devHarnessOptions) {
    applyDevHarnessOptions(app, devHarnessOptions);
  } else {
    // macOS derives safeStorage's Keychain service from app.name. Keep normal
    // unpackaged v2 development separate from both production and harnesses.
    app.setName(STELLA_DEV_APP_NAME);
    app.setPath(
      "userData",
      path.join(app.getPath("appData"), "Stella Development"),
    );
  }
} else {
  app.setName(STELLA_APP_NAME);
}

const configuredStatePath = isDev
  ? process.env.STELLA_V2_DEV_DATA_DIR?.trim()
  : process.env.STELLA_DATA_DIR?.trim();
// Packaged and development builds share the durable `~/.stella` home (see
// data-paths.ts) so SQLite, bundled-skill reconciliation, the runtime worker,
// and prompt-facing paths all agree on one tree. Electron's userData remains a
// separate platform app-data profile for Chromium/session/runtime state only.
const stellaDataDirPath = resolveDesktopStellaDataDirPath({
  configuredStatePath,
});
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
  // Acquire Electron's process lock before bootstrap services are constructed
  // so a second packaged instance cannot open local state.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  initMainProcessLogging(stellaAppDir);
  installDevBrokenPipeGuards();
  startLocalCrashReporter();
  // Windows-only: keep DWM from putting Stella on MPO hardware overlay
  // planes (whole-monitor flicker on NVIDIA + high-refresh setups). Must run
  // before `ready` so the switch reaches the GPU process. No-op on macOS.
  applyWindowsCompositionWorkarounds();
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
