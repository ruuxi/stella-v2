import { readFileSync } from "node:fs";
import { resolveRuntimeSourceAsset } from "../shared/runtime-paths.js";

export type OAuthCatalogTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  exactSlug?: boolean;
};

export type OAuthCatalogProvider = {
  id: string;
  name: string;
  category: string;
  auth: readonly ["OAUTH2"];
  catalogToolCount: number;
  description: string;
  sourceUrl: string;
  tools: readonly OAuthCatalogTool[];
};

const CATALOG_JSON_BASENAME = "oauth-provider-catalog.json";

let cachedCatalog: readonly OAuthCatalogProvider[] | null = null;

export const getOAuthProviderCatalog = (): readonly OAuthCatalogProvider[] => {
  if (cachedCatalog) {
    return cachedCatalog;
  }
  const catalogPath = resolveRuntimeSourceAsset(
    "kernel",
    "connectors",
    CATALOG_JSON_BASENAME,
  );
  try {
    const raw = readFileSync(catalogPath, "utf-8");
    cachedCatalog = JSON.parse(raw) as OAuthCatalogProvider[];
    return cachedCatalog;
  } catch (error) {
    throw new Error(
      `Failed to load ${CATALOG_JSON_BASENAME} (tried: ${catalogPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};
