/** Hash-history reconciliation for extensions shipped as Stella-home seed. */

import {
  createDirectoryEntryAdapter,
  reconcileBundledEntries,
  summarizeBundledSync,
  type BundledSyncReport,
} from "./bundled-sync.js";

export type ExtensionsSyncReport = BundledSyncReport;

export const reconcileBundledExtensions = async (
  bundledExtensionsDir: string,
  homeExtensionsDir: string,
): Promise<ExtensionsSyncReport> =>
  reconcileBundledEntries(
    bundledExtensionsDir,
    homeExtensionsDir,
    createDirectoryEntryAdapter(),
    {
      // Unknown/user-authored extensions are never retired by an app update.
      removeObsolete: false,
      manifestFilename: ".bundled-extensions-manifest.json",
    },
  );

export const summarizeExtensionsSync = summarizeBundledSync;
