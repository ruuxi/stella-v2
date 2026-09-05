use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::types::{CdpCommand, CdpEvent, CdpMessage};

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<CdpMessage>>>>;
const CDP_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Raw incoming CDP message (text) broadcast to all subscribers.
/// Used by the inspect proxy to forward responses and events to DevTools.
#[derive(Debug, Clone)]
pub struct RawCdpMessage {
    pub text: String,
    pub session_id: Option<String>,
}

pub struct CdpClient {
    ws_tx: Arc<
        Mutex<
            futures_util::stream::SplitSink<
                tokio_tungstenite::WebSocketStream<
                    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
                >,
                Message,
            >,
        >,
    >,
    next_id: AtomicU64,
    pending: PendingMap,
    event_tx: broadcast::Sender<CdpEvent>,
    raw_tx: broadcast::Sender<RawCdpMessage>,
    _reader_handle: tokio::task::JoinHandle<()>,
    /// Flattened child-frame sessions by (parent session, frame id). Entries
    /// are pruned when Chromium reports the child or parent session detached.
    frame_sessions: Arc<Mutex<HashMap<(String, String), String>>>,
}

impl CdpClient {
    pub async fn connect(url: &str) -> Result<Self, String> {
        // Use unlimited message/frame sizes to handle large CDP responses
        // (e.g. Accessibility.getFullAXTree) over remote WSS connections where
        // proxies may produce frames exceeding the default 16 MiB limit.
        let ws_config = WebSocketConfig {
            max_message_size: None,
            max_frame_size: None,
            ..Default::default()
        };

        let (ws_stream, _) =
            tokio_tungstenite::connect_async_with_config(url, Some(ws_config), false)
                .await
                .map_err(|e| format!("CDP WebSocket connect failed: {}", e))?;

        let (ws_tx, mut ws_rx) = ws_stream.split();
        let ws_tx = Arc::new(Mutex::new(ws_tx));

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, _) = broadcast::channel(256);
        let (raw_tx, _) = broadcast::channel(512);

        let frame_sessions: Arc<Mutex<HashMap<(String, String), String>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let pending_clone = pending.clone();
        let event_tx_clone = event_tx.clone();
        let raw_tx_clone = raw_tx.clone();
        let frame_sessions_clone = frame_sessions.clone();

