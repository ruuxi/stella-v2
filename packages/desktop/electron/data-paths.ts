import os from "node:os";
import path from "node:path";
import {
  resolveAppInstall,
  type AppIdentityOptions,
  type AppInstall,
} from "./app-identity.js";

export const STELLA_PRODUCTION_DATA_DIR_NAME = ".stella";
export const STELLA_DEVELOPMENT_DATA_DIR_NAME = ".stella-development";

export type DesktopStellaDataMode = "development" | "production";

/**
 * Durable Stella data root for the desktop app. The installed product keeps
 * the production `~/.stella` home. A developer checkout and the harness use
 * `~/.stella-development`, so a dev migration, reset, runtime, or SQLite write
 * cannot mutate the data used by the installed app.
 *
 * Redirection stays possible only through the mode-specific override
 * (`STELLA_V2_DEV_DATA_DIR` in development, `STELLA_DATA_DIR` for the
 * product) — development deliberately ignores the generic `STELLA_DATA_DIR`
 * so a terminal environment can't retarget a checkout.
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

/** Which durable home an install owns. */
export const desktopStellaDataMode = (
  install: AppInstall,
): DesktopStellaDataMode =>
  install === "product" ? "production" : "development";

/**
 * The durable home for this process, derived from who it is. The single
 * derivation bootstrap and the browser bridge namespace share, so they cannot
 * disagree about which tree the run owns.
 *
 * Reads the mode's own override from `env`, which is why callers that run
 * before bootstrap publishes `STELLA_DATA_DIR` still get the right answer.
 */
export const resolveDesktopStellaDataDirForInstall = (
  options: AppIdentityOptions = {},
): string => {
  const env = options.env ?? process.env;
  const mode = desktopStellaDataMode(resolveAppInstall(options));
  return resolveDesktopStellaDataDirPath({
    mode,
    configuredStatePath:
      mode === "production" ? env.STELLA_DATA_DIR : env.STELLA_V2_DEV_DATA_DIR,
  });
};

