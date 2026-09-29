//! JSON-RPC 2.0 over the existing newline-delimited transport.
use crate::storage::{Store, chat::AppendEvent};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    sync::broadcast,
};

const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;

pub struct Service {
    store: Option<Store>,
    database_path: Option<PathBuf>,
    config: Value,
    notifications: broadcast::Sender<Value>,
}

impl Service {
    pub fn new(database: Option<PathBuf>) -> Result<Self> {
        let store = database.as_deref().map(Store::open).transpose()?;
        Ok(Self {
            store,
            database_path: database,
            config: json!({}),
            notifications: broadcast::channel(1024).0,
        })
    }

    fn store(&mut self) -> Result<&mut Store> {
        self.store
            .as_mut()
            .context("Runtime storage is not initialized")
    }

    pub fn dispatch(&mut self, method: &str, params: Value) -> Result<Value> {
        let string = |key| params[key].as_str().unwrap_or("");
        match method {
            "internal.worker.readyz" => Ok(json!({"protocolVersion":"v1"})),
            "internal.worker.initialize" => {
                if let Some(version) = params["protocolVersion"].as_str() {
                    if version != "v1" {
                        bail!("Unsupported protocol version {version}");
                    }
                }
                let dir = string("stellaDataDirPath");
                if !dir.is_empty() {
                    let path = PathBuf::from(dir).join("stella.sqlite");
                    if self.database_path.as_ref().is_some_and(|p| p != &path) {
                        bail!("Runtime already owns a different database");
                    }
                    if self.store.is_none() {
                        self.store = Some(Store::open(&path)?);
                        self.database_path = Some(path);
                    }
                }
                self.store()?;
                self.config = params;
                self.dispatch("internal.worker.health", Value::Null)
            }
            "internal.worker.configure" => {
                let patch = params
                    .as_object()
                    .context("Configuration must be an object")?;
                self.config
                    .as_object_mut()
                    .context("Invalid runtime configuration")?
                    .extend(patch.clone());
                Ok(json!({"ok":true}))
            }
            "internal.worker.health" => Ok(json!({
                "protocolVersion":"v1", "pid":std::process::id(),
                "ready":false, "reason":"Rust agent execution is not connected yet",
                "storageReady":self.store.is_some(), "implementation":"rust"
            })),
            "internal.worker.storage.diagnostics" => self.store()?.diagnostics(),
            "internal.worker.localChat.getOrCreateDefaultConversationId" => {
                Ok(json!(self.store()?.default_conversation()?))
            }
            "internal.worker.localChat.createConversation" => {
                Ok(json!(self.store()?.create_conversation()?))
            }
            "internal.worker.localChat.appendEvent" => {
                let event: AppendEvent = serde_json::from_value(params.clone())?;
                let stored = self.store()?.append_event(event)?;
                let _=self.notifications.send(json!({"jsonrpc":"2.0","method":"localChat.updated","params":{"conversationId":params["conversationId"],"event":stored}}));
                Ok(json!({"ok":true}))
            }
            "internal.worker.localChat.listEvents" => {
                Ok(serde_json::to_value(self.store()?.list_events(
                    string("conversationId"),
                    params["maxItems"].as_i64().unwrap_or(200),
                    params["beforeSequence"].as_i64(),
                )?)?)
            }
            "internal.worker.localChat.getEventCount" => {
                Ok(json!(self.store()?.event_count(string("conversationId"))?))
            }
            "internal.worker.localChat.search" => self.store()?.search_transcript(
                string("query"),
                params["conversationId"].as_str(),
                params["limit"].as_i64().unwrap_or(20),
            ),
            "internal.worker.settings.get" => Ok(json!(self.store()?.get_setting(string("key"))?)),
            "internal.worker.settings.set" => {
                self.store()?.set_setting(string("key"), string("value"))?;
                Ok(json!({"ok":true}))
            }
            _ => bail!("Method not found: {method}"),
        }
    }
}

pub type SharedService = Arc<Mutex<Service>>;

async fn write_message<W: AsyncWrite + Unpin>(writer: &mut W, message: &Value) -> Result<()> {
    let mut data = serde_json::to_vec(message)?;
    data.push(b'\n');
    writer.write_all(&data).await?;
    writer.flush().await?;
    Ok(())
}

fn error(id: Value, code: i64, message: String) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

pub async fn serve<R, W>(reader: R, mut writer: W, service: SharedService) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut notifications = service
        .lock()
        .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?
        .notifications
        .subscribe();
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        let mut bounded = (&mut reader).take((MAX_FRAME_BYTES + 1 - line.len()) as u64);
        tokio::select! {
            read=bounded.read_until(b'\n',&mut line) => {
                if read?==0 { return Ok(()); }
                if line.len()>MAX_FRAME_BYTES { bail!("RPC frame exceeds 32 MiB"); }
                if line.iter().all(u8::is_ascii_whitespace) { line.clear(); continue; }
                let request=serde_json::from_slice::<Value>(&line);
                line.clear();
                let request=match request { Ok(r)=>r,Err(e)=>{write_message(&mut writer,&error(Value::Null,-32700,e.to_string())).await?; continue;} };
                let id=request.get("id").cloned();
                let method=request["method"].as_str();
                if request["jsonrpc"]!="2.0" || method.is_none() {
                    write_message(&mut writer,&error(id.unwrap_or(Value::Null),-32600,"Invalid JSON-RPC request".into())).await?;
                    continue;
                }
                let method=method.unwrap().to_string();
                let params=request.get("params").cloned().unwrap_or_else(||json!({}));
                let cloned=service.clone();
                let result=tokio::task::spawn_blocking(move || {
                    cloned.lock().map_err(|_|anyhow::anyhow!("Runtime state poisoned"))?.dispatch(&method,params)
                }).await?;
                if let Some(id)=id {
                    let message=match result {
                        Ok(result)=>json!({"jsonrpc":"2.0","id":id,"result":result}),
                        Err(e)=>{let msg=format!("{e:#}"); error(id,if msg.starts_with("Method not found:") {-32601} else {-32000},msg)}
                    };
                    write_message(&mut writer,&message).await?;
                }
            }
            notification=notifications.recv()=> {
                match notification {
                    Ok(message)=>write_message(&mut writer,&message).await?,
                    Err(broadcast::error::RecvError::Lagged(skipped))=>write_message(&mut writer,&json!({"jsonrpc":"2.0","method":"runtime.lagged","params":{"skipped":skipped}})).await?,
                    Err(broadcast::error::RecvError::Closed)=>return Ok(()),
                }
            }
        }
    }
}
