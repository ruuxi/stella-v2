// The OAuth provider catalog data lives in `oauth-provider-catalog.json`
// (generated from the public Composio toolkit catalog on 2026-05-17; entries
// whose public pages omitted actions were backfilled from Composio's MCP search
// metadata). Slack, Slackbot, Discord, Discordbot, Microsoft Teams, and
// WhatsApp are intentionally excluded because Stella handles bot-style
// connections through backend-owned services.
//
// PERF: the catalog is ~8MB of JSON and was previously an inlined `const` in
// this module. That made it ~83% of the 14.6MB electron-main bundle, so V8
// re-parsed 11.6MB of JS source on every cold start and esbuild re-parsed it on
// every rebuild. We now keep the data as a sibling .json read lazily from disk
// (Stella runs from its source tree, so STELLA_APP_DIR points at the repo root)
// and JSON.parse it once on first access. JSON.parse of 8MB is far cheaper than
// V8 parsing 11.6MB of JS, and the bundle drops to ~3MB.
//
// PERF (2): even that parse (~12ms, ~18MB retained heap) was paid on the first
// orchestrator turn of every worker, because the connector keyword reminder
// builds its index from the catalog. The index and the connector list need
// only each provider's id/name/category/flags, so they now read a generated
// `oauth-provider-catalog.index.json` sidecar; the full JSON is parsed only
// for a provider's actions.

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

/** Every catalog field except `tools` (the ~99% of the bytes). */
export type OAuthCatalogProviderSummary = Omit<OAuthCatalogProvider, "tools">;

const CATALOG_JSON_BASENAME = "oauth-provider-catalog.json";
/**
 * Generated sidecar: the full catalog minus each provider's `tools`, in the
 * same order (~50KB vs ~12MB). Everything that lists or matches connectors
 * (the keyword reminder, discovery, the Store list) reads only this; the full
 * catalog is parsed only when a provider's actions are requested. Regenerate
 * with `bun packages/runtime/kernel/connectors/generate-oauth-provider-catalog-index.ts`
 * after editing the catalog; `--check` (and the bun test beside it) fails on
 * drift.
 */
export const OAUTH_PROVIDER_CATALOG_INDEX_BASENAME =
  "oauth-provider-catalog.index.json";

export const toOAuthProviderCatalogIndex = (
  catalog: readonly OAuthCatalogProvider[],
): OAuthCatalogProviderSummary[] =>
  catalog.map(({ tools: _tools, ...summary }) => summary);

export const serializeOAuthProviderCatalogIndex = (
  index: readonly OAuthCatalogProviderSummary[],
): string => `${JSON.stringify(index, null, 2)}\n`;

const readCatalogAsset = <T>(basename: string): T => {
  const assetPath = resolveRuntimeSourceAsset("kernel", "connectors", basename);
  try {
    return JSON.parse(readFileSync(assetPath, "utf-8")) as T;
  } catch (error) {
    throw new Error(
      `Failed to load ${basename} (tried: ${assetPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

let cachedCatalog: readonly OAuthCatalogProvider[] | null = null;
let cachedSummaries: readonly OAuthCatalogProviderSummary[] | null = null;
const cachedToolsById = new Map<string, readonly OAuthCatalogTool[]>();

/**
 * Lazily load and memoize the full OAuth provider catalog (one ~12MB
 * JSON.parse, retained for the process lifetime). Runtime paths should use
 * `getOAuthProviderSummaries` / `getOAuthCatalogProviderTools` instead so a
 * worker never retains the whole catalog; this stays for scripts and tests.
 */
export const getOAuthProviderCatalog = (): readonly OAuthCatalogProvider[] => {
  if (cachedCatalog) {
    return cachedCatalog;
  }
  cachedCatalog = readCatalogAsset<OAuthCatalogProvider[]>(
    CATALOG_JSON_BASENAME,
  );
  return cachedCatalog;
};

/** Memoized provider summaries from the small generated sidecar. */
export const getOAuthProviderSummaries =
  (): readonly OAuthCatalogProviderSummary[] => {
    if (cachedSummaries) {
      return cachedSummaries;
    }
    cachedSummaries = readCatalogAsset<OAuthCatalogProviderSummary[]>(
      OAUTH_PROVIDER_CATALOG_INDEX_BASENAME,
    );
    return cachedSummaries;
  };

/**
 * One provider's catalog tools. Parses the full catalog on the first request
 * for each provider and keeps only that provider's tools, so the rest of the
 * parse is garbage once this returns. Ids absent from the sidecar return
 * undefined without touching the full catalog.
 */
export const getOAuthCatalogProviderTools = (
  id: string,
): readonly OAuthCatalogTool[] | undefined => {
  const cached = cachedToolsById.get(id);
  if (cached) return cached;
  if (!getOAuthProviderSummaries().some((entry) => entry.id === id)) {
    return undefined;
  }
  const catalog =
    cachedCatalog ??
    readCatalogAsset<OAuthCatalogProvider[]>(CATALOG_JSON_BASENAME);
  const tools = catalog.find((entry) => entry.id === id)?.tools;
  if (tools) cachedToolsById.set(id, tools);
  return tools;
};
