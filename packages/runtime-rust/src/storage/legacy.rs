//! One-time migration of the pre-versioned Stella database. All work runs
//! inside the caller's exclusive transaction, including removal of old tables.
use super::schema::{has_column, table_exists};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

pub fn import(db: &Connection) -> Result<()> {
    db.execute_batch(include_str!("sql/legacy_importConversations_0.sql"))?;
    import_chat(db)?;
    if table_exists(db, "runtime_threads")? {
        import_threads(db)?;
    }
    if table_exists(db, "runtime_thread_entries")? {
        let order = if has_column(db, "runtime_thread_entries", "insertion_sequence")? {
            "e.insertion_sequence IS NULL, e.insertion_sequence ASC, e.rowid ASC"
        } else {
            "e.rowid ASC"
        };
        db.execute_batch(
            &include_str!("sql/legacy_importThreadEntries_0.sql").replace("{order_clause}", order),
        )?;
        db.execute_batch(include_str!("sql/legacy_importThreadEntries_1.sql"))?;
    }
    import_blobs(db)?;
    import_compactions(db)?;
    if table_exists(db, "runtime_agents")? {
        import_agents(db)?;
    }
    db.execute_batch(include_str!("sql/legacy_rebuildThreadSearchText_0.sql"))?;
    // Dropping session would otherwise cascade-delete still-live import receipts.
    let mut fks = db.prepare("PRAGMA foreign_key_list(legacy_chat_cloud_import)")?;
    let mut has_session_fk = false;
    for name in fks.query_map([], |r| r.get::<_, String>(2))? {
        if name? == "session" {
            has_session_fk = true;
        }
    }
    drop(fks);
    if has_session_fk {
        db.execute_batch(include_str!(
            "sql/legacy_rebuildLegacyChatCloudImport_0.sql"
        ))?;
    }
    for table in [
        "part",
        "message",
        "session",
        "runtime_thread_entry_payload_chunks",
        "runtime_thread_entries",
        "runtime_thread_sessions",
        "runtime_threads",
        "runtime_agents",
        "agent_progress_summaries",
        "message_ordering_counter",
        "message_text_fts",
        "thread_search_fts",
        "run_event_log",
        "chat_sync_checkpoints",
        "chat_events",
        "chat_conversations",
        "runtime_thread_messages",
        "runtime_run_events",
        "runtime_memories",
        "runtime_tasks",
        "runtime_memory_review_state",
        "dream_inbox",
    ] {
        db.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))?;
    }
    db.execute("DELETE FROM settings WHERE key IN ('transcript_fts_backfilled_v1','thread_search_fts_backfilled_v2')", [])?;
    Ok(())
}

