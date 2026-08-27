use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::env;
use std::fs;
use std::future::Future;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Write;
use std::path::PathBuf;
use std::process;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::signal;
use tokio::sync::{broadcast, mpsc, oneshot, RwLock};

use super::actions::{execute_command, teardown_daemon_state, DaemonState};
use super::cdp::client::CdpClient;
use super::state;
use super::stream::StreamServer;

const MAX_REPLAY_KEY_BYTES: usize = 512;
const MAX_IN_FLIGHT_REQUESTS: usize = 256;
const MAX_REPLAY_WAITERS_PER_REQUEST: usize = 64;
const MAX_COMPLETED_REQUESTS: usize = 1024;
const MAX_CAPABILITY_BYTES: usize = 512;
const DEFAULT_DAEMON_COMMAND_TIMEOUT_MS: u64 = 32_000;
const DAEMON_COMMAND_TIMEOUT_GRACE_MS: u64 = 3_000;
const MAX_DAEMON_COMMAND_TIMEOUT_MS: u64 = 10 * 60_000 + DAEMON_COMMAND_TIMEOUT_GRACE_MS;

#[derive(Clone, Default)]
struct DaemonAccessPolicy {
    control_token: Option<String>,
    owner_id: Option<String>,
    turn_id: Option<String>,
    owner_lease_id: Option<String>,
    owner_lease_issued_at: Option<u64>,
    capability_expires_at_ms: Option<u64>,
    extension_delegations: Arc<StdMutex<HashMap<String, ExtensionDelegation>>>,
}

#[derive(Clone)]
struct ExtensionDelegation {
    owner_id: String,
    turn_id: String,
    owner_lease_id: String,
    owner_lease_issued_at: u64,
    expires_at_ms: u64,
}

impl DaemonAccessPolicy {
    fn from_env() -> Result<Self, String> {
        let control_token = non_empty_env("STELLA_BROWSER_CONTROL_TOKEN");
        let owner_id = non_empty_env("STELLA_BROWSER_REQUIRED_OWNER_ID");
        let turn_id = non_empty_env("STELLA_BROWSER_REQUIRED_TURN_ID");
        let owner_lease_id = non_empty_env("STELLA_BROWSER_REQUIRED_OWNER_LEASE_ID");
        let owner_lease_issued_at = non_empty_env("STELLA_BROWSER_REQUIRED_OWNER_LEASE_ISSUED_AT")
            .map(|value| {
                value.parse::<u64>().map_err(|_| {
                    "STELLA_BROWSER_REQUIRED_OWNER_LEASE_ISSUED_AT must be an unsigned integer"
                        .to_string()
                })
            })
            .transpose()?;
        let capability_expires_at_ms = non_empty_env("STELLA_BROWSER_CAPABILITY_EXPIRES_AT_MS")
            .map(|value| {
                value.parse::<u64>().map_err(|_| {
                    "STELLA_BROWSER_CAPABILITY_EXPIRES_AT_MS must be an unsigned integer"
                        .to_string()
                })
            })
            .transpose()?;
        let owner_fields = [
            owner_id.is_some(),
            turn_id.is_some(),
            owner_lease_id.is_some(),
            owner_lease_issued_at.is_some(),
            capability_expires_at_ms.is_some(),
        ];
        if owner_fields.iter().any(|present| *present)
            && (!owner_fields.iter().all(|present| *present) || control_token.is_none())
        {
            return Err(
                "Protected browser daemon requires a control token and a complete owner capability"
                    .to_string(),
            );
        }
        for (name, value) in [
            ("control token", control_token.as_deref()),
            ("owner id", owner_id.as_deref()),
            ("turn id", turn_id.as_deref()),
            ("owner lease id", owner_lease_id.as_deref()),
        ] {
            if value.is_some_and(|value| value.len() > MAX_CAPABILITY_BYTES) {
                return Err(format!("Browser daemon {name} is too long"));
            }
        }
        Ok(Self {
            control_token,
            owner_id,
            turn_id,
            owner_lease_id,
            owner_lease_issued_at,
            capability_expires_at_ms,
            extension_delegations: Arc::new(StdMutex::new(HashMap::new())),
        })
    }

    fn is_protected(&self) -> bool {
        self.control_token.is_some()
    }

    fn authorize(&self, command: &Value) -> Result<(), Value> {
        if !self.is_protected() {
            return Ok(());
        }
        let request_id = command.get("id").and_then(Value::as_str).unwrap_or("");
        if command.get("controlToken").and_then(Value::as_str) == self.control_token.as_deref() {
            return Ok(());
        }
        if let Some(token) = command
            .get("extensionDelegateToken")
            .and_then(Value::as_str)
        {
            return self.authorize_extension_delegation(command, request_id, token);
        }
        let capability_matches = command.get("ownerId").and_then(Value::as_str)
            == self.owner_id.as_deref()
            && command.get("sessionId").and_then(Value::as_str) == self.owner_id.as_deref()
            && command.get("turnId").and_then(Value::as_str) == self.turn_id.as_deref()
            && command.get("ownerLeaseId").and_then(Value::as_str)
                == self.owner_lease_id.as_deref()
            && command.get("ownerLeaseIssuedAt").and_then(Value::as_u64)
                == self.owner_lease_issued_at;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let is_expired = self
            .capability_expires_at_ms
            .is_some_and(|expires_at| now_ms >= expires_at);
        if capability_matches && !is_expired {
            return Ok(());
        }
        Err(serde_json::json!({
            "id": request_id,
            "success": false,
            "error": if is_expired {
                "Browser session capability expired; initialize the in-app browser session again"
            } else {
                "Browser daemon rejected a request outside its authorized session"
            },
        }))
    }

