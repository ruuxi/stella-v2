import os from "node:os";
import path from "node:path";

/**
 * Electron's packaged app path normally points at `app.asar`, which is a
 * file. Runtime worker identities and child-process cwd fallbacks both require
 * a real directory, so the stable packaged install root is its parent
 * Resources directory.
 */
export const resolvePackagedStellaAppDirPath = (appPath: string): string =>
  path.dirname(path.resolve(appPath));

/**
 * Durable Stella data root for the desktop app.
 *
 * Packaged and development builds share `~/.stella`: the runtime worker's
 * control files (`runtime-paths.ts`), the Vite ui-state plugin, CLI sidecars,
 * and the prompt-facing skill catalog (`skill-catalog.ts`) all address that
 * durable home. Electron's per-app userData remains a separate home for
 * replaceable Chromium/session/runtime state and must not become Stella's
 * durable data root.
 *
 * Redirection stays possible only through the mode-specific override that
 * bootstrap selects before calling this (`STELLA_V2_DEV_DATA_DIR` in dev,
 * `STELLA_DATA_DIR` when packaged) — dev deliberately ignores the generic
 * `STELLA_DATA_DIR` so a terminal environment can't retarget a checkout.
 */
export const resolveDesktopStellaDataDirPath = (options: {
  /** Mode-specific env override, already selected by bootstrap. */
  configuredStatePath?: string | null;
  homeDir?: string;
}): string => {
  const configured = options.configuredStatePath?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  // Mirrors `resolveDefaultStellaDataDir` in runtime/kernel/home/stella-paths.
  return path.join(options.homeDir ?? os.homedir(), ".stella");
};
