pub mod chat;
mod legacy;
pub mod schema;
mod summaries;

use anyhow::Result;
use rusqlite::Connection;
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

pub struct Store {
    pub(crate) db: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(parent)?;
        }
        // Create privately before SQLite opens WAL or journal sidecars. Never
        // chmod the caller's existing parent directory (which may be shared).
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(path) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        let mut db = Connection::open(path)?;
        schema::migrate(&mut db)?;
        Ok(Self { db })
    }

    pub fn diagnostics(&self) -> Result<serde_json::Value> {
        Ok(serde_json::json!({
            "schemaVersion": self.db.query_row("PRAGMA user_version", [], |r| r.get::<_,i64>(0))?,
            "journalMode": self.db.query_row("PRAGMA journal_mode", [], |r| r.get::<_,String>(0))?,
            "sqliteVersion": rusqlite::version(),
            "fts5": self.db.query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| r.get::<_,bool>(0))?,
            "foreignKeys": self.db.query_row("PRAGMA foreign_keys", [], |r| r.get::<_,bool>(0))?
        }))
    }
}