    fn authorize_extension_delegation(
        &self,
        command: &Value,
        request_id: &str,
        token: &str,
    ) -> Result<(), Value> {
        let now_ms = current_time_ms();
        let delegation = self
            .extension_delegations
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(token)
            .cloned();
        let matches = delegation.as_ref().is_some_and(|delegation| {
            command.get("browserBackend").and_then(Value::as_str) == Some("extension")
                && command.get("ownerId").and_then(Value::as_str)
                    == Some(delegation.owner_id.as_str())
                && command.get("sessionId").and_then(Value::as_str)
                    == Some(delegation.owner_id.as_str())
                && command.get("turnId").and_then(Value::as_str)
                    == Some(delegation.turn_id.as_str())
                && command.get("ownerLeaseId").and_then(Value::as_str)
                    == Some(delegation.owner_lease_id.as_str())
                && command.get("ownerLeaseIssuedAt").and_then(Value::as_u64)
                    == Some(delegation.owner_lease_issued_at)
                && now_ms < delegation.expires_at_ms
        });
        if matches {
            return Ok(());
        }
        if delegation.is_some_and(|delegation| now_ms >= delegation.expires_at_ms) {
            self.extension_delegations
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(token);
        }
        Err(serde_json::json!({
            "id": request_id,
            "success": false,
            "error": "Browser extension delegation expired, was revoked, or does not match this owner session; initialize the browser session again",
        }))
    }

    fn handle_extension_delegation_command(&self, command: &Value) -> Option<Value> {
        let action = command.get("action").and_then(Value::as_str)?;
        if action != "extension_delegate_register" && action != "extension_delegate_revoke" {
            return None;
        }
        let id = command.get("id").and_then(Value::as_str).unwrap_or("");
        if command.get("controlToken").and_then(Value::as_str) != self.control_token.as_deref() {
            return Some(serde_json::json!({
                "id": id,
                "success": false,
                "error": "Only the desktop bridge owner may manage extension delegations",
            }));
        }
        let token = match bounded_command_string(command, "extensionDelegateToken") {
            Ok(value) => value,
            Err(error) => {
                return Some(serde_json::json!({
                    "id": id,
                    "success": false,
                    "error": error,
                }))
            }
        };
        let mut delegations = self
            .extension_delegations
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if action == "extension_delegate_revoke" {
            let revoked = delegations.remove(&token).is_some();
            return Some(serde_json::json!({
                "id": id,
                "success": true,
                "data": { "revoked": revoked },
            }));
        }
        let owner_id = match bounded_command_string(command, "ownerId") {
            Ok(value) => value,
            Err(error) => return Some(delegation_error(id, &error)),
        };
        let session_id = match bounded_command_string(command, "sessionId") {
            Ok(value) => value,
            Err(error) => return Some(delegation_error(id, &error)),
        };
        let turn_id = match bounded_command_string(command, "turnId") {
            Ok(value) => value,
            Err(error) => return Some(delegation_error(id, &error)),
        };
        let owner_lease_id = match bounded_command_string(command, "ownerLeaseId") {
            Ok(value) => value,
            Err(error) => return Some(delegation_error(id, &error)),
        };
        let owner_lease_issued_at = command
            .get("ownerLeaseIssuedAt")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0);
        let expires_at_ms = command
            .get("capabilityExpiresAt")
            .and_then(Value::as_u64)
            .filter(|value| *value > current_time_ms());
        if owner_id != session_id || owner_lease_issued_at.is_none() || expires_at_ms.is_none() {
            return Some(delegation_error(
                id,
                "Extension delegation requires a matching owner/session and valid lease/expiry",
            ));
        }
        delegations.insert(
            token,
            ExtensionDelegation {
                owner_id,
                turn_id,
                owner_lease_id,
                owner_lease_issued_at: owner_lease_issued_at.unwrap(),
                expires_at_ms: expires_at_ms.unwrap(),
            },
        );
        Some(serde_json::json!({
            "id": id,
            "success": true,
            "data": { "registered": true },
        }))
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn bounded_command_string(command: &Value, name: &str) -> Result<String, String> {
    command
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_CAPABILITY_BYTES)
        .map(String::from)
        .ok_or_else(|| format!("{name} must be a bounded non-empty string"))
}

fn delegation_error(id: &str, error: &str) -> Value {
    serde_json::json!({ "id": id, "success": false, "error": error })
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct ReplayKey {
    owner_id: String,
    request_id: String,
}

enum ReplayEntry {
    InFlight {
        fingerprint: u64,
        waiters: Vec<oneshot::Sender<Value>>,
    },
    Completed {
        fingerprint: u64,
        response: Value,
    },
}

#[derive(Default)]
struct ReplayState {
    entries: HashMap<ReplayKey, ReplayEntry>,
    completed_order: VecDeque<ReplayKey>,
    in_flight: usize,
}

#[derive(Default)]
struct RequestReplayCache {
    state: StdMutex<ReplayState>,
}

enum ReplayDecision {
    Execute,
    Wait(oneshot::Receiver<Value>),
    Return(Value),
}

struct InFlightRequestGuard {
    cache: Arc<RequestReplayCache>,
    key: Option<ReplayKey>,
}

impl Drop for InFlightRequestGuard {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.cache.cancel(&key);
        }
    }
}

impl RequestReplayCache {
    async fn execute_once<F, Fut>(
        self: &Arc<Self>,
        key: ReplayKey,
        fingerprint: u64,
        operation: F,
    ) -> Value
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Value>,
    {
        let mut operation = Some(operation);
        loop {
            let decision = {
                let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
                if let Some(entry) = state.entries.get_mut(&key) {
                    match entry {
                        ReplayEntry::Completed {
                            fingerprint: existing,
                            response,
                        } => {
                            if *existing != fingerprint {
                                ReplayDecision::Return(replay_fingerprint_error(&key))
                            } else {
                                ReplayDecision::Return(response.clone())
                            }
                        }
                        ReplayEntry::InFlight {
                            fingerprint: existing,
                            waiters,
                        } => {
                            if *existing != fingerprint {
                                ReplayDecision::Return(replay_fingerprint_error(&key))
                            } else if waiters.len() >= MAX_REPLAY_WAITERS_PER_REQUEST {
                                ReplayDecision::Return(serde_json::json!({
                                    "id": key.request_id,
                                    "success": false,
                                    "error": "Browser daemon request has too many replay waiters",
                                }))
                            } else {
                                let (tx, rx) = oneshot::channel();
                                waiters.push(tx);
                                ReplayDecision::Wait(rx)
                            }
                        }
                    }
                } else if state.in_flight >= MAX_IN_FLIGHT_REQUESTS {
                    ReplayDecision::Return(serde_json::json!({
                        "id": key.request_id,
                        "success": false,
                        "error": "Browser daemon has too many in-flight requests",
                    }))
                } else {
                    state.entries.insert(
                        key.clone(),
                        ReplayEntry::InFlight {
                            fingerprint,
                            waiters: Vec::new(),
                        },
                    );
                    state.in_flight += 1;
                    ReplayDecision::Execute
                }
            };

            match decision {
                ReplayDecision::Return(response) => return response,
                ReplayDecision::Wait(receiver) => match receiver.await {
                    Ok(response) => return response,
                    Err(_) => continue,
                },
                ReplayDecision::Execute => {
                    let mut guard = InFlightRequestGuard {
                        cache: self.clone(),
                        key: Some(key.clone()),
                    };
                    let response = operation
                        .take()
                        .expect("replay operation must execute at most once")(
                    )
                    .await;
                    self.complete(&key, fingerprint, response.clone());
                    guard.key = None;
                    return response;
                }
            }
        }
    }

