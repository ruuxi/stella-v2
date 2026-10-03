-- Product feedback from the app's feedback dialog. Anonymous by design: no
-- owner, subject or device is stored. Read with
-- `wrangler d1 execute stella-v2-dev --remote --command "select ..."`.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX feedback_created_at ON feedback (created_at);
