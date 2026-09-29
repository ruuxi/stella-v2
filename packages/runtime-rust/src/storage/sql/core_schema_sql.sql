CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'chat',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  next_seq INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_kind_status_updated
  ON conversation(kind, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS entry (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  role TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 0,
  turn_seq INTEGER,
  device_id TEXT,
  request_id TEXT,
  target_device_id TEXT,
  run_id TEXT,
  agent_type TEXT,
  payload TEXT,
  channel_envelope TEXT,
  search_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entry_id ON entry(id);
CREATE INDEX IF NOT EXISTS idx_entry_conv_visible_seq
  ON entry(conversation_id, seq) WHERE visible = 1;
CREATE INDEX IF NOT EXISTS idx_entry_conv_type_seq
  ON entry(conversation_id, type, seq);
CREATE INDEX IF NOT EXISTS idx_entry_conv_turn_seq
  ON entry(conversation_id, turn_seq, seq);
CREATE INDEX IF NOT EXISTS idx_entry_created ON entry(created_at);
CREATE INDEX IF NOT EXISTS idx_entry_run
  ON entry(run_id) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT,
  external_session_id TEXT,
  external_delivered_entry_id TEXT,
  group_key TEXT,
  group_label TEXT,
  session_id TEXT,
  session_created_at INTEGER,
  cwd TEXT NOT NULL DEFAULT '',
  parent_session TEXT,
  next_seq INTEGER NOT NULL DEFAULT 1,
  search_text TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_conv_status
  ON thread(conversation_id, status, last_used_at);
CREATE INDEX IF NOT EXISTS idx_thread_last_used ON thread(last_used_at);

CREATE TABLE IF NOT EXISTS blob (
  id INTEGER PRIMARY KEY,
  byte_length INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_entry (
  thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  custom_type TEXT,
  payload TEXT,
  blob_id INTEGER,
  est_tokens INTEGER NOT NULL DEFAULT 0,
  image_count INTEGER NOT NULL DEFAULT 0,
  image_bytes INTEGER NOT NULL DEFAULT 0,
  timestamp_iso TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_entry_id ON thread_entry(id);
CREATE INDEX IF NOT EXISTS idx_thread_entry_assistant_created
  ON thread_entry(created_at) WHERE role = 'assistant' AND type = 'message';
CREATE INDEX IF NOT EXISTS idx_thread_entry_thread_role
  ON thread_entry(thread_id, role, seq);
CREATE INDEX IF NOT EXISTS idx_thread_entry_thread_custom
  ON thread_entry(thread_id, custom_type, seq) WHERE custom_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS thread_context (
  thread_id TEXT PRIMARY KEY REFERENCES thread(id) ON DELETE CASCADE,
  compaction_entry_id TEXT NOT NULL,
  covered_from_seq INTEGER NOT NULL,
  covered_through_seq INTEGER NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  tokens_before INTEGER NOT NULL DEFAULT 0,
  timestamp_iso TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent (
  thread_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  storage_mode TEXT NOT NULL DEFAULT 'local',
  owner_generation TEXT,
  agent_type TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT,
  prompt_created_at INTEGER,
  agent_depth INTEGER NOT NULL,
  max_agent_depth INTEGER,
  parent_agent_id TEXT,
  model_config_json TEXT,
  tool_workspace_root TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  result TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL,
  root_run_id TEXT,
  attempt_generation INTEGER NOT NULL DEFAULT 0,
  cloud_terminal_receipt_generation INTEGER,
  terminal_lifecycle_receipt_generation INTEGER,
  descendant_boundary_state_json TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_conversation_updated
  ON agent(conversation_id, updated_at, thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_active_updated
  ON agent(conversation_id, updated_at DESC, thread_id)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_agent_terminal_updated
  ON agent(conversation_id, updated_at DESC, thread_id)
  WHERE status NOT IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_updated ON agent(updated_at);

CREATE TABLE IF NOT EXISTS durable_thread_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  content TEXT NOT NULL,
  conversation_id TEXT,
  source_updated_at INTEGER NOT NULL,
  UNIQUE (source_key)
);
CREATE INDEX IF NOT EXISTS idx_durable_thread_summaries_updated
  ON durable_thread_summaries(source_updated_at);

CREATE TABLE IF NOT EXISTS runtime_conversation_state (
  conversation_id TEXT PRIMARY KEY,
  force_reminder_on_next_turn INTEGER NOT NULL DEFAULT 0
);