        let reader_handle = tokio::spawn(async move {
            while let Some(msg) = ws_rx.next().await {
                // Accept both Text and Binary frames — remote CDP proxies
                // (e.g. Browserless) may send responses as Binary frames.
                let msg = match msg {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Binary(data)) => match String::from_utf8(data) {
                        Ok(text) => text,
                        Err(_) => continue,
                    },
                    Ok(Message::Close(_)) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                };

                // Broadcast raw message for inspect proxy subscribers before typed parse,
                // so messages with negative IDs (used by the inspect proxy) are still delivered.
                if raw_tx_clone.receiver_count() > 0 {
                    let session_id = serde_json::from_str::<serde_json::Value>(&msg)
                        .ok()
                        .and_then(|v| v.get("sessionId")?.as_str().map(String::from));
                    let _ = raw_tx_clone.send(RawCdpMessage {
                        text: msg.clone(),
                        session_id,
                    });
                }

                let parsed: CdpMessage = match serde_json::from_str(&msg) {
                    Ok(m) => m,
                    // Expected for inspect proxy messages with negative IDs
                    // (CdpMessage.id is u64); handled via raw broadcast above.
                    Err(_) => continue,
                };

                if let Some(id) = parsed.id {
                    // Response to a command
                    let mut pending = pending_clone.lock().await;
                    if let Some(tx) = pending.remove(&id) {
                        let _ = tx.send(parsed);
                    }
                } else if let Some(ref method) = parsed.method {
                    // Event
                    if method == "Target.detachedFromTarget" {
                        if let Some(detached) = parsed
                            .params
                            .as_ref()
                            .and_then(|params| params.get("sessionId"))
                            .and_then(Value::as_str)
                        {
                            frame_sessions_clone
                                .lock()
                                .await
                                .retain(|(parent, _), child| {
                                    parent != detached && child != detached
                                });
                        }
                    }
                    let event = CdpEvent {
                        method: method.clone(),
                        params: parsed.params.clone().unwrap_or(Value::Null),
                        session_id: parsed.session_id.clone(),
                    };
                    let _ = event_tx_clone.send(event);
                }
            }

            // Reader loop exited (connection closed or error). Drop all pending
            // command senders so callers get an immediate channel-closed error
            // instead of waiting for the 30-second timeout.
            pending_clone.lock().await.clear();
        });

        Ok(Self {
            ws_tx,
            next_id: AtomicU64::new(1),
            pending,
            event_tx,
            raw_tx,
            _reader_handle: reader_handle,
            frame_sessions,
        })
    }

    pub async fn send_command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);

        let cmd = CdpCommand {
            id,
            method: method.to_string(),
            params,
            session_id: session_id.map(|s| s.to_string()),
        };

        let json = serde_json::to_string(&cmd)
            .map_err(|e| format!("Failed to serialize CDP command: {}", e))?;

        let (tx, rx) = oneshot::channel();

        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }

        // Bound the whole transport operation, including waiting for the sink
        // lock and flushing the WebSocket frame. The previous timeout started
        // only after `send()` returned, so a backpressured/dead adapter could
        // hold the daemon-wide browser state lock forever.
        let operation = async {
            {
                let mut ws_tx = self.ws_tx.lock().await;
                ws_tx
                    .send(Message::Text(json))
                    .await
                    .map_err(|e| format!("Failed to send CDP command: {}", e))?;
            }
            rx.await
                .map_err(|_| "CDP response channel closed".to_string())
        };
        let response = match tokio::time::timeout(CDP_COMMAND_TIMEOUT, operation).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(error)) => {
                self.pending.lock().await.remove(&id);
                return Err(error);
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                return Err(format!("CDP command timed out: {}", method));
            }
        };

        if let Some(error) = response.error {
            return Err(format!("CDP error ({}): {}", method, error));
        }

        Ok(response.result.unwrap_or(Value::Null))
    }

    pub async fn attach_frame(
        &self,
        parent_session: &str,
        frame_id: &str,
    ) -> Result<String, String> {
        let key = (parent_session.to_string(), frame_id.to_string());
        let previous = self.frame_sessions.lock().await.get(&key).cloned();
        if let Some(previous) = previous {
            if self
                .send_command_no_params("Page.getFrameTree", Some(&previous))
                .await
                .is_ok()
            {
                return Ok(previous);
            }
            self.frame_sessions.lock().await.remove(&key);
        }
        let attached = self
            .send_command(
                "Target.attachToTarget",
                Some(serde_json::json!({"targetId": frame_id,"flatten":true})),
                Some(parent_session),
            )
            .await?;
        let session = attached
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or("Missing child frame session")?
            .to_string();
        self.frame_sessions
            .lock()
            .await
            .insert(key, session.clone());
        Ok(session)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.event_tx.subscribe()
    }

    /// Subscribe to all raw incoming CDP messages (responses + events).
    /// Used by the inspect proxy to forward traffic to the DevTools frontend.
    pub fn subscribe_raw(&self) -> broadcast::Receiver<RawCdpMessage> {
        self.raw_tx.subscribe()
    }

    /// Create a lightweight handle for the inspect WebSocket proxy.
    /// Contains only what's needed to forward messages bidirectionally.
    pub fn inspect_handle(&self) -> InspectProxyHandle {
        InspectProxyHandle {
            ws_tx: self.ws_tx.clone(),
            raw_tx: self.raw_tx.clone(),
        }
    }

    pub async fn send_command_typed<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: &P,
        session_id: Option<&str>,
    ) -> Result<R, String> {
        let params_value = serde_json::to_value(params)
            .map_err(|e| format!("Failed to serialize params: {}", e))?;
        let result = self
            .send_command(method, Some(params_value), session_id)
            .await?;
        serde_json::from_value(result)
            .map_err(|e| format!("Failed to deserialize CDP response for {}: {}", method, e))
    }

    pub async fn send_command_no_params(
        &self,
        method: &str,
        session_id: Option<&str>,
    ) -> Result<Value, String> {
        self.send_command(method, None, session_id).await
    }

    /// Send raw JSON through the WebSocket without tracking a response.
    /// Used by the inspect proxy to forward DevTools frontend messages.
    pub async fn send_raw(&self, json: String) -> Result<(), String> {
        let mut ws_tx = self.ws_tx.lock().await;
        ws_tx
            .send(Message::Text(json))
            .await
            .map_err(|e| format!("Failed to send raw CDP message: {}", e))
    }
}

type WsTx = Arc<
    Mutex<
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
    >,
>;

/// Lightweight handle for the inspect WebSocket proxy, holding only
/// the cloneable parts of CdpClient needed for bidirectional message forwarding.
pub struct InspectProxyHandle {
    ws_tx: WsTx,
    raw_tx: broadcast::Sender<RawCdpMessage>,
}

impl InspectProxyHandle {
    pub async fn send_raw(&self, json: String) -> Result<(), String> {
        let mut ws_tx = self.ws_tx.lock().await;
        ws_tx
            .send(Message::Text(json))
            .await
            .map_err(|e| format!("Failed to send raw CDP message: {}", e))
    }

    pub fn subscribe_raw(&self) -> broadcast::Receiver<RawCdpMessage> {
        self.raw_tx.subscribe()
    }
}
