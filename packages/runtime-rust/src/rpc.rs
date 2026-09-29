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
    pub(crate) store: Option<Store>,
    pub(crate) files: Arc<crate::file_tools::FileTools>,
    pub(crate) shells: Arc<crate::shell::Shells>,
    pub(crate) catalog: Arc<crate::catalog::Catalog>,
    pub(crate) orchestrator_lane: Arc<tokio::sync::Mutex<()>>,
    database_path: Option<PathBuf>,
    pub(crate) run_events: Option<crate::storage::run_events::RunEvents>,
    pub(crate) config: Value,
    pub(crate) host: Option<Peer>,
    delivery_started: bool,
    connections: usize,
    last_activity: i64,
    pub(crate) runs: std::collections::BTreeMap<String, Arc<crate::runs::Run>>,
    pub(crate) notifications: broadcast::Sender<Value>,
}

impl Service {
    pub fn new(database: Option<PathBuf>) -> Result<Self> {
        let store = database.as_deref().map(Store::open).transpose()?;
        let run_events = database
            .as_deref()
            .and_then(|p| p.parent())
            .map(crate::storage::run_events::RunEvents::open)
            .transpose()?;
        Ok(Self {
            run_events,
            files: Arc::new(Default::default()),
            shells: Arc::new(Default::default()),
            catalog: Arc::new(Default::default()),
            orchestrator_lane: Arc::new(tokio::sync::Mutex::new(())),
            store,
            database_path: database,
            config: json!({}),
            host: None,
            runs: Default::default(),
            delivery_started: false,
            connections: 0,
            last_activity: crate::storage::now_ms(),
            notifications: broadcast::channel(1024).0,
        })
    }

    pub fn active_runs(&self) -> Vec<Arc<crate::runs::Run>> {
        self.runs
            .values()
            .filter(|r| r.finished.borrow().is_none())
            .cloned()
            .collect()
    }
    pub fn is_idle(&self, timeout_ms: u64) -> bool {
        timeout_ms > 0
            && self.connections == 0
            && self.active_runs().is_empty()
            && !self.shells.has_active_work()
            && crate::storage::now_ms().saturating_sub(self.last_activity) > timeout_ms as i64
    }
    pub(crate) fn store(&mut self) -> Result<&mut Store> {
        self.store
            .as_mut()
            .context("Runtime storage is not initialized")
    }

