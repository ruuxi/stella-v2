-- Slack: "tag Stella in Slack" (src/slack/). One row per workspace that
-- installed the app through OAuth v2; the bot token is AES-GCM encrypted under
-- a key derived from BETTER_AUTH_SECRET.
CREATE TABLE slack_installations (
  team_id TEXT PRIMARY KEY,
  enterprise_id TEXT,
  team_name TEXT NOT NULL,
  app_id TEXT NOT NULL,
  bot_user_id TEXT NOT NULL,
  bot_token_enc TEXT NOT NULL,
  scopes TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- A Slack user linked to a Stella account. A Slack user links to at most one
-- owner; an owner may link several Slack users (one per workspace).
CREATE TABLE slack_identities (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);
CREATE INDEX slack_identities_owner ON slack_identities (owner_id);

-- Which Stella conversation a Slack thread (or a DM) runs in, and whose
-- account it runs on.
CREATE TABLE slack_threads (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_turn_ts TEXT,
  PRIMARY KEY (team_id, channel_id, thread_key)
);
CREATE INDEX slack_threads_owner ON slack_threads (owner_id);

-- Messages the Events API already delivered, kept briefly so a thread's
-- context comes from here instead of the rate-limited history APIs.
CREATE TABLE slack_messages (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  thread_ts TEXT,
  user_id TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  files_json TEXT,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, ts)
);
CREATE INDEX slack_messages_thread ON slack_messages (team_id, channel_id, thread_ts, ts);
CREATE INDEX slack_messages_received ON slack_messages (received_at);

-- Slack retries an event it thinks we missed; each event id runs once.
CREATE TABLE slack_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX slack_events_received ON slack_events (received_at);

-- Display names, so prompts read "@dana" rather than "<@U0123>".
CREATE TABLE slack_users (
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  real_name TEXT,
  email TEXT,
  tz TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, slack_user_id)
);
