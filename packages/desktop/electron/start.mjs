/**
 * Electron's entry when Stella runs from its source tree (the root
 * package.json "main"). The renderer is served from source and the runtime is
 * Bun running TypeScript; Electron main and the sandboxed preload are esbuild
 * bundles, rebuilt here before main loads whenever their sources changed. A
 * launch with nothing changed only pays the fingerprint check.
 *
 * Packaged builds use `launch.js` directly (packages/desktop/package.json).
 */
import { ensureElectronBundlesFresh } from "../scripts/dev-electron-build.mjs";

await ensureElectronBundlesFresh({
  log: (message) => console.log(`[electron-build] ${message}`),
});
await import("../dist-electron/electron/launch.js");