    fn complete(&self, key: &ReplayKey, fingerprint: u64, response: Value) {
        let waiters = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            let waiters = match state.entries.insert(
                key.clone(),
                ReplayEntry::Completed {
                    fingerprint,
                    response: response.clone(),
                },
            ) {
                Some(ReplayEntry::InFlight { waiters, .. }) => waiters,
                _ => Vec::new(),
            };
            state.in_flight = state.in_flight.saturating_sub(1);
            state.completed_order.push_back(key.clone());
            while state.completed_order.len() > MAX_COMPLETED_REQUESTS {
                if let Some(expired) = state.completed_order.pop_front() {
                    if matches!(
                        state.entries.get(&expired),
                        Some(ReplayEntry::Completed { .. })
                    ) {
                        state.entries.remove(&expired);
                    }
                }
            }
            waiters
        };
        for waiter in waiters {
            let _ = waiter.send(response.clone());
        }
    }

    fn cancel(&self, key: &ReplayKey) {
        let waiters = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            match state.entries.remove(key) {
                Some(ReplayEntry::InFlight { waiters, .. }) => {
                    state.in_flight = state.in_flight.saturating_sub(1);
                    waiters
                }
                _ => Vec::new(),
            }
        };
        drop(waiters);
    }
}

fn replay_fingerprint_error(key: &ReplayKey) -> Value {
    serde_json::json!({
        "id": key.request_id,
        "success": false,
        "error": "Browser daemon request id was reused with different command content",
    })
}

fn replay_key(cmd: &Value) -> Result<Option<(ReplayKey, u64)>, Value> {
    let Some(owner_value) = cmd.get("ownerId") else {
        return Ok(None);
    };
    let request_id = cmd.get("id").and_then(Value::as_str).unwrap_or("");
    let owner_id = owner_value.as_str().unwrap_or("");
    if request_id.is_empty() || owner_id.is_empty() {
        return Err(serde_json::json!({
            "id": request_id,
            "success": false,
            "error": "Owner-scoped browser daemon requests require non-empty string id and ownerId fields",
        }));
    }
    if request_id.len() > MAX_REPLAY_KEY_BYTES || owner_id.len() > MAX_REPLAY_KEY_BYTES {
        return Err(serde_json::json!({
            "id": request_id,
            "success": false,
            "error": "Browser daemon request id or ownerId is too long",
        }));
    }
    let mut hasher = DefaultHasher::new();
    serde_json::to_vec(cmd)
        .map_err(|error| {
            serde_json::json!({
                "id": request_id,
                "success": false,
                "error": format!("Failed to fingerprint browser daemon request: {error}"),
            })
        })?
        .hash(&mut hasher);
    Ok(Some((
        ReplayKey {
            owner_id: owner_id.to_string(),
            request_id: request_id.to_string(),
        },
        hasher.finish(),
    )))
}

pub async fn run_daemon(session: &str) {
    let socket_dir = get_daemon_socket_dir();
    if !socket_dir.exists() {
        let _ = fs::create_dir_all(&socket_dir);
    }

    let pid_path = socket_dir.join(format!("{}.pid", session));
    let _ = fs::write(&pid_path, process::id().to_string());

    let socket_path = socket_dir.join(format!("{}.sock", session));

    if socket_path.exists() {
        let _ = fs::remove_file(&socket_path);
    }

    if let Ok(days_str) = env::var("STELLA_BROWSER_STATE_EXPIRE_DAYS") {
        if let Ok(days) = days_str.parse::<u64>() {
            if days > 0 {
                let _ = state::state_clean(days);
            }
        }
    }

    let mut stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>> = None;
    let mut stream_server_instance: Option<Arc<StreamServer>> = None;
    if let Ok(port_str) = env::var("STELLA_BROWSER_STREAM_PORT") {
        if let Ok(port) = port_str.parse::<u16>() {
            if port > 0 {
                match StreamServer::start_without_client(port, session.to_string()).await {
                    Ok((stream_server, client_slot)) => {
                        stream_client = Some(client_slot.clone());
                        let stream_path = socket_dir.join(format!("{}.stream", session));
                        if let Err(e) = fs::write(&stream_path, stream_server.port().to_string()) {
                            let _ =
                                writeln!(std::io::stderr(), "Failed to write .stream file: {}", e);
                        }
                        stream_server_instance = Some(Arc::new(stream_server));
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Stream server failed to start: {}", e);
                    }
                }
            }
        }
    }

    let idle_timeout_ms = env::var("STELLA_BROWSER_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|&ms| ms > 0);
    let access_policy = match DaemonAccessPolicy::from_env() {
        Ok(policy) => Arc::new(policy),
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "Daemon access policy error: {error}");
            process::exit(1);
        }
    };

    let result = run_socket_server(
        &socket_path,
        session,
        stream_client,
        stream_server_instance,
        idle_timeout_ms,
        access_policy,
    )
    .await;

    let _ = fs::remove_file(&socket_path);
    let _ = fs::remove_file(&pid_path);
    let stream_path = socket_dir.join(format!("{}.stream", session));
    let _ = fs::remove_file(&stream_path);

    if let Err(e) = result {
        let _ = writeln!(std::io::stderr(), "Daemon error: {}", e);
        process::exit(1);
    }
}

