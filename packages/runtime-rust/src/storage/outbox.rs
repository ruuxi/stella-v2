use super::{Store, now_ms};
use anyhow::{Context, Result, bail};
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
impl Store {
    pub fn put_transcript(
        &mut self,
        conversation: &str,
        kind: &str,
        payload: &Value,
        recovery: Option<&Value>,
    ) -> Result<String> {
        let device = payload["deviceId"].as_str().context("Missing deviceId")?;
        let generation = payload["expectedOwnerGeneration"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("Missing owner generation")?;
        let turn = payload["localTurnId"].as_str().context("Missing turn id")?;
        let id = format!(
            "cloud-transcript:{}",
            serde_json::to_string(&json!([kind, device, conversation, turn]))?
        );
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let serialized = serde_json::to_string(payload)?;
        if let Some(old) = tx
            .query_row(
                "SELECT payload_json FROM cloud_transcript_outbox WHERE id=?",
                [&id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            && serde_json::from_str::<Value>(&old)? != *payload
        {
            bail!("Cloud turn identity was reused with a different payload");
        }
        tx.execute("INSERT OR IGNORE INTO cloud_transcript_outbox(id,kind,conversation_id,device_id,owner_generation,local_turn_id,payload_json,recovery_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![id,kind,conversation,device,generation,turn,serialized,recovery.map(serde_json::to_string).transpose()?,now_ms(),now_ms()])?;
        if kind == "finish" {
            tx.execute("DELETE FROM cloud_transcript_outbox WHERE kind='begin' AND conversation_id=? AND device_id=? AND local_turn_id=?",params![conversation,device,turn])?;
        }
        tx.commit()?;
        Ok(id)
    }
    pub fn transcript_outbox(&self) -> Result<Vec<Value>> {
        let mut query=self.db.prepare("SELECT id,kind,conversation_id,payload_json,recovery_json,attempts,updated_at FROM cloud_transcript_outbox WHERE dead_lettered_at IS NULL ORDER BY created_at,id")?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|(id,kind,conversation,payload,recovery,attempts,updated)|Ok(json!({"id":id,"kind":kind,"conversationId":conversation,"payload":serde_json::from_str::<Value>(&payload)?,"recovery":recovery.map(|v|serde_json::from_str::<Value>(&v)).transpose()?,"attempts":attempts,"updatedAt":updated}))).collect()
    }
    pub fn transcript_attempt(&self, id: &str, error: Option<&str>, dead: bool) -> Result<()> {
        self.db.execute("UPDATE cloud_transcript_outbox SET attempts=attempts+1,updated_at=?,last_error=?,dead_lettered_at=CASE WHEN ? THEN ? ELSE dead_lettered_at END WHERE id=?",params![now_ms(),error,dead,now_ms(),id])?;
        Ok(())
    }
    pub fn transcript_delete(&self, id: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM cloud_transcript_outbox WHERE id=?", [id])?;
        Ok(())
    }
}
