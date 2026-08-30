import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import {
  prepareMacDevPermissionIdentity,
  resolveMacDevResponsibilityLauncher,
} from "./lib/macos-dev-permission-identity.mjs";

const DEV_SERVER_URL =
  process.env.STELLA_DEV_SERVER_URL?.trim() || "http://127.0.0.1:57314";
const DEV_IN_APP_BROWSER_BOOTSTRAP_SESSION = "stella-app-bridge-development";
const DEV_IN_APP_BROWSER_INIT_PORT = "39042";
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForVite = async () => {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(DEV_SERVER_URL, { redirect: "manual" });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Vite did not become ready at ${DEV_SERVER_URL}.`);
};

await waitForVite();

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const desktopDir = path.resolve(import.meta.dirname, "..");
prepareMacDevPermissionIdentity({ electronBinary, desktopDir });
const responsibilityLauncher = resolveMacDevResponsibilityLauncher({
  desktopDir,
});
const devEnvironment = { ...process.env };
for (const inheritedLiveKey of [
  "STELLA_APP_DIR",
  "STELLA_DATA_DIR",
  "STELLA_DEV_RESTART_REQUEST_FILE",
  "STELLA_DEV_USER_QUIT_REQUEST_FILE",
  "STELLA_ELECTRON_DEV_RUNNER_PID",
  "STELLA_ELECTRON_READY_FILE",
  "STELLA_GIT_BIN",
  "STELLA_HOST_EXECUTABLE_PATH",
  "STELLA_LAUNCHER_PROTECTED_STORAGE_BIN",
  "STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION",
  "STELLA_IN_APP_BROWSER_INIT_PORT",
  "STELLA_RUNTIME_STATE_DIR",
]) {
  delete devEnvironment[inheritedLiveKey];
}
const child = spawn(
  responsibilityLauncher ?? electronBinary,
  responsibilityLauncher ? [electronBinary, ".", "--dev"] : [".", "--dev"],
  {
    cwd: path.resolve(import.meta.dirname, "..", "..", ".."),
    env: {
      ...devEnvironment,
      NODE_ENV: "development",
      STELLA_DEV_SERVER_URL: DEV_SERVER_URL,
      STELLA_IN_APP_BROWSER_BOOTSTRAP_SESSION:
        DEV_IN_APP_BROWSER_BOOTSTRAP_SESSION,
      STELLA_IN_APP_BROWSER_INIT_PORT: DEV_IN_APP_BROWSER_INIT_PORT,
    },
    stdio: "inherit",
    windowsHide: true,
  },
);

const forwardSignal = (signal) => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
};

process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("error", (error) => {
  console.error(`[electron:dev] Failed to launch Electron: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
