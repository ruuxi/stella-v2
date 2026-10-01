import { ensureElectronBinary } from "./ensure-electron-binary.mjs";

// Self-heal a broken Electron binary install: cheap when healthy, re-extracts
// the cached zip natively when `extract-zip` left it half-written. Nothing is
// built here; `electron/start.mjs` rebuilds main and preload on the next
// launch when their inputs (the lockfile included) changed.
try {
  await ensureElectronBinary();
} catch (error) {
  console.error(
    `[postinstall-electron-binary] Failed to repair Electron binary: ${error instanceof Error ? error.message : String(error)}`,
  );
}
