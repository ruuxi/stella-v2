use serde::Deserialize;
use serde_json::{Value, json};
use stella_runtime_core::builtin::{AGENTS, PromptContext, prepare_prompt};
use worker::*;

fn main() {}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _context: Context) -> Result<Response> {
    if req.path() == "/health" {
        return Response::from_json(
            &json!({"implementation":"rust","target":"wasm32-unknown-emscripten","protocolVersion":"v1","agentExecutionReady":false}),
        );
    }
    let secret = env.secret("RUNTIME_VERIFY_TOKEN")?;
    if req.headers().get("Authorization")?.as_deref() != Some(&format!("Bearer {secret}")) {
        return Response::error("Unauthorized", 401);
    }
    if req.path() == "/agents" && req.method() == Method::Get {
        return Response::from_json(&*AGENTS);
    }
    if req.path() == "/prepare" && req.method() == Method::Post {
        let thread = req.headers().get("x-stella-thread")?.unwrap_or_default();
        if thread.is_empty() || thread.len() > 256 {
            return Response::error("x-stella-thread is required (at most 256 bytes)", 400);
        }
        let namespace = env.durable_object("SESSIONS")?;
        return namespace
            .id_from_name(&thread)?
            .get_stub()?
            .fetch_with_request(req)
            .await;
    }
    Response::error("Not found", 404)
}

#[durable_object]
pub struct RuntimeSession {
    state: State,
}

impl DurableObject for RuntimeSession {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        if req.method() != Method::Post || req.path() != "/prepare" {
            return Response::error("Not found", 404);
        }
        let mut context: PromptContext = req.json().await?;
        let sql = self.state.storage().sql();
        sql.exec("CREATE TABLE IF NOT EXISTS reminder_window(key TEXT PRIMARY KEY,shown_at INTEGER NOT NULL)",None)?;
        #[derive(Deserialize)]
        struct ReminderRow {
            key: String,
            shown_at: i64,
        }
        let rows = sql
            .exec("SELECT key,shown_at FROM reminder_window", None)?
            .to_array::<ReminderRow>()?;
        context.shown_reminders = rows
            .into_iter()
            .map(|row| (row.key, row.shown_at))
            .collect();
        let prepared = prepare_prompt(&context);
        let at = Date::now().as_millis() as i64;
        // All SQL is synchronous in one event turn; there is no await between
        // reading the gate and persisting it, so concurrent calls cannot repeat it.
        for key in &prepared.reminder_keys {
            sql.exec("INSERT INTO reminder_window(key,shown_at) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET shown_at=excluded.shown_at",vec![key.as_str().into(),at.into()])?;
        }
        sql.exec("DELETE FROM reminder_window WHERE key IN (SELECT key FROM reminder_window ORDER BY shown_at DESC,key LIMIT -1 OFFSET 500)",None)?;
        // Exercise the Workers-hosted Tokio timer used by agent retries and
        // cancellation, rather than a blocking Emscripten sleep.
        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        let value: Value = serde_json::to_value(prepared)?;
        Response::from_json(&value)
    }
}
