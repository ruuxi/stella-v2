import os from "node:os";
import path from "node:path";

export const STELLA_PRODUCTION_DATA_DIR_NAME = ".stella";
export const STELLA_DEVELOPMENT_DATA_DIR_NAME = ".stella-development";

export type DesktopStellaDataMode = "development" | "production";

/**
 * Durable Stella data root for the desktop app. Packaged builds keep the
 * production `~/.stella` home. Unpackaged development uses
 * `~/.stella-development`, so a dev migration, reset, runtime, or SQLite write
 * cannot mutate the data used by the installed app.
 *
 * Redirection stays possible only through the mode-specific override that
 * bootstrap selects before calling this (`STELLA_V2_DEV_DATA_DIR` in dev,
 * `STELLA_DATA_DIR` when packaged) — dev deliberately ignores the generic
 * `STELLA_DATA_DIR` so a terminal environment can't retarget a checkout.
 */
export const resolveDesktopStellaDataDirPath = (options: {
  mode: DesktopStellaDataMode;
  /** Mode-specific env override, already selected by bootstrap. */
  configuredStatePath?: string | null;
  homeDir?: string;
}): string => {
  const configured = options.configuredStatePath?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(
    options.homeDir ?? os.homedir(),
    options.mode === "development"
      ? STELLA_DEVELOPMENT_DATA_DIR_NAME
      : STELLA_PRODUCTION_DATA_DIR_NAME,
  );
};
