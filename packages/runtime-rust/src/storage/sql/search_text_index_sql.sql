CREATE INDEX IF NOT EXISTS idx_entry_search_conv_created
  ON entry(conversation_id, created_at, seq, role, id, search_text)
  WHERE search_text IS NOT NULL;
