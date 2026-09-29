use super::{Store, now_ms};
use anyhow::{Result, bail};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};

impl Store {
    pub fn resolve_thread(
        &mut self,
        conversation: &str,
        agent_type: &str,
        requested: Option<&str>,
        name: &str,
    ) -> Result<(String, bool)> {
        if conversation.trim().is_empty() || agent_type.trim().is_empty() {
            bail!("conversationId and agentType are required");
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let id = requested
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}-{}", agent_type, ulid::Ulid::new()));
        let existing = tx
            .query_row(
                "SELECT conversation_id,agent_type FROM thread WHERE id=?",
                [&id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let reused = existing.is_some();
        if let Some((owner, kind)) = existing {
            if owner != conversation || kind != agent_type {
                bail!("Thread belongs to a different conversation or agent type");
            }
            tx.execute(
                "UPDATE thread SET status='active',last_used_at=? WHERE id=?",
                params![now_ms(), id],
            )?;
        } else {
            tx.execute("INSERT OR IGNORE INTO conversation(id,kind,created_at,updated_at) VALUES(?,'chat',?,?)",params![conversation,now_ms(),now_ms()])?;
            tx.execute("INSERT INTO thread(id,conversation_id,agent_type,name,status,search_text,created_at,last_used_at) VALUES(?,?,?,?,'active',?,?,?)",params![id,conversation,agent_type,name,format!("{id} {name}"),now_ms(),now_ms()])?;
        }
        tx.commit()?;
        Ok((id, reused))
    }

    /// Exact native messages use the legacy {message: ...} payload wrapper.
    /// Large messages remain exact in the blob table instead of being truncated.
    pub fn append_thread_message(&mut self, thread: &str, message: &Value) -> Result<String> {
        self.append_session_entry(
            thread,
            "message",
            &json!({"message":message}),
            message["timestamp"].as_i64().unwrap_or_else(now_ms),
        )
    }

    pub fn thread_last_sequence(&self, thread: &str) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT next_seq-1 FROM thread WHERE id=?", [thread], |r| {
                r.get(0)
            })?)
    }
    pub fn raw_thread_messages(&self, thread: &str) -> Result<Vec<Value>> {
        self.thread_messages_after(thread, 0)
    }
    pub fn thread_messages_after(&self, thread: &str, after: i64) -> Result<Vec<Value>> {
        let mut query=self.db.prepare("SELECT COALESCE(b.content,e.payload) FROM thread_entry e LEFT JOIN blob b ON b.id=e.blob_id WHERE e.thread_id=? AND e.seq>? AND e.type='message' ORDER BY e.seq")?;
        let rows = query
            .query_map(params![thread, after], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|s| Ok(serde_json::from_str::<Value>(&s)?["message"].clone()))
            .collect()
    }
}
