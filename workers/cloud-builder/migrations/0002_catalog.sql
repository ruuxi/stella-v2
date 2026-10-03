-- Managed model prices, synced daily from models.dev by the Cron Trigger
-- (src/catalog/prices.ts). The model gateway prices requests with them
-- through `BillingControl.gatewayConfig()`, and the public catalog
-- (`GET /api/stella/models`) shows them.
CREATE TABLE model_prices (
  model TEXT PRIMARY KEY,
  -- "models.dev" or "static" (a fill-in from @stella/model-catalog/pricing).
  source TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_model_id TEXT NOT NULL,
  input_per_million_usd REAL NOT NULL,
  output_per_million_usd REAL NOT NULL,
  cache_read_per_million_usd REAL NOT NULL,
  cache_write_per_million_usd REAL NOT NULL,
  reasoning_per_million_usd REAL NOT NULL,
  -- JSON string arrays, e.g. ["text","image"].
  modalities_input TEXT NOT NULL,
  modalities_output TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);

-- One row per X mention the X bot (workers/x-bot) answers. The row is written
-- `pending` when the webhook arrives, with the mention it must answer, and
-- completed with the reply once it is posted; the worker's cron retries
-- pending rows older than 2 minutes. `handle` is the lowercased X username
-- the plan is addressed to (the summoner, or the original poster when a
-- promoter account summoned); the website's /x/<handle> page lists done rows.
CREATE TABLE x_bot_runs (
  mention_id TEXT PRIMARY KEY,
  -- pending | done | failed
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- The mention as received: {id, text, authorId, authorUsername, authorName,
  -- authorCreatedAt?, parentId}.
  mention_json TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  summoner_username TEXT NOT NULL,
  handle TEXT,
  handle_display TEXT,
  poster_username TEXT,
  reply_id TEXT,
  headline TEXT,
  reply TEXT,
  -- JSON array of {user, stella}.
  exchanges_json TEXT,
  -- The rendered reply card, when it rendered.
  image_png BLOB,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX x_bot_runs_handle ON x_bot_runs (handle, created_at);
CREATE INDEX x_bot_runs_status ON x_bot_runs (status, updated_at);
