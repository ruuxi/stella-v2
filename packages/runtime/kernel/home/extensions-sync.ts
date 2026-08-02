/** Hash-history reconciliation for extensions shipped as Stella-home seed. */

import type { Effect } from "effect";

import {
  createDirectoryEntryAdapter,
  reconcileBundledEntriesEffect,
  type BundledSyncReport,
} from "./bundled-sync.js";
import { withHome } from "./home-runtime.js";

// Live re-export (not a top-level binding read): this module sits inside the
// home facade/service import cycle, and reading the binding at evaluation
// time would hit the temporal dead zone depending on entry order.
export { summarizeBundledSync as summarizeExtensionsSync } from "./bundled-sync.js";

export type ExtensionsSyncReport = BundledSyncReport;

export const reconcileBundledExtensionsEffect = (
  bundledExtensionsDir: string,
  homeExtensionsDir: string,
): Effect.Effect<ExtensionsSyncReport, unknown> =>
  reconcileBundledEntriesEffect(
    bundledExtensionsDir,
    homeExtensionsDir,
    createDirectoryEntryAdapter(),
    {
      // Unknown/user-authored extensions are never retired by an app update.
      removeObsolete: false,
      manifestFilename: ".bundled-extensions-manifest.json",
    },
  );

export const reconcileBundledExtensions = (
  bundledExtensionsDir: string,
  homeExtensionsDir: string,
): Promise<ExtensionsSyncReport> =>
  withHome((home) =>
    home.reconcileBundledExtensions(bundledExtensionsDir, homeExtensionsDir),
  );
