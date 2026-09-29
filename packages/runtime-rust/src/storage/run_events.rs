//! The existing short-lived replay database, separate from stella.sqlite.
use super::now_ms;
use anyhow::{Context, Result};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::path::Path;

pub struct RunEvents {
    db: Connection,
    next_sweep: i64,
}
impl RunEvents {
    pub fn open(directory: &Path) -> Result<Self> {
        let path = directory.join("stella-runs.sqlite");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.into()),
        }
        let db = Connection::open(path)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS run_event_log(run_id TEXT NOT NULL,seq INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(run_id,seq));
          CREATE INDEX IF NOT EXISTS idx_run_event_log_created ON run_event_log(created_at);")?;
        let mut log = Self { db, next_sweep: 0 };
        // Match existing worker semantics: never replay interrupted side effects
        // as a fresh model turn. Settle the old run once with a terminal receipt.
        for run in log.buffered()? {
            if run["hasTerminalEvent"] == true {
                continue;
            }
            log.append(&json!({"type":"run-finished","runId":run["runId"],"rootRunId":run["runId"],"conversationId":run["conversationId"],"seq":9007199254740991_i64,"outcome":"error","reason":"worker_restart","error":"Stella restarted before this run could finish."}))?;
        }
        Ok(log)
    }
    pub fn sweep(&mut self) -> Result<()> {
        let now = now_ms();
        if now >= self.next_sweep {
            self.db.execute(
                "DELETE FROM run_event_log WHERE created_at < ?",
                [now - 30 * 60 * 1000],
            )?;
            self.next_sweep = now + 60_000;
        }
        Ok(())
    }
    pub fn append(&mut self, event: &Value) -> Result<()> {
        self.sweep()?;
        self.db.execute("INSERT OR IGNORE INTO run_event_log(run_id,seq,payload_json,created_at) VALUES(?,?,?,?)",params![event["runId"].as_str().context("Missing runId")?,event["seq"].as_i64().context("Missing sequence")?,serde_json::to_string(event)?,now_ms()])?;
        Ok(())
    }
    pub fn resume(&mut self, run_id: &str, last_seq: i64) -> Result<Value> {
        self.sweep()?;
        let oldest: Option<i64> = self.db.query_row(
            "SELECT min(seq) FROM run_event_log WHERE run_id=?",
            [run_id],
            |r| r.get(0),
        )?;
        let mut statement = self.db.prepare(
            "SELECT payload_json FROM run_event_log WHERE run_id=? AND seq>? ORDER BY seq",
        )?;
        let values = statement
            .query_map(params![run_id, last_seq], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let events = values
            .into_iter()
            .map(|v| serde_json::from_str::<Value>(&v))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(json!({"events":events,"exhausted":oldest.is_some_and(|oldest|last_seq<oldest-1)}))
    }
    pub fn ack(&mut self, run_id: &str, last_seq: i64) -> Result<usize> {
        Ok(self.db.execute(
            "DELETE FROM run_event_log WHERE run_id=? AND seq<=?",
            params![run_id, last_seq],
        )?)
    }
    pub fn buffered(&self) -> Result<Vec<Value>> {
        let mut query=self.db.prepare("SELECT run_id,MAX(created_at),MAX(CASE WHEN json_extract(payload_json,'$.type')='run-finished' THEN 1 ELSE 0 END),(SELECT json_extract(inner.payload_json,'$.conversationId') FROM run_event_log AS inner WHERE inner.run_id=run_event_log.run_id AND json_type(inner.payload_json,'$.conversationId')='text' ORDER BY inner.created_at DESC,inner.seq DESC LIMIT 1) FROM run_event_log GROUP BY run_id ORDER BY MAX(created_at) DESC")?;
        Ok(query.query_map([],|r|Ok(json!({"runId":r.get::<_,String>(0)?,"updatedAt":r.get::<_,i64>(1)?,"hasTerminalEvent":r.get::<_,bool>(2)?,"conversationId":r.get::<_,Option<String>>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?.into_iter().filter(|v|v["conversationId"].as_str().is_some_and(|id|!id.trim().is_empty())).collect())
    }
}
