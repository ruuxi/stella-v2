CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
  search_text,
  content='entry',
  content_rowid='rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS trg_entry_fts_insert
AFTER INSERT ON entry WHEN NEW.search_text IS NOT NULL
BEGIN
  INSERT INTO entry_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_entry_fts_delete
AFTER DELETE ON entry WHEN OLD.search_text IS NOT NULL
BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, search_text)
  VALUES ('delete', OLD.rowid, OLD.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_entry_fts_update
AFTER UPDATE OF search_text ON entry
BEGIN
  INSERT INTO entry_fts(entry_fts, rowid, search_text)
  SELECT 'delete', OLD.rowid, OLD.search_text WHERE OLD.search_text IS NOT NULL;
  INSERT INTO entry_fts(rowid, search_text)
  SELECT NEW.rowid, NEW.search_text WHERE NEW.search_text IS NOT NULL;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS thread_fts USING fts5(
  search_text,
  content='thread',
  content_rowid='rowid',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS trg_thread_fts_insert
AFTER INSERT ON thread WHEN NEW.search_text IS NOT NULL
BEGIN
  INSERT INTO thread_fts(rowid, search_text) VALUES (NEW.rowid, NEW.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_thread_fts_delete
AFTER DELETE ON thread WHEN OLD.search_text IS NOT NULL
BEGIN
  INSERT INTO thread_fts(thread_fts, rowid, search_text)
  VALUES ('delete', OLD.rowid, OLD.search_text);
END;
CREATE TRIGGER IF NOT EXISTS trg_thread_fts_update
AFTER UPDATE OF search_text ON thread
BEGIN
  INSERT INTO thread_fts(thread_fts, rowid, search_text)
  SELECT 'delete', OLD.rowid, OLD.search_text WHERE OLD.search_text IS NOT NULL;
  INSERT INTO thread_fts(rowid, search_text)
  SELECT NEW.rowid, NEW.search_text WHERE NEW.search_text IS NOT NULL;
END;
