// Regenerates `oauth-provider-catalog.index.json` (the catalog minus each
// provider's `tools`) from `oauth-provider-catalog.json`. Run after editing the
// catalog (e.g. after scripts/recover-composio-oauth-actions.mjs):
//
//   bun packages/runtime/kernel/connectors/generate-oauth-provider-catalog-index.ts [--check]
//
// `--check` exits 1 when the committed sidecar has drifted. The bun test
// beside this file runs the same comparison.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OAUTH_PROVIDER_CATALOG_INDEX_BASENAME,
  serializeOAuthProviderCatalogIndex,
  toOAuthProviderCatalogIndex,
  type OAuthCatalogProvider,
} from "./oauth-provider-catalog.js";

const connectorsDir = path.dirname(fileURLToPath(import.meta.url));

export const oauthProviderCatalogIndexPaths = {
  catalog: path.join(connectorsDir, "oauth-provider-catalog.json"),
  index: path.join(connectorsDir, OAUTH_PROVIDER_CATALOG_INDEX_BASENAME),
};

export const renderOAuthProviderCatalogIndex = (): string =>
  serializeOAuthProviderCatalogIndex(
    toOAuthProviderCatalogIndex(
      JSON.parse(
        readFileSync(oauthProviderCatalogIndexPaths.catalog, "utf-8"),
      ) as OAuthCatalogProvider[],
    ),
  );

if (import.meta.main) {
  const expected = renderOAuthProviderCatalogIndex();
  const indexPath = oauthProviderCatalogIndexPaths.index;
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(indexPath, "utf-8");
    } catch {
      // Missing sidecar is drift.
    }
    if (current !== expected) {
      console.error(
        `${OAUTH_PROVIDER_CATALOG_INDEX_BASENAME} is out of date; run bun ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`,
      );
      process.exit(1);
    }
    console.log(`${OAUTH_PROVIDER_CATALOG_INDEX_BASENAME} is up to date`);
  } else {
    writeFileSync(indexPath, expected, "utf-8");
    console.log(`wrote ${indexPath}`);
  }
}
