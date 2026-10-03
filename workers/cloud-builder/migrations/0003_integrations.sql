-- The Store's integration catalog, published by
-- `POST /api/admin/native-integrations/upsert` (src/integrations/catalog.ts).
-- A publication replaces an integration's row and all of its actions in one
-- batch, so readers see the old set or the new set, never a mix.

-- `json` is the integration record: id, name, provider, category, auth,
-- catalogToolCount, actionCount, description, sourceUrl, iconUrl, connector
-- ({type:"composio", toolkit, provider}), enabled, usagePolicy.
CREATE TABLE integration_catalog (
  slug TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX integration_catalog_by_updated ON integration_catalog (updated_at DESC);

-- One row per published action. `json` is {name, title?, description?,
-- annotations?, inputSchema}; `search_text` is the name,
-- title and description, lowercased, for the actions query.
CREATE TABLE integration_actions (
  slug TEXT NOT NULL,
  action TEXT NOT NULL,
  json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, action)
);
