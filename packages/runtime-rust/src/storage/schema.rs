use anyhow::{Context, Result, bail};
use rusqlite::{Connection, ErrorCode, OptionalExtension, TransactionBehavior};
use std::{thread, time::Duration};

pub const VERSION: i64 = 3;
pub const CORE: &str = include_str!("sql/core_schema_sql.sql");
pub const CLOUD: &str = include_str!("sql/cloud_schema_sql.sql");
pub const ENTRY_REFS: &str = include_str!("sql/entry_ref_schema_sql.sql");
pub const FTS: &str = include_str!("sql/fts_schema_sql.sql");
pub const SUMMARY_FTS: &str = include_str!("sql/thread_summary_fts_schema_sql.sql");
pub const SEARCH_INDEX: &str = include_str!("sql/search_text_index_sql.sql");

pub fn table_exists(db: &Connection, name: &str) -> rusqlite::Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?",
            [name],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}

pub fn has_column(db: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    // Parameters are fixed table names supplied by the migration, never user input.
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
    for value in stmt.query_map([], |row| row.get::<_, String>(1))? {
        if value? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn backfill_cloud_columns(db: &Connection) -> Result<()> {
    for (table, column, ty) in [
        ("legacy_chat_cloud_import", "owner_generation", "TEXT"),
        ("cloud_transcript_outbox", "owner_generation", "TEXT"),
        ("cloud_transcript_outbox", "recovery_json", "TEXT"),
        ("cloud_transcript_outbox", "last_error", "TEXT"),
        ("cloud_transcript_outbox", "dead_lettered_at", "INTEGER"),
        ("cloud_journal_outbox", "owner_generation", "TEXT"),
        ("computer_agent_cloud_outbox", "owner_scope", "TEXT"),
        ("computer_agent_cloud_outbox", "owner_generation", "TEXT"),
        (
            "computer_agent_cloud_thread_owners",
            "owner_generation",
            "TEXT",
        ),
    ] {
        if table_exists(db, table)? && !has_column(db, table, column)? {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"))?;
        }
    }
    Ok(())
}

/// Same on-disk contract as the desktop v3 schema. Only migrations take the
/// exclusive lock; opening a current file never rebuilds tables or outboxes.
pub fn migrate(db: &mut Connection) -> Result<()> {
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON;")?;
    let version = db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?;
    if version > VERSION {
        bail!("Database schema {version} is newer than supported schema {VERSION}");
    }
    if version == VERSION {
        return Ok(());
    }
    // Match the old opener's lock budget. Retrying only busy/locked errors
    // prevents a damaged file or full disk being mistaken for contention.
    for attempt in 0..12 {
        let tx = match db.transaction_with_behavior(TransactionBehavior::Exclusive) {
            Ok(tx) => tx,
            Err(rusqlite::Error::SqliteFailure(e, _))
                if matches!(e.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
                    && attempt < 11 =>
            {
                thread::sleep(Duration::from_secs(5));
                continue;
            }
            Err(e) => return Err(e).context("Acquiring desktop migration lock"),
        };
        let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > VERSION {
            bail!("Database schema advanced beyond {VERSION} during open");
        }
        if version < 1 {
            tx.execute_batch(CORE)?;
            backfill_cloud_columns(&tx)?;
            tx.execute_batch(CLOUD)?;
            // SQLite is bundled with FTS5, so unlike the old optional driver
            // a failed index creation is an error and rolls the migration back.
            tx.execute_batch(FTS)?;
            tx.execute_batch("DROP TABLE IF EXISTS dream_inbox; DROP TABLE IF EXISTS runtime_memory_review_state;")?;
            if table_exists(&tx, "session")? && table_exists(&tx, "message")? {
                super::legacy::import(&tx)?;
            }
            tx.execute("INSERT INTO meta(key,value,updated_at) VALUES('fts_ready','1',?) ON CONFLICT(key) DO UPDATE SET value='1',updated_at=excluded.updated_at", [super::now_ms()])?;
        }
        if version < 2 {
            tx.execute_batch(ENTRY_REFS)?;
        }
        if version < 3 {
            tx.execute_batch(SUMMARY_FTS)?;
            tx.execute_batch("INSERT INTO durable_thread_summaries_fts(durable_thread_summaries_fts) VALUES('rebuild')")?;
        }
        tx.pragma_update(None, "user_version", VERSION)?;
        tx.commit()?;
        return Ok(());
    }
    bail!("Could not acquire the desktop migration lock")
}

pub fn rebuild_search(db: &Connection) -> Result<()> {
    for table in ["entry_fts", "thread_fts", "durable_thread_summaries_fts"] {
        db.execute_batch(&format!("INSERT INTO {table}({table}) VALUES('rebuild')"))?;
    }
    db.execute("INSERT INTO meta(key,value,updated_at) VALUES('fts_ready','1',?) ON CONFLICT(key) DO UPDATE SET value='1',updated_at=excluded.updated_at", [super::now_ms()])?;
    Ok(())
}