fn import_chat(db: &Connection) -> Result<()> {
    let ordered = has_column(db, "message", "ordering_sequence")?
        && !db
            .query_row(
                "SELECT 1 FROM message WHERE ordering_sequence IS NULL LIMIT 1",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
    let order = if ordered {
        "m.ordering_sequence ASC, m.id ASC"
    } else {
        "m.created_at ASC, m.id ASC"
    };
    let hidden = "(json_valid(p.data_json) AND (COALESCE(json_extract(p.data_json,'$.metadata.ui.visibility'),'')='hidden' OR COALESCE(json_extract(p.data_json,'$.metadata.trigger.kind'),'')='workspace_creation_request'))";
    let explicit = if has_column(db, "message", "ui_visible")? {
        "WHEN m.ui_visible IS NOT NULL THEN m.ui_visible"
    } else {
        ""
    };
    let visible = format!(
        "CASE WHEN m.type IN ('user_message','assistant_message') THEN CASE {explicit} WHEN {hidden} THEN 0 ELSE 1 END ELSE 0 END"
    );
    db.execute_batch(
        &include_str!("sql/legacy_importChatEntries_0.sql")
            .replace("{visible_sql}", &visible)
            .replace("{order_clause}", order),
    )?;
    db.execute_batch(include_str!("sql/legacy_importChatEntries_1.sql"))?;
    Ok(())
}

fn import_threads(db: &Connection) -> Result<()> {
    let mut sql = include_str!("sql/legacy_importThreads_0.sql").to_string();
    for column in [
        "external_session_id",
        "external_delivered_entry_id",
        "group_key",
        "group_label",
    ] {
        let expr = if has_column(db, "runtime_threads", column)? {
            format!("t.{column}")
        } else {
            "NULL".into()
        };
        sql = sql.replace(&format!("{{{column}}}"), &expr);
    }
    let sessions = table_exists(db, "runtime_thread_sessions")?;
    for (key, yes, no) in [
        ("session_id", "s.session_id", "NULL"),
        ("session_created_at", "s.created_at", "NULL"),
        ("cwd", "COALESCE(s.cwd, '')", "''"),
        ("parent_session", "s.parent_session", "NULL"),
        (
            "session_join",
            "LEFT JOIN runtime_thread_sessions s ON s.thread_key=t.thread_key",
            "",
        ),
    ] {
        sql = sql.replace(&format!("{{{key}}}"), if sessions { yes } else { no });
    }
    db.execute_batch(&sql)?;
    Ok(())
}

fn import_agents(db: &Connection) -> Result<()> {
    let mut sql = include_str!("sql/legacy_importAgents_0.sql").to_string();
    for column in [
        "storage_mode",
        "owner_generation",
        "prompt",
        "prompt_created_at",
        "model_config_json",
        "tool_workspace_root",
        "root_run_id",
        "attempt_generation",
        "cloud_terminal_receipt_generation",
        "terminal_lifecycle_receipt_generation",
        "descendant_boundary_state_json",
        "record_revision",
    ] {
        let fallback = match column {
            "storage_mode" => "'local'",
            "attempt_generation" | "record_revision" => "0",
            _ => "NULL",
        };
        sql = sql.replace(
            &format!("{{{column}}}"),
            if has_column(db, "runtime_agents", column)? {
                column
            } else {
                fallback
            },
        );
    }
    db.execute_batch(&sql)?;
    Ok(())
}

fn number(value: &Value) -> Option<f64> {
    // JavaScript's Number() accepted numeric strings in the legacy marker.
    if value.is_null() {
        Some(0.)
    } else if let Some(b) = value.as_bool() {
        Some(if b { 1. } else { 0. })
    } else {
        value.as_f64().or_else(|| {
            value.as_str().and_then(|s| {
                if s.trim().is_empty() {
                    Some(0.)
                } else {
                    s.parse().ok()
                }
            })
        })
    }
    .filter(|n| n.is_finite())
}

fn import_blobs(db: &Connection) -> Result<()> {
    if !table_exists(db, "runtime_thread_entry_payload_chunks")? {
        return Ok(());
    }
    let mut markers = db.prepare("SELECT thread_id,seq,id,payload FROM thread_entry WHERE payload LIKE '%\"__stellaExactPayloadChunks\"%'")?;
    let mut chunks = db.prepare("SELECT chunk_text FROM runtime_thread_entry_payload_chunks WHERE entry_id=? ORDER BY chunk_index ASC")?;
    for row in markers.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (thread, seq, id, payload) = row?;
        let bounded: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let marker = &bounded["__stellaExactPayloadChunks"];
        let expected_chunks = marker.get("chunkCount").and_then(number);
        let expected_bytes = marker.get("byteLength").and_then(number);
        let mut exact = String::new();
        let mut count = 0;
        for chunk in chunks.query_map([&id], |r| r.get::<_, Option<String>>(0))? {
            exact.push_str(&chunk?.unwrap_or_default());
            count += 1;
        }
        if exact.is_empty() {
            continue;
        }
        if let (Some(n), Some(b)) = (expected_chunks, expected_bytes)
            && (n != count as f64 || b != exact.len() as f64)
        {
            continue;
        }
        db.execute(
            "INSERT INTO blob(byte_length,content) VALUES(?,?)",
            params![exact.len() as i64, exact],
        )?;
        db.execute(
            "UPDATE thread_entry SET blob_id=? WHERE thread_id=? AND seq=?",
            params![db.last_insert_rowid(), thread, seq],
        )?;
    }
    Ok(())
}

fn import_compactions(db: &Connection) -> Result<()> {
    let mut stmt = db.prepare("SELECT te.thread_id,te.id,te.payload,te.timestamp_iso,te.created_at FROM thread_entry te JOIN (SELECT thread_id,MAX(seq) AS seq FROM thread_entry WHERE type='compaction' GROUP BY thread_id) latest ON latest.thread_id=te.thread_id AND latest.seq=te.seq")?;
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })? {
        let (thread, id, payload, iso, created) = row?;
        let data: Value =
            serde_json::from_str(payload.as_deref().unwrap_or("")).unwrap_or(Value::Null);
        let string = |k: &str| data[k].as_str().unwrap_or("").trim();
        let summary = string("summary");
        if summary.is_empty() {
            continue;
        }
        let seq_for = |id: &str| -> rusqlite::Result<Option<i64>> {
            db.query_row(
                "SELECT seq FROM thread_entry WHERE thread_id=? AND id=? LIMIT 1",
                params![thread, id],
                |r| r.get(0),
            )
            .optional()
        };
        let (from, to) = if !string("fromEntryId").is_empty() && !string("toEntryId").is_empty() {
            (
                seq_for(string("fromEntryId"))?,
                seq_for(string("toEntryId"))?,
            )
        } else if !string("firstKeptEntryId").is_empty() {
            (db.query_row("SELECT MIN(seq) FROM thread_entry WHERE thread_id=? AND type IN ('message','custom_message')",[&thread],|r| r.get::<_,Option<i64>>(0))?,seq_for(string("firstKeptEntryId"))?.map(|s| s-1))
        } else {
            (None, None)
        };
        let (Some(from), Some(to)) = (from, to) else {
            continue;
        };
        if to < from {
            continue;
        }
        let tokens = data["tokensBefore"].as_f64().unwrap_or(0.).max(0.).floor() as i64;
        let details = data.get("details").map(Value::to_string);
        db.execute("INSERT OR REPLACE INTO thread_context(thread_id,compaction_entry_id,covered_from_seq,covered_through_seq,summary,details,tokens_before,timestamp_iso,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![thread,id,from,to,summary,details,tokens,iso,created,created])?;
    }
    Ok(())
}
