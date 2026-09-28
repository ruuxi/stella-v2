// Drift gate for the generated catalog summary sidecar (runs in test:bun).
// On failure: bun packages/runtime/kernel/connectors/generate-oauth-provider-catalog-index.ts
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

import {
  oauthProviderCatalogIndexPaths,
  renderOAuthProviderCatalogIndex,
} from "./generate-oauth-provider-catalog-index.js";

test("oauth-provider-catalog.index.json matches oauth-provider-catalog.json", () => {
  expect(readFileSync(oauthProviderCatalogIndexPaths.index, "utf-8")).toBe(
    renderOAuthProviderCatalogIndex(),
  );
});
