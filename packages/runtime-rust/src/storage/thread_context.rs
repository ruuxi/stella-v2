//! Durable session entries and compaction overlays in the existing SQLite schema.
use super::{Store, now_ms};
use anyhow::{Context, Result, bail};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};

fn iso(timestamp: i64) -> Result<String> {
    Ok(chrono::DateTime::from_timestamp_millis(timestamp)
        .context("Invalid entry timestamp")?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}
fn append(
    tx: &Transaction<'_>,
    thread: &str,
    kind: &str,
    data: &Value,
    timestamp: i64,
) -> Result<String> {
    let seq: i64 = tx
        .query_row(
            "UPDATE thread SET next_seq=next_seq+1,last_used_at=? WHERE id=? RETURNING next_seq-1",
            params![timestamp, thread],
            |r| r.get(0),
        )
        .context("Unknown thread")?;
    let id = ulid::Ulid::new().to_string();
    let exact = data.to_string();
    let message = if kind == "message" {
        &data["message"]
    } else {
        data
    };
    let stats = stella_runtime_core::context::pressure(&json!({"messages":[message]}));
    let blob = if exact.len() > 64 * 1024 {
        Some(tx.query_row(
            "INSERT INTO blob(byte_length,content) VALUES(?,?) RETURNING id",
            params![exact.len() as i64, exact],
            |r| r.get::<_, i64>(0),
        )?)
    } else {
        None
    };
    // Keep accounting metadata queryable even when the exact content is a blob.
    let payload = if blob.is_some() {
        let mut bounded = data.clone();
        let target = if kind == "message" {
            &mut bounded["message"]
        } else {
            &mut bounded
        };
        if target.is_object() {
            target["content"] = json!("[Exact content stored in blob]");
        }
        if bounded.to_string().len() > 64 * 1024 {
            json!({"message":{"role":message["role"],"timestamp":timestamp,"content":"[Exact content stored in blob]"},"customType":data["customType"]}).to_string()
        } else {
            bounded.to_string()
        }
    } else {
        exact
    };
    tx.execute("INSERT INTO thread_entry(thread_id,seq,id,type,role,custom_type,payload,blob_id,est_tokens,image_count,image_bytes,timestamp_iso,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",params![thread,seq,id,kind,if kind=="message"{message["role"].as_str()}else{None},if kind=="custom_message"{data["customType"].as_str()}else{None},payload,blob,stats.tokens as i64,stats.images as i64,stats.image_bytes as i64,iso(timestamp)?,timestamp])?;
    tx.execute("UPDATE thread SET session_id=COALESCE(session_id,?),session_created_at=COALESCE(session_created_at,?) WHERE id=?",params![ulid::Ulid::new().to_string(),timestamp,thread])?;
    Ok(id)
}
impl Store {
    pub fn append_session_entry(
        &mut self,
        thread: &str,
        kind: &str,
        data: &Value,
        timestamp: i64,
    ) -> Result<String> {
        match kind {
            "message" if data["message"].is_object() && data["message"]["role"].is_string() => {}
            "custom_message"
                if data["customType"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
                    && (data["content"].is_string() || data["content"].is_array()) => {}
            "lifecycle_event"
                if data["event"]["_id"].is_string() && data["event"]["timestamp"].is_number() => {}
            _ => bail!("Invalid session entry"),
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = append(&tx, thread, kind, data, timestamp)?;
        tx.commit()?;
        Ok(id)
    }
    pub fn session_entries(&self, thread: &str, limit: Option<i64>) -> Result<Vec<Value>> {
        self.session_entries_outside(thread, limit, 0, 0)
    }
    fn session_entries_outside(
        &self,
        thread: &str,
        limit: Option<i64>,
        from: i64,
        to: i64,
    ) -> Result<Vec<Value>> {
        let mut query=self.db.prepare("SELECT e.seq,e.id,e.type,e.timestamp_iso,e.created_at,COALESCE(b.content,e.payload) FROM (SELECT * FROM thread_entry WHERE thread_id=? AND (seq<? OR seq>? OR custom_type='containment.quarantine') ORDER BY seq DESC LIMIT ?) e LEFT JOIN blob b ON b.id=e.blob_id ORDER BY seq ASC")?;
        let rows = query
            .query_map(
                params![thread, from, to, limit.map(|n| n.max(1)).unwrap_or(-1)],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|(seq,id,kind,time,created,data)|Ok(json!({"seq":seq,"id":id,"type":kind,"timestamp":time,"createdAt":created,"data":data.map(|s|serde_json::from_str::<Value>(&s)).transpose()?.unwrap_or(Value::Null)}))).collect()
    }
    pub fn thread_context(&self, thread: &str) -> Result<Option<Value>> {
        let row=self.db.query_row("SELECT compaction_entry_id,covered_from_seq,covered_through_seq,summary,details,tokens_before,timestamp_iso,updated_at FROM thread_context WHERE thread_id=?",[thread],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,i64>(5)?,r.get::<_,String>(6)?,r.get::<_,i64>(7)?))).optional()?;
        row.map(|(id,from,to,summary,details,tokens,time,stamp)|Ok(json!({"threadId":thread,"compactionEntryId":id,"coveredFromSeq":from,"coveredThroughSeq":to,"summary":summary,"details":details.map(|s|serde_json::from_str::<Value>(&s)).transpose()?.unwrap_or(Value::Null),"tokensBefore":tokens,"timestampIso":time,"timestamp":stamp}))).transpose()
    }
    pub fn context_messages(&self, thread: &str, limit: Option<i64>) -> Result<Vec<Value>> {
        let context = if limit.is_none() {
            self.thread_context(thread)?
        } else {
            None
        };
        Ok(stella_runtime_core::context::project(
            &self.session_entries_outside(
                thread,
                limit,
                context
                    .as_ref()
                    .and_then(|c| c["coveredFromSeq"].as_i64())
                    .unwrap_or(0),
                context
                    .as_ref()
                    .and_then(|c| c["coveredThroughSeq"].as_i64())
                    .unwrap_or(0),
            )?,
            context.as_ref(),
        ))
    }
    pub fn compact_thread(&mut self, args: &Value) -> Result<Value> {
        let thread = args["threadKey"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .context("threadKey is required")?;
        let summary = args["summary"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .context("summary is required")?;
        let stamp = args["timestamp"].as_i64().unwrap_or_else(now_ms);
        let time = iso(stamp)?;
        let tokens = args["tokensBefore"].as_i64().unwrap_or(0).max(0);
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let conversation: String = tx
            .query_row(
                "SELECT conversation_id FROM thread WHERE id=?",
                [thread],
                |r| r.get(0),
            )
            .context("Unknown thread")?;
        let existing = tx
            .query_row(
                "SELECT covered_from_seq,covered_through_seq FROM thread_context WHERE thread_id=?",
                [thread],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?;
        let seq = |id: &str| -> Result<i64> {
            tx.query_row(
                "SELECT seq FROM thread_entry WHERE thread_id=? AND id=?",
                params![thread, id],
                |r| r.get(0),
            )
            .context("Compaction boundary is not a durable entry in this thread")
        };
        let (from, to) = if let (Some(from), Some(to)) =
            (args["fromEntryId"].as_str(), args["toEntryId"].as_str())
        {
            let start = seq(from)?;
            (existing.map(|e| e.0).unwrap_or(start), seq(to)?)
        } else if let Some(keep) = args["firstKeptEntryId"].as_str() {
            let first:i64=tx.query_row("SELECT MIN(seq) FROM thread_entry WHERE thread_id=? AND type IN ('message','custom_message')",[thread],|r|r.get(0))?;
            (existing.map(|e| e.0).unwrap_or(first), seq(keep)? - 1)
        } else {
            bail!("A compaction range is required")
        };
        if from > to || existing.is_some_and(|e| to < e.1) {
            bail!("Compaction must cover a nonempty range and cannot shrink existing coverage");
        }
        let from_id: String = tx.query_row(
            "SELECT id FROM thread_entry WHERE thread_id=? AND seq=?",
            params![thread, from],
            |r| r.get(0),
        )?;
        let to_id: String = tx.query_row(
            "SELECT id FROM thread_entry WHERE thread_id=? AND seq=?",
            params![thread, to],
            |r| r.get(0),
        )?;
        let mut data = json!({"summary":summary,"fromEntryId":from_id,"toEntryId":to_id,"tokensBefore":tokens});
        if let Some(details) = args.get("details") {
            data["details"] = details.clone();
        }
        if args["fromHook"] == true {
            data["fromHook"] = json!(true);
        }
        let id = append(&tx, thread, "compaction", &data, stamp)?;
        tx.execute("INSERT INTO thread_context(thread_id,compaction_entry_id,covered_from_seq,covered_through_seq,summary,details,tokens_before,timestamp_iso,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET compaction_entry_id=excluded.compaction_entry_id,covered_from_seq=excluded.covered_from_seq,covered_through_seq=excluded.covered_through_seq,summary=excluded.summary,details=excluded.details,tokens_before=excluded.tokens_before,timestamp_iso=excluded.timestamp_iso,updated_at=excluded.updated_at",params![thread,id,from,to,summary,args.get("details").map(Value::to_string),tokens,time,stamp,stamp])?;
        tx.commit()?;
        Ok(json!({"entryId":id,"conversationId":conversation,"timestamp":stamp}))
    }
    pub fn thread_pressure(&self, thread: &str) -> Result<Value> {
        let context = self.thread_context(thread)?;
        let (from, to) = context
            .as_ref()
            .map(|c| {
                (
                    c["coveredFromSeq"].as_i64().unwrap_or(0),
                    c["coveredThroughSeq"].as_i64().unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        let (rows,tokens,images,bytes):(i64,i64,i64,i64)=self.db.query_row("SELECT COUNT(*),COALESCE(SUM(est_tokens),0),COALESCE(SUM(image_count),0),COALESCE(SUM(image_bytes),0) FROM thread_entry WHERE thread_id=? AND type IN ('message','custom_message') AND (seq<? OR seq>?)",params![thread,from,to],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        let checkpoint_tokens = context
            .as_ref()
            .map(|c| {
                (c["summary"].as_str().unwrap_or("").encode_utf16().count()
                    + c["details"]
                        .get("imageReceipts")
                        .unwrap_or(&json!([]))
                        .to_string()
                        .encode_utf16()
                        .count())
                .div_ceil(3)
            })
            .unwrap_or(0);
        let mut quarantine = 0;
        let mut query=self.db.prepare("SELECT e.seq,COALESCE(b.content,e.payload) FROM thread_entry e LEFT JOIN blob b ON b.id=e.blob_id WHERE e.thread_id=? AND e.custom_type='containment.quarantine'")?;
        let quarantines = query
            .query_map([thread], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (seq, payload) in quarantines {
            let data: Value = serde_json::from_str(&payload)?;
            let record = serde_json::from_str::<Value>(&stella_runtime_core::context::text(
                &data["content"],
            ))
            .unwrap_or(Value::Null);
            if !(seq >= from
                && seq <= to
                && context.as_ref().is_some_and(|c| {
                    c["details"]["quarantinedToolResultKeys"]
                        .as_array()
                        .is_some_and(|keys| {
                            keys.contains(&record["key"]) && !record["key"].is_null()
                        })
                }))
            {
                quarantine += 1;
            }
        }
        Ok(
            json!({"complete":true,"rowCount":rows,"estimatedTokens":tokens+checkpoint_tokens as i64,"imageCount":images,"imageDecodedBytes":bytes,"quarantineCount":quarantine}),
        )
    }
    pub fn thread_session(&mut self, thread: &str) -> Result<Value> {
        let timestamp = now_ms();
        let count=self.db.execute("UPDATE thread SET session_id=COALESCE(session_id,?),session_created_at=COALESCE(session_created_at,?) WHERE id=?",params![ulid::Ulid::new().to_string(),timestamp,thread])?;
        if count == 0 {
            bail!("Unknown thread");
        }
        Ok(self.db.query_row("SELECT session_id,session_created_at,cwd,parent_session FROM thread WHERE id=?",[thread],|r|Ok(json!({"sessionId":r.get::<_,String>(0)?,"createdAt":r.get::<_,i64>(1)?,"cwd":r.get::<_,String>(2)?,"parentSession":r.get::<_,Option<String>>(3)?})))?)
    }
}
