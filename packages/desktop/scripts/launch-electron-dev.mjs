import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const DEV_SERVER_URL =
  process.env.STELLA_DEV_SERVER_URL?.trim() || "http://127.0.0.1:57314";
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
const child = spawn(electronBinary, [".", "--dev"], {
  cwd: path.resolve(import.meta.dirname, "..", "..", ".."),
  env: {
    ...process.env,
    NODE_ENV: "development",
    STELLA_DEV_SERVER_URL: DEV_SERVER_URL,
  },
  stdio: "inherit",
  windowsHide: true,
});

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
