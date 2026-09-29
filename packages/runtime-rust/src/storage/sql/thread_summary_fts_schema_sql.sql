CREATE VIRTUAL TABLE IF NOT EXISTS durable_thread_summaries_fts USING fts5(
  "content",
  thread_id,
  run_id,
  agent_type,
  content='durable_thread_summaries',
  content_rowid='id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS trg_durable_thread_summaries_fts_insert
AFTER INSERT ON durable_thread_summaries
BEGIN
  INSERT INTO durable_thread_summaries_fts(
    rowid, "content", thread_id, run_id, agent_type
  )
  VALUES (NEW.id, NEW.content, NEW.thread_id, NEW.run_id, NEW.agent_type);
END;
CREATE TRIGGER IF NOT EXISTS trg_durable_thread_summaries_fts_delete
AFTER DELETE ON durable_thread_summaries
BEGIN
  INSERT INTO durable_thread_summaries_fts(
    durable_thread_summaries_fts, rowid, "content", thread_id, run_id, agent_type
  )
  VALUES ('delete', OLD.id, OLD.content, OLD.thread_id, OLD.run_id, OLD.agent_type);
END;
CREATE TRIGGER IF NOT EXISTS trg_durable_thread_summaries_fts_update
AFTER UPDATE OF content, thread_id, run_id, agent_type
ON durable_thread_summaries
BEGIN
  INSERT INTO durable_thread_summaries_fts(
    durable_thread_summaries_fts, rowid, "content", thread_id, run_id, agent_type
  )
  VALUES ('delete', OLD.id, OLD.content, OLD.thread_id, OLD.run_id, OLD.agent_type);
  INSERT INTO durable_thread_summaries_fts(
    rowid, "content", thread_id, run_id, agent_type
  )
  VALUES (NEW.id, NEW.content, NEW.thread_id, NEW.run_id, NEW.agent_type);
END;