#[cfg(unix)]
fn validate_unix_socket_path_len(socket_path: &std::path::Path) -> Result<(), String> {
    let path_len = socket_path.as_os_str().len();
    if path_len > 103 {
        return Err(format!(
            "Socket path '{}' is too long: {} bytes (max 103).\n\
             Use a shorter session name or set STELLA_BROWSER_SOCKET_DIR to a shorter path.",
            socket_path.display(),
            path_len
        ));
    }
    Ok(())
}

#[cfg(unix)]
async fn run_socket_server(
    socket_path: &PathBuf,
    _session: &str,
    stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
    stream_server: Option<Arc<StreamServer>>,
    idle_timeout_ms: Option<u64>,
    access_policy: Arc<DaemonAccessPolicy>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    validate_unix_socket_path_len(socket_path)?;
    let listener =
        UnixListener::bind(socket_path).map_err(|e| format!("Failed to bind socket: {}", e))?;
    fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("Failed to secure browser daemon socket: {}", e))?;

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();
    let mut daemon_state = DaemonState::new_with_stream(stream_client, stream_server);
    daemon_state.daemon_shutdown_tx = Some(shutdown_tx);
    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(daemon_state));
    let replay_cache = Arc::new(RequestReplayCache::default());

    let (reset_tx, mut reset_rx) = mpsc::channel::<()>(64);
    let reset_tx = idle_timeout_ms.map(|_| Arc::new(reset_tx));

    loop {
        let sleep_future = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
        let mut sleep_pin = sleep_future.map(Box::pin);

        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let replay_cache = replay_cache.clone();
                        let reset_tx = reset_tx.clone();
                        let access_policy = access_policy.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, replay_cache, reset_tx, access_policy).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = async {
                if let Some(ref mut s) = sleep_pin {
                    s.as_mut().await
                } else {
                    std::future::pending::<()>().await
                }
            }, if idle_timeout_ms.is_some() => {
                shutdown_daemon(state.clone(), false).await;
                break;
            }
            _ = reset_rx.recv(), if idle_timeout_ms.is_some() => {
                continue;
            }
            shutdown = shutdown_rx.recv() => {
                if shutdown.is_some() {
                    shutdown_daemon(state.clone(), false).await;
                }
                break;
            }
            _ = shutdown_signal() => {
                shutdown_daemon(state.clone(), false).await;
                break;
            }
        }
    }

    Ok(())
}

