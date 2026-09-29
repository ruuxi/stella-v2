use super::{Store, now_ms};
use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const DEFAULT_ID: &str = "default_conversation_id";
const EVENT_COLUMNS: &str =
    "id,created_at,seq,type,device_id,request_id,target_device_id,payload,channel_envelope";
const EVENT_FILTER: &str = "type NOT IN ('thread_message','run_event','memory')";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendEvent {
    pub conversation_id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub event_id: Option<String>,
    pub timestamp: Option<i64>,
    pub device_id: Option<String>,
    pub request_id: Option<String>,
    pub target_device_id: Option<String>,
    pub run_id: Option<String>,
    pub agent_type: Option<String>,
    pub payload: Option<Value>,
    pub channel_envelope: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    #[serde(rename = "_id")]
    pub id: String,
    pub timestamp: i64,
    pub sequence: i64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_envelope: Option<Value>,
}

fn row_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatEvent> {
    let parse = |i| -> rusqlite::Result<Option<Value>> {
        Ok(row
            .get::<_, Option<String>>(i)?
            .and_then(|s| serde_json::from_str(&s).ok())
            .filter(Value::is_object))
    };
    Ok(ChatEvent {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        sequence: row.get(2)?,
        kind: row.get(3)?,
        device_id: row.get(4)?,
        request_id: row.get(5)?,
        target_device_id: row.get(6)?,
        payload: parse(7)?,
        channel_envelope: parse(8)?,
    })
}

fn kind(id: &str) -> &'static str {
    if id.starts_with("local_")
        || (id.len() == 26
            && id
                .bytes()
                .all(|c| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&c)))
    {
        "chat"
    } else {
        "derived"
    }
}

fn ensure_conversation(db: &Connection, id: &str, timestamp: i64) -> Result<()> {
    db.execute("INSERT INTO conversation(id,kind,title,status,next_seq,created_at,updated_at) VALUES(?,?,'','active',1,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,updated_at=MAX(updated_at,excluded.updated_at)", params![id,kind(id),timestamp,timestamp])?;
    Ok(())
}

fn setting(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",params![key,value,now_ms()])?;
    Ok(())
}

fn repair_turns(db: &Connection, conversation: &str, seq: i64) -> Result<()> {
    db.execute("UPDATE entry SET turn_seq=(SELECT source.seq FROM entry source WHERE source.conversation_id=entry.conversation_id AND source.type='user_message' AND source.visible=1 AND source.seq<=entry.seq ORDER BY source.seq DESC LIMIT 1) WHERE conversation_id=? AND seq>=?",params![conversation,seq])?;
    Ok(())
}

