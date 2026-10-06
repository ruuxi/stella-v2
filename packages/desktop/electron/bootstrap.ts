import { app, Menu } from "electron";
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
  desktopStellaDataMode,
  resolveDesktopStellaDataDirPath,
} from "./data-paths.js";
import { resolveAppInstall } from "./app-identity.js";
import {
  initializeBootstrapSingleInstance,
  registerBootstrapLifecycle,
} from "./bootstrap/lifecycle.js";
import {
  applyDevHarnessOptions,
  resolveDevHarnessOptions,
} from "./bootstrap/dev-harness-options.js";
import { connectLauncher } from "./launcher-client.js";
const __dirname = import.meta.dirname;
// Who this process is: the user's Stella, the harness, or a developer's
// checkout. Never `app.isPackaged` — there is no packaging step, so it is
// false for the product too. See app-identity.ts.
const install = resolveAppInstall({ isPackaged: app.isPackaged });
const isInstalledProduct = install === "product";
// A human is running this tree: the condition for developer conveniences.
const isDeveloperInstance = !isInstalledProduct;
// The app always runs from its source tree — in every install, not just in
// development. Main lives at packages/desktop/dist-electron/electron/.
const stellaAppDir = path.resolve(__dirname, "..", "..", "..", "..");
const devHarnessOptions = resolveDevHarnessOptions({
  isPackaged: app.isPackaged,
  workspaceDir: stellaAppDir,
});

if (devHarnessOptions) {
  applyDevHarnessOptions(app, devHarnessOptions);
} else if (isInstalledProduct) {
  // The native launcher runs the source tree as the product: name, userData
  // and Stella home are Stella's, not the development app's.
  app.setName(STELLA_APP_NAME);
  app.setPath(
    "userData",
    process.env.STELLA_LAUNCHER_USER_DATA_DIR?.trim() ||
      path.join(app.getPath("appData"), STELLA_APP_NAME),
  );
} else {
  // macOS derives safeStorage's Keychain service from app.name. Keep normal
  // development separate from both the product and the harnesses.
  app.setName(STELLA_DEV_APP_NAME);
  app.setPath(
    "userData",
    path.join(app.getPath("appData"), "Stella Development"),
  );
}

const dataMode = desktopStellaDataMode(install);
const usesDevelopmentData = dataMode === "development";
const configuredStatePath = usesDevelopmentData
  ? process.env.STELLA_V2_DEV_DATA_DIR?.trim()
  : process.env.STELLA_DATA_DIR?.trim();
// SQLite, bundled-skill reconciliation, the runtime worker, and prompt-facing
// paths agree on one mode-specific tree. Development defaults to a separate
// durable home; Electron userData remains a second, replaceable profile for
// Chromium/auth/runtime state.
const stellaDataDirPath = resolveDesktopStellaDataDirPath({
  mode: dataMode,
  configuredStatePath,
});
// Establish the selected roots before logging or service construction. The
// worker and Electron main share STELLA_DATA_DIR. Dev runtime control files and
// logs also use the short isolated data root; Electron's Application Support
// path is too long for macOS' bounded Unix-domain socket paths.
process.env.STELLA_DATA_DIR = stellaDataDirPath;
process.env.STELLA_TELEMETRY_ENVIRONMENT = usesDevelopmentData
  ? "development"
  : "production";
if (isDeveloperInstance) {
  process.env.STELLA_RUNTIME_STATE_DIR = stellaDataDirPath;
}
const installBrokenPipeGuards = () => {
  const swallowBrokenPipe = (_error: Error & { code?: string }) => {
    // Electron inherits stdio from whatever started it — the launcher for the
    // product, the dev runner for a checkout. If that parent pipe disappears,
    // logging should not crash the app.
  };

  process.stdout.on("error", swallowBrokenPipe);
  process.stderr.on("error", swallowBrokenPipe);
};

export const bootstrapMainProcess = () => {
  // Acquire Electron's process lock before bootstrap services are constructed
  // so a second instance cannot open local state.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  connectLauncher();
  initMainProcessLogging(stellaAppDir);
  installBrokenPipeGuards();
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
    install,
    isInstalledProduct,
    isDeveloperInstance,
    telemetryEnvironment: usesDevelopmentData ? "development" : "production",
    sessionPartition: STELLA_SESSION_PARTITION,
    startupStageDelayMs: STARTUP_STAGE_DELAY_MS,
    startupFirstPaintFallbackMs: STARTUP_FIRST_PAINT_FALLBACK_MS,
    startupRuntimeWarmupDelayMs: STARTUP_RUNTIME_WARMUP_DELAY_MS,
  });

  // The verification harness (`--inspect` on main) reaches the live services here.
  if (install === "harness") {
    (globalThis as { __stellaHarnessContext?: unknown }).__stellaHarnessContext = context;
  }

  initializeBootstrapSingleInstance(context);
  registerBootstrapLifecycle(context);
};