#[cfg(windows)]
async fn run_socket_server(
    socket_path: &PathBuf,
    session: &str,
    stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
    stream_server: Option<Arc<StreamServer>>,
    idle_timeout_ms: Option<u64>,
    access_policy: Arc<DaemonAccessPolicy>,
) -> Result<(), String> {
    use tokio::net::TcpListener;

    let port = get_port_for_session(session);

    let addr = format!("127.0.0.1:{}", port);
    let mut listener: Option<TcpListener> = None;
    for attempt in 0..15 {
        match TcpListener::bind(&addr).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(e) => {
                if attempt == 14 {
                    return Err(format!("Failed to bind TCP: {}", e));
                }

                if attempt == 0 {
                    super::extension_bridge::kill_process_on_port(port);
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    let listener = listener.unwrap();

    let socket_dir = socket_path.parent().unwrap_or(std::path::Path::new("."));
    let port_path = socket_dir.join(format!("{}.port", session));
    let _ = fs::write(&port_path, port.to_string());

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();
    let mut daemon_state = DaemonState::new_with_stream(stream_client, stream_server);
    daemon_state.daemon_shutdown_tx = Some(shutdown_tx);
    let state: std::sync::Arc<tokio::sync::Mutex<DaemonState>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(daemon_state));
    let replay_cache = Arc::new(RequestReplayCache::default());

    let (reset_tx, mut reset_rx) = mpsc::channel::<()>(64);
    let reset_tx = idle_timeout_ms.map(|_| Arc::new(reset_tx));

    loop {
        let sleep_future = idle_timeout_ms.map(|ms| tokio::time::sleep(Duration::from_millis(ms)));
        let mut sleep_pin = sleep_future.map(Box::pin);

        tokio::select! {
            accept_result = listener.accept() => {
                match accept_result {
                    Ok((stream, _)) => {
                        let state = state.clone();
                        let replay_cache = replay_cache.clone();
                        let reset_tx = reset_tx.clone();
                        let access_policy = access_policy.clone();
                        tokio::spawn(async move {
                            handle_connection(stream, state, replay_cache, reset_tx, access_policy).await;
                        });
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "Accept error: {}", e);
                    }
                }
            }
            _ = async {
                if let Some(ref mut s) = sleep_pin {
                    s.as_mut().await
                } else {
                    std::future::pending::<()>().await
                }
            }, if idle_timeout_ms.is_some() => {
                shutdown_daemon(state.clone(), false).await;
                let _ = fs::remove_file(&port_path);
                break;
            }
            _ = reset_rx.recv(), if idle_timeout_ms.is_some() => {
                continue;
            }
            shutdown = shutdown_rx.recv() => {
                if shutdown.is_some() {
                    shutdown_daemon(state.clone(), false).await;
                }
                let _ = fs::remove_file(&port_path);
                break;
            }
            _ = shutdown_signal() => {
                shutdown_daemon(state.clone(), false).await;
                let _ = fs::remove_file(&port_path);
                break;
            }
        }
    }

    Ok(())
}

async fn shutdown_daemon(
    state: std::sync::Arc<tokio::sync::Mutex<DaemonState>>,
    persist_session: bool,
) {
    let mut guard = state.lock().await;
    if let Err(e) = teardown_daemon_state(&mut guard, persist_session).await {
        let _ = writeln!(std::io::stderr(), "Daemon shutdown cleanup error: {}", e);
    }
}

async fn handle_connection<S>(
    stream: S,
    state: std::sync::Arc<tokio::sync::Mutex<DaemonState>>,
    replay_cache: Arc<RequestReplayCache>,
    idle_reset_tx: Option<Arc<mpsc::Sender<()>>>,
    access_policy: Arc<DaemonAccessPolicy>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match buf_reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if looks_like_http(trimmed) {
                    break;
                }

                let cmd: Value = match serde_json::from_str(trimmed) {
                    Ok(v) => v,
                    Err(e) => {
                        let err = serde_json::json!({
                            "success": false,
                            "error": format!("Invalid JSON: {}", e),
                        });
                        let mut resp = serde_json::to_string(&err).unwrap_or_default();
                        resp.push('\n');
                        let _ = writer.write_all(resp.as_bytes()).await;
                        continue;
                    }
                };

                let authorization = access_policy.authorize(&cmd);
                if authorization.is_ok() {
                    if let Some(ref tx) = idle_reset_tx {
                        let _ = tx.try_send(());
                    }
                }
                let action = cmd.get("action").and_then(|v| v.as_str());
                let is_extension_delegation = cmd
                    .get("extensionDelegateToken")
                    .and_then(Value::as_str)
                    .is_some();
                let is_close = authorization.is_ok()
                    && !is_extension_delegation
                    && (action == Some("close")
                        || (access_policy.owner_id.is_some()
                            && action == Some("release_owner_lease")));

                if authorization.is_ok() {
                    if let Some(response) = access_policy.handle_extension_delegation_command(&cmd)
                    {
                        let mut resp = serde_json::to_string(&response).unwrap_or_default();
                        resp.push('\n');
                        if writer.write_all(resp.as_bytes()).await.is_err() {
                            break;
                        }
                        continue;
                    }
                }

                if action == Some("subscribe_events") {
                    match authorization {
                        Err(response) => {
                            let mut resp = serde_json::to_string(&response).unwrap_or_default();
                            resp.push('\n');
                            let _ = writer.write_all(resp.as_bytes()).await;
                            break;
                        }
                        Ok(()) => {
                            let request_id = cmd
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let receiver = {
                                let guard = state.lock().await;
                                guard
                                    .extension_bridge
                                    .as_ref()
                                    .map(|bridge| bridge.subscribe_events())
                            };
                            let ack = serde_json::json!({
                                "id": request_id,
                                "success": true,
                                "data": { "subscribed": receiver.is_some() },
                            });
                            let mut ack_line = serde_json::to_string(&ack).unwrap_or_default();
                            ack_line.push('\n');
                            if writer.write_all(ack_line.as_bytes()).await.is_err() {
                                break;
                            }
                            if let Some(receiver) = receiver {
                                stream_extension_events(receiver, &mut buf_reader, &mut writer)
                                    .await;
                            }
                            break;
                        }
                    }
                }

                let response = match authorization {
                    Err(response) => response,
                    Ok(()) => match replay_key(&cmd) {
                        Ok(Some((key, fingerprint))) => {
                            replay_cache
                                .execute_once(key, fingerprint, || async {
                                    execute_command_with_deadline(&cmd, state.clone()).await
                                })
                                .await
                        }
                        Ok(None) => execute_command_with_deadline(&cmd, state.clone()).await,
                        Err(response) => response,
                    },
                };

                let mut resp = serde_json::to_string(&response).unwrap_or_default();
                resp.push('\n');
                if writer.write_all(resp.as_bytes()).await.is_err() {
                    break;
                }

                if is_close {
                    let shutdown_tx = {
                        let guard = state.lock().await;
                        guard.daemon_shutdown_tx.clone()
                    };
                    if let Some(tx) = shutdown_tx {
                        let _ = tx.send(());
                    }
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

async fn stream_extension_events<R, W>(
    mut receiver: broadcast::Receiver<String>,
    reader: &mut BufReader<R>,
    writer: &mut W,
) where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::sync::broadcast::error::RecvError;

    const MAX_SUBSCRIBER_LINE_BYTES: usize = 64 * 1024;
    let mut scratch = String::new();
    loop {
        tokio::select! {
            recv = receiver.recv() => match recv {
                Ok(event) => {
                    let mut line = event;
                    line.push('\n');
                    if writer.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    if writer.flush().await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    if writer
                        .write_all(b"{\"type\":\"event\",\"event\":\"events_lagged\"}\n")
                        .await
                        .is_err()
                    {
                        break;
                    }
                    if writer.flush().await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Closed) => break,
            },
            read = reader.read_line(&mut scratch) => match read {
                Ok(0) => break,
                Ok(_) => {
                    if scratch.len() > MAX_SUBSCRIBER_LINE_BYTES {
                        break;
                    }
                    scratch.clear();
                }
                Err(_) => break,
            },
        }
    }
}

fn daemon_command_timeout_ms(command: &Value) -> u64 {
    command
        .get("timeout")
        .and_then(Value::as_u64)
        .filter(|timeout| *timeout > 0)
        .map(|timeout| {
            timeout
                .saturating_add(DAEMON_COMMAND_TIMEOUT_GRACE_MS)
                .clamp(
                    DEFAULT_DAEMON_COMMAND_TIMEOUT_MS,
                    MAX_DAEMON_COMMAND_TIMEOUT_MS,
                )
        })
        .unwrap_or(DEFAULT_DAEMON_COMMAND_TIMEOUT_MS)
}

async fn execute_command_with_deadline(
    command: &Value,
    state: Arc<tokio::sync::Mutex<DaemonState>>,
) -> Value {
    let timeout_ms = daemon_command_timeout_ms(command);
    let request_id = command.get("id").and_then(Value::as_str).unwrap_or("");
    let action = command
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match tokio::time::timeout(Duration::from_millis(timeout_ms), async {
        let mut guard = state.lock().await;
        execute_command(command, &mut guard).await
    })
    .await
    {
        Ok(response) => response,
        Err(_) => serde_json::json!({
            "id": request_id,
            "success": false,
            "error": format!(
                "Browser daemon command timed out after {}ms on action={}",
                timeout_ms, action
            ),
        }),
    }
}

fn looks_like_http(line: &str) -> bool {
    let prefixes = [
        "GET ", "POST ", "PUT ", "DELETE ", "PATCH ", "HEAD ", "OPTIONS ", "CONNECT ", "TRACE ",
    ];
    prefixes.iter().any(|p| line.starts_with(p))
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut sigint = match signal::unix::signal(signal::unix::SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGINT handler: {}", e);
                process::exit(1);
            }
        };
        let mut sigterm = match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(
                    std::io::stderr(),
                    "Failed to install SIGTERM handler: {}",
                    e
                );
                process::exit(1);
            }
        };
        let mut sighup = match signal::unix::signal(signal::unix::SignalKind::hangup()) {
            Ok(s) => s,
            Err(e) => {
                let _ = writeln!(std::io::stderr(), "Failed to install SIGHUP handler: {}", e);
                process::exit(1);
            }
        };

        tokio::select! {
            _ = sigint.recv() => {}
            _ = sigterm.recv() => {}
            _ = sighup.recv() => {}
        }
    }

    #[cfg(windows)]
    {
        if let Err(e) = signal::ctrl_c().await {
            let _ = writeln!(std::io::stderr(), "Failed to install Ctrl+C handler: {}", e);
            process::exit(1);
        }
    }
}

