CREATE TABLE IF NOT EXISTS entry_ref (
  conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  entry_seq INTEGER NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('message', 'agent')),
  target_key TEXT NOT NULL,
  PRIMARY KEY (conversation_id, entry_seq, target_kind, target_key)
);
CREATE INDEX IF NOT EXISTS idx_entry_ref_target
  ON entry_ref(conversation_id, target_kind, target_key, entry_seq);
