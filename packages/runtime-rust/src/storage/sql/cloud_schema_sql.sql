CREATE TABLE IF NOT EXISTS legacy_chat_cloud_import (
  local_conversation_id TEXT PRIMARY KEY,
  cloud_conversation_id TEXT,
  owner_generation TEXT,
  next_turn_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_transcript_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('begin', 'finish')),
  conversation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  local_turn_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recovery_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dead_lettered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_transcript_outbox_turn_kind
  ON cloud_transcript_outbox(conversation_id, device_id, local_turn_id, kind);
CREATE INDEX IF NOT EXISTS idx_cloud_transcript_outbox_created
  ON cloud_transcript_outbox(created_at, id);
CREATE INDEX IF NOT EXISTS idx_cloud_transcript_outbox_delivery
  ON cloud_transcript_outbox(dead_lettered_at, attempts, updated_at, created_at, id);

CREATE TABLE IF NOT EXISTS cloud_journal_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  append_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dead_lettered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_journal_outbox_delivery
  ON cloud_journal_outbox(dead_lettered_at, sequence);

CREATE TABLE IF NOT EXISTS computer_agent_cloud_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'terminal', 'cancel')),
  thread_id TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL,
  owner_scope TEXT,
  owner_generation TEXT,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_outbox_delivery
  ON computer_agent_cloud_outbox(next_attempt_at, sequence);
CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_outbox_owner_delivery
  ON computer_agent_cloud_outbox(owner_scope, next_attempt_at, sequence);

CREATE TABLE IF NOT EXISTS computer_agent_cloud_thread_owners (
  thread_id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL,
  owner_generation TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_thread_owners_scope
  ON computer_agent_cloud_thread_owners(owner_scope, updated_at);

CREATE TABLE IF NOT EXISTS computer_agent_cloud_retired_generations (
  thread_id TEXT NOT NULL,
  owner_scope TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, owner_scope, owner_generation)
);
CREATE INDEX IF NOT EXISTS idx_computer_agent_cloud_retired_scope
  ON computer_agent_cloud_retired_generations(owner_scope, retired_at);

CREATE TABLE IF NOT EXISTS cloud_journal_admission_receipts (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_journal_admission_receipts_created
  ON cloud_journal_admission_receipts(created_at, id);

CREATE TABLE IF NOT EXISTS cloud_agent_thread_controls (
  thread_id TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  cloud_conversation_id TEXT NOT NULL,
  origin_conversation_id TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL,
  thread_updated_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'failed', 'canceled')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, owner_generation)
);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_thread_controls_origin
  ON cloud_agent_thread_controls(owner_generation, origin_conversation_id, updated_at);

CREATE TABLE IF NOT EXISTS cloud_agent_tool_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('spawn', 'continue', 'cancel')),
  fingerprint TEXT NOT NULL,
  owner_generation TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cloud_agent_tool_operations_updated
  ON cloud_agent_tool_operations(updated_at, operation_id);

CREATE TABLE IF NOT EXISTS connector_followup_targets (
  conversation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  backend_conversation_id TEXT NOT NULL,
  initial_turn_completed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_followup_targets_request
  ON connector_followup_targets(request_id);

CREATE TABLE IF NOT EXISTS connector_followup_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  backend_conversation_id TEXT NOT NULL,
  text TEXT NOT NULL,
  eligible_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connector_followup_outbox_delivery
  ON connector_followup_outbox(eligible_at, next_attempt_at, sequence);

CREATE TABLE IF NOT EXISTS voice_transcript_inbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_tool_call_receipts (
  conversation_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completion_json TEXT,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_tool_call_receipts_completed
  ON voice_tool_call_receipts(completed_at, updated_at);