fn get_daemon_socket_dir() -> PathBuf {
    if let Ok(dir) = env::var("STELLA_BROWSER_SOCKET_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }

    if let Ok(xdg) = env::var("XDG_RUNTIME_DIR") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("stella-browser");
        }
    }

    if let Some(home) = dirs::home_dir() {
        return home.join(".stella-browser");
    }

    std::env::temp_dir().join("stella-browser")
}

#[cfg(windows)]
fn get_port_for_session(session: &str) -> u16 {
    let mut hash: i32 = 0;
    for c in session.chars() {
        hash = ((hash << 5).wrapping_sub(hash)).wrapping_add(c as i32);
    }
    49152 + ((hash.unsigned_abs() as u32 % 16383) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::actions::BackendType;
    use crate::native::extension_bridge::ExtensionBridge;
    use crate::native::policy::ActionPolicy;
    use serde_json::json;

    #[tokio::test]
    async fn test_stream_extension_events_forwards_and_closes() {
        let (tx, rx) = broadcast::channel::<String>(8);
        let (mut client, server) = tokio::io::duplex(4096);
        let (server_read, mut server_write) = tokio::io::split(server);
        let mut server_reader = BufReader::new(server_read);
        let task = tokio::spawn(async move {
            stream_extension_events(rx, &mut server_reader, &mut server_write).await;
        });

        tx.send("{\"type\":\"event\",\"event\":\"cookies_changed\"}".to_string())
            .unwrap();

        let mut reader = BufReader::new(&mut client);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
            .await
            .expect("event should arrive before timeout")
            .expect("read ok");
        assert_eq!(
            line.trim(),
            "{\"type\":\"event\",\"event\":\"cookies_changed\"}"
        );

        drop(tx);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("stream task should finish after channel close")
            .expect("task join");
    }

    #[tokio::test]
    async fn test_stream_extension_events_emits_lag_notice_when_overflowed() {
        let (tx, rx) = broadcast::channel::<String>(2);

        for i in 0..5 {
            tx.send(format!("{{\"type\":\"event\",\"n\":{}}}", i)).unwrap();
        }
        let (mut client, server) = tokio::io::duplex(4096);
        let (server_read, mut server_write) = tokio::io::split(server);
        let mut server_reader = BufReader::new(server_read);
        let task = tokio::spawn(async move {
            stream_extension_events(rx, &mut server_reader, &mut server_write).await;
        });

        let mut reader = BufReader::new(&mut client);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
            .await
            .expect("lag notice should arrive before timeout")
            .expect("read ok");
        assert!(
            line.contains("events_lagged"),
            "expected a lag notice, got: {line}"
        );

        drop(tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn protected_policy(expires_at: u64) -> DaemonAccessPolicy {
        DaemonAccessPolicy {
            control_token: Some("control-secret".to_string()),
            owner_id: Some("agent-thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            owner_lease_id: Some("lease-1".to_string()),
            owner_lease_issued_at: Some(1_000),
            capability_expires_at_ms: Some(expires_at),
            extension_delegations: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    #[test]
    fn command_deadlines_bound_default_requested_and_oversized_work() {
        assert_eq!(
            daemon_command_timeout_ms(&json!({ "action": "evaluate" })),
            DEFAULT_DAEMON_COMMAND_TIMEOUT_MS
        );
        assert_eq!(
            daemon_command_timeout_ms(&json!({
                "action": "wait",
                "timeout": 120_000,
            })),
            120_000 + DAEMON_COMMAND_TIMEOUT_GRACE_MS
        );
        assert_eq!(
            daemon_command_timeout_ms(&json!({
                "action": "chain",
                "timeout": u64::MAX,
            })),
            MAX_DAEMON_COMMAND_TIMEOUT_MS
        );
    }

    #[test]
    fn protected_daemon_accepts_only_exact_owner_turn_and_lease() {
        let policy = protected_policy(u64::MAX);
        let exact = json!({
            "id": "request-1",
            "action": "tab_list",
            "ownerId": "agent-thread-1",
            "sessionId": "agent-thread-1",
            "turnId": "turn-1",
            "ownerLeaseId": "lease-1",
            "ownerLeaseIssuedAt": 1_000,
        });
        assert!(policy.authorize(&exact).is_ok());
        for changed in [
            json!({ "ownerId": "agent-thread-2" }),
            json!({ "sessionId": "agent-thread-2" }),
            json!({ "turnId": "turn-2" }),
            json!({ "ownerLeaseId": "lease-2" }),
            json!({ "ownerLeaseIssuedAt": 999 }),
        ] {
            let mut command = exact.clone();
            command
                .as_object_mut()
                .unwrap()
                .extend(changed.as_object().unwrap().clone());
            let error = policy.authorize(&command).unwrap_err();
            assert_eq!(error["success"], false);
            assert!(error["error"]
                .as_str()
                .unwrap()
                .contains("outside its authorized session"));
        }
    }

    #[test]
    fn protected_daemon_control_token_and_expiry_are_enforced() {
        let expired = protected_policy(1);
        let owner_command = json!({
            "id": "request-1",
            "action": "tab_list",
            "ownerId": "agent-thread-1",
            "sessionId": "agent-thread-1",
            "turnId": "turn-1",
            "ownerLeaseId": "lease-1",
            "ownerLeaseIssuedAt": 1_000,
        });
        let error = expired.authorize(&owner_command).unwrap_err();
        assert!(error["error"].as_str().unwrap().contains("expired"));
        assert!(expired
            .authorize(&json!({
                "id": "control-1",
                "action": "close",
                "controlToken": "control-secret",
            }))
            .is_ok());
        assert!(expired
            .authorize(&json!({
                "id": "control-2",
                "action": "close",
                "controlToken": "wrong",
            }))
            .is_err());
    }

    #[test]
    #[cfg(windows)]
    fn test_port_matches_client_algorithm() {

        assert_eq!(get_port_for_session("default"), 50838);
        assert_eq!(get_port_for_session("my-session"), 63105);
        assert_eq!(get_port_for_session("work"), 51184);
        assert_eq!(get_port_for_session(""), 49152);
    }

    #[test]
    #[cfg(unix)]
    fn test_unix_socket_path_length_guard() {
        use std::path::PathBuf;

        assert!(validate_unix_socket_path_len(&PathBuf::from("/tmp/short.sock")).is_ok());

        let base = "/tmp/";
        let at_limit = PathBuf::from(format!("{}{}", base, "a".repeat(103 - base.len())));
        assert_eq!(at_limit.as_os_str().len(), 103);
        assert!(validate_unix_socket_path_len(&at_limit).is_ok());

        let over_limit = PathBuf::from(format!("{}{}", base, "a".repeat(104 - base.len())));
        let err = validate_unix_socket_path_len(&over_limit).unwrap_err();
        assert!(err.contains("104 bytes"), "unexpected message: {err}");
        assert!(err.contains("max 103"), "unexpected message: {err}");
        assert!(
            err.contains(over_limit.to_str().unwrap()),
            "error should name the offending path: {err}"
        );
    }

    #[tokio::test]
    async fn test_handle_connection_close_requests_graceful_shutdown() {
        let (client, server) = tokio::io::duplex(1024);
        let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel();

        let mut daemon_state = DaemonState::new();
        daemon_state.daemon_shutdown_tx = Some(shutdown_tx);
        let state = Arc::new(tokio::sync::Mutex::new(daemon_state));
        let replay_cache = Arc::new(RequestReplayCache::default());

        let handle = tokio::spawn(async move {
            handle_connection(
                server,
                state,
                replay_cache,
                None,
                Arc::new(DaemonAccessPolicy::default()),
            )
            .await;
        });

        let (reader, mut writer) = tokio::io::split(client);
        writer
            .write_all(br#"{"id":"test-close","action":"close"}"#)
            .await
            .unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.shutdown().await.unwrap();

        let mut reader = BufReader::new(reader);
        let mut response_line = String::new();
        reader.read_line(&mut response_line).await.unwrap();
        let response: Value = serde_json::from_str(&response_line).unwrap();
        assert_eq!(response["success"], true);
        assert_eq!(response["data"]["closed"], true);

        tokio::time::timeout(Duration::from_secs(1), shutdown_rx.recv())
            .await
            .expect("close should trigger daemon shutdown")
            .expect("shutdown sender should remain open");

        handle.await.unwrap();
    }

    #[tokio::test]
    async fn test_handle_connection_non_close_does_not_shutdown_daemon() {
        let (client, server) = tokio::io::duplex(1024);
        let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel();

        let mut daemon_state = DaemonState::new();
        daemon_state.daemon_shutdown_tx = Some(shutdown_tx);
        let state = Arc::new(tokio::sync::Mutex::new(daemon_state));
        let replay_cache = Arc::new(RequestReplayCache::default());

        let handle = tokio::spawn(async move {
            handle_connection(
                server,
                state,
                replay_cache,
                None,
                Arc::new(DaemonAccessPolicy::default()),
            )
            .await;
        });

        let (reader, mut writer) = tokio::io::split(client);
        let command = serde_json::to_string(&json!({
            "id": "test-state-list",
            "action": "state_list"
        }))
        .unwrap();
        writer.write_all(command.as_bytes()).await.unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.shutdown().await.unwrap();

        let mut reader = BufReader::new(reader);
        let mut response_line = String::new();
        reader.read_line(&mut response_line).await.unwrap();
        let response: Value = serde_json::from_str(&response_line).unwrap();
        assert_eq!(response["success"], true);

        handle.await.unwrap();

        assert!(
            shutdown_rx.try_recv().is_err(),
            "non-close commands should not trigger daemon shutdown"
        );
    }

    #[tokio::test]
    async fn test_extension_connection_routes_through_execute_command_policy() {
        let path = std::env::temp_dir().join(format!(
            "stella-browser-daemon-policy-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, r#"{"default":"allow","deny":["click"]}"#).unwrap();

        let (client, server) = tokio::io::duplex(2048);
        let mut daemon_state = DaemonState::new();
        daemon_state.backend_type = BackendType::Extension;
        daemon_state.extension_bridge = Some(ExtensionBridge::new(Some(0), Some(String::new())));
        daemon_state.policy = Some(ActionPolicy::load(path.to_str().unwrap()).unwrap());
        let state = Arc::new(tokio::sync::Mutex::new(daemon_state));
        let replay_cache = Arc::new(RequestReplayCache::default());

        let handle = tokio::spawn(async move {
            handle_connection(
                server,
                state,
                replay_cache,
                None,
                Arc::new(DaemonAccessPolicy::default()),
            )
            .await;
        });

        let (reader, mut writer) = tokio::io::split(client);
        writer
            .write_all(br##"{"id":"policy","action":"click","selector":"#submit"}"##)
            .await
            .unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.shutdown().await.unwrap();

        let mut reader = BufReader::new(reader);
        let mut response_line = String::new();
        tokio::time::timeout(Duration::from_secs(1), reader.read_line(&mut response_line))
            .await
            .expect("policy should reject before waiting for the extension bridge")
            .unwrap();
        let response: Value = serde_json::from_str(&response_line).unwrap();
        assert_eq!(response["success"], false);
        assert!(response["error"].as_str().unwrap().contains("click"));

        handle.await.unwrap();
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn test_close_owner_does_not_request_daemon_shutdown() {
        let (client, server) = tokio::io::duplex(1024);
        let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel();

        let mut daemon_state = DaemonState::new();
        daemon_state.daemon_shutdown_tx = Some(shutdown_tx);
        let state = Arc::new(tokio::sync::Mutex::new(daemon_state));
        let replay_cache = Arc::new(RequestReplayCache::default());
        let handle = tokio::spawn(async move {
            handle_connection(
                server,
                state,
                replay_cache,
                None,
                Arc::new(DaemonAccessPolicy::default()),
            )
            .await;
        });

        let (reader, mut writer) = tokio::io::split(client);
        writer
            .write_all(br#"{"id":"owner-close","action":"close_owner","ownerId":"worker-1","sessionId":"worker-1","turnId":"turn-1","ownerLeaseId":"lease-1","ownerLeaseIssuedAt":1}"#)
            .await
            .unwrap();
        writer.write_all(b"\n").await.unwrap();
        writer.shutdown().await.unwrap();

        let mut reader = BufReader::new(reader);
        let mut response_line = String::new();
        reader.read_line(&mut response_line).await.unwrap();
        let response: Value = serde_json::from_str(&response_line).unwrap();

        assert_eq!(response["success"], true);
        assert_eq!(response["data"]["closedTabIds"], json!([]));

        handle.await.unwrap();
        assert!(shutdown_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn test_replay_cache_returns_completed_response_without_reexecution() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = Arc::new(RequestReplayCache::default());
        let key = ReplayKey {
            owner_id: "worker-1".to_string(),
            request_id: "request-1".to_string(),
        };
        let executions = Arc::new(AtomicUsize::new(0));

        let first = cache
            .execute_once(key.clone(), 1, {
                let executions = executions.clone();
                move || async move {
                    executions.fetch_add(1, Ordering::SeqCst);
                    json!({ "id": "request-1", "success": true })
                }
            })
            .await;
        let second = cache
            .execute_once(key, 1, {
                let executions = executions.clone();
                move || async move {
                    executions.fetch_add(1, Ordering::SeqCst);
                    json!({ "id": "request-1", "success": false })
                }
            })
            .await;

        assert_eq!(first, second);
        assert_eq!(executions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_replay_cache_waits_for_in_flight_response_without_reexecution() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = Arc::new(RequestReplayCache::default());
        let key = ReplayKey {
            owner_id: "worker-1".to_string(),
            request_id: "request-2".to_string(),
        };
        let executions = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();

        let first = tokio::spawn({
            let cache = cache.clone();
            let key = key.clone();
            let executions = executions.clone();
            async move {
                cache
                    .execute_once(key, 2, move || async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        let _ = started_tx.send(());
                        let _ = release_rx.await;
                        json!({ "id": "request-2", "success": true })
                    })
                    .await
            }
        });
        started_rx.await.unwrap();
        let second = tokio::spawn({
            let cache = cache.clone();
            let executions = executions.clone();
            async move {
                cache
                    .execute_once(key, 2, move || async move {
                        executions.fetch_add(1, Ordering::SeqCst);
                        json!({ "id": "request-2", "success": false })
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        release_tx.send(()).unwrap();

        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(first, second);
        assert_eq!(executions.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_replay_cache_bounds_completed_and_in_flight_entries() {
        let cache = Arc::new(RequestReplayCache::default());
        for index in 0..=MAX_COMPLETED_REQUESTS {
            let key = ReplayKey {
                owner_id: "worker-1".to_string(),
                request_id: format!("completed-{index}"),
            };
            cache
                .execute_once(key, index as u64, || async {
                    json!({ "id": "completed", "success": true })
                })
                .await;
        }
        {
            let state = cache.state.lock().unwrap();
            assert_eq!(state.entries.len(), MAX_COMPLETED_REQUESTS);
            assert_eq!(state.completed_order.len(), MAX_COMPLETED_REQUESTS);
        }

        let saturated_cache = Arc::new(RequestReplayCache::default());
        {
            let mut state = saturated_cache.state.lock().unwrap();
            state.in_flight = MAX_IN_FLIGHT_REQUESTS;
        }
        let response = saturated_cache
            .execute_once(
                ReplayKey {
                    owner_id: "worker-1".to_string(),
                    request_id: "overflow".to_string(),
                },
                3,
                || async { panic!("saturated replay cache must reject before execution") },
            )
            .await;
        assert_eq!(response["id"], "overflow");
        assert_eq!(response["success"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("too many in-flight"));

        let waiter_cache = Arc::new(RequestReplayCache::default());
        let waiter_key = ReplayKey {
            owner_id: "worker-1".to_string(),
            request_id: "waiter-overflow".to_string(),
        };
        let mut receivers = Vec::new();
        {
            let mut state = waiter_cache.state.lock().unwrap();
            let mut waiters = Vec::new();
            for _ in 0..MAX_REPLAY_WAITERS_PER_REQUEST {
                let (tx, rx) = oneshot::channel();
                waiters.push(tx);
                receivers.push(rx);
            }
            state.entries.insert(
                waiter_key.clone(),
                ReplayEntry::InFlight {
                    fingerprint: 4,
                    waiters,
                },
            );
            state.in_flight = 1;
        }
        let response = waiter_cache
            .execute_once(waiter_key, 4, || async {
                panic!("saturated waiter list must reject before execution")
            })
            .await;
        assert_eq!(response["id"], "waiter-overflow");
        assert_eq!(response["success"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("too many replay waiters"));
        drop(receivers);
    }

    #[tokio::test]
    async fn test_replay_cache_rejects_mismatched_request_fingerprint() {
        let cache = Arc::new(RequestReplayCache::default());
        let key = ReplayKey {
            owner_id: "worker-1".to_string(),
            request_id: "request-mismatch".to_string(),
        };
        let first = cache
            .execute_once(key.clone(), 10, || async {
                json!({ "id": "request-mismatch", "success": true })
            })
            .await;
        assert_eq!(first["success"], true);

        let second = cache
            .execute_once(key, 11, || async {
                panic!("mismatched replay must not execute")
            })
            .await;
        assert_eq!(second["success"], false);
        assert!(second["error"]
            .as_str()
            .unwrap()
            .contains("different command content"));
    }
}
