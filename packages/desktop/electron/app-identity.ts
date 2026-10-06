/**
 * Who this Stella process is: the user's installed Stella, a developer's
 * checkout, or the verification harness. One answer, one module, so that no
 * site has to invent its own.
 *
 * The question used to be answered by `app.isPackaged`, and for a packaged
 * Electron app that was right. Stella has no packaging step any more: the
 * installed desktop app is a git checkout of this source tree, started by the
 * native launchers in `launcher/`, with the renderer served from source and
 * the runtime on Bun. `app.isPackaged` is therefore false for the real
 * product too, and every predicate that used it as a proxy for "is this the
 * shipped app" silently inverted — the whole class of bug this module exists
 * to remove. (The shared browser bridge was the instance that reached users:
 * every installed Stella took the dev-checkout branch and isolated itself
 * away from the Chrome extension.)
 *
 * The launcher's `STELLA_LAUNCHER=1` is the signal that a source tree is being
 * run as the product. The verification harness sets `STELLA_DEV_HARNESS=1`
 * and is never the product, even if it were launcher-started.
 *
 * What this module does NOT answer:
 *
 * - "Does the app run from source?" It always does, in every install. Code
 *   that serves the renderer from source, watches files, or exposes the
 *   app-source drafts must simply do so unconditionally.
 * - "Is `import.meta.env.DEV` true?" That is a build-mode flag, chosen from
 *   this answer in `source/env.ts`, not a second opinion about it.
 */

export const STELLA_LAUNCHER_ENV = "STELLA_LAUNCHER";
export const STELLA_DEV_HARNESS_ENV = "STELLA_DEV_HARNESS";

/**
 * `product`: the user's installed Stella. `harness`: the verification harness
 * (`.agents/skills/verify-stella`). `checkout`: a developer running the source
 * tree directly (`bun run electron:dev`).
 */
export type AppInstall = "product" | "harness" | "checkout";

export type AppIdentityOptions = {
  env?: NodeJS.ProcessEnv;
  /**
   * `app.isPackaged`, for the one caller that still has it. Stella has no
   * packaging step, so this is false everywhere; it is honoured only so that a
   * hypothetical packaged build would classify as the product rather than as a
   * developer checkout.
   */
  isPackaged?: boolean;
};

export const resolveAppInstall = (
  options: AppIdentityOptions = {},
): AppInstall => {
  const env = options.env ?? process.env;
  // A packaged build could never be a harness, and a harness is never the
  // product even when the launcher started it.
  if (options.isPackaged) return "product";
  if (env[STELLA_DEV_HARNESS_ENV]?.trim() === "1") return "harness";
  return env[STELLA_LAUNCHER_ENV]?.trim() === "1" ? "product" : "checkout";
};

/** This process IS the user's Stella, not a checkout running alongside it. */
export const isInstalledProduct = (options: AppIdentityOptions = {}): boolean =>
  resolveAppInstall(options) === "product";

/**
 * A human is running this tree themselves: a developer checkout or the
 * harness. The condition for developer conveniences — devtools, verbose
 * diagnostics, relaxed checks, development telemetry and data.
 */
export const isDeveloperInstance = (
  options: AppIdentityOptions = {},
): boolean => !isInstalledProduct(options);

/** The isolated verification harness. */
export const isDevHarness = (options: AppIdentityOptions = {}): boolean =>
  resolveAppInstall(options) === "harness";