pub fn append(db: &Connection, mut args: AppendEvent) -> Result<ChatEvent> {
    args.conversation_id = args.conversation_id.trim().to_string();
    args.kind = args.kind.trim().to_string();
    if args.conversation_id.is_empty() || args.kind.is_empty() {
        bail!("conversationId and type are required");
    }
    let clean = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let id = clean(args.event_id).unwrap_or_else(|| format!("local-{}", ulid::Ulid::new()));
    let timestamp = args.timestamp.unwrap_or_else(now_ms);
    let payload = args.payload.filter(Value::is_object);
    let envelope = args.channel_envelope.filter(Value::is_object);
    let p = payload.as_ref().unwrap_or(&Value::Null);
    let message = matches!(args.kind.as_str(), "user_message" | "assistant_message");
    let visible = message
        && p.pointer("/metadata/ui/visibility").and_then(Value::as_str) != Some("hidden")
        && p.pointer("/metadata/trigger/kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            != "workspace_creation_request";
    let role = match args.kind.as_str() {
        "user_message" => "user",
        "assistant_message" => "assistant",
        "tool_request" | "tool_result" => "tool",
        _ => "system",
    };
    let search = if message { p["text"].as_str() } else { None };
    let device = clean(args.device_id);
    let request = clean(args.request_id);
    let target = clean(args.target_device_id);
    let old = db
        .query_row(
            "SELECT conversation_id,seq,visible,type FROM entry WHERE id=?",
            [&id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    ensure_conversation(db, &args.conversation_id, timestamp)?;
    if let Some((old_conv, seq, _, _)) = &old
        && old_conv != &args.conversation_id
    {
        db.execute(
            "DELETE FROM entry_ref WHERE conversation_id=? AND entry_seq=?",
            params![old_conv, seq],
        )?;
        db.execute("DELETE FROM entry WHERE id=?", [&id])?;
        repair_turns(db, old_conv, *seq)?;
    }
    let seq;
    if let Some((_, existing_seq, old_visible, old_type)) =
        old.filter(|o| o.0 == args.conversation_id)
    {
        seq = existing_seq;
        db.execute("UPDATE entry SET type=?,role=?,visible=?,device_id=?,request_id=?,target_device_id=?,run_id=COALESCE(?,run_id),agent_type=COALESCE(?,agent_type),payload=?,channel_envelope=?,search_text=?,created_at=?,updated_at=? WHERE id=?",
            params![args.kind,role,visible,device,request,target,args.run_id,args.agent_type,payload.as_ref().map(Value::to_string).unwrap_or_else(||"null".into()),envelope.as_ref().map(Value::to_string).unwrap_or_else(||"null".into()),search,timestamp,timestamp,id])?;
        if (args.kind == "user_message" || old_type == "user_message")
            && (old_visible != visible || old_type != args.kind)
        {
            repair_turns(db, &args.conversation_id, seq)?;
        }
    } else {
        seq = db.query_row(
            "UPDATE conversation SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq-1",
            [&args.conversation_id],
            |r| r.get::<_, i64>(0),
        )?;
        let turn = if args.kind == "user_message" && visible {
            Some(seq)
        } else {
            db.query_row("SELECT seq FROM entry WHERE conversation_id=? AND type='user_message' AND visible=1 ORDER BY seq DESC LIMIT 1",[&args.conversation_id],|r|r.get::<_,i64>(0)).optional()?
        };
        db.execute("INSERT INTO entry(conversation_id,seq,id,type,role,visible,turn_seq,device_id,request_id,target_device_id,run_id,agent_type,payload,channel_envelope,search_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![args.conversation_id,seq,id,args.kind,role,visible,turn,device,request,target,args.run_id,args.agent_type,payload.as_ref().map(Value::to_string).unwrap_or_else(||"null".into()),envelope.as_ref().map(Value::to_string).unwrap_or_else(||"null".into()),search,timestamp,timestamp])?;
    }
    db.execute(
        "DELETE FROM entry_ref WHERE conversation_id=? AND entry_seq=?",
        params![args.conversation_id, seq],
    )?;
    if args.kind == "assistant_message"
        && let Some(refs) = p
            .pointer("/metadata/runtime/replyRefs")
            .and_then(Value::as_array)
    {
        for reference in refs {
            let key = match reference["kind"].as_str() {
                Some("message")
                    if reference["sequence"]
                        .as_i64()
                        .is_some_and(|n| n.abs() <= 9_007_199_254_740_991)
                        && reference["id"].is_string() =>
                {
                    reference["sequence"].as_i64().map(|n| n.to_string())
                }
                Some("agent") => reference["threadId"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(String::from),
                _ => None,
            };
            if let Some(key) = key {
                db.execute("INSERT OR IGNORE INTO entry_ref(conversation_id,entry_seq,target_kind,target_key) VALUES(?,?,?,?)",params![args.conversation_id,seq,reference["kind"].as_str(),key])?;
            }
        }
    }
    Ok(ChatEvent {
        id,
        timestamp,
        sequence: seq,
        kind: args.kind,
        device_id: device,
        request_id: request,
        target_device_id: target,
        payload,
        channel_envelope: envelope,
    })
}

impl Store {
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row("SELECT value FROM settings WHERE key=?", [key], |r| {
                r.get::<_, String>(0)
            })
            .optional()?
            .filter(|s| !s.is_empty()))
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        setting(&self.db, key, value)
    }
    pub fn default_conversation(&mut self) -> Result<String> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key=?",
                [DEFAULT_ID],
                |r| r.get(0),
            )
            .optional()?;
        let existing = existing.filter(|s| !s.is_empty());
        let is_new = existing.is_none();
        let id = existing.unwrap_or_else(|| ulid::Ulid::new().to_string());
        if !id.starts_with("local_") {
            ensure_conversation(&tx, &id, now_ms())?;
        }
        if is_new {
            setting(&tx, DEFAULT_ID, &id)?;
        }
        tx.commit()?;
        Ok(id)
    }
    pub fn create_conversation(&mut self) -> Result<String> {
        let id = ulid::Ulid::new().to_string();
        ensure_conversation(&self.db, &id, now_ms())?;
        Ok(id)
    }
    pub fn append_event(&mut self, args: AppendEvent) -> Result<ChatEvent> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let event = append(&tx, args)?;
        tx.commit()?;
        Ok(event)
    }
    pub fn event_count(&self, conversation: &str) -> Result<i64> {
        Ok(self.db.query_row(
            &format!("SELECT COUNT(*) FROM entry WHERE conversation_id=? AND {EVENT_FILTER}"),
            [conversation],
            |r| r.get(0),
        )?)
    }
    pub fn list_events(
        &self,
        conversation: &str,
        limit: i64,
        before: Option<i64>,
    ) -> Result<Vec<ChatEvent>> {
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM (SELECT * FROM entry WHERE conversation_id=? AND {EVENT_FILTER} AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC"
        );
        let mut stmt = self.db.prepare_cached(&sql)?;
        Ok(stmt
            .query_map(
                params![conversation, before, before, limit.clamp(1, 2000)],
                row_event,
            )?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn search_transcript(
        &self,
        query: &str,
        conversation: Option<&str>,
        limit: i64,
    ) -> Result<Value> {
        // Quote tokens rather than accepting FTS operators from the model.
        let query = query
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        if query.is_empty() {
            return Ok(json!([]));
        }
        let mut stmt=self.db.prepare("SELECT entry.conversation_id,entry.id,entry.seq,entry.created_at,entry.role,entry.search_text,bm25(entry_fts) FROM entry_fts JOIN entry ON entry.rowid=entry_fts.rowid WHERE entry_fts MATCH ? AND (? IS NULL OR entry.conversation_id=?) ORDER BY bm25(entry_fts),entry.seq DESC LIMIT ?")?;
        let rows=stmt.query_map(params![query,conversation,conversation,limit.clamp(1,100)],|r|Ok(json!({"conversationId":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"sequence":r.get::<_,i64>(2)?,"timestamp":r.get::<_,i64>(3)?,"role":r.get::<_,String>(4)?,"text":r.get::<_,String>(5)?,"score":r.get::<_,f64>(6)?})))?;
        Ok(Value::Array(rows.collect::<rusqlite::Result<_>>()?))
    }
}
