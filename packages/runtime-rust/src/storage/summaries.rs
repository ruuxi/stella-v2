use super::{Store, now_ms};
use anyhow::Result;
use rusqlite::params;
use serde_json::{Value, json};

impl Store {
    pub fn record_thread_summary(
        &self,
        thread: &str,
        run: &str,
        agent: &str,
        text: &str,
    ) -> Result<()> {
        let content = stella_runtime_core::redaction::memory(text.trim());
        if thread.is_empty() || run.is_empty() || content.is_empty() {
            return Ok(());
        }
        if !stella_runtime_core::builtin::agent(agent).is_some_and(|a| a.records_thread_summary) {
            return Ok(());
        }
        self.db.execute("INSERT INTO durable_thread_summaries(source_key,thread_id,run_id,agent_type,content,source_updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET thread_id=excluded.thread_id,run_id=excluded.run_id,agent_type=excluded.agent_type,content=excluded.content,source_updated_at=excluded.source_updated_at",params![format!("{thread}:{run}"),thread,run,agent,content,now_ms()])?;
        Ok(())
    }

    pub fn list_thread_summaries(&self, limit: i64) -> Result<Value> {
        let mut stmt=self.db.prepare_cached("SELECT id,source_key,thread_id,run_id,agent_type,content,source_updated_at FROM durable_thread_summaries ORDER BY source_updated_at DESC LIMIT ?")?;
        let rows=stmt.query_map([limit.clamp(1,200)],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"sourceKey":r.get::<_,String>(1)?,"threadId":r.get::<_,String>(2)?,"runId":r.get::<_,String>(3)?,"agentType":r.get::<_,String>(4)?,"content":r.get::<_,String>(5)?,"sourceUpdatedAt":r.get::<_,i64>(6)?})))?;
        Ok(json!(rows.collect::<rusqlite::Result<Vec<_>>>()?))
    }

    pub fn sweep_thread_summaries(&self) -> Result<usize> {
        Ok(self.db.execute("DELETE FROM durable_thread_summaries WHERE id IN (SELECT id FROM durable_thread_summaries WHERE source_updated_at<? OR id IN (SELECT id FROM durable_thread_summaries ORDER BY source_updated_at DESC,id DESC LIMIT -1 OFFSET 5000) ORDER BY source_updated_at ASC,id ASC LIMIT 500)",[now_ms()-90*24*60*60*1000])?)
    }
}