    pub fn dispatch(&mut self, method: &str, params: Value) -> Result<Value> {
        let string = |key| params[key].as_str().unwrap_or("");
        match method {
            "internal.worker.getActive" => Ok(self
                .runs
                .values()
                .find(|r| r.finished.borrow().is_none())
                .map(|r| r.snapshot())
                .unwrap_or(Value::Null)),
            "internal.worker.listActiveRuns" => {
                let mut runs = self
                    .runs
                    .values()
                    .filter(|r| r.finished.borrow().is_none())
                    .map(|r| {
                        let mut value = r.snapshot();
                        value["kind"] = json!("active");
                        value
                    })
                    .collect::<Vec<_>>();
                if let Some(log) = self.run_events.as_ref() {
                    for buffered in log.buffered()? {
                        if !runs.iter().any(|r| r["runId"] == buffered["runId"]) {
                            runs.push(json!({"runId":buffered["runId"],"conversationId":buffered["conversationId"],"kind":"buffered"}));
                        }
                    }
                }
                Ok(json!({"runs":runs}))
            }

            "internal.worker.resumeEvents" => self
                .run_events
                .as_mut()
                .context("Run log not initialized")?
                .resume(string("runId"), params["lastSeq"].as_i64().unwrap_or(0)),
            "internal.worker.ackEvents" => {
                let pruned = self
                    .run_events
                    .as_mut()
                    .context("Run log not initialized")?
                    .ack(
                        string("runId"),
                        params["lastSeq"].as_i64().context("lastSeq is required")?,
                    )?;
                Ok(json!({"ok":true,"pruned":pruned}))
            }

            "internal.worker.builtin.recordThreadSummary" => {
                if string("outcome") == "success" && params["sideEffectsAllowed"] == true {
                    self.store()?.record_thread_summary(
                        string("threadId"),
                        string("runId"),
                        string("agentType"),
                        string("finalText"),
                    )?;
                }
                Ok(json!({"ok":true}))
            }
            "internal.worker.builtin.listThreadSummaries" => self
                .store()?
                .list_thread_summaries(params["limit"].as_i64().unwrap_or(20)),
            "internal.worker.builtin.listAgents" => Ok(serde_json::to_value(
                &*stella_runtime_core::builtin::AGENTS,
            )?),
            "internal.worker.builtin.preparePrompt" => {
                let context = serde_json::from_value(params)?;
                Ok(serde_json::to_value(
                    stella_runtime_core::builtin::prepare_prompt(&context),
                )?)
            }
            "internal.worker.readyz" => Ok(json!({"protocolVersion":"v1"})),
            "internal.worker.initialize" => {
                if let Some(version) = params["protocolVersion"].as_str()
                    && version != "v1"
                {
                    bail!("Unsupported protocol version {version}");
                }
                let dir = string("stellaDataDirPath");
                if !dir.is_empty() {
                    let path = PathBuf::from(dir).join("stella.sqlite");
                    if self.database_path.as_ref().is_some_and(|p| p != &path) {
                        bail!("Runtime already owns a different database");
                    }
                    if self.store.is_none() {
                        self.store = Some(Store::open(&path)?);
                        self.run_events = Some(crate::storage::run_events::RunEvents::open(
                            path.parent().context("Missing data directory")?,
                        )?);
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
                "ready":self.store.is_some() && self.host.is_some(),
                "health":{"ready":self.store.is_some() && self.host.is_some()},
                "deviceId":self.config["deviceId"],
                "activeRun":self.active_runs().first().map(|r|r.snapshot()),
                "activeAgentCount":self.active_runs().len(),
                "parityComplete":false,
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

pub async fn shutdown(service: &SharedService) {
    let (runs, shells) = {
        let state = service.lock().unwrap();
        (state.active_runs(), state.shells.clone())
    };
    for run in &runs {
        run.cancel.send_replace(true);
    }
    for run in runs {
        let _ = run.join().await;
    }
    if let Err(error) = shells.kill_all().await {
        eprintln!("Shell shutdown: {error:#}");
    }
}

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

/// One live duplex connection. Callback IDs are strings in a separate namespace
/// from the host's request IDs. No callback response can cross connections.
#[derive(Clone)]
pub struct Peer(Arc<PeerState>);
struct PeerState {
    outgoing: tokio::sync::mpsc::Sender<Value>,
    pending: Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Result<Value>>>>,
    next_id: std::sync::atomic::AtomicU64,
}

struct PendingCall {
    peer: Peer,
    id: String,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.peer.0.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl Peer {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = format!(
            "rust:{}",
            self.0
                .next_id
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let (send, receive) = tokio::sync::oneshot::channel();
        self.0
            .pending
            .lock()
            .map_err(|_| anyhow::anyhow!("Callback state poisoned"))?
            .insert(id.clone(), send);
        let _pending = PendingCall {
            peer: self.clone(),
            id: id.clone(),
        };
        tokio::time::timeout(std::time::Duration::from_secs(120), async {
            self.0
                .outgoing
                .send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .await
                .context("Host disconnected")?;
            receive.await.context("Host disconnected during callback")?
        })
        .await
        .context("Host callback timed out")?
    }

    fn response(&self, message: &Value) -> bool {
        let Some(id) = message["id"].as_str() else {
            return false;
        };
        let Ok(mut pending) = self.0.pending.lock() else {
            return false;
        };
        let Some(sender) = pending.remove(id) else {
            return false;
        };
        let result = if let Some(error) = message.get("error") {
            Err(anyhow::anyhow!(
                "Host callback: {}",
                error["message"].as_str().unwrap_or("Unknown error")
            ))
        } else {
            message
                .get("result")
                .cloned()
                .context("Invalid callback response")
        };
        let _ = sender.send(result);
        true
    }
}

pub async fn dispatch(
    service: SharedService,
    peer: Peer,
    method: String,
    params: Value,
) -> Result<Value> {
    match method.as_str() {
        "internal.worker.configure" => {
            let (result, catalog) = {
                let mut state = service.lock().unwrap();
                (state.dispatch(&method, params)?, state.catalog.clone())
            };
            let weak = Arc::downgrade(&service);
            tokio::spawn(async move {
                if let Some(service) = weak.upgrade() {
                    catalog.list(&service, false).await;
                }
            });
            return Ok(result);
        }
        "internal.worker.listModels" => {
            let catalog = service.lock().unwrap().catalog.clone();
            return Ok(catalog.list(&service, params["forceRefresh"] == true).await);
        }
        "internal.worker.killAllShells" => {
            let shells = service.lock().unwrap().shells.clone();
            return Ok(json!({"ok":true,"killed":shells.kill_all().await?}));
        }
        "internal.worker.killShellByPort" => {
            let port = params["port"]
                .as_u64()
                .filter(|port| (1..=65535).contains(port))
                .context("port must be an integer from 1 to 65535")? as u16;
            let shells = service.lock().unwrap().shells.clone();
            return Ok(json!({"ok":true,"killed":shells.kill_by_port(port).await?}));
        }
        "internal.worker.startChat" | "internal.worker.runAutomation" => {
            let user_message_id = params["userMessageEventId"].clone();
            let run = crate::runs::start(service, params)?;
            return if method.ends_with("runAutomation") {
                run.join().await
            } else {
                Ok(
                    json!({"runId":run.id,"userMessageId":user_message_id.as_str().unwrap_or(&run.user_id)}),
                )
            };
        }
        "internal.worker.cancel" | "internal.worker.cancelByConversation" => {
            let runs = {
                let state = service
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?;
                state
                    .runs
                    .values()
                    .filter(|r| {
                        r.finished.borrow().is_none()
                            && if method.ends_with("cancelByConversation") {
                                params["conversationId"] == r.conversation
                            } else {
                                params["runId"] == r.id
                            }
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            };
            for run in &runs {
                run.cancel.send_replace(true);
            }
            for run in &runs {
                run.join().await?;
            }
            return Ok(json!({"ok":true,"cancelled":!runs.is_empty()}));
        }
        _ => {}
    }
    if method == "internal.worker.initialize" {
        let initialized = service
            .lock()
            .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?
            .dispatch(&method, params)?;
        // The host owns the protected private key. The runtime gets only its
        // public identity and requests scoped signatures on this same channel.
        let identity = peer.request("host.deviceIdentity.get", json!({})).await?;
        let mut state = service
            .lock()
            .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?;
        state.config["deviceId"] = identity["deviceId"].clone();
        state.host = Some(peer);
        if !state.delivery_started {
            state.delivery_started = true;
            crate::cloud_transcript::start_delivery(&service);
        }
        let catalog = state.catalog.clone();
        let weak = Arc::downgrade(&service);
        tokio::spawn(async move {
            if let Some(service) = weak.upgrade() {
                catalog.list(&service, false).await;
            }
        });
        return Ok(initialized);
    }
    tokio::task::spawn_blocking(move || {
        service
            .lock()
            .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?
            .dispatch(&method, params)
    })
    .await?
}

struct ConnectionGuard(SharedService);
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.connections = state.connections.saturating_sub(1);
            state.last_activity = crate::storage::now_ms();
        }
    }
}

pub async fn serve<R, W>(reader: R, mut writer: W, service: SharedService) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let _connection = ConnectionGuard(service.clone());
    {
        let mut state = service
            .lock()
            .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?;
        state.connections += 1;
    }
    let mut notifications = service
        .lock()
        .map_err(|_| anyhow::anyhow!("Runtime state poisoned"))?
        .notifications
        .subscribe();
    let (outgoing, mut incoming) = tokio::sync::mpsc::channel(256);
    let peer = Peer(Arc::new(PeerState {
        outgoing,
        pending: Mutex::new(Default::default()),
        next_id: std::sync::atomic::AtomicU64::new(1),
    }));
    let mut requests = tokio::task::JoinSet::new();
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    let result = async {
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
                    // Stella's v1 transport predates the optional JSON-RPC
                    // version field. Accept both envelopes, reject other versions.
                    if request.get("jsonrpc").is_some_and(|v| v != "2.0") || !request.is_object() {
                        write_message(&mut writer,&error(id.unwrap_or(Value::Null),-32600,"Invalid JSON-RPC request".into())).await?;
                        continue;
                    }
                    if method.is_none() && id.is_some() && (request.get("result").is_some() || request.get("error").is_some()) {
                        peer.response(&request);
                        continue;
                    }
                    let Some(method) = method else {
                        write_message(&mut writer,&error(id.unwrap_or(Value::Null),-32600,"Invalid JSON-RPC request".into())).await?;
                        continue;
                    };
                    if id.as_ref().is_some_and(|id| !id.is_string() && !id.is_number()) {
                        write_message(&mut writer,&error(Value::Null,-32600,"Invalid request id".into())).await?;
                        continue;
                    }
                    if requests.len() >= 128 {
                        if let Some(id)=id { write_message(&mut writer,&error(id,-32800,"Too many concurrent requests".into())).await?; }
                        continue;
                    }
                    let method=method.to_owned();
                    let params=request.get("params").cloned().unwrap_or_else(||json!({}));
                    let cloned=service.clone();
                    let peer=peer.clone();
                    requests.spawn(async move {
                        let result=dispatch(cloned,peer.clone(),method,params).await;
                        if let Some(id)=id {
                            let message=match result {
                                Ok(result)=>json!({"jsonrpc":"2.0","id":id,"result":result}),
                                Err(e)=>{let msg=format!("{e:#}"); error(id,if msg.starts_with("Method not found:") {-32601} else {-32000},msg)}
                            };
                            let _ = peer.0.outgoing.send(message).await;
                        }
                    });
                }
                Some(message)=incoming.recv()=>write_message(&mut writer,&message).await?,
                Some(joined)=requests.join_next(), if !requests.is_empty()=> { joined?; }
                notification=notifications.recv()=> {
                    match notification {
                        Ok(message)=>write_message(&mut writer,&message).await?,
                        Err(broadcast::error::RecvError::Lagged(skipped))=>write_message(&mut writer,&json!({"jsonrpc":"2.0","method":"runtime.lagged","params":{"skipped":skipped}})).await?,
                        Err(broadcast::error::RecvError::Closed)=>return Ok(()),
                    }
                }
            }
        }
    }.await;
    // Drop pending callbacks and connection-owned requests before returning.
    // Admitted agent runs belong to the service and survive a host reconnect.
    peer.0
        .pending
        .lock()
        .map_err(|_| anyhow::anyhow!("Callback state poisoned"))?
        .clear();
    requests.abort_all();
    while requests.join_next().await.is_some() {}
    result
}
