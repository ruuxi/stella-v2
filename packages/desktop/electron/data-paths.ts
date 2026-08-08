import os from "node:os";
import path from "node:path";

/**
 * Durable Stella data root for the desktop app.
 *
 * Development must share the packaged `~/.stella` home: the runtime worker's
 * control files (`runtime-paths.ts`), the Vite ui-state plugin, CLI sidecars,
 * and the prompt-facing skill catalog (`skill-catalog.ts`) all address
 * `~/.stella` directly. Pointing dev's data root at Electron's per-app
 * userData ("Stella Development") instead silently split the tree: bundled
 * skills were reconciled into userData while agents kept reading the stale
 * copies under `~/.stella/skills`.
 *
 * Redirection stays possible only through the mode-specific override that
 * bootstrap selects before calling this (`STELLA_V2_DEV_DATA_DIR` in dev,
 * `STELLA_DATA_DIR` when packaged) — dev deliberately ignores the generic
 * `STELLA_DATA_DIR` so a terminal environment can't retarget a checkout.
 */
export const resolveDesktopStellaDataDirPath = (options: {
  isPackaged: boolean;
  /** Mode-specific env override, already selected by bootstrap. */
  configuredStatePath?: string | null;
  /** `app.getPath("userData")` — packaged fallback only. */
  userDataPath: string;
  homeDir?: string;
}): string => {
  const configured = options.configuredStatePath?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (!options.isPackaged) {
    // Mirrors `resolveDefaultStellaDataDir` in runtime/kernel/home/stella-paths.
    return path.join(options.homeDir ?? os.homedir(), ".stella");
  }
  return path.resolve(options.userDataPath);
};
