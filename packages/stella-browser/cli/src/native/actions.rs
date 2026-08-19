use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::sync::{broadcast, mpsc, oneshot, RwLock};

use super::auth;
use super::browser::{BrowserManager, WaitUntil};
use super::cdp::chrome::LaunchOptions;
use super::cdp::client::CdpClient;
use super::cdp::types::{
    AttachToTargetParams, AttachToTargetResult, CdpEvent, ConsoleApiCalledEvent,
    CreateTargetResult, ExceptionThrownEvent, TargetCreatedEvent, TargetDestroyedEvent,
};
use super::cookies;
use super::diff;
use super::element::RefMap;
use super::extension_bridge::ExtensionBridge;
use super::inspect_server::InspectServer;
use super::interaction;
use super::network::{self, DomainFilter, EventTracker};
use super::policy::{ActionPolicy, ConfirmActions, PolicyResult};
use super::providers;
use super::recording::{self, RecordingState};
use super::screenshot::{self, ScreenshotOptions};
use super::snapshot::{self, SnapshotOptions};
use super::state;
use super::storage;
use super::stream::{self, StreamServer};
use super::tracing::{self as native_tracing, TracingState};
use super::webdriver::appium::AppiumManager;
use super::webdriver::backend::{BrowserBackend, WebDriverBackend, WEBDRIVER_UNSUPPORTED_ACTIONS};
use super::webdriver::ios;
use super::webdriver::safari;
use crate::connection;

pub struct PendingConfirmation {
    pub action: String,
    pub cmd: Value,
}

// The command vocabulary is contract-checked against
// packages/stella-browser/protocol/actions.json (see contract_tests.rs).
// Adding, removing, or renaming an action here without updating the manifest
// (and the JS layers listed in it) fails the contract tests.
fn is_known_action(action: &str) -> bool {
    matches!(
        action,
        "healthcheck"
            | "launch"
            | "navigate"
            | "url"
            | "cdp_url"
            | "inspect"
            | "title"
            | "content"
            | "evaluate"
            | "evaluate_detached"
            | "close"
            | "snapshot"
            | "screenshot"
            | "click"
            | "dblclick"
            | "fill"
            | "type"
            | "press"
            | "hover"
            | "scroll"
            | "select"
            | "check"
            | "uncheck"
            | "wait"
            | "gettext"
            | "getattribute"
            | "isvisible"
            | "isenabled"
            | "ischecked"
            | "back"
            | "forward"
            | "reload"
            | "cookies_get"
            | "cookies_export_all"
            | "cookies_export_for_urls"
            | "cookies_set"
            | "cookies_clear"
            | "extension_status"
            | "storage_get"
            | "storage_set"
            | "storage_clear"
            | "setcontent"
            | "headers"
            | "offline"
            | "console"
            | "errors"
            | "state_save"
            | "state_load"
            | "state_list"
            | "state_show"
            | "state_clear"
            | "state_clean"
            | "state_rename"
            | "trace_start"
            | "trace_stop"
            | "profiler_start"
            | "profiler_stop"
            | "recording_start"
            | "recording_stop"
            | "recording_restart"
            | "pdf"
            | "tab_list"
            | "tab_new"
            | "tab_switch"
            | "tab_close"
            | "viewport"
            | "useragent"
            | "user_agent"
            | "set_media"
            | "download"
            | "diff_snapshot"
            | "diff_url"
            | "credentials_set"
            | "credentials_get"
            | "credentials_delete"
            | "credentials_list"
            | "mouse"
            | "keyboard"
            | "focus"
            | "clear"
            | "selectall"
            | "scrollintoview"
            | "dispatch"
            | "highlight"
            | "tap"
            | "boundingbox"
            | "innertext"
            | "innerhtml"
            | "inputvalue"
            | "setvalue"
            | "count"
            | "styles"
            | "bringtofront"
            | "timezone"
            | "locale"
            | "geolocation"
            | "permissions"
            | "dialog"
            | "upload"
            | "addscript"
            | "addinitscript"
            | "addstyle"
            | "clipboard"
            | "wheel"
            | "device"
            | "screencast_start"
            | "screencast_stop"
            | "waitforurl"
            | "waitforloadstate"
            | "waitforfunction"
            | "frame"
            | "mainframe"
            | "getbyrole"
            | "getbytext"
            | "getbylabel"
            | "getbyplaceholder"
            | "getbyalttext"
            | "getbytitle"
            | "getbytestid"
            | "nth"
            | "find"
            | "evalhandle"
            | "drag"
            | "expose"
            | "pause"
            | "multiselect"
            | "responsebody"
            | "waitfordownload"
            | "window_new"
            | "diff_screenshot"
            | "video_start"
            | "video_stop"
            | "har_start"
            | "har_stop"
            | "route"
            | "unroute"
            | "rewrite_request"
            | "unrewrite_request"
            | "requests"
            | "authenticated_request"
            | "authenticated_request_batch"
            | "credentials"
            | "emulatemedia"
            | "auth_save"
            | "auth_login"
            | "auth_list"
            | "auth_delete"
            | "auth_show"
            | "confirm"
            | "deny"
            | "swipe"
            | "device_list"
            | "input_mouse"
            | "input_keyboard"
            | "input_touch"
            | "keydown"
            | "keyup"
            | "inserttext"
            | "mousemove"
            | "mousedown"
            | "mouseup"
            | "chain"
            | "finalize_tabs"
            | "close_owner"
            | "release_owner_lease"
    )
}

const MAX_CHAIN_STEPS: usize = 100;

/// Actions the JS client (BROWSER_CHAIN_ACTIONS in
/// packages/runtime/kernel/browser-use/client.ts) permits inside a chain,
/// contract-checked against protocol/actions.json ("chain": true). Kept in
/// sync as defense-in-depth: lifecycle, credential, and state-mutating
/// maintenance actions must stay top-level so policy prompts and confirmation
/// flows cannot be smuggled past inside a batch.
fn is_chain_allowed_action(action: &str) -> bool {
    matches!(
        action,
        "healthcheck"
            | "navigate"
            | "back"
            | "forward"
            | "reload"
            | "url"
            | "title"
            | "click"
            | "fill"
            | "type"
            | "hover"
            | "select"
            | "press"
            | "scroll"
            | "clear"
            | "check"
            | "uncheck"
            | "focus"
            | "dblclick"
            | "wait"
            | "screenshot"
            | "snapshot"
            | "content"
            | "evaluate"
            | "gettext"
            | "getattribute"
            | "innertext"
            | "innerhtml"
            | "inputvalue"
            | "boundingbox"
            | "scrollintoview"
            | "isvisible"
            | "isenabled"
            | "ischecked"
            | "count"
            | "styles"
            | "waitforurl"
            | "waitforfunction"
            | "bringtofront"
            | "requests"
            | "responsebody"
            | "route"
            | "unroute"
            | "har_start"
            | "har_stop"
            | "clipboard"
            | "mousemove"
            | "mousedown"
            | "mouseup"
            | "drag"
            | "keydown"
            | "keyup"
            | "inserttext"
            | "tab_new"
            | "tab_list"
            | "tab_switch"
            | "tab_close"
            | "cookies_get"
            | "cookies_set"
            | "cookies_clear"
            | "upload"
    )
}

fn validate_chain_actions(cmd: &Value) -> Result<Vec<&str>, String> {
    let steps = cmd
        .get("steps")
        .and_then(Value::as_array)
        .ok_or("Chain steps must be an array")?;
    if steps.is_empty() {
        return Err("Chain must contain at least one step".to_string());
    }
    if steps.len() > MAX_CHAIN_STEPS {
        return Err(format!(
            "Chain has {} steps; maximum is {}",
            steps.len(),
            MAX_CHAIN_STEPS
        ));
    }

    let mut actions = Vec::with_capacity(steps.len());
    for (index, step) in steps.iter().enumerate() {
        let step = step
            .as_object()
            .ok_or_else(|| format!("Chain step {} must be an object", index))?;
        let action = step
            .get("action")
            .and_then(Value::as_str)
            .filter(|action| !action.trim().is_empty())
            .ok_or_else(|| format!("Chain step {} must have a non-empty string action", index))?;
        if action == "chain"
            || action == "finalize_tabs"
            || action == "close_owner"
            || action == "release_owner_lease"
            || action == "cookies_export_all"
            || action == "cookies_export_for_urls"
            || action == "extension_status"
        {
            return Err(format!(
                "Chain step {} cannot contain top-level-only action {}",
                index, action
            ));
        }
        if !is_known_action(action) {
            return Err(format!(
                "Unknown chain action at step {}: {}",
                index, action
            ));
        }
        if !is_chain_allowed_action(action) {
            return Err(format!(
                "Chain step {} action is not allowed: {}",
                index, action
            ));
        }
        actions.push(action);
    }
    Ok(actions)
}

/// Runtime browser sessions default to the in-app CDP daemon. An explicit
/// per-request marker opts a command into the already-connected extension
/// bridge without changing the daemon's process-wide provider.
fn command_targets_extension(cmd: &Value) -> bool {
    cmd.get("browserBackend").and_then(Value::as_str) == Some("extension")
}

fn validate_extension_domain_gates(cmd: &Value, state: &DaemonState) -> Result<(), String> {
    let Some(filter) = state.domain_filter.as_ref() else {
        return Ok(());
    };

    let mut commands = vec![cmd];
    if cmd.get("action").and_then(Value::as_str) == Some("chain") {
        commands.extend(
            cmd.get("steps")
                .and_then(Value::as_array)
                .into_iter()
                .flatten(),
        );
    }

    for command in commands {
        if command.get("action").and_then(Value::as_str) != Some("navigate") {
            continue;
        }
        let url = command
            .get("url")
            .and_then(Value::as_str)
            .ok_or("Missing 'url' parameter")?;
        filter.check_url(url)?;
    }
    Ok(())
}

/// Trimmed, non-empty `ownerId` a command was sent with, if any. The JS
/// client stamps every command with the session's owner id; commands from
/// other transports may omit it.
fn command_owner_id(cmd: &Value) -> Option<&str> {
    cmd.get("ownerId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|owner_id| !owner_id.is_empty())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct OwnerLease {
    session_id: String,
    turn_id: String,
    lease_id: String,
    issued_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct OwnerLeaseOrder {
    issued_at: u64,
    lease_id: String,
}

impl OwnerLease {
    fn order(&self) -> OwnerLeaseOrder {
        OwnerLeaseOrder {
            issued_at: self.issued_at,
            lease_id: self.lease_id.clone(),
        }
    }
}

#[derive(Clone, Debug)]
struct OwnerLeaseClaim {
    owner_id: String,
    lease: OwnerLease,
}

#[derive(Default)]
struct OwnerLeaseRegistry {
    current_by_owner: HashMap<String, OwnerLease>,
    order_high_water: HashMap<String, OwnerLeaseOrder>,
}

impl OwnerLeaseRegistry {
    fn validate_claim(&self, cmd: &Value) -> Result<Option<OwnerLeaseClaim>, String> {
        let Some(owner_id) = command_owner_id(cmd) else {
            if ["sessionId", "turnId", "ownerLeaseId", "ownerLeaseIssuedAt"]
                .iter()
                .any(|key| cmd.get(*key).is_some())
            {
                return Err("Browser ownership fields require a non-empty ownerId".to_string());
            }
            return Ok(None);
        };
        if owner_id.len() > 256 {
            return Err("ownerId is too long".to_string());
        }
        let required_string = |key: &str| {
            cmd.get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("Owner-scoped browser command requires a non-empty {}", key))
        };
        let session_id = required_string("sessionId")?;
        if session_id != owner_id {
            return Err("Browser command sessionId must match ownerId".to_string());
        }
        let turn_id = required_string("turnId")?;
        let lease_id = required_string("ownerLeaseId")?;
        let issued_at = cmd
            .get("ownerLeaseIssuedAt")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or("Owner-scoped browser command requires a positive ownerLeaseIssuedAt")?;
        let lease = OwnerLease {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            lease_id: lease_id.to_string(),
            issued_at,
        };
        let current = self.current_by_owner.get(owner_id);
        if current == Some(&lease) {
            return Ok(Some(OwnerLeaseClaim {
                owner_id: owner_id.to_string(),
                lease,
            }));
        }
        if current.is_some_and(|current| current.lease_id == lease.lease_id) {
            return Err(format!(
                "Stale browser turn rejected for owner \"{}\"; the lease identity does not match the current turn",
                owner_id
            ));
        }
        let order = lease.order();
        let high_water = self
            .order_high_water
            .get(owner_id)
            .cloned()
            .into_iter()
            .chain(current.map(OwnerLease::order))
            .max();
        if high_water
            .as_ref()
            .is_some_and(|high_water| order <= *high_water)
        {
            return Err(format!(
                "Stale browser owner lease rejected for owner \"{}\"; a newer turn already owns this browser session",
                owner_id
            ));
        }
        Ok(Some(OwnerLeaseClaim {
            owner_id: owner_id.to_string(),
            lease,
        }))
    }

    fn commit(&mut self, claim: &OwnerLeaseClaim) {
        let order = claim.lease.order();
        self.order_high_water
            .entry(claim.owner_id.clone())
            .and_modify(|high_water| {
                if order > *high_water {
                    *high_water = order.clone();
                }
            })
            .or_insert(order);
        self.current_by_owner
            .insert(claim.owner_id.clone(), claim.lease.clone());
    }

    fn release(&mut self, cmd: &Value) -> Result<bool, String> {
        let Some(claim) = OwnerLeaseRegistry::default().validate_claim(cmd)? else {
            return Err("release_owner_lease requires browser ownership fields".to_string());
        };
        let is_current = self.current_by_owner.get(&claim.owner_id) == Some(&claim.lease);
        if is_current {
            self.current_by_owner.remove(&claim.owner_id);
        }
        Ok(is_current)
    }
}

fn lease_fingerprint(lease_id: &str) -> String {
    if lease_id == "unscoped" {
        return lease_id.to_string();
    }
    let digest = Sha256::digest(lease_id.as_bytes());
    digest[..6]
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

fn browser_error_provenance(cmd: &Value, tab_id: u64, generation: &str) -> String {
    let owner_id = command_owner_id(cmd).unwrap_or("unscoped");
    let turn_id = cmd
        .get("turnId")
        .and_then(Value::as_str)
        .unwrap_or("unscoped");
    let lease_id = cmd
        .get("ownerLeaseId")
        .and_then(Value::as_str)
        .unwrap_or("unscoped");
    format!(
        "browser provenance: owner={} turn={} lease#={} tab={} generation={}",
        owner_id,
        turn_id,
        lease_fingerprint(lease_id),
        tab_id,
        generation
    )
}

/// Rejects an owner-scoped command unless the addressed tab is recorded for
/// that exact owner. Commands without `ownerId` retain unrestricted manual/UI
/// behavior.
fn validate_tab_ownership(cmd: &Value, mgr: &BrowserManager, tab_id: u64) -> Result<(), String> {
    let requested_generation = match cmd.get("tabGeneration") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("'tabGeneration' must be a non-empty string")?,
        ),
    };
    let current_generation = mgr.tab_generation_by_id(tab_id);
    let provenance = |generation: &str| browser_error_provenance(cmd, tab_id, generation);

    let Some(current_generation) = current_generation else {
        return Err(format!(
            "Tab {} was released or closed; the handle is no longer usable [{}]",
            tab_id,
            provenance(requested_generation.unwrap_or("unknown"))
        ));
    };
    if let Some(requested_generation) = requested_generation {
        if requested_generation != current_generation {
            return Err(format!(
                "Tab {} handle generation \"{}\" was replaced by generation \"{}\"; the numeric tab id was reused [{}]",
                tab_id,
                requested_generation,
                current_generation,
                provenance(requested_generation)
            ));
        }
    }

    let Some(owner_id) = command_owner_id(cmd) else {
        return Ok(());
    };
    match mgr.owner_of_tab(tab_id).as_deref() {
        Some(actual_owner) if actual_owner == owner_id => Ok(()),
        Some(_) => Err(format!(
            "Tab {} was transferred to a different browser owner [{}]",
            tab_id,
            provenance(current_generation)
        )),
        None => Err(format!(
            "Tab {} was released from browser owner \"{}\" [{}]",
            tab_id,
            owner_id,
            provenance(current_generation)
        )),
    }
}

/// Validates `finalize_tabs`/`close_owner` action-specific inputs after the
/// common owner-lease fence has authenticated the caller. `keep` is optional
/// (missing means "close everything") but must be well-formed when present.
fn validate_owner_finalization(cmd: &Value, action: &str) -> Result<(), String> {
    let owner_id = command_owner_id(cmd)
        .ok_or_else(|| format!("Action '{}' requires a non-empty ownerId", action))?;
    if owner_id.len() > 256 {
        return Err(format!("Action '{}' ownerId is too long", action));
    }

    if action == "finalize_tabs" {
        let keep = match cmd.get("keep") {
            None | Some(Value::Null) => return Ok(()),
            Some(value) => value
                .as_array()
                .ok_or("finalize_tabs keep must be an array")?,
        };
        let mut seen = std::collections::HashSet::new();
        for (index, entry) in keep.iter().enumerate() {
            let entry = entry
                .as_object()
                .ok_or_else(|| format!("finalize_tabs keep entry {} must be an object", index))?;
            if entry
                .keys()
                .any(|key| key != "tabId" && key != "tabGeneration" && key != "status")
            {
                return Err(format!(
                    "finalize_tabs keep entry {} has unknown fields",
                    index
                ));
            }
            let tab_id = entry
                .get("tabId")
                .and_then(Value::as_u64)
                .filter(|tab_id| *tab_id > 0 && *tab_id <= u32::MAX as u64)
                .ok_or_else(|| {
                    format!(
                        "finalize_tabs keep entry {} tabId must be a positive integer",
                        index
                    )
                })?;
            if !seen.insert(tab_id) {
                return Err(format!(
                    "finalize_tabs keep contains duplicate tabId {}",
                    tab_id
                ));
            }
            if let Some(generation) = entry.get("tabGeneration") {
                if generation
                    .as_str()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                {
                    return Err(format!(
                        "finalize_tabs keep entry {} tabGeneration must be a non-empty string",
                        index
                    ));
                }
            }
            match entry.get("status").and_then(Value::as_str) {
                Some("handoff" | "deliverable") => {}
                _ => {
                    return Err(format!(
                        "finalize_tabs keep entry {} has invalid status",
                        index
                    ));
                }
            }
        }
    }

    Ok(())
}

pub struct HarEntry {
    pub request_id: String,
    /// Seconds since Unix epoch (CDP `wallTime`), with sub-second precision.
    pub wall_time: f64,
    // Request fields
    pub method: String,
    pub url: String,
    pub request_headers: Vec<(String, String)>,
    pub post_data: Option<String>,
    pub request_body_size: i64,
    pub resource_type: String,
    // Response fields — populated by `Network.responseReceived`
    pub status: Option<i64>,
    pub status_text: String,
    /// Normalised from CDP `response.protocol` (e.g. `"h2"` → `"HTTP/2.0"`).
    pub http_version: String,
    pub response_headers: Vec<(String, String)>,
    pub mime_type: String,
    pub redirect_url: String,
    /// Updated by `Network.loadingFinished` for final accuracy.
    pub response_body_size: i64,
    /// Response payload, captured only for API-shaped requests. Without it a
    /// HAR records that a call happened but not what it returned, which is not
    /// enough to derive a client from.
    pub response_body: Option<String>,
    pub response_body_base64: bool,
    pub response_body_truncated: bool,
    /// Raw CDP `ResourceTiming` object from `Network.responseReceived`.
    pub cdp_timing: Option<Value>,
    /// Monotonic timestamp (seconds) from `Network.loadingFinished`; used to
    /// compute the `receive` timing phase.
    pub loading_finished_timestamp: Option<f64>,
}

pub struct RouteEntry {
    pub url_pattern: String,
    pub response: Option<RouteResponse>,
    pub abort: bool,
}

pub struct RouteResponse {
    pub status: Option<u16>,
    pub body: Option<String>,
    pub content_type: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
}

pub struct RequestRewriteEntry {
    pub session_id: String,
    pub url_pattern: String,
    pub method: Option<String>,
    pub post_data: Option<String>,
    pub json_patch: Option<Value>,
    pub headers: HashMap<String, String>,
}

#[derive(Clone, serde::Serialize)]
pub struct TrackedRequest {
    #[serde(skip)]
    pub request_id: String,
    #[serde(skip)]
    pub session_id: String,
    pub url: String,
    pub method: String,
    pub headers: Value,
    #[serde(rename = "postData", skip_serializing_if = "Option::is_none")]
    pub post_data: Option<String>,
    #[serde(
        rename = "postDataTruncated",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub post_data_truncated: bool,
    pub timestamp: u64,
    #[serde(rename = "resourceType")]
    pub resource_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<i64>,
    #[serde(rename = "responseHeaders", skip_serializing_if = "Option::is_none")]
    pub response_headers: Option<Value>,
    #[serde(rename = "mimeType", skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(rename = "bodyBase64", skip_serializing_if = "std::ops::Not::not")]
    pub body_base64: bool,
    #[serde(rename = "bodyTruncated", skip_serializing_if = "std::ops::Not::not")]
    pub body_truncated: bool,
    pub completed: bool,
    #[serde(rename = "failureText", skip_serializing_if = "Option::is_none")]
    pub failure_text: Option<String>,
}

pub struct FetchPausedRequest {
    pub request_id: String,
    pub url: String,
    pub resource_type: String,
    pub session_id: String,
    pub method: String,
    pub headers: Value,
    pub post_data: Option<String>,
}

const MAX_TRACKED_REQUESTS: usize = 256;
const MAX_TRACKED_BODY_BYTES: usize = 128 * 1024;
const MAX_TRACKED_TOTAL_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_TRACKED_REQUEST_BODY_BYTES: usize = 128 * 1024;
const MAX_TRACKED_HEADERS: usize = 128;
const MAX_TRACKED_HEADER_VALUE_BYTES: usize = 8 * 1024;

fn truncate_utf8(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn bounded_header_object(headers: Option<&Value>) -> Value {
    Value::Object(
        headers
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .take(MAX_TRACKED_HEADERS)
            .map(|(name, value)| {
                let (text, _) =
                    truncate_utf8(value.as_str().unwrap_or(""), MAX_TRACKED_HEADER_VALUE_BYTES);
                (name.clone(), Value::String(text))
            })
            .collect(),
    )
}

pub enum BackendType {
    Cdp,
    WebDriver,
    Extension,
}

#[derive(Clone)]
struct ExtensionProxy {
    session: String,
    delegate_token: String,
}

pub struct DaemonState {
    pub browser: Option<BrowserManager>,
    pub extension_bridge: Option<ExtensionBridge>,
    extension_proxy: Option<ExtensionProxy>,
    pub appium: Option<AppiumManager>,
    pub safari_driver: Option<safari::SafariDriverProcess>,
    pub webdriver_backend: Option<super::webdriver::backend::WebDriverBackend>,
    pub backend_type: BackendType,
    pub ref_map: RefMap,
    pub domain_filter: Option<DomainFilter>,
    pub event_tracker: EventTracker,
    pub session_name: Option<String>,
    pub session_id: String,
    pub tracing_state: TracingState,
    pub recording_state: RecordingState,
    event_rx: Option<broadcast::Receiver<CdpEvent>>,
    pub screencasting: bool,
    pub policy: Option<ActionPolicy>,
    pub pending_confirmation: Option<PendingConfirmation>,
    pub har_recording: bool,
    pub har_entries: Vec<HarEntry>,
    /// Request IDs whose response bodies still need to be pulled from CDP.
    /// Bodies cannot be read from inside the synchronous event drain, and they
    /// are evicted from the CDP buffer on navigation, so they are collected
    /// here and fetched on the next command tick.
    pub har_pending_bodies: Vec<String>,
    /// Running total of captured body bytes for the open recording.
    pub har_body_bytes: usize,
    pub confirm_actions: Option<ConfirmActions>,
    pub inspect_server: Option<InspectServer>,
    pub routes: Vec<RouteEntry>,
    pub request_rewrites: Vec<RequestRewriteEntry>,
    pub tracked_requests: Vec<TrackedRequest>,
    pub tracked_pending_bodies: Vec<(String, String)>,
    pub tracked_body_bytes: usize,
    pub request_tracking: bool,
    pub active_frame_id: Option<String>,
    /// Directory downloads are routed to, recorded when the `download` action
    /// configures Browser.setDownloadBehavior so `waitfordownload` can report
    /// the real on-disk path of a completed download.
    pub download_dir: Option<String>,
    /// Shared slot for stream server to receive CDP client when browser launches.
    pub stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
    /// Stream server instance kept alive so the broadcast channel remains open.
    pub stream_server: Option<Arc<StreamServer>>,
    /// Signals the daemon accept loop to stop gracefully.
    pub daemon_shutdown_tx: Option<mpsc::UnboundedSender<()>>,
    owner_leases: OwnerLeaseRegistry,
}

impl DaemonState {
    pub fn new() -> Self {
        Self {
            browser: None,
            extension_bridge: None,
            extension_proxy: match (
                env::var("STELLA_BROWSER_EXTENSION_PROXY_SESSION").ok(),
                env::var("STELLA_BROWSER_EXTENSION_DELEGATE_TOKEN").ok(),
            ) {
                (Some(session), Some(delegate_token))
                    if !session.trim().is_empty() && !delegate_token.trim().is_empty() =>
                {
                    Some(ExtensionProxy {
                        session: session.trim().to_string(),
                        delegate_token: delegate_token.trim().to_string(),
                    })
                }
                _ => None,
            },
            appium: None,
            safari_driver: None,
            webdriver_backend: None,
            backend_type: BackendType::Cdp,
            ref_map: RefMap::new(),
            domain_filter: env::var("STELLA_BROWSER_ALLOWED_DOMAINS")
                .ok()
                .filter(|s| !s.is_empty())
                .map(|s| DomainFilter::new(&s)),
            event_tracker: EventTracker::new(),
            session_name: env::var("STELLA_BROWSER_SESSION_NAME").ok(),
            session_id: env::var("STELLA_BROWSER_SESSION")
                .unwrap_or_else(|_| "default".to_string()),
            tracing_state: TracingState::new(),
            recording_state: RecordingState::new(),
            event_rx: None,
            screencasting: false,
            policy: ActionPolicy::load_if_exists(),
            pending_confirmation: None,
            har_recording: false,
            har_entries: Vec::new(),
            har_pending_bodies: Vec::new(),
            har_body_bytes: 0,
            confirm_actions: ConfirmActions::from_env(),
            inspect_server: None,
            routes: Vec::new(),
            request_rewrites: Vec::new(),
            tracked_requests: Vec::new(),
            tracked_pending_bodies: Vec::new(),
            tracked_body_bytes: 0,
            request_tracking: false,
            active_frame_id: None,
            download_dir: env::var("STELLA_BROWSER_DOWNLOAD_PATH")
                .ok()
                .filter(|s| !s.is_empty()),
            stream_client: None,
            owner_leases: OwnerLeaseRegistry::default(),
            stream_server: None,
            daemon_shutdown_tx: None,
        }
    }

    /// Create state with an optional stream client slot and server instance
    /// (for daemon startup with stream server).
    pub fn new_with_stream(
        stream_client: Option<Arc<RwLock<Option<Arc<CdpClient>>>>>,
        stream_server: Option<Arc<StreamServer>>,
    ) -> Self {
        let mut s = Self::new();
        s.stream_client = stream_client;
        s.stream_server = stream_server;
        s
    }

    fn subscribe_to_browser_events(&mut self) {
        if let Some(ref browser) = self.browser {
            self.event_rx = Some(browser.client.subscribe());
        }
    }

    /// Update the stream server's CDP client slot when browser is set or cleared.
    pub async fn update_stream_client(&self) {
        if let Some(ref slot) = self.stream_client {
            let mut guard = slot.write().await;
            *guard = self.browser.as_ref().map(|m| Arc::clone(&m.client));
        }
        if let Some(ref server) = self.stream_server {
            // Update the CDP page session ID so screencast commands target the right page
            let session_id = self
                .browser
                .as_ref()
                .and_then(|m| m.active_session_id().ok().map(|s| s.to_string()));
            server.set_cdp_session_id(session_id).await;

            // Broadcast connection status change to WebSocket clients
            let connected = self.browser.is_some();
            let sc = server.is_screencasting().await;
            server.broadcast_status(connected, sc, 1280, 720);
            // Notify the background CDP event loop that the client changed
            server.notify_client_changed();
        }
    }

    /// Spawn a background task that polls screenshots and pipes them to ffmpeg.
    async fn start_recording_task(
        &mut self,
        client: Arc<CdpClient>,
        session_id: String,
    ) -> Result<(), String> {
        let shared_count = Arc::new(AtomicU64::new(0));
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let handle = recording::spawn_recording_task(
            client,
            session_id,
            self.recording_state.output_path.clone(),
            shared_count.clone(),
            cancel_rx,
        );
        self.recording_state.capture_task = Some(handle);
        self.recording_state.shared_frame_count = Some(shared_count);
        self.recording_state.cancel_tx = Some(cancel_tx);
        Ok(())
    }

    async fn stop_recording_task(&mut self) -> Result<(), String> {
        recording::stop_recording_task(&mut self.recording_state).await
    }

    fn drain_cdp_events(
        &mut self,
    ) -> (
        Vec<i64>,
        Vec<TargetCreatedEvent>,
        Vec<String>,
        Vec<FetchPausedRequest>,
    ) {
        let rx = match self.event_rx.as_mut() {
            Some(rx) => rx,
            None => return (Vec::new(), Vec::new(), Vec::new(), Vec::new()),
        };

        let mut pending_acks: Vec<i64> = Vec::new();
        let mut new_targets: Vec<TargetCreatedEvent> = Vec::new();
        let mut destroyed_targets: Vec<String> = Vec::new();
        let mut fetch_paused: Vec<FetchPausedRequest> = Vec::new();

        loop {
            match rx.try_recv() {
                Ok(event) => {
                    // Target events are not session-scoped; handle them first
                    match event.method.as_str() {
                        "Target.targetCreated" => {
                            if let Ok(te) =
                                serde_json::from_value::<TargetCreatedEvent>(event.params.clone())
                            {
                                if (te.target_info.target_type == "page"
                                    || te.target_info.target_type == "webview")
                                    && !te.target_info.url.is_empty()
                                {
                                    let already_tracked = self
                                        .browser
                                        .as_ref()
                                        .is_none_or(|b| b.has_target(&te.target_info.target_id));
                                    if !already_tracked {
                                        new_targets.push(te);
                                    }
                                }
                            }
                            continue;
                        }
                        "Target.targetDestroyed" => {
                            if let Ok(te) =
                                serde_json::from_value::<TargetDestroyedEvent>(event.params.clone())
                            {
                                destroyed_targets.push(te.target_id);
                            }
                            continue;
                        }
                        _ => {}
                    }

                    let session_matches = if let Some(ref browser) = self.browser {
                        event.session_id.as_deref() == browser.active_session_id().ok()
                    } else {
                        false
                    };

                    // Network observation is tab-scoped, but events can arrive
                    // after another owned tab becomes active. Preserve traffic
                    // from every attached page session; non-network events keep
                    // their historical active-tab-only behavior.
                    let attached_network_session = event.method.starts_with("Network.")
                        && self.browser.as_ref().is_some_and(|browser| {
                            event
                                .session_id
                                .as_deref()
                                .is_some_and(|session_id| browser.has_session_id(session_id))
                        });

                    if !session_matches && !attached_network_session {
                        continue;
                    }

                    match event.method.as_str() {
                        "Runtime.consoleAPICalled" => {
                            if let Ok(console_event) = serde_json::from_value::<ConsoleApiCalledEvent>(
                                event.params.clone(),
                            ) {
                                let text: String = console_event
                                    .args
                                    .iter()
                                    .filter_map(|arg| {
                                        arg.value
                                            .as_ref()
                                            .map(|v| match v {
                                                Value::String(s) => s.clone(),
                                                other => other.to_string(),
                                            })
                                            .or_else(|| arg.description.clone())
                                    })
                                    .collect::<Vec<_>>()
                                    .join(" ");
                                self.event_tracker
                                    .add_console(&console_event.call_type, &text);
                            }
                        }
                        "Runtime.exceptionThrown" => {
                            if let Ok(ex_event) =
                                serde_json::from_value::<ExceptionThrownEvent>(event.params.clone())
                            {
                                let details = &ex_event.exception_details;
                                let text = details
                                    .exception
                                    .as_ref()
                                    .and_then(|e| e.description.as_deref())
                                    .unwrap_or(&details.text);
                                self.event_tracker.add_error(
                                    text,
                                    None,
                                    details.line_number,
                                    details.column_number,
                                );
                            }
                        }
                        "Network.requestWillBeSent"
                            if self.har_recording || self.request_tracking =>
                        {
                            if let Some(request) = event.params.get("request") {
                                let method = request
                                    .get("method")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("GET")
                                    .to_string();
                                let url = request
                                    .get("url")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let request_id = event
                                    .params
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if self.har_recording {
                                    let wall_time = event
                                        .params
                                        .get("wallTime")
                                        .and_then(|v| v.as_f64())
                                        .unwrap_or(0.0);
                                    let request_headers =
                                        har_extract_headers(request.get("headers"));
                                    let post_data = request
                                        .get("postData")
                                        .and_then(|v| v.as_str())
                                        .map(String::from);
                                    let request_body_size =
                                        post_data.as_ref().map(|s| s.len() as i64).unwrap_or(0);
                                    let resource_type = event
                                        .params
                                        .get("type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("Other")
                                        .to_string();
                                    self.har_entries.push(HarEntry {
                                        request_id: request_id.clone(),
                                        wall_time,
                                        method: method.clone(),
                                        url: url.clone(),
                                        request_headers,
                                        post_data,
                                        request_body_size,
                                        resource_type,
                                        status: None,
                                        status_text: String::new(),
                                        http_version: "HTTP/1.1".to_string(),
                                        response_headers: Vec::new(),
                                        mime_type: String::new(),
                                        redirect_url: String::new(),
                                        response_body_size: -1,
                                        response_body: None,
                                        response_body_base64: false,
                                        response_body_truncated: false,
                                        cdp_timing: None,
                                        loading_finished_timestamp: None,
                                    });
                                }
                                if self.request_tracking {
                                    let headers = bounded_header_object(request.get("headers"));
                                    let resource_type = event
                                        .params
                                        .get("type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("Other")
                                        .to_string();
                                    let timestamp = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_millis() as u64)
                                        .unwrap_or(0);
                                    let (post_data, post_data_truncated) = request
                                        .get("postData")
                                        .and_then(Value::as_str)
                                        .map(|post_data| {
                                            let (body, truncated) = truncate_utf8(
                                                post_data,
                                                MAX_TRACKED_REQUEST_BODY_BYTES,
                                            );
                                            (Some(body), truncated)
                                        })
                                        .unwrap_or((None, false));
                                    self.tracked_requests.push(TrackedRequest {
                                        request_id,
                                        session_id: event.session_id.clone().unwrap_or_default(),
                                        url,
                                        method,
                                        headers,
                                        post_data,
                                        post_data_truncated,
                                        timestamp,
                                        resource_type,
                                        status: None,
                                        response_headers: None,
                                        mime_type: None,
                                        body: None,
                                        body_base64: false,
                                        body_truncated: false,
                                        completed: false,
                                        failure_text: None,
                                    });
                                    while self.tracked_requests.len() > MAX_TRACKED_REQUESTS {
                                        let evicted = self.tracked_requests.remove(0);
                                        self.tracked_body_bytes =
                                            self.tracked_body_bytes.saturating_sub(
                                                evicted.body.as_ref().map_or(0, String::len),
                                            );
                                    }
                                }
                            }
                        }
                        "Network.responseReceived"
                            if self.har_recording || self.request_tracking =>
                        {
                            if let Some(response) = event.params.get("response") {
                                let request_id = event
                                    .params
                                    .get("requestId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                let status = response.get("status").and_then(|v| v.as_i64());
                                let status_text = response
                                    .get("statusText")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let mime_type = response
                                    .get("mimeType")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let http_version = response
                                    .get("protocol")
                                    .and_then(|v| v.as_str())
                                    .map(har_cdp_protocol_to_http_version)
                                    .unwrap_or_else(|| "HTTP/1.1".to_string());
                                let response_headers = har_extract_headers(response.get("headers"));
                                let redirect_url = response_headers
                                    .iter()
                                    .find(|(k, _)| k.eq_ignore_ascii_case("location"))
                                    .map(|(_, v)| v.clone())
                                    .unwrap_or_default();
                                let encoded_data_length = response
                                    .get("encodedDataLength")
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(-1);
                                let cdp_timing = response.get("timing").cloned();
                                if let Some(entry) = self
                                    .har_entries
                                    .iter_mut()
                                    .rev()
                                    .find(|e| e.request_id == request_id)
                                {
                                    entry.status = status;
                                    entry.status_text = status_text;
                                    entry.mime_type = mime_type;
                                    entry.http_version = http_version;
                                    entry.response_headers = response_headers;
                                    entry.redirect_url = redirect_url;
                                    entry.response_body_size = encoded_data_length;
                                    entry.cdp_timing = cdp_timing;
                                }
                                if self.request_tracking {
                                    if let Some(entry) =
                                        self.tracked_requests.iter_mut().rev().find(|entry| {
                                            entry.request_id == request_id
                                                && event.session_id.as_deref()
                                                    == Some(entry.session_id.as_str())
                                        })
                                    {
                                        entry.status = status;
                                        entry.response_headers =
                                            Some(bounded_header_object(response.get("headers")));
                                        entry.mime_type = response
                                            .get("mimeType")
                                            .and_then(Value::as_str)
                                            .map(String::from);
                                    }
                                }
                            }
                        }
                        "Network.loadingFinished"
                            if self.har_recording || self.request_tracking =>
                        {
                            let request_id = event
                                .params
                                .get("requestId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            let timestamp = event.params.get("timestamp").and_then(|v| v.as_f64());
                            let encoded_data_length = event
                                .params
                                .get("encodedDataLength")
                                .and_then(|v| v.as_i64());
                            let mut wants_body = false;
                            if let Some(entry) = self
                                .har_entries
                                .iter_mut()
                                .rev()
                                .find(|e| e.request_id == request_id)
                            {
                                if let Some(ts) = timestamp {
                                    entry.loading_finished_timestamp = Some(ts);
                                }
                                if let Some(len) = encoded_data_length {
                                    entry.response_body_size = len;
                                }
                                wants_body =
                                    har_is_api_shaped(&entry.resource_type, &entry.mime_type);
                            }
                            if wants_body {
                                self.har_pending_bodies.push(request_id.to_string());
                            }
                            if self.request_tracking {
                                if let Some(entry) =
                                    self.tracked_requests.iter_mut().rev().find(|entry| {
                                        entry.request_id == request_id
                                            && event.session_id.as_deref()
                                                == Some(entry.session_id.as_str())
                                    })
                                {
                                    entry.completed = true;
                                    self.tracked_pending_bodies
                                        .push((entry.session_id.clone(), request_id.to_string()));
                                }
                            }
                        }
                        "Network.loadingFailed" if self.request_tracking => {
                            let request_id = event
                                .params
                                .get("requestId")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            if let Some(entry) =
                                self.tracked_requests.iter_mut().rev().find(|entry| {
                                    entry.request_id == request_id
                                        && event.session_id.as_deref()
                                            == Some(entry.session_id.as_str())
                                })
                            {
                                entry.completed = true;
                                entry.failure_text = event
                                    .params
                                    .get("errorText")
                                    .and_then(Value::as_str)
                                    .map(String::from);
                            }
                        }
                        "Page.screencastFrame" => {
                            // Frame broadcasting and acks are handled in real-time by the
                            // stream server's background CDP event loop. Here we just
                            // collect acks as a fallback for non-streaming mode.
                            if self.stream_server.is_none() {
                                if let Some(sid) =
                                    event.params.get("sessionId").and_then(|v| v.as_i64())
                                {
                                    pending_acks.push(sid);
                                }
                            }
                        }
                        "Fetch.requestPaused" => {
                            let request_id = event
                                .params
                                .get("requestId")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let request_url = event
                                .params
                                .get("request")
                                .and_then(|r| r.get("url"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let resource_type = event
                                .params
                                .get("resourceType")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let sid = event.session_id.clone().unwrap_or_default();
                            let request = event.params.get("request");

                            fetch_paused.push(FetchPausedRequest {
                                request_id,
                                url: request_url,
                                resource_type,
                                session_id: sid,
                                method: request
                                    .and_then(|request| request.get("method"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("GET")
                                    .to_string(),
                                headers: request
                                    .and_then(|request| request.get("headers"))
                                    .cloned()
                                    .unwrap_or_else(|| json!({})),
                                post_data: request
                                    .and_then(|request| request.get("postData"))
                                    .and_then(Value::as_str)
                                    .map(String::from),
                            });
                        }
                        _ => {}
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => break,
                Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(broadcast::error::TryRecvError::Closed) => {
                    self.event_rx = None;
                    break;
                }
            }
        }

        (pending_acks, new_targets, destroyed_targets, fetch_paused)
    }
}

pub async fn execute_command(cmd: &Value, state: &mut DaemonState) -> Value {
    let action = cmd.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let id = cmd
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if !is_known_action(action) {
        return error_response(&id, &format!("Not yet implemented: {}", action));
    }

    let targets_extension = command_targets_extension(cmd);

    if action == "release_owner_lease" && targets_extension {
        if let Err(error) = state.owner_leases.release(cmd) {
            return error_response(&id, &error);
        }
        return forward_targeted_extension_command(cmd, state).await;
    }

    if action == "release_owner_lease" {
        return match state.owner_leases.release(cmd) {
            Ok(released) => success_response(&id, json!({ "released": released })),
            Err(error) => error_response(&id, &error),
        };
    }

    let owner_lease_claim = match state.owner_leases.validate_claim(cmd) {
        Ok(claim) => claim,
        Err(error) => return error_response(&id, &error),
    };
    if let Some(ref claim) = owner_lease_claim {
        // Lease rotation fences stale callers but deliberately preserves the
        // durable task's tabs. A replacement worker/REPL generation reclaims
        // them; only an explicit end-of-task finalize/close_owner destroys
        // targets.
        state.owner_leases.commit(claim);
    }

    let chain_actions = if action == "chain" {
        match validate_chain_actions(cmd) {
            Ok(actions) => actions,
            Err(error) => return error_response(&id, &error),
        }
    } else {
        Vec::new()
    };
    if action == "chain" {
        if let Err(error) = chain_runtime_budget_ms(cmd) {
            return error_response(&id, &error);
        }
    }
    let actions_to_authorize: Vec<&str> = std::iter::once(action)
        .chain(chain_actions.iter().copied())
        .collect();

    if action == "finalize_tabs" || action == "close_owner" {
        if let Err(error) = validate_owner_finalization(cmd, action) {
            return error_response(&id, &error);
        }
    }

    // Drain pending CDP events (console, errors, screencast frames, target lifecycle, fetch)
    let (pending_acks, new_targets, destroyed_targets, fetch_paused) = state.drain_cdp_events();
    // Bodies are read here rather than at har_stop because a navigation clears
    // the CDP buffer, which would silently drop every payload recorded before it.
    har_collect_pending_bodies(state).await;
    tracked_collect_pending_bodies(state).await;
    if !pending_acks.is_empty() {
        if let Some(ref browser) = state.browser {
            if let Ok(session_id) = browser.active_session_id() {
                for ack_sid in pending_acks {
                    let _ =
                        stream::ack_screencast_frame(&browser.client, session_id, ack_sid).await;
                }
            }
        }
    }

    for target_id in &destroyed_targets {
        if let Some(ref mut mgr) = state.browser {
            mgr.remove_page_by_target_id(target_id);
        }
    }

    for te in &new_targets {
        if let Some(ref mut mgr) = state.browser {
            let attach_result: Result<AttachToTargetResult, String> = mgr
                .client
                .send_command_typed(
                    "Target.attachToTarget",
                    &AttachToTargetParams {
                        target_id: te.target_info.target_id.clone(),
                        flatten: true,
                    },
                    None,
                )
                .await;
            if let Ok(attach) = attach_result {
                let _ = mgr.enable_domains_pub(&attach.session_id).await;

                // Install domain filter on new pages
                if let Some(ref filter) = state.domain_filter {
                    let _ = network::install_domain_filter(
                        &mgr.client,
                        &attach.session_id,
                        &filter.allowed_domains,
                    )
                    .await;
                }

                let tab_id = mgr.add_page(super::browser::PageInfo {
                    target_id: te.target_info.target_id.clone(),
                    session_id: attach.session_id,
                    tab_id: 0,                     // assigned by add_page
                    tab_generation: String::new(), // assigned by add_page
                    url: te.target_info.url.clone(),
                    title: te.target_info.title.clone(),
                    target_type: te.target_info.target_type.clone(),
                });

                // Popups inherit ownership from their opener tab (mirrors the
                // extension's owner-tab adoption): a tab opened by an
                // owner-tracked tab belongs to the same owner, so
                // finalize_tabs reaps it too. Tabs without a tracked opener
                // (e.g. user-created tabs in the in-app browser) stay
                // unowned and are never reaped on the owner's behalf.
                let opener_owner = te
                    .target_info
                    .opener_id
                    .as_deref()
                    .and_then(|opener_target_id| mgr.known_tab_id_for_target(opener_target_id))
                    .and_then(|opener_tab_id| mgr.owner_of_tab(opener_tab_id));
                if let Some(owner_id) = opener_owner {
                    mgr.record_owner_tab(&owner_id, tab_id);
                }
            }
        }
    }

    // Handle Fetch.requestPaused events (route interception + domain filter)
    for paused in &fetch_paused {
        if let Some(ref browser) = state.browser {
            resolve_fetch_paused(
                browser,
                state.domain_filter.as_ref(),
                &state.routes,
                &state.request_rewrites,
                paused,
            )
            .await;
        }
    }

    // Hot-reload and check action policy
    if let Some(ref mut policy) = state.policy {
        let _ = policy.reload();
        for policy_action in &actions_to_authorize {
            match policy.check(policy_action) {
                PolicyResult::Allow => {}
                PolicyResult::Deny(reason) => {
                    return error_response(
                        &id,
                        &format!("Action '{}' denied by policy: {}", policy_action, reason),
                    );
                }
                PolicyResult::RequiresConfirmation => {
                    state.pending_confirmation = Some(PendingConfirmation {
                        action: (*policy_action).to_string(),
                        cmd: cmd.clone(),
                    });
                    return json!({
                        "id": id,
                        "success": true,
                        "data": { "confirmation_required": true, "action": policy_action },
                    });
                }
            }
        }
    }

    // Check STELLA_BROWSER_CONFIRM_ACTIONS (category-based, independent of policy file)
    if action != "confirm" && action != "deny" {
        if let Some(ref ca) = state.confirm_actions {
            for confirm_action in &actions_to_authorize {
                if ca.requires_confirmation(confirm_action) {
                    state.pending_confirmation = Some(PendingConfirmation {
                        action: (*confirm_action).to_string(),
                        cmd: cmd.clone(),
                    });
                    return json!({
                        "id": id,
                        "success": true,
                        "data": {
                            "confirmation_required": true,
                            "confirmation_id": id,
                            "action": confirm_action,
                        },
                    });
                }
            }
        }
    }

    if targets_extension {
        if let Err(error) = validate_extension_domain_gates(cmd, state) {
            return error_response(&id, &error);
        }
        return forward_targeted_extension_command(cmd, state).await;
    }

    let skip_launch = matches!(
        action,
        "" | "healthcheck"
            | "launch"
            | "close"
            | "credentials_set"
            | "credentials_get"
            | "credentials_delete"
            | "credentials_list"
            | "auth_save"
            | "auth_show"
            | "auth_delete"
            | "auth_list"
            | "state_list"
            | "state_show"
            | "state_clear"
            | "state_clean"
            | "state_rename"
            | "device_list"
            | "finalize_tabs"
            | "close_owner"
            | "release_owner_lease"
            | "cookies_export_all"
            | "cookies_export_for_urls"
            | "extension_status"
    );
    if !skip_launch && !matches!(state.backend_type, BackendType::Extension) {
        // Check if existing connection is stale and needs re-launch
        let needs_launch = if let Some(ref mgr) = state.browser {
            !mgr.is_connection_alive().await
        } else {
            true
        };

        if needs_launch {
            if state.browser.is_some() {
                if let Some(ref mut mgr) = state.browser {
                    let _ = mgr.close().await;
                }
                state.browser = None;
                state.update_stream_client().await;
            }
            if let Err(e) = auto_launch(state, command_owner_id(cmd)).await {
                return error_response(&id, &format!("Auto-launch failed: {}", e));
            }
        }

        // Validate an explicit stable tab id before creating or selecting any
        // owner tab. This prevents a rejected foreign-tab command from
        // mutating browser state as a side effect.
        if let Some(tab_id_value) = cmd.get("tabId") {
            let Some(tab_id) = tab_id_value.as_u64().filter(|tab_id| *tab_id > 0) else {
                return error_response(&id, "'tabId' must be a positive integer");
            };
            if let Some(ref mgr) = state.browser {
                if let Err(error) = validate_tab_ownership(cmd, mgr, tab_id) {
                    return error_response(&id, &error);
                }
            }
        }

        if let Some(ref mut mgr) = state.browser {
            if let Some(owner_id) = command_owner_id(cmd) {
                // An owner's first implicit page must be its own even when
                // other owners or the user already have tabs in the shared
                // in-app browser. Explicit tab commands resolve the requested
                // tab instead, and tab_new creates/records its own page.
                if mgr.owner_tab_ids(owner_id).is_empty()
                    && cmd.get("tabId").is_none()
                    && !matches!(action, "tab_new" | "tab_switch" | "tab_close")
                {
                    match mgr.tab_new(None).await {
                        Ok(result) => {
                            if let Some(tab_id) = result.get("tabId").and_then(Value::as_u64) {
                                mgr.record_owner_tab(owner_id, tab_id);
                                state.ref_map.clear();
                            }
                        }
                        Err(error) => return error_response(&id, &error),
                    }
                }

                // Commands without an explicit tab address operate on the
                // owner's logical active tab, not whichever other owner most
                // recently changed the process-global CDP page.
                if cmd.get("tabId").is_none()
                    && !matches!(action, "tab_list" | "tab_new" | "tab_switch" | "tab_close")
                {
                    if let Some(tab_id) = mgr.active_tab_id_for_owner(Some(owner_id)) {
                        match mgr.select_tab_by_id(tab_id).await {
                            Ok(switched) => {
                                if switched {
                                    state.ref_map.clear();
                                }
                            }
                            Err(error) => return error_response(&id, &error),
                        }
                    }
                }
            } else if mgr.page_count() == 0 {
                // Legacy/manual requests remain unowned and retain the old
                // shared-page behavior.
                if let Err(error) = mgr.ensure_page().await {
                    return error_response(&id, &error);
                }
            }
        }
    }

    // WebDriver backend: reject unsupported CDP-only actions
    if matches!(state.backend_type, BackendType::WebDriver)
        && WEBDRIVER_UNSUPPORTED_ACTIONS.contains(&action)
    {
        return error_response(
            &id,
            &format!(
                "Action '{}' is not supported on the WebDriver backend",
                action
            ),
        );
    }

    // The extension is a credential-seeding transport only. Never route agent
    // browser-control actions into the user's real Chrome/Brave profile.
    if matches!(state.backend_type, BackendType::Extension) {
        match action {
            "healthcheck" | "launch" | "close" | "extension_status" => {}
            "cookies_export_all" => {
                if let Some(ref bridge) = state.extension_bridge {
                    return forward_extension_command(cmd, bridge).await;
                }
                return error_response(
                    &id,
                    "Browser extension is not connected. Connect it before importing browser cookies.",
                );
            }
            "cookies_export_for_urls" => {
                if let Some(ref bridge) = state.extension_bridge {
                    return export_extension_cookies_for_urls(cmd, bridge).await;
                }
                return error_response(
                    &id,
                    "Browser extension is not connected. Connect it before importing browser cookies.",
                );
            }
            _ => {
                return error_response(
                    &id,
                    "In-app browser is not ready. Browser control runs on the Stella in-app browser; the extension transport only seeds credentials. Open the Stella in-app browser and try again.",
                );
            }
        }
    }

    // Callers built against the tab-addressed protocol (the browser worker
    // API) pass the stable `tabId` from tab_list/tab_new on every per-tab
    // action. The CDP handlers operate on the active page, so make the
    // addressed tab active first. tab_switch/tab_close resolve their own
    // target, and tab_list/tab_new take none.
    if !matches!(action, "tab_list" | "tab_new" | "tab_switch" | "tab_close") {
        if let Some(tab_id_value) = cmd.get("tabId") {
            match tab_id_value.as_u64().filter(|tab_id| *tab_id > 0) {
                None => return error_response(&id, "'tabId' must be a positive integer"),
                Some(tab_id) => {
                    if let Some(ref mut mgr) = state.browser {
                        match mgr.select_tab_by_id(tab_id).await {
                            Ok(switched) => {
                                if let Some(owner_id) = command_owner_id(cmd) {
                                    mgr.mark_owner_tab_active(owner_id, tab_id);
                                }
                                if switched {
                                    state.ref_map.clear();
                                }
                            }
                            Err(e) => return error_response(&id, &e),
                        }
                    }
                }
            }
        }
    }

    if action == "chain" {
        return handle_chain(cmd, state, &id).await;
    }

    let result = dispatch_action(action, cmd, state).await;

    match result {
        Ok(data) => success_response(&id, data),
        Err(e) => error_response(&id, &super::browser::to_ai_friendly_error(&e)),
    }
}

/// Single-step dispatch shared by top-level commands and chain steps. Every
/// per-action handler is routed through here so chains reuse the exact same
/// implementations (including the shared actionability waits) instead of
/// duplicating handler logic.
async fn dispatch_action(
    action: &str,
    cmd: &Value,
    state: &mut DaemonState,
) -> Result<Value, String> {
    match action {
        "healthcheck" => Ok(json!({ "status": "ok" })),
        "extension_status" => Ok(handle_extension_status(state).await),
        "launch" => handle_launch(cmd, state).await,
        "navigate" => handle_navigate(cmd, state).await,
        "url" => handle_url(state).await,
        "cdp_url" => handle_cdp_url(state),
        "inspect" => handle_inspect(state).await,
        "title" => handle_title(state).await,
        "content" => handle_content(state).await,
        "evaluate" => handle_evaluate(cmd, state).await,
        "evaluate_detached" => handle_evaluate_detached(cmd, state).await,
        "close" => handle_close(state).await,
        "snapshot" => handle_snapshot(cmd, state).await,
        "screenshot" => handle_screenshot(cmd, state).await,
        "click" => handle_click(cmd, state).await,
        "dblclick" => handle_dblclick(cmd, state).await,
        "fill" => handle_fill(cmd, state).await,
        "type" => handle_type(cmd, state).await,
        "press" => handle_press(cmd, state).await,
        "hover" => handle_hover(cmd, state).await,
        "scroll" => handle_scroll(cmd, state).await,
        "select" => handle_select(cmd, state).await,
        "check" => handle_check(cmd, state).await,
        "uncheck" => handle_uncheck(cmd, state).await,
        "wait" => handle_wait(cmd, state).await,
        "gettext" => handle_gettext(cmd, state).await,
        "getattribute" => handle_getattribute(cmd, state).await,
        "isvisible" => handle_isvisible(cmd, state).await,
        "isenabled" => handle_isenabled(cmd, state).await,
        "ischecked" => handle_ischecked(cmd, state).await,
        "back" => handle_back(state).await,
        "forward" => handle_forward(state).await,
        "reload" => handle_reload(state).await,
        "cookies_get" => handle_cookies_get(cmd, state).await,
        "cookies_set" => handle_cookies_set(cmd, state).await,
        "cookies_clear" => handle_cookies_clear(state).await,
        "storage_get" => handle_storage_get(cmd, state).await,
        "storage_set" => handle_storage_set(cmd, state).await,
        "storage_clear" => handle_storage_clear(cmd, state).await,
        "setcontent" => handle_setcontent(cmd, state).await,
        "headers" => handle_headers(cmd, state).await,
        "offline" => handle_offline(cmd, state).await,
        "console" => handle_console(state).await,
        "errors" => handle_errors(state).await,
        "state_save" => handle_state_save(cmd, state).await,
        "state_load" => handle_state_load(cmd, state).await,
        "state_list" => handle_state_list().await,
        "state_show" => handle_state_show(cmd).await,
        "state_clear" => handle_state_clear(cmd).await,
        "state_clean" => handle_state_clean(cmd).await,
        "state_rename" => handle_state_rename(cmd).await,
        "trace_start" => handle_trace_start(state).await,
        "trace_stop" => handle_trace_stop(cmd, state).await,
        "profiler_start" => handle_profiler_start(cmd, state).await,
        "profiler_stop" => handle_profiler_stop(cmd, state).await,
        "recording_start" => handle_recording_start(cmd, state).await,
        "recording_stop" => handle_recording_stop(state).await,
        "recording_restart" => handle_recording_restart(cmd, state).await,
        "pdf" => handle_pdf(cmd, state).await,
        "tab_list" => handle_tab_list(cmd, state).await,
        "tab_new" => handle_tab_new(cmd, state).await,
        "tab_switch" => handle_tab_switch(cmd, state).await,
        "tab_close" => handle_tab_close(cmd, state).await,
        "viewport" => handle_viewport(cmd, state).await,
        "useragent" | "user_agent" => handle_user_agent(cmd, state).await,
        "set_media" => handle_set_media(cmd, state).await,
        "download" => handle_download(cmd, state).await,
        "diff_snapshot" => handle_diff_snapshot(cmd, state).await,
        "diff_url" => handle_diff_url(cmd, state).await,
        "credentials_set" => handle_credentials_set(cmd).await,
        "credentials_get" => handle_credentials_get(cmd).await,
        "credentials_delete" => handle_credentials_delete(cmd).await,
        "credentials_list" => handle_credentials_list().await,
        "mouse" => handle_mouse(cmd, state).await,
        "keyboard" => handle_keyboard(cmd, state).await,
        "focus" => handle_focus(cmd, state).await,
        "clear" => handle_clear(cmd, state).await,
        "selectall" => handle_selectall(cmd, state).await,
        "scrollintoview" => handle_scrollintoview(cmd, state).await,
        "dispatch" => handle_dispatch(cmd, state).await,
        "highlight" => handle_highlight(cmd, state).await,
        "tap" => handle_tap(cmd, state).await,
        "boundingbox" => handle_boundingbox(cmd, state).await,
        "innertext" => handle_innertext(cmd, state).await,
        "innerhtml" => handle_innerhtml(cmd, state).await,
        "inputvalue" => handle_inputvalue(cmd, state).await,
        "setvalue" => handle_setvalue(cmd, state).await,
        "count" => handle_count(cmd, state).await,
        "styles" => handle_styles(cmd, state).await,
        "bringtofront" => handle_bringtofront(state).await,
        "timezone" => handle_timezone(cmd, state).await,
        "locale" => handle_locale(cmd, state).await,
        "geolocation" => handle_geolocation(cmd, state).await,
        "permissions" => handle_permissions(cmd, state).await,
        "dialog" => handle_dialog(cmd, state).await,
        "upload" => handle_upload(cmd, state).await,
        "addscript" => handle_addscript(cmd, state).await,
        "addinitscript" => handle_addinitscript(cmd, state).await,
        "addstyle" => handle_addstyle(cmd, state).await,
        "clipboard" => handle_clipboard(cmd, state).await,
        "wheel" => handle_wheel(cmd, state).await,
        "device" => handle_device(cmd, state).await,
        "screencast_start" => handle_screencast_start(cmd, state).await,
        "screencast_stop" => handle_screencast_stop(state).await,
        "waitforurl" => handle_waitforurl(cmd, state).await,
        "waitforloadstate" => handle_waitforloadstate(cmd, state).await,
        "waitforfunction" => handle_waitforfunction(cmd, state).await,
        "frame" => handle_frame(cmd, state).await,
        "mainframe" => handle_mainframe(state).await,
        "getbyrole" => handle_getbyrole(cmd, state).await,
        "getbytext" => handle_getbytext(cmd, state).await,
        "getbylabel" => handle_getbylabel(cmd, state).await,
        "getbyplaceholder" => handle_getbyplaceholder(cmd, state).await,
        "getbyalttext" => handle_getbyalttext(cmd, state).await,
        "getbytitle" => handle_getbytitle(cmd, state).await,
        "getbytestid" => handle_getbytestid(cmd, state).await,
        "nth" => handle_nth(cmd, state).await,
        "find" => handle_find(cmd, state).await,
        "evalhandle" => handle_evalhandle(cmd, state).await,
        "drag" => handle_drag(cmd, state).await,
        "expose" => handle_expose(cmd, state).await,
        "pause" => handle_pause(state).await,
        "multiselect" => handle_multiselect(cmd, state).await,
        "responsebody" => handle_responsebody(cmd, state).await,
        "waitfordownload" => handle_waitfordownload(cmd, state).await,
        "window_new" => handle_window_new(cmd, state).await,
        "diff_screenshot" => handle_diff_screenshot(cmd, state).await,
        "video_start" => handle_video_start(cmd, state).await,
        "video_stop" => handle_video_stop(state).await,
        "har_start" => handle_har_start(state).await,
        "har_stop" => handle_har_stop(cmd, state).await,
        "route" => handle_route(cmd, state).await,
        "unroute" => handle_unroute(cmd, state).await,
        "rewrite_request" => handle_rewrite_request(cmd, state).await,
        "unrewrite_request" => handle_unrewrite_request(cmd, state).await,
        "requests" => handle_requests(cmd, state).await,
        "authenticated_request" => handle_authenticated_request(cmd, state).await,
        "authenticated_request_batch" => handle_authenticated_request_batch(cmd, state).await,
        "credentials" => handle_http_credentials(cmd, state).await,
        "emulatemedia" => handle_set_media(cmd, state).await,
        "auth_save" => handle_auth_save(cmd).await,
        "auth_login" => handle_auth_login(cmd, state).await,
        "auth_list" => handle_credentials_list().await,
        "auth_delete" => handle_credentials_delete(cmd).await,
        "auth_show" => handle_auth_show(cmd).await,
        "confirm" => handle_confirm(cmd, state).await,
        "deny" => handle_deny(cmd, state).await,
        "swipe" => handle_swipe(cmd, state).await,
        "device_list" => handle_device_list().await,
        "input_mouse" => handle_input_mouse(cmd, state).await,
        "input_keyboard" => handle_input_keyboard(cmd, state).await,
        "input_touch" => handle_input_touch(cmd, state).await,
        "keydown" => handle_keydown(cmd, state).await,
        "keyup" => handle_keyup(cmd, state).await,
        "inserttext" => handle_inserttext(cmd, state).await,
        "mousemove" => handle_mousemove(cmd, state).await,
        "mousedown" => handle_mousedown(cmd, state).await,
        "mouseup" => handle_mouseup(cmd, state).await,
        // Chains are executed by handle_chain before dispatch; reaching this
        // arm means a nested chain step slipped past validation.
        "chain" => Err("Chain steps cannot contain a nested chain".to_string()),
        "finalize_tabs" | "close_owner" => handle_finalize_tabs(action, cmd, state).await,
        // Handled before launch/policy dispatch so release never creates a
        // browser and stale cleanup cannot reach tab mutation.
        "release_owner_lease" => unreachable!("release handled before dispatch"),
        "cookies_export_all" | "cookies_export_for_urls" => Err(format!(
            "Action '{}' requires the extension backend (it exports cookies from the user's real browser)",
            action
        )),
        _ => Err(format!("Not yet implemented: {}", action)),
    }
}

// ---------------------------------------------------------------------------
// Chain execution
// ---------------------------------------------------------------------------

const DEFAULT_CHAIN_COMMAND_TIMEOUT_MS: u64 = 30_000;
const MIN_CHAIN_RUNTIME_MS: u64 = 3 * 60_000;
/// Must stay aligned with MAX_BROWSER_CHAIN_TIMEOUT_MS in the runtime client.
const MAX_CHAIN_RUNTIME_MS: u64 = 4 * 60_000;
const CHAIN_STEP_BUDGET_MS: u64 = 1_000;
/// Default implicit selector wait per step, mirroring the extension executor.
const DEFAULT_CHAIN_WAIT_TIMEOUT_MS: u64 = 10_000;
/// Poll interval for the implicit selector-existence wait.
const CHAIN_SELECTOR_POLL_MS: u64 = 200;

async fn within_chain_deadline<T, F>(
    deadline: tokio::time::Instant,
    chain_budget_ms: u64,
    context: &str,
    operation: F,
) -> Result<T, String>
where
    F: Future<Output = T>,
{
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    tokio::time::timeout(remaining, operation)
        .await
        .map_err(|_| {
            format!(
                "Chain exceeded its {}ms execution budget {}",
                chain_budget_ms, context
            )
        })
}

fn chain_runtime_budget_ms(cmd: &Value) -> Result<u64, String> {
    if let Some(value) = cmd.get("timeout") {
        return value
            .as_u64()
            .filter(|timeout| *timeout > 0 && *timeout <= MAX_CHAIN_RUNTIME_MS)
            .ok_or_else(|| {
                format!(
                    "Chain timeout must be a positive integer no greater than {}ms",
                    MAX_CHAIN_RUNTIME_MS
                )
            });
    }

    let steps = cmd
        .get("steps")
        .and_then(Value::as_array)
        .ok_or("Chain steps must be an array")?;
    let should_wait = cmd
        .get("waitForSelector")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let selector_wait_steps = if should_wait {
        steps
            .iter()
            .filter(|step| step.get("selector").is_some() || step.get("ref").is_some())
            .count() as u64
    } else {
        0
    };
    let wait_timeout_ms = cmd
        .get("waitTimeout")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_CHAIN_WAIT_TIMEOUT_MS);
    let max_delay_ms = cmd
        .get("delay")
        .and_then(Value::as_object)
        .and_then(|delay| delay.get("max"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let delay_count = steps.len().saturating_sub(1) as u64;
    let requested = DEFAULT_CHAIN_COMMAND_TIMEOUT_MS
        .saturating_add((steps.len() as u64).saturating_mul(CHAIN_STEP_BUDGET_MS))
        .saturating_add(selector_wait_steps.saturating_mul(wait_timeout_ms))
        .saturating_add(delay_count.saturating_mul(max_delay_ms))
        .saturating_add(
            if cmd
                .get("returnSnapshot")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                DEFAULT_CHAIN_COMMAND_TIMEOUT_MS
            } else {
                0
            },
        )
        .saturating_add(
            if cmd
                .get("returnScreenshot")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                DEFAULT_CHAIN_COMMAND_TIMEOUT_MS
            } else {
                0
            },
        );
    Ok(requested.clamp(MIN_CHAIN_RUNTIME_MS, MAX_CHAIN_RUNTIME_MS))
}

fn chain_step_failure(index: usize, action: &str, error: String, duration_ms: u64) -> Value {
    json!({
        "step": index,
        "action": action,
        "success": false,
        "error": error,
        "durationMs": duration_ms,
    })
}

/// Random delay in `[min, max]` with a rough bell-curve distribution
/// (average of two uniform draws), matching the extension's randomDelay().
fn chain_random_delay_ms(min: u64, max: u64) -> u64 {
    if max <= min {
        return min;
    }
    let mut buf = [0u8; 16];
    if getrandom::getrandom(&mut buf).is_err() {
        return (min + max) / 2;
    }
    let first = u64::from_le_bytes(buf[0..8].try_into().unwrap());
    let second = u64::from_le_bytes(buf[8..16].try_into().unwrap());
    let span = max - min + 1;
    min + ((first % span) + (second % span)) / 2
}

/// Implicit per-step wait: poll for the step's selector/ref to resolve before
/// dispatching the handler. The handler's own actionability wait (visibility,
/// occlusion) still runs afterwards; this only extends the existence window to
/// the chain's waitTimeout the way the extension executor does. Skipped when
/// no CDP page is available (the handler will produce the precise error).
async fn wait_for_chain_step_selector(
    state: &DaemonState,
    selector_or_ref: &str,
    timeout_ms: u64,
) -> bool {
    let Some(ref mgr) = state.browser else {
        return true;
    };
    let Ok(session_id) = mgr.active_session_id() else {
        return true;
    };
    let session_id = session_id.to_string();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
    loop {
        if super::element::resolve_element_object_id(
            &mgr.client,
            &session_id,
            &state.ref_map,
            selector_or_ref,
        )
        .await
        .is_ok()
        {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(CHAIN_SELECTOR_POLL_MS)).await;
    }
}

/// Re-select the chain's addressed tab before a trailing snapshot/screenshot,
/// since per-step tabIds may have moved the active page.
async fn chain_select_tab(state: &mut DaemonState, tab_id: Option<u64>) {
    let Some(tab_id) = tab_id else { return };
    if let Some(ref mut mgr) = state.browser {
        if let Ok(true) = mgr.select_tab_by_id(tab_id).await {
            state.ref_map.clear();
        }
    }
}

async fn dispatch_chain_output_with_deadline(
    action: &str,
    cmd: &Value,
    state: &mut DaemonState,
    tab_id: Option<u64>,
    deadline: tokio::time::Instant,
    chain_budget_ms: u64,
) -> Result<Value, String> {
    within_chain_deadline(
        deadline,
        chain_budget_ms,
        &format!("while capturing {}", action),
        async {
            chain_select_tab(state, tab_id).await;
            dispatch_action(action, cmd, state).await
        },
    )
    .await?
}

/// Executes a validated `chain` command: runs each step through the shared
/// per-action dispatch with implicit selector waits, optional inter-step
/// delays, and stop-on-first-error semantics, then returns the extension
/// executor's response shape:
///
/// ```json
/// {
///   "id": "...",
///   "success": <all steps ok and requested outputs ok>,
///   "error": "Chain step N (action) failed: ..."   // only on failure
///   "data": {
///     "results": [{ "step", "action", "success", "data"?, "error"?, "durationMs" }],
///     "completed": <count of successful steps>,
///     "total": <steps.len()>,
///     "totalDurationMs": <elapsed>,
///     "snapshot"?, "snapshotError"?,
///     "screenshot"?, "screenshotFormat"?, "screenshotError"?
///   }
/// }
/// ```
async fn handle_chain(cmd: &Value, state: &mut DaemonState, id: &str) -> Value {
    // Steps were validated by validate_chain_actions before dispatch reached
    // this point; re-derive them defensively.
    let steps: Vec<Value> = cmd
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let chain_tab_id = cmd
        .get("tabId")
        .and_then(Value::as_u64)
        .filter(|tab_id| *tab_id > 0);
    let should_wait = cmd
        .get("waitForSelector")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let wait_timeout_ms = cmd
        .get("waitTimeout")
        .and_then(Value::as_u64)
        .filter(|timeout| *timeout > 0)
        .unwrap_or(DEFAULT_CHAIN_WAIT_TIMEOUT_MS);
    let abort_on_error = cmd
        .get("abortOnError")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let delay = cmd.get("delay").and_then(Value::as_object).map(|config| {
        let min = config.get("min").and_then(Value::as_u64).unwrap_or(300);
        let max = config.get("max").and_then(Value::as_u64).unwrap_or(1_200);
        (min, max.max(min))
    });
    let chain_budget_ms = match chain_runtime_budget_ms(cmd) {
        Ok(timeout) => timeout,
        Err(error) => return error_response(id, &error),
    };

    let chain_start = tokio::time::Instant::now();
    let deadline = chain_start + tokio::time::Duration::from_millis(chain_budget_ms);
    let mut results: Vec<Value> = Vec::new();

    for (index, step) in steps.iter().enumerate() {
        let action = step.get("action").and_then(Value::as_str).unwrap_or("");
        let step_start = tokio::time::Instant::now();

        if tokio::time::Instant::now() >= deadline {
            results.push(chain_step_failure(
                index,
                action,
                format!("Chain exceeded its {}ms execution budget", chain_budget_ms),
                0,
            ));
            break;
        }

        // Build the step command: the flat step fields plus an inherited chain
        // tabId, a derived id, and the chain's owner metadata so per-step
        // handlers observe the same caller as the container.
        let mut step_cmd = step.clone();
        if let Some(step_object) = step_cmd.as_object_mut() {
            step_object.insert("id".to_string(), json!(format!("{}_s{}", id, index)));
            if !step_object.contains_key("tabId") {
                if let Some(tab_id) = chain_tab_id {
                    step_object.insert("tabId".to_string(), json!(tab_id));
                }
            }
            for key in [
                "ownerId",
                "sessionId",
                "turnId",
                "ownerLeaseId",
                "ownerLeaseIssuedAt",
            ] {
                // The chain container is the authorization boundary. A step
                // cannot replace its caller identity to gain another owner's
                // tabs.
                if let Some(value) = cmd.get(key) {
                    step_object.insert(key.to_string(), value.clone());
                }
            }
        }

        if let Some(tab_id) = step_cmd
            .get("tabId")
            .and_then(Value::as_u64)
            .filter(|tab_id| *tab_id > 0)
        {
            if let Some(ref mgr) = state.browser {
                if let Err(error) = validate_tab_ownership(&step_cmd, mgr, tab_id) {
                    results.push(chain_step_failure(
                        index,
                        action,
                        error,
                        step_start.elapsed().as_millis() as u64,
                    ));
                    if abort_on_error {
                        break;
                    }
                    continue;
                }
            }
        }

        // Route the step to its addressed tab. This mirrors execute_command's
        // pre-dispatch tabId resolution: tab_* actions resolve their own
        // targets, every other action runs against the active page.
        if !matches!(action, "tab_list" | "tab_new" | "tab_switch" | "tab_close") {
            if let Some(tab_id_value) = step_cmd.get("tabId") {
                match tab_id_value.as_u64().filter(|tab_id| *tab_id > 0) {
                    None => {
                        results.push(chain_step_failure(
                            index,
                            action,
                            "'tabId' must be a positive integer".to_string(),
                            step_start.elapsed().as_millis() as u64,
                        ));
                        if abort_on_error {
                            break;
                        }
                        continue;
                    }
                    Some(tab_id) => {
                        let mut switch_error = None;
                        if let Some(ref mut mgr) = state.browser {
                            let remaining =
                                deadline.saturating_duration_since(tokio::time::Instant::now());
                            match tokio::time::timeout(remaining, mgr.select_tab_by_id(tab_id)).await {
                                Ok(Ok(switched)) => {
                                    if let Some(owner_id) = command_owner_id(&step_cmd) {
                                        mgr.mark_owner_tab_active(owner_id, tab_id);
                                    }
                                    if switched {
                                        state.ref_map.clear();
                                    }
                                }
                                Ok(Err(error)) => switch_error = Some(error),
                                Err(_) => {
                                    switch_error = Some(format!(
                                        "Chain exceeded its {}ms execution budget while selecting the step tab",
                                        chain_budget_ms
                                    ))
                                }
                            }
                        }
                        if let Some(error) = switch_error {
                            results.push(chain_step_failure(
                                index,
                                action,
                                error,
                                step_start.elapsed().as_millis() as u64,
                            ));
                            if abort_on_error || tokio::time::Instant::now() >= deadline {
                                break;
                            }
                            continue;
                        }
                    }
                }
            }
        }

        if matches!(state.backend_type, BackendType::WebDriver)
            && WEBDRIVER_UNSUPPORTED_ACTIONS.contains(&action)
        {
            results.push(chain_step_failure(
                index,
                action,
                format!(
                    "Action '{}' is not supported on the WebDriver backend",
                    action
                ),
                step_start.elapsed().as_millis() as u64,
            ));
            if abort_on_error {
                break;
            }
            continue;
        }

        // Implicit wait: element-targeted steps get a bounded existence wait
        // before the handler's own actionability wait takes over.
        if should_wait {
            if let Some(selector) = step
                .get("selector")
                .or_else(|| step.get("ref"))
                .and_then(Value::as_str)
            {
                let remaining = deadline
                    .saturating_duration_since(tokio::time::Instant::now())
                    .as_millis() as u64;
                let budget = wait_timeout_ms.min(remaining);
                let found = if budget == 0 {
                    false
                } else {
                    tokio::time::timeout(
                        tokio::time::Duration::from_millis(budget),
                        wait_for_chain_step_selector(state, selector, budget),
                    )
                    .await
                    .unwrap_or(false)
                };
                if !found {
                    results.push(chain_step_failure(
                        index,
                        action,
                        format!("Timeout waiting for selector: {}", selector),
                        step_start.elapsed().as_millis() as u64,
                    ));
                    if abort_on_error || tokio::time::Instant::now() >= deadline {
                        break;
                    }
                    continue;
                }
            }
        }

        let dispatched = within_chain_deadline(
            deadline,
            chain_budget_ms,
            "during this step",
            dispatch_action(action, &step_cmd, state),
        )
        .await;
        match dispatched {
            Ok(Ok(data)) => {
                results.push(json!({
                    "step": index,
                    "action": action,
                    "success": true,
                    "data": data,
                    "durationMs": step_start.elapsed().as_millis() as u64,
                }));
            }
            Ok(Err(error)) => {
                results.push(chain_step_failure(
                    index,
                    action,
                    super::browser::to_ai_friendly_error(&error),
                    step_start.elapsed().as_millis() as u64,
                ));
                if abort_on_error {
                    break;
                }
            }
            Err(error) => {
                results.push(chain_step_failure(
                    index,
                    action,
                    error,
                    step_start.elapsed().as_millis() as u64,
                ));
                break;
            }
        }

        // Optional randomized delay between steps (never after the last one).
        if let Some((min, max)) = delay {
            if index + 1 < steps.len() {
                let remaining = deadline
                    .saturating_duration_since(tokio::time::Instant::now())
                    .as_millis() as u64;
                if remaining == 0 {
                    break;
                }
                let pause = chain_random_delay_ms(min.min(remaining), max.min(remaining));
                if pause > 0 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(pause)).await;
                }
            }
        }
    }

    let completed = results
        .iter()
        .filter(|result| result.get("success").and_then(Value::as_bool) == Some(true))
        .count();
    let failed_step_error = results
        .iter()
        .find(|result| result.get("success").and_then(Value::as_bool) == Some(false))
        .map(|failed| {
            format!(
                "Chain step {} ({}) failed: {}",
                failed.get("step").and_then(Value::as_u64).unwrap_or(0),
                failed
                    .get("action")
                    .and_then(Value::as_str)
                    .filter(|action| !action.is_empty())
                    .unwrap_or("unknown"),
                failed
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("browser action failed without an error message"),
            )
        });

    let mut data = json!({
        "results": results,
        "completed": completed,
        "total": steps.len(),
        "totalDurationMs": chain_start.elapsed().as_millis() as u64,
    });

    let mut requested_output_error: Option<String> = None;

    if cmd
        .get("returnSnapshot")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let mut snapshot_cmd = json!({
            "id": format!("{}_snap", id),
            "action": "snapshot",
            "interactive": true,
            "compact": true,
        });
        if let Some(tab_id) = chain_tab_id {
            snapshot_cmd["tabId"] = json!(tab_id);
        }
        match dispatch_chain_output_with_deadline(
            "snapshot",
            &snapshot_cmd,
            state,
            chain_tab_id,
            deadline,
            chain_budget_ms,
        )
        .await
        {
            Ok(snapshot_data) => match snapshot_data.get("snapshot") {
                Some(snapshot) => {
                    data["snapshot"] = snapshot.clone();
                }
                None => {
                    let error = "Snapshot capture returned no snapshot data".to_string();
                    data["snapshotError"] = json!(error);
                    requested_output_error = Some(error);
                }
            },
            Err(error) => {
                let error = super::browser::to_ai_friendly_error(&error);
                data["snapshotError"] = json!(error);
                requested_output_error = Some(error);
            }
        }
    }

    if cmd
        .get("returnScreenshot")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let mut screenshot_cmd = json!({
            "id": format!("{}_shot", id),
            "action": "screenshot",
        });
        if let Some(tab_id) = chain_tab_id {
            screenshot_cmd["tabId"] = json!(tab_id);
        }
        match dispatch_chain_output_with_deadline(
            "screenshot",
            &screenshot_cmd,
            state,
            chain_tab_id,
            deadline,
            chain_budget_ms,
        )
        .await
        {
            Ok(shot) => {
                let format = shot
                    .get("format")
                    .and_then(Value::as_str)
                    .unwrap_or("png")
                    .to_string();
                match shot
                    .get("base64")
                    .and_then(Value::as_str)
                    .filter(|base64| !base64.is_empty())
                {
                    Some(base64) => {
                        data["screenshot"] = json!(base64);
                        data["screenshotFormat"] = json!(format);
                    }
                    None => {
                        let error = "Screenshot capture returned no image data".to_string();
                        data["screenshotError"] = json!({ "error": error, "format": format });
                        requested_output_error = Some(error);
                    }
                }
            }
            Err(error) => {
                let error = super::browser::to_ai_friendly_error(&error);
                data["screenshotError"] = json!({ "error": error, "format": "png" });
                requested_output_error = Some(error);
            }
        }
    }

    let success = failed_step_error.is_none() && requested_output_error.is_none();
    let mut response = json!({ "id": id, "success": success, "data": data });
    if let Some(error) = requested_output_error.or(failed_step_error) {
        response["error"] = json!(error);
    }
    response
}

async fn handle_extension_status(state: &DaemonState) -> Value {
    let connection_generation = match state.extension_bridge.as_ref() {
        Some(bridge) => bridge.verified_connection_generation().await,
        None => None,
    };
    json!({
        "connected": connection_generation.is_some(),
        "authorized": connection_generation.is_some(),
        "connectionGeneration": connection_generation,
        "daemonGeneration": std::process::id(),
    })
}

const COOKIE_EXPORT_URL_LIMIT: usize = 10_000;
const COOKIE_EXPORT_CHAIN_SIZE: usize = 100;

async fn export_extension_cookies_for_urls(cmd: &Value, bridge: &ExtensionBridge) -> Value {
    let id = cmd
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let Some(urls) = cmd.get("urls").and_then(Value::as_array) else {
        return error_response(&id, "cookies_export_for_urls requires a urls array");
    };
    if urls.len() > COOKIE_EXPORT_URL_LIMIT {
        return error_response(
            &id,
            &format!(
                "cookies_export_for_urls accepts at most {} URLs",
                COOKIE_EXPORT_URL_LIMIT
            ),
        );
    }

    let urls: Vec<&str> = urls
        .iter()
        .filter_map(Value::as_str)
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .collect();
    let mut cookies = Vec::new();
    let mut seen = HashSet::new();

    for (chunk_index, chunk) in urls.chunks(COOKIE_EXPORT_CHAIN_SIZE).enumerate() {
        let steps: Vec<Value> = chunk
            .iter()
            .map(|url| json!({ "action": "cookies_get", "url": url }))
            .collect();
        let chain = json!({
            "id": format!("{}_compat_{}", id, chunk_index),
            "action": "chain",
            "steps": steps,
            "abortOnError": false,
            "waitForSelector": false,
        });
        let response = match bridge.execute_command(&chain).await {
            Ok(response) => response,
            Err(error) => return error_response(&id, &error),
        };
        let Some(results) = response
            .get("data")
            .and_then(|data| data.get("results"))
            .and_then(Value::as_array)
        else {
            return error_response(
                &id,
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Browser extension returned an invalid compatibility cookie export"),
            );
        };

        for result in results {
            let Some(exported) = result
                .get("data")
                .and_then(|data| data.get("cookies"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for cookie in exported {
                let Some(mut normalized) = cookie.as_object().cloned() else {
                    continue;
                };
                let name = normalized
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let domain = normalized
                    .get("domain")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let path = normalized
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("/")
                    .to_string();
                if name.is_empty() || domain.is_empty() {
                    continue;
                }
                if !normalized.contains_key("expirationDate") {
                    if let Some(expires) = normalized.get("expires").and_then(Value::as_f64) {
                        if expires >= 0.0 {
                            normalized.insert("expirationDate".to_string(), json!(expires));
                        }
                    }
                }
                normalized.remove("expires");
                normalized
                    .entry("hostOnly".to_string())
                    .or_insert_with(|| json!(!domain.starts_with('.')));
                let session = !normalized.contains_key("expirationDate");
                normalized
                    .entry("session".to_string())
                    .or_insert_with(|| json!(session));
                normalized
                    .entry("storeId".to_string())
                    .or_insert_with(|| json!("0"));
                let key = format!("{}\0{}\0{}", name, domain, path);
                if seen.insert(key) {
                    cookies.push(Value::Object(normalized));
                }
            }
        }
    }

    success_response(
        &id,
        json!({ "cookies": cookies, "compatibilityMode": true }),
    )
}

async fn forward_targeted_extension_command(cmd: &Value, state: &DaemonState) -> Value {
    let id = cmd
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(ref bridge) = state.extension_bridge {
        return forward_extension_command(cmd, bridge).await;
    }
    let Some(proxy) = state.extension_proxy.clone() else {
        return error_response(
            &id,
            "Extension not connected. Install or connect the Stella Browser Bridge extension before using the external browser.",
        );
    };
    let mut proxied = cmd.clone();
    if let Some(object) = proxied.as_object_mut() {
        object.insert(
            "extensionDelegateToken".to_string(),
            Value::String(proxy.delegate_token),
        );
    }
    let timeout = if cmd.get("action").and_then(Value::as_str) == Some("chain") {
        Duration::from_secs(5 * 60)
    } else {
        Duration::from_secs(65)
    };
    match tokio::task::spawn_blocking(move || {
        connection::send_command_with_timeout(proxied, &proxy.session, timeout)
    })
    .await
    {
        Ok(Ok(response)) if response.success => {
            let mut result = json!({ "id": id, "success": true });
            if let Some(data) = response.data {
                result["data"] = data;
            }
            result
        }
        Ok(Ok(response)) => error_response(
            &id,
            response
                .error
                .as_deref()
                .unwrap_or("Extension proxy command failed without an error message"),
        ),
        Ok(Err(error)) => error_response(&id, &format!("Extension proxy unavailable: {error}")),
        Err(error) => error_response(&id, &format!("Extension proxy task failed: {error}")),
    }
}

pub(crate) async fn forward_extension_command(cmd: &Value, bridge: &ExtensionBridge) -> Value {
    let id = cmd
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut forwarded = cmd.clone();
    if let Some(object) = forwarded.as_object_mut() {
        for private_field in [
            "controlToken",
            "extensionDelegateToken",
            "browserBackend",
            "sessionId",
            "turnId",
        ] {
            object.remove(private_field);
        }
    }
    match bridge.execute_command(&forwarded).await {
        Ok(response) => normalize_extension_response(&id, &response),
        Err(e) => error_response(&id, &e),
    }
}

fn normalize_extension_response(id: &str, response: &Value) -> Value {
    // Extension returns {id, success, data/error}; the daemon owns request correlation.
    let success = response
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if success {
        let mut normalized = json!({ "id": id, "success": true });
        if let Some(data) = response.get("data") {
            normalized["data"] = data.clone();
        }
        normalized
    } else {
        error_response(
            id,
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Extension command failed without an error message"),
        )
    }
}

// ---------------------------------------------------------------------------
// Auto-launch
// ---------------------------------------------------------------------------

/// Connect to a running Chrome via auto-discovery and open a fresh tab so
/// subsequent navigations don't hijack the user's existing tabs.
async fn connect_auto_with_fresh_tab(owner_id: Option<&str>) -> Result<BrowserManager, String> {
    let mut mgr = BrowserManager::connect_auto().await?;
    let tab = mgr.tab_new(None).await?;
    if let (Some(owner_id), Some(tab_id)) = (owner_id, tab.get("tabId").and_then(Value::as_u64)) {
        mgr.record_owner_tab(owner_id, tab_id);
    }
    let session_id = mgr.active_session_id()?.to_string();
    let _ = mgr
        .client
        .send_command("Page.bringToFront", None, Some(&session_id))
        .await;
    Ok(mgr)
}

fn requested_provider(cmd: Option<&Value>) -> Option<String> {
    cmd.and_then(|value| {
        value
            .get("provider")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    })
    .or_else(|| env::var("STELLA_BROWSER_PROVIDER").ok())
    .map(|provider| provider.trim().to_string())
    .filter(|provider| !provider.is_empty())
}

async fn auto_launch(state: &mut DaemonState, owner_id: Option<&str>) -> Result<(), String> {
    let options = launch_options_from_env();
    let engine = env::var("STELLA_BROWSER_ENGINE").ok();

    if let Ok(cdp) = env::var("STELLA_BROWSER_CDP") {
        let mgr = BrowserManager::connect_cdp(&cdp).await?;
        state.browser = Some(mgr);
        state.subscribe_to_browser_events();
        state.update_stream_client().await;
        try_auto_restore_state(state).await;
        return Ok(());
    }

    if env::var("STELLA_BROWSER_AUTO_CONNECT").is_ok() {
        state.browser = Some(connect_auto_with_fresh_tab(owner_id).await?);
        state.subscribe_to_browser_events();
        state.update_stream_client().await;
        try_auto_restore_state(state).await;
        return Ok(());
    }

    if let Some(provider) = requested_provider(None) {
        handle_launch(
            &json!({
                "action": "launch",
                "id": "_auto_launch",
                "provider": provider,
            }),
            state,
        )
        .await?;
        return Ok(());
    }

    let mgr = BrowserManager::launch(options, engine.as_deref()).await?;
    state.browser = Some(mgr);
    state.subscribe_to_browser_events();
    state.update_stream_client().await;
    try_auto_restore_state(state).await;
    Ok(())
}

fn launch_options_from_env() -> LaunchOptions {
    let headed = env::var("STELLA_BROWSER_HEADED")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);

    let extensions: Option<Vec<String>> = env::var("STELLA_BROWSER_EXTENSIONS").ok().map(|v| {
        v.split([',', '\n'])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });

    LaunchOptions {
        headless: !headed,
        executable_path: env::var("STELLA_BROWSER_EXECUTABLE_PATH").ok(),
        proxy: env::var("STELLA_BROWSER_PROXY").ok(),
        proxy_bypass: env::var("STELLA_BROWSER_PROXY_BYPASS").ok(),
        profile: env::var("STELLA_BROWSER_PROFILE").ok(),
        allow_file_access: env::var("STELLA_BROWSER_ALLOW_FILE_ACCESS")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false),
        args: env::var("STELLA_BROWSER_ARGS")
            .map(|v| {
                v.split([',', '\n'])
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        extensions,
        storage_state: env::var("STELLA_BROWSER_STATE").ok(),
        user_agent: env::var("STELLA_BROWSER_USER_AGENT").ok(),
        ignore_https_errors: env::var("STELLA_BROWSER_IGNORE_HTTPS_ERRORS")
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false),
        color_scheme: env::var("STELLA_BROWSER_COLOR_SCHEME").ok(),
        download_path: env::var("STELLA_BROWSER_DOWNLOAD_PATH").ok(),
    }
}

fn daemon_state_from_env(state: &mut DaemonState) {
    if let Ok(name) = env::var("STELLA_BROWSER_SESSION_NAME") {
        if !name.is_empty() {
            state.session_name = Some(name);
        }
    }
    if let Ok(domains) = env::var("STELLA_BROWSER_ALLOWED_DOMAINS") {
        if !domains.is_empty() {
            state.domain_filter = Some(DomainFilter::new(&domains));
        }
    }
    if state.policy.is_none() {
        state.policy = ActionPolicy::load_if_exists();
    }
}

async fn try_auto_restore_state(state: &mut DaemonState) {
    let session_name = match state.session_name.as_deref() {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => return,
    };
    if let Some(path) = state::find_auto_state_file(&session_name) {
        if let Some(ref mgr) = state.browser {
            if let Ok(session_id) = mgr.active_session_id() {
                let _ = state::load_state(&mgr.client, session_id, &path).await;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 1 handlers
// ---------------------------------------------------------------------------

async fn handle_launch(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let headless = cmd
        .get("headless")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let cdp_url = cmd.get("cdpUrl").and_then(|v| v.as_str());
    let cdp_port = cmd.get("cdpPort").and_then(|v| v.as_u64());
    let auto_connect = cmd
        .get("autoConnect")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let targets_cdp = cdp_url.is_some() || cdp_port.is_some() || auto_connect;

    // Relaunch logic: check if we can reuse the existing connection
    let needs_relaunch = if let Some(ref mgr) = state.browser {
        let is_external = cdp_url.is_some() || cdp_port.is_some() || auto_connect;
        let was_external = mgr.is_cdp_connection();
        is_external != was_external || !mgr.is_connection_alive().await
    } else {
        true
    };

    if needs_relaunch {
        if let Some(ref mut b) = state.browser {
            b.close().await?;
            state.browser = None;
            state.update_stream_client().await;
        }
    } else {
        if targets_cdp {
            state.backend_type = BackendType::Cdp;
        }
        return Ok(json!({ "launched": true, "reused": true }));
    }
    state.ref_map.clear();
    let extensions: Option<Vec<String>> =
        cmd.get("extensions").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        });

    let profile = cmd.get("profile").and_then(|v| v.as_str());
    let storage_state = cmd.get("storageState").and_then(|v| v.as_str());
    let allow_file_access = cmd
        .get("allowFileAccess")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let executable_path: Option<String> = cmd
        .get("executablePath")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| std::env::var("STELLA_BROWSER_EXECUTABLE_PATH").ok());

    let has_cdp = cdp_url.is_some() || cdp_port.is_some();
    super::browser::validate_launch_options(
        extensions.as_deref(),
        has_cdp,
        profile,
        storage_state,
        allow_file_access,
        executable_path.as_deref(),
    )?;

    if let Some(url) = cdp_url {
        state.browser = Some(BrowserManager::connect_cdp(url).await?);
        if let (Some(owner_id), Some(browser)) = (command_owner_id(cmd), state.browser.as_mut()) {
            browser.adopt_all_tabs_for_owner(owner_id);
        }
        state.backend_type = BackendType::Cdp;
        state.subscribe_to_browser_events();
        state.update_stream_client().await;
        return Ok(json!({ "launched": true }));
    }

    if let Some(port) = cdp_port {
        state.browser = Some(BrowserManager::connect_cdp(&port.to_string()).await?);
        if let (Some(owner_id), Some(browser)) = (command_owner_id(cmd), state.browser.as_mut()) {
            browser.adopt_all_tabs_for_owner(owner_id);
        }
        state.backend_type = BackendType::Cdp;
        state.subscribe_to_browser_events();
        state.update_stream_client().await;
        return Ok(json!({ "launched": true }));
    }

    if auto_connect {
        state.browser = Some(connect_auto_with_fresh_tab(command_owner_id(cmd)).await?);
        state.backend_type = BackendType::Cdp;
        state.subscribe_to_browser_events();
        state.update_stream_client().await;
        return Ok(json!({ "launched": true }));
    }

    if let Some(provider) = requested_provider(Some(cmd)) {
        match provider.to_lowercase().as_str() {
            "extension" => {
                // Reuse existing extension bridge if it's still connected
                if matches!(state.backend_type, BackendType::Extension) {
                    if let Some(ref bridge) = state.extension_bridge {
                        if bridge.is_connected().await {
                            return Ok(
                                json!({ "launched": true, "provider": "extension", "reused": true }),
                            );
                        }
                    }
                }

                let ext_port = env::var("STELLA_BROWSER_EXT_PORT")
                    .ok()
                    .and_then(|s| s.parse().ok());
                let ext_token = env::var("STELLA_BROWSER_EXT_TOKEN").ok();
                let mut bridge = ExtensionBridge::new(ext_port, ext_token);
                let session =
                    env::var("STELLA_BROWSER_SESSION").unwrap_or_else(|_| "default".to_string());
                let _disconnect_rx = bridge.start(&session).await?;
                state.extension_bridge = Some(bridge);
                state.backend_type = BackendType::Extension;

                // The bridge and its connection status remain useful after this
                // daemon switches to an in-app CDP target. Extension loss must
                // therefore not terminate the daemon; extension_status reports
                // the disconnected state while CDP automation keeps running.

                return Ok(json!({ "launched": true, "provider": "extension" }));
            }
            "ios" => {
                return launch_ios(cmd, state).await;
            }
            "safari" => {
                return launch_safari(cmd, state).await;
            }
            _ => {
                let (ws_url, provider_session) = providers::connect_provider(&provider).await?;
                match BrowserManager::connect_cdp(&ws_url).await {
                    Ok(mgr) => {
                        state.browser = Some(mgr);
                        state.backend_type = BackendType::Cdp;
                        state.subscribe_to_browser_events();
                        state.update_stream_client().await;
                        return Ok(json!({ "launched": true, "provider": provider }));
                    }
                    Err(e) => {
                        if let Some(ref ps) = provider_session {
                            providers::close_provider_session(ps).await;
                        }
                        return Err(e);
                    }
                }
            }
        }
    }

    let engine = cmd
        .get("engine")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| env::var("STELLA_BROWSER_ENGINE").ok());

    let options = LaunchOptions {
        headless,
        executable_path: cmd
            .get("executablePath")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| env::var("STELLA_BROWSER_EXECUTABLE_PATH").ok()),
        proxy: cmd.get("proxy").and_then(|v| {
            v.as_str().map(|s| s.to_string()).or_else(|| {
                v.get("server")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string())
            })
        }),
        profile: cmd
            .get("profile")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        allow_file_access: cmd
            .get("allowFileAccess")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        args: cmd
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        extensions,
        storage_state: storage_state.map(String::from),
        proxy_bypass: cmd
            .get("proxy")
            .and_then(|v| v.get("bypass"))
            .and_then(|v| v.as_str())
            .map(String::from),
        user_agent: cmd
            .get("userAgent")
            .and_then(|v| v.as_str())
            .map(String::from),
        ignore_https_errors: cmd
            .get("ignoreHTTPSErrors")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        color_scheme: cmd
            .get("colorScheme")
            .and_then(|v| v.as_str())
            .map(String::from),
        download_path: cmd
            .get("downloadPath")
            .and_then(|v| v.as_str())
            .map(String::from),
    };

    if let Some(ref domains) = cmd
        .get("allowedDomains")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        state.domain_filter = Some(DomainFilter::new(domains));
    }

    state.browser = Some(BrowserManager::launch(options, engine.as_deref()).await?);
    state.backend_type = BackendType::Cdp;
    state.subscribe_to_browser_events();
    state.update_stream_client().await;

    if let Some(ref filter) = state.domain_filter {
        if let Some(ref mgr) = state.browser {
            if let Ok(session_id) = mgr.active_session_id() {
                let _ = network::install_domain_filter(
                    &mgr.client,
                    session_id,
                    &filter.allowed_domains,
                )
                .await;
                network::sanitize_existing_pages(&mgr.client, &mgr.pages_list(), filter).await;
            }
        }
    }

    Ok(json!({ "launched": true }))
}

async fn launch_ios(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let device_name = cmd.get("deviceName").and_then(|v| v.as_str());
    let device_udid = cmd.get("udid").and_then(|v| v.as_str());
    let platform_version = cmd.get("platformVersion").and_then(|v| v.as_str());

    // Select device (or use default)
    let device = ios::select_device(device_name, device_udid)?;

    // Boot simulator if it's not real and not already booted
    if !device.is_real && device.state != "Booted" {
        ios::boot_simulator(&device.udid)?;
    }

    // Start Appium
    let mut appium = AppiumManager::connect_or_launch(Some(&device.udid)).await?;

    // Create iOS Safari session
    appium
        .create_ios_session(Some(&device.name), platform_version)
        .await?;

    // Create a WebDriverBackend from the Appium session for common commands
    if let Some(sid) = appium.client.session_id_pub().map(String::from) {
        let wd_client = super::webdriver::client::WebDriverClient::new_with_session(4723, sid);
        state.webdriver_backend = Some(WebDriverBackend::new(wd_client));
    }

    state.appium = Some(appium);
    state.backend_type = BackendType::WebDriver;

    Ok(json!({
        "launched": true,
        "provider": "ios",
        "device": device.name,
        "udid": device.udid,
        "backend": "webdriver",
    }))
}

async fn launch_safari(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let port: u16 = cmd
        .get("port")
        .and_then(|v| v.as_u64())
        .map(|p| p as u16)
        .unwrap_or(0);
    let driver_port = if port > 0 { port } else { 0 };

    // Find a free port if none specified
    let actual_port = if driver_port > 0 {
        driver_port
    } else {
        // Use any available high port
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to find free port: {}", e))?;
        listener
            .local_addr()
            .map_err(|e| format!("Failed to get local address: {}", e))?
            .port()
    };

    let driver = safari::launch_safaridriver(actual_port)?;
    let mut client = super::webdriver::client::WebDriverClient::new(actual_port);

    client
        .create_session(serde_json::json!({
            "browserName": "safari",
        }))
        .await?;

    state.safari_driver = Some(driver);
    state.webdriver_backend = Some(WebDriverBackend::new(client));
    state.backend_type = BackendType::WebDriver;

    Ok(json!({
        "launched": true,
        "provider": "safari",
        "port": actual_port,
        "backend": "webdriver",
    }))
}

async fn handle_navigate(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let url = cmd
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url' parameter")?;

    if let Some(ref filter) = state.domain_filter {
        filter.check_url(url)?;
    }

    // WebDriver backend path
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            state.ref_map.clear();
            wb.navigate(url).await?;
            let new_url = wb.get_url().await.unwrap_or_else(|_| url.to_string());
            let title = wb.get_title().await.unwrap_or_default();
            return Ok(json!({ "url": new_url, "title": title }));
        }
    }

    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;

    let wait_until = cmd
        .get("waitUntil")
        .and_then(|v| v.as_str())
        .map(WaitUntil::from_str)
        .unwrap_or(WaitUntil::Load);

    let scoped_headers = cmd
        .get("headers")
        .and_then(|v| v.as_object())
        .filter(|m| !m.is_empty());

    if let Some(headers_map) = scoped_headers {
        let session_id = mgr.active_session_id()?.to_string();
        let headers: std::collections::HashMap<String, String> = headers_map
            .iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect();
        network::set_extra_headers(&mgr.client, &session_id, &headers).await?;
    }

    state.ref_map.clear();
    let result = mgr.navigate(url, wait_until).await;

    if scoped_headers.is_some() {
        if let Ok(session_id) = mgr.active_session_id() {
            let empty: std::collections::HashMap<String, String> = std::collections::HashMap::new();
            let _ = network::set_extra_headers(&mgr.client, session_id, &empty).await;
        }
    }

    result
}

async fn handle_url(state: &DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            let url = wb.get_url().await?;
            return Ok(json!({ "url": url }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let url = mgr.get_url().await?;
    Ok(json!({ "url": url }))
}

fn handle_cdp_url(state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    Ok(json!({ "cdpUrl": mgr.get_cdp_url() }))
}

async fn handle_inspect(state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;

    // Shut down any existing inspect server so we always target the current page
    if let Some(server) = state.inspect_server.take() {
        server.shutdown();
    }

    let target_id = mgr.active_target_id()?.to_string();
    let chrome_hp = mgr.chrome_host_port().to_string();
    let proxy_handle = mgr.client.inspect_handle();

    let server = InspectServer::start(proxy_handle, target_id, chrome_hp).await?;
    let url = format!("http://127.0.0.1:{}", server.port());
    open_url_in_browser(&url);

    state.inspect_server = Some(server);
    Ok(json!({ "opened": true, "url": url }))
}

fn open_url_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/c", "start", "", url])
        .spawn();
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let result: Result<std::process::Child, std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "unsupported platform",
    ));
    if let Err(e) = result {
        let _ = writeln!(std::io::stderr(), "[inspect] Failed to open browser: {}", e);
    }
}

async fn handle_title(state: &DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            let title = wb.get_title().await?;
            return Ok(json!({ "title": title }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let title = mgr.get_title().await?;
    Ok(json!({ "title": title }))
}

async fn handle_content(state: &DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            let html = wb.get_content().await?;
            let url = wb.get_url().await.unwrap_or_default();
            return Ok(json!({ "html": html, "origin": url }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let html = mgr.get_content().await?;
    let url = mgr.get_url().await.unwrap_or_default();
    Ok(json!({ "html": html, "origin": url }))
}

async fn handle_evaluate(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            let script = cmd
                .get("script")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'script' parameter")?;
            let result = wb.evaluate(script).await?;
            let url = wb.get_url().await.unwrap_or_default();
            return Ok(json!({ "result": result, "origin": url }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let script = cmd
        .get("script")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'script' parameter")?;

    let result = mgr.evaluate(script, None).await?;
    // Do not immediately inject a second `Runtime.evaluate(location.href)`.
    // A page script can complete while leaving the renderer saturated (for
    // example, a runaway observer); making origin metadata another blocking
    // page evaluation turned one command into two independent hang points.
    let url = mgr.active_url_cached();
    Ok(json!({ "result": result, "origin": url }))
}

async fn handle_evaluate_detached(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    if state.browser.is_none() {
        return Err("Detached evaluation requires the CDP browser backend".to_string());
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let script = cmd
        .get("script")
        .and_then(Value::as_str)
        .ok_or("Missing 'script' parameter")?;
    mgr.evaluate_detached(script).await?;
    Ok(json!({ "scheduled": true, "origin": mgr.active_url_cached() }))
}

async fn handle_close(state: &mut DaemonState) -> Result<Value, String> {
    teardown_daemon_state(state, true).await?;
    Ok(json!({ "closed": true }))
}

pub(crate) async fn teardown_daemon_state(
    state: &mut DaemonState,
    persist_session: bool,
) -> Result<(), String> {
    if persist_session {
        if let Some(ref mgr) = state.browser {
            if let Some(ref session_name) = state.session_name {
                if let Ok(session_id) = mgr.active_session_id() {
                    let _ = state::save_state(
                        &mgr.client,
                        session_id,
                        None,
                        Some(session_name.as_str()),
                        &state.session_id,
                    )
                    .await;
                }
            }
        }
    }

    if let Some(ref mut mgr) = state.browser {
        mgr.close().await?;
    }
    state.browser = None;
    state.update_stream_client().await;

    // Close WebDriver sessions.
    if let Some(ref mut wb) = state.webdriver_backend {
        let _ = wb.close().await;
    }
    state.webdriver_backend = None;
    if let Some(ref mut appium) = state.appium {
        let _ = appium.close().await;
    }
    state.appium = None;
    if let Some(ref mut driver) = state.safari_driver {
        driver.kill();
    }
    state.safari_driver = None;

    // Close extension bridge.
    if let Some(ref mut bridge) = state.extension_bridge {
        bridge.stop().await;
    }
    state.extension_bridge = None;

    state.backend_type = BackendType::Cdp;

    if let Some(server) = state.inspect_server.take() {
        server.shutdown();
    }

    state.ref_map.clear();
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 2 handlers
// ---------------------------------------------------------------------------

async fn handle_snapshot(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let options = SnapshotOptions {
        selector: cmd
            .get("selector")
            .and_then(|v| v.as_str())
            .map(String::from),
        interactive: cmd
            .get("interactive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        compact: cmd
            .get("compact")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        depth: cmd
            .get("maxDepth")
            .and_then(|v| v.as_u64())
            .map(|d| d as usize),
        cursor: cmd.get("cursor").and_then(|v| v.as_bool()).unwrap_or(false),
    };

    state.ref_map.clear();
    let tree =
        snapshot::take_snapshot(&mgr.client, &session_id, &options, &mut state.ref_map, None)
            .await?;

    let url = mgr.get_url().await.unwrap_or_default();

    let refs: serde_json::Map<String, Value> = state
        .ref_map
        .entries_sorted()
        .into_iter()
        .map(|(ref_id, entry)| {
            let mut obj = serde_json::Map::new();
            obj.insert("role".into(), Value::String(entry.role));
            obj.insert("name".into(), Value::String(entry.name));
            (ref_id, Value::Object(obj))
        })
        .collect();

    Ok(json!({ "snapshot": tree, "origin": url, "refs": refs }))
}

async fn handle_screenshot(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let annotate = cmd
        .get("annotate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            if annotate {
                return Err(
                    "Annotated screenshots are not yet implemented on the WebDriver backend"
                        .to_string(),
                );
            }

            let base64_data = wb.screenshot().await?;
            let path = cmd.get("path").and_then(|v| v.as_str());
            if let Some(p) = path {
                let bytes = base64::Engine::decode(
                    &base64::engine::general_purpose::STANDARD,
                    &base64_data,
                )
                .map_err(|e| format!("Base64 decode error: {}", e))?;
                std::fs::write(p, bytes)
                    .map_err(|e| format!("Failed to write screenshot: {}", e))?;
                return Ok(json!({ "path": p }));
            }
            let tmp = format!(
                "/tmp/screenshot-{}.png",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            );
            let bytes =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &base64_data)
                    .map_err(|e| format!("Base64 decode error: {}", e))?;
            std::fs::write(&tmp, bytes)
                .map_err(|e| format!("Failed to write screenshot: {}", e))?;
            return Ok(json!({ "path": tmp }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let format = cmd
        .get("format")
        .or_else(|| cmd.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("png")
        .to_string();

    let options = ScreenshotOptions {
        selector: cmd
            .get("selector")
            .and_then(|v| v.as_str())
            .map(String::from),
        path: cmd.get("path").and_then(|v| v.as_str()).map(String::from),
        full_page: cmd
            .get("fullPage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        format,
        quality: cmd
            .get("quality")
            .and_then(|v| v.as_i64())
            .map(|q| q as i32),
        annotate,
        output_dir: cmd
            .get("screenshotDir")
            .and_then(|v| v.as_str())
            .map(String::from),
    };

    if annotate {
        state.ref_map.clear();
        let _ = snapshot::take_snapshot(
            &mgr.client,
            &session_id,
            &SnapshotOptions {
                interactive: true,
                cursor: true,
                ..SnapshotOptions::default()
            },
            &mut state.ref_map,
            None,
        )
        .await?;
    }

    let format = options.format.clone();
    let result =
        screenshot::take_screenshot(&mgr.client, &session_id, &state.ref_map, &options).await?;

    // `base64` and `format` mirror the extension backend's screenshot payload;
    // runtime consumers (e.g. the node_repl browser receipt) read `base64`.
    let mut response = json!({
        "path": result.path,
        "base64": result.base64,
        "format": format,
    });
    if !result.annotations.is_empty() {
        response["annotations"] = serde_json::to_value(&result.annotations)
            .map_err(|e| format!("Failed to serialize annotations: {}", e))?;
    }

    Ok(response)
}

async fn handle_click(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            wb.click(selector).await?;
            return Ok(json!({ "clicked": selector }));
        }
    }

    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let new_tab = cmd.get("newTab").and_then(|v| v.as_bool()).unwrap_or(false);

    if new_tab {
        use super::element::resolve_element_object_id;
        let object_id =
            resolve_element_object_id(&mgr.client, &session_id, &state.ref_map, selector).await?;
        let call_params = json!({
            "objectId": object_id,
            "functionDeclaration": "function() { var h = this.getAttribute('href'); if (!h) return null; try { return new URL(h, document.baseURI).toString(); } catch(e) { return null; } }",
            "returnByValue": true
        });
        let call_result = mgr
            .client
            .send_command(
                "Runtime.callFunctionOn",
                Some(call_params),
                Some(&session_id),
            )
            .await?;
        let href = call_result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                format!(
                    "Element '{}' does not have an href attribute. --new-tab only works on links.",
                    selector
                )
            })?
            .to_string();

        let mgr = state.browser.as_mut().ok_or("Browser not launched")?;
        state.ref_map.clear();
        mgr.tab_new(Some(&href)).await?;

        return Ok(json!({ "clicked": selector, "newTab": true, "url": href }));
    }

    let button = cmd.get("button").and_then(|v| v.as_str()).unwrap_or("left");
    let click_count = cmd.get("clickCount").and_then(|v| v.as_i64()).unwrap_or(1) as i32;

    interaction::click(
        &mgr.client,
        &session_id,
        &state.ref_map,
        selector,
        button,
        click_count,
    )
    .await?;

    Ok(json!({ "clicked": selector }))
}

async fn handle_dblclick(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::dblclick(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "clicked": selector }))
}

async fn handle_fill(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;
    let value = cmd
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'value' parameter")?;

    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            wb.fill(selector, value).await?;
            return Ok(json!({ "filled": selector }));
        }
    }

    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    interaction::fill(&mgr.client, &session_id, &state.ref_map, selector, value).await?;
    Ok(json!({ "filled": selector }))
}

async fn handle_type(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;
    let text = cmd
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'text' parameter")?;
    let clear = cmd.get("clear").and_then(|v| v.as_bool()).unwrap_or(false);
    let delay = cmd.get("delay").and_then(|v| v.as_u64());

    interaction::type_text(
        &mgr.client,
        &session_id,
        &state.ref_map,
        selector,
        text,
        clear,
        delay,
    )
    .await?;
    Ok(json!({ "typed": text }))
}

async fn handle_press(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let key = cmd
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'key' parameter")?;

    // When a selector is provided, resolve and focus the target first
    // (visible + attached actionability, same as fill/focus) so the key
    // lands on that element instead of whatever happens to be focused.
    // Without a selector this is a page-level press.
    if let Some(selector) = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        interaction::focus(&mgr.client, &session_id, &state.ref_map, selector).await?;
        interaction::press_key(&mgr.client, &session_id, key).await?;
        return Ok(json!({ "pressed": key, "selector": selector }));
    }

    interaction::press_key(&mgr.client, &session_id, key).await?;
    Ok(json!({ "pressed": key }))
}

async fn handle_hover(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::hover(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "hovered": selector }))
}

async fn handle_scroll(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd.get("selector").and_then(|v| v.as_str());

    let (mut dx, mut dy) = (
        cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
        cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
    );

    if let Some(direction) = cmd.get("direction").and_then(|v| v.as_str()) {
        let amount = cmd.get("amount").and_then(|v| v.as_f64()).unwrap_or(300.0);
        match direction {
            "up" => dy = -amount,
            "down" => dy = amount,
            "left" => dx = -amount,
            "right" => dx = amount,
            _ => {}
        }
    }

    interaction::scroll(&mgr.client, &session_id, &state.ref_map, selector, dx, dy).await?;
    Ok(json!({ "scrolled": true }))
}

async fn handle_select(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let values: Vec<String> = match cmd.get("values") {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => cmd
            .get("value")
            .and_then(|v| v.as_str())
            .map(|s| vec![s.to_string()])
            .unwrap_or_default(),
    };

    interaction::select_option(&mgr.client, &session_id, &state.ref_map, selector, &values).await?;
    Ok(json!({ "selected": values }))
}

async fn handle_check(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::check(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "checked": selector }))
}

async fn handle_uncheck(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::uncheck(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "unchecked": selector }))
}

async fn handle_wait(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let timeout_ms = cmd.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30000);

    if let Some(text) = cmd.get("text").and_then(|v| v.as_str()) {
        wait_for_text(&mgr.client, &session_id, text, timeout_ms).await?;
        return Ok(json!({ "waited": "text", "text": text }));
    }

    if let Some(selector) = cmd.get("selector").and_then(|v| v.as_str()) {
        let state_str = cmd
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("visible");
        wait_for_selector(&mgr.client, &session_id, selector, state_str, timeout_ms).await?;
        return Ok(json!({ "waited": "selector", "selector": selector }));
    }

    if let Some(url_pattern) = cmd.get("url").and_then(|v| v.as_str()) {
        wait_for_url(&mgr.client, &session_id, url_pattern, timeout_ms).await?;
        return Ok(json!({ "waited": "url", "url": url_pattern }));
    }

    if let Some(fn_str) = cmd.get("function").and_then(|v| v.as_str()) {
        wait_for_function(&mgr.client, &session_id, fn_str, timeout_ms).await?;
        return Ok(json!({ "waited": "function" }));
    }

    if let Some(load_state) = cmd.get("loadState").and_then(|v| v.as_str()) {
        let wait_until = WaitUntil::from_str(load_state);
        mgr.wait_for_lifecycle_external(wait_until, &session_id)
            .await?;
        return Ok(json!({ "waited": "load", "state": load_state }));
    }

    // Just a timeout wait
    tokio::time::sleep(tokio::time::Duration::from_millis(timeout_ms)).await;
    Ok(json!({ "waited": "timeout", "ms": timeout_ms }))
}

async fn handle_gettext(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let text = super::element::get_element_text(&mgr.client, &session_id, &state.ref_map, selector)
        .await?;
    let url = mgr.get_url().await.unwrap_or_default();
    Ok(json!({ "text": text, "origin": url }))
}

async fn handle_getattribute(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;
    let attribute = cmd
        .get("attribute")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'attribute' parameter")?;

    let value = super::element::get_element_attribute(
        &mgr.client,
        &session_id,
        &state.ref_map,
        selector,
        attribute,
    )
    .await?;
    let url = mgr.get_url().await.unwrap_or_default();
    Ok(json!({ "value": value, "origin": url }))
}

async fn handle_isvisible(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let visible =
        super::element::is_element_visible(&mgr.client, &session_id, &state.ref_map, selector)
            .await?;
    let url = mgr.get_url().await.unwrap_or_default();
    Ok(json!({ "visible": visible, "origin": url }))
}

async fn handle_isenabled(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let enabled =
        super::element::is_element_enabled(&mgr.client, &session_id, &state.ref_map, selector)
            .await?;
    let url = mgr.get_url().await.unwrap_or_default();
    Ok(json!({ "enabled": enabled, "origin": url }))
}

async fn handle_ischecked(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let checked =
        super::element::is_element_checked(&mgr.client, &session_id, &state.ref_map, selector)
            .await?;
    let url = mgr.get_url().await.unwrap_or_default();
    Ok(json!({ "checked": checked, "origin": url }))
}

async fn handle_back(state: &mut DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            wb.back().await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            let url = wb.get_url().await.unwrap_or_default();
            state.ref_map.clear();
            return Ok(json!({ "url": url }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    mgr.evaluate("history.back()", None).await?;
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    let url = mgr.get_url().await.unwrap_or_default();
    state.ref_map.clear();
    Ok(json!({ "url": url }))
}

async fn handle_forward(state: &mut DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            wb.forward().await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            let url = wb.get_url().await.unwrap_or_default();
            state.ref_map.clear();
            return Ok(json!({ "url": url }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    mgr.evaluate("history.forward()", None).await?;
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    let url = mgr.get_url().await.unwrap_or_default();
    state.ref_map.clear();
    Ok(json!({ "url": url }))
}

async fn handle_reload(state: &mut DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            wb.reload().await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
            let url = wb.get_url().await.unwrap_or_default();
            state.ref_map.clear();
            return Ok(json!({ "url": url }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    mgr.client
        .send_command_no_params("Page.reload", Some(&session_id))
        .await?;

    let mut rx = mgr.client.subscribe();
    let _ = tokio::time::timeout(tokio::time::Duration::from_secs(10), async {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if event.method == "Page.loadEventFired"
                        && event.session_id.as_deref() == Some(&session_id)
                    {
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    })
    .await;

    let url = mgr.get_url().await.unwrap_or_default();
    state.ref_map.clear();
    Ok(json!({ "url": url }))
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

async fn wait_for_selector(
    client: &super::cdp::client::CdpClient,
    session_id: &str,
    selector: &str,
    state: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    // Semantic (aria=) selectors go through the unified resolver. Matching is
    // visibility-filtered (extension parity), so "attached"/"visible" both map
    // to at-least-one-match and "detached"/"hidden" to zero matches.
    if let Some(semantic) = super::selector::parse_semantic_selector(selector)? {
        let count = super::selector::count_expression(&semantic);
        let check_fn = match state {
            "detached" | "hidden" => format!("({}) === 0", count),
            _ => format!("({}) > 0", count),
        };
        return poll_until_true(
            client,
            session_id,
            &check_fn,
            timeout_ms,
            &format!("selector {:?} to become {}", selector, state),
        )
        .await;
    }

    // Plain CSS: match across every reachable document (top document,
    // same-origin iframes, open shadow roots) so waits agree with the
    // unified resolver used by the input commands.
    let all = super::selector::css_match_all_expression(selector);
    let check_fn = match state {
        "attached" => format!("({}).length > 0", all),
        "detached" => format!("({}).length === 0", all),
        "hidden" => format!(
            r#"(() => {{
                const el = ({all})[0];
                if (!el) return true;
                const w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
                const s = w.getComputedStyle(el);
                return s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0;
            }})()"#,
            all = all
        ),
        _ => format!(
            r#"(() => {{
                const el = ({all})[0];
                if (!el) return false;
                const r = el.getBoundingClientRect();
                const w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
                const s = w.getComputedStyle(el);
                return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
            }})()"#,
            all = all
        ),
    };

    poll_until_true(
        client,
        session_id,
        &check_fn,
        timeout_ms,
        &format!("selector {:?} to become {}", selector, state),
    )
    .await
}

async fn wait_for_url(
    client: &super::cdp::client::CdpClient,
    session_id: &str,
    pattern: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    let check_fn = format!(
        "location.href.includes({})",
        serde_json::to_string(pattern).unwrap_or_default()
    );
    poll_until_true(
        client,
        session_id,
        &check_fn,
        timeout_ms,
        &format!("URL containing {:?}", pattern),
    )
    .await
}

async fn wait_for_text(
    client: &super::cdp::client::CdpClient,
    session_id: &str,
    text: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    let check_fn = format!(
        "(document.body.innerText || '').includes({})",
        serde_json::to_string(text).unwrap_or_default()
    );
    poll_until_true(
        client,
        session_id,
        &check_fn,
        timeout_ms,
        &format!("page text containing {:?}", text),
    )
    .await
}

async fn wait_for_function(
    client: &super::cdp::client::CdpClient,
    session_id: &str,
    fn_str: &str,
    timeout_ms: u64,
) -> Result<(), String> {
    let check_fn = format!("!!({})", fn_str);
    poll_until_true(
        client,
        session_id,
        &check_fn,
        timeout_ms,
        "page function to return true",
    )
    .await
}

fn wait_observation_expression(expression: &str) -> String {
    format!(
        r#"(() => {{
            let matched = false;
            let evaluationError = null;
            try {{ matched = !!({expression}); }}
            catch (error) {{ evaluationError = String(error && (error.stack || error.message) || error).slice(0, 500); }}
            const frameEls = Array.from(document.querySelectorAll('iframe,frame'));
            const frames = frameEls.slice(0, 8).map((frame, index) => {{
                const rect = frame.getBoundingClientRect();
                return {{
                    index,
                    name: String(frame.name || frame.id || '').slice(0, 120),
                    title: String(frame.title || '').slice(0, 120),
                    src: String(frame.src || '').slice(0, 300),
                    visible: rect.width > 0 && rect.height > 0,
                }};
            }});
            return {{
                matched,
                url: String(location.href).slice(0, 500),
                readyState: document.readyState,
                frameCount: frameEls.length,
                frames,
                bodyTextSample: String(document.body && document.body.innerText || '')
                    .replace(/\s+/g, ' ').trim().slice(0, 500),
                evaluationError,
            }};
        }})()"#,
        expression = expression,
    )
}

fn wait_timeout_message(
    timeout_ms: u64,
    expectation: &str,
    last_observation: Option<&Value>,
    last_transport_error: Option<&str>,
) -> String {
    let mut message = format!(
        "Wait timed out after {}ms waiting for {}.",
        timeout_ms, expectation
    );
    if let Some(observation) = last_observation {
        let encoded =
            serde_json::to_string(observation).unwrap_or_else(|_| "unavailable".to_string());
        message.push_str(" Last observed page/frame state: ");
        message.push_str(&encoded);
    }
    if let Some(error) = last_transport_error {
        message.push_str(" Last observation error: ");
        message.push_str(error);
    }
    message
}

async fn poll_until_true(
    client: &super::cdp::client::CdpClient,
    session_id: &str,
    expression: &str,
    timeout_ms: u64,
    expectation: &str,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
    let probe_expression = wait_observation_expression(expression);
    let mut last_observation: Option<Value> = None;
    let mut last_transport_error: Option<String>;

    loop {
        let result: Result<super::cdp::types::EvaluateResult, String> = client
            .send_command_typed(
                "Runtime.evaluate",
                &super::cdp::types::EvaluateParams {
                    expression: probe_expression.clone(),
                    return_by_value: Some(true),
                    await_promise: Some(true),
                },
                Some(session_id),
            )
            .await;

        match result {
            Ok(result) => {
                let result: super::cdp::types::EvaluateResult = result;
                let observation = result.result.value.unwrap_or(Value::Null);
                if observation
                    .get("matched")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Ok(());
                }
                last_observation = Some(observation);
                last_transport_error = None;
            }
            Err(error) => {
                // Navigations can invalidate an execution context between two
                // polls. Keep waiting within the caller's deadline and report
                // the final transport failure if the condition never settles.
                last_transport_error = Some(error);
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(wait_timeout_message(
                timeout_ms,
                expectation,
                last_observation.as_ref(),
                last_transport_error.as_deref(),
            ));
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
}

// ---------------------------------------------------------------------------
// Phase 3 handlers
// ---------------------------------------------------------------------------

async fn handle_cookies_get(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    if let Some(ref wb) = state.webdriver_backend {
        if state.browser.is_none() {
            let cookies_list = wb.get_cookies().await?;
            return Ok(json!({ "cookies": cookies_list }));
        }
    }
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let urls = cmd
        .get("url")
        .and_then(|v| v.as_str())
        .map(|url| vec![url.to_string()])
        .or_else(|| {
            cmd.get("urls").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
        });

    let cookies_list = cookies::get_cookies(&mgr.client, &session_id, urls).await?;
    Ok(json!({ "cookies": cookies_list }))
}

async fn handle_cookies_set(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let url = mgr.get_url().await.ok();

    let cookie_values = if let Some(arr) = cmd.get("cookies").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        let mut cookie = serde_json::Map::new();
        for key in &[
            "name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite", "url",
        ] {
            if let Some(v) = cmd.get(*key) {
                if !v.is_null() {
                    cookie.insert(key.to_string(), v.clone());
                }
            }
        }
        vec![Value::Object(cookie)]
    };

    cookies::set_cookies(&mgr.client, &session_id, cookie_values, url.as_deref()).await?;
    Ok(json!({ "set": true }))
}

async fn handle_cookies_clear(state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    cookies::clear_cookies(&mgr.client, &session_id).await?;
    Ok(json!({ "cleared": true }))
}

async fn handle_storage_get(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let storage_type = cmd.get("type").and_then(|v| v.as_str()).unwrap_or("local");
    let key = cmd.get("key").and_then(|v| v.as_str());
    storage::storage_get(&mgr.client, &session_id, storage_type, key).await
}

async fn handle_storage_set(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let storage_type = cmd.get("type").and_then(|v| v.as_str()).unwrap_or("local");
    let key = cmd
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'key' parameter")?;
    let value = cmd
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'value' parameter")?;
    storage::storage_set(&mgr.client, &session_id, storage_type, key, value).await?;
    Ok(json!({ "set": true }))
}

async fn handle_storage_clear(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let storage_type = cmd.get("type").and_then(|v| v.as_str()).unwrap_or("local");
    storage::storage_clear(&mgr.client, &session_id, storage_type).await?;
    Ok(json!({ "cleared": true }))
}

async fn handle_setcontent(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let html = cmd
        .get("html")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'html' parameter")?;
    network::set_content(&mgr.client, &session_id, html).await?;
    Ok(json!({ "set": true }))
}

async fn handle_headers(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let headers_value = cmd.get("headers").ok_or("Missing 'headers' parameter")?;

    let headers: std::collections::HashMap<String, String> = headers_value
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();

    network::set_extra_headers(&mgr.client, &session_id, &headers).await?;
    Ok(json!({ "set": true }))
}

async fn handle_offline(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let offline = cmd.get("offline").and_then(|v| v.as_bool()).unwrap_or(true);
    network::set_offline(&mgr.client, &session_id, offline).await?;
    Ok(json!({ "offline": offline }))
}

async fn handle_console(state: &DaemonState) -> Result<Value, String> {
    Ok(state.event_tracker.get_console_json())
}

async fn handle_errors(state: &DaemonState) -> Result<Value, String> {
    Ok(state.event_tracker.get_errors_json())
}

async fn handle_state_save(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let path = cmd.get("path").and_then(|v| v.as_str());

    let saved_path = state::save_state(
        &mgr.client,
        &session_id,
        path,
        state.session_name.as_deref(),
        &state.session_id,
    )
    .await?;

    Ok(json!({ "saved": true, "path": saved_path }))
}

async fn handle_state_load(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let path = cmd
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;

    state::load_state(&mgr.client, &session_id, path).await?;
    Ok(json!({ "loaded": true, "path": path }))
}

async fn handle_state_list() -> Result<Value, String> {
    state::state_list()
}

async fn handle_state_show(cmd: &Value) -> Result<Value, String> {
    let path = cmd
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;
    state::state_show(path)
}

async fn handle_state_clear(cmd: &Value) -> Result<Value, String> {
    let path = cmd.get("path").and_then(|v| v.as_str());
    state::state_clear(path)
}

async fn handle_state_clean(cmd: &Value) -> Result<Value, String> {
    let days = cmd.get("days").and_then(|v| v.as_u64()).unwrap_or(30);
    state::state_clean(days)
}

async fn handle_state_rename(cmd: &Value) -> Result<Value, String> {
    let path = cmd
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name' parameter")?;
    state::state_rename(path, name)
}

// ---------------------------------------------------------------------------
// Phase 6 handlers
// ---------------------------------------------------------------------------

async fn handle_diff_snapshot(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let compact = cmd
        .get("compact")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let max_depth = cmd
        .get("maxDepth")
        .and_then(|v| v.as_u64())
        .map(|d| d as usize);
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .map(String::from);

    let options = SnapshotOptions {
        compact,
        depth: max_depth,
        selector,
        ..SnapshotOptions::default()
    };
    let current =
        snapshot::take_snapshot(&mgr.client, &session_id, &options, &mut state.ref_map, None)
            .await?;

    let baseline = cmd.get("baseline").and_then(|v| v.as_str());

    let baseline_text = match baseline {
        Some(b) if std::path::Path::new(b).exists() => {
            std::fs::read_to_string(b).map_err(|e| format!("Failed to read baseline: {}", e))?
        }
        Some(b) => b.to_string(),
        None => String::new(),
    };

    let result = diff::diff_snapshots(&baseline_text, &current);
    Ok(json!({
        "diff": result.diff,
        "additions": result.additions,
        "removals": result.removals,
        "unchanged": result.unchanged,
        "changed": result.changed,
    }))
}

async fn handle_diff_url(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;

    let url1 = cmd
        .get("url1")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url1' parameter")?;
    let url2 = cmd
        .get("url2")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url2' parameter")?;

    let wait_until = cmd
        .get("waitUntil")
        .and_then(|v| v.as_str())
        .map(WaitUntil::from_str)
        .unwrap_or(WaitUntil::Load);

    // Navigate to URL1 and snapshot
    mgr.navigate(url1, wait_until).await?;
    let session_id = mgr.active_session_id()?.to_string();
    let options = SnapshotOptions::default();
    let snap1 =
        snapshot::take_snapshot(&mgr.client, &session_id, &options, &mut state.ref_map, None)
            .await?;

    // Navigate to URL2 and snapshot
    mgr.navigate(url2, wait_until).await?;
    state.ref_map.clear();
    let snap2 =
        snapshot::take_snapshot(&mgr.client, &session_id, &options, &mut state.ref_map, None)
            .await?;

    let result = diff::diff_text(&snap1, &snap2);
    Ok(json!({
        "diff": result,
        "url1": url1,
        "url2": url2,
        "snapshot1": snap1,
        "snapshot2": snap2,
    }))
}

async fn handle_credentials_set(cmd: &Value) -> Result<Value, String> {
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name'")?;
    let username = cmd
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'username'")?;
    let password = cmd
        .get("password")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'password'")?;
    let url = cmd.get("url").and_then(|v| v.as_str());
    auth::credentials_set(name, username, password, url)
}

async fn handle_credentials_get(cmd: &Value) -> Result<Value, String> {
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name'")?;
    auth::credentials_get(name)
}

async fn handle_credentials_delete(cmd: &Value) -> Result<Value, String> {
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name'")?;
    auth::credentials_delete(name)
}

async fn handle_credentials_list() -> Result<Value, String> {
    auth::credentials_list()
}

async fn handle_auth_show(cmd: &Value) -> Result<Value, String> {
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name'")?;
    auth::auth_show(name)
}

async fn handle_mouse(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let event_type = cmd
        .get("eventType")
        .and_then(|v| v.as_str())
        .unwrap_or("mouseMoved");
    let x = cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let button = cmd.get("button").and_then(|v| v.as_str()).unwrap_or("none");
    let click_count = cmd.get("clickCount").and_then(|v| v.as_i64()).unwrap_or(0);

    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({
                "type": event_type,
                "x": x,
                "y": y,
                "button": button,
                "clickCount": click_count,
            })),
            Some(&session_id),
        )
        .await?;

    Ok(json!({ "dispatched": event_type }))
}

async fn handle_keyboard(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let event_type = cmd
        .get("eventType")
        .and_then(|v| v.as_str())
        .unwrap_or("keyDown");
    let key = cmd.get("key").and_then(|v| v.as_str());
    let code = cmd.get("code").and_then(|v| v.as_str());
    let text = cmd.get("text").and_then(|v| v.as_str());

    let mut params = json!({ "type": event_type });
    if let Some(k) = key {
        params["key"] = Value::String(k.to_string());
    }
    if let Some(c) = code {
        params["code"] = Value::String(c.to_string());
    }
    if let Some(t) = text {
        params["text"] = Value::String(t.to_string());
    }

    mgr.client
        .send_command("Input.dispatchKeyEvent", Some(params), Some(&session_id))
        .await?;

    Ok(json!({ "dispatched": event_type }))
}

// ---------------------------------------------------------------------------
// Phase 5 handlers
// ---------------------------------------------------------------------------

async fn handle_tab_list(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let owner_id = command_owner_id(cmd);
    let tabs = mgr.tab_list_for_owner(owner_id);
    Ok(json!({
        "tabs": tabs,
        "activeTabId": mgr.active_tab_id_for_owner(owner_id),
    }))
}

async fn handle_tab_new(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;
    let url = cmd.get("url").and_then(|v| v.as_str());
    state.ref_map.clear();
    let result = mgr.tab_new(url).await?;
    if let Some(owner_id) = command_owner_id(cmd) {
        if let Some(tab_id) = result.get("tabId").and_then(Value::as_u64) {
            mgr.record_owner_tab(owner_id, tab_id);
        }
    }
    Ok(result)
}

/// CDP implementation of `finalize_tabs`/`close_owner`: closes every tab
/// recorded for the command owner (minus `keep` entries, which are released
/// from ownership without closing) and clears the owner's mapping. The
/// response shape mirrors the extension handler
/// (extension/commands/tabs.js finalizeOwnerTabs), which is the contract
/// worker-api.ts `browser.tabs.finalize` round-trips:
/// `{ closedTabIds, releasedTabIds, kept }`.
///
/// Tabs that are already gone are success, not an error — the goal state
/// (tab closed) holds. With no browser connected there is nothing to reap,
/// which is likewise success with empty results.
async fn handle_finalize_tabs(
    action: &str,
    cmd: &Value,
    state: &mut DaemonState,
) -> Result<Value, String> {
    let owner_id = command_owner_id(cmd)
        .ok_or_else(|| format!("Action '{}' requires a non-empty ownerId", action))?
        .to_string();

    // `close_owner` always closes everything; `finalize_tabs` may keep tabs.
    // Entries were validated by validate_owner_finalization before dispatch.
    let keep_entries: Vec<(u64, Option<String>, String)> = if action == "finalize_tabs" {
        cmd.get("keep")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|entry| {
                        let tab_id = entry.get("tabId").and_then(Value::as_u64)?;
                        let tab_generation = entry
                            .get("tabGeneration")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        let status = entry
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("deliverable")
                            .to_string();
                        Some((tab_id, tab_generation, status))
                    })
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let keep_ids: std::collections::HashSet<u64> =
        keep_entries.iter().map(|(tab_id, _, _)| *tab_id).collect();

    let mut closed_tab_ids: Vec<u64> = Vec::new();
    let mut released_tab_ids: Vec<u64> = Vec::new();
    if let Some(ref mut mgr) = state.browser {
        // Validate every retained handle before mutating ownership or closing
        // any tab. A stale generation must fail atomically rather than keep a
        // newly reused numeric id while closing the rest of the task's tabs.
        for (tab_id, tab_generation, _) in &keep_entries {
            let mut handle_cmd = cmd.clone();
            if let Some(object) = handle_cmd.as_object_mut() {
                object.insert("tabId".to_string(), json!(tab_id));
                if let Some(tab_generation) = tab_generation {
                    object.insert("tabGeneration".to_string(), json!(tab_generation));
                }
            }
            validate_tab_ownership(&handle_cmd, mgr, *tab_id)?;
        }
        for tab_id in mgr.owner_tab_ids(&owner_id) {
            if keep_ids.contains(&tab_id) {
                mgr.release_owner_tab(&owner_id, tab_id);
                released_tab_ids.push(tab_id);
                continue;
            }
            if mgr.close_tab_by_id(tab_id).await? {
                closed_tab_ids.push(tab_id);
            }
        }
        if !closed_tab_ids.is_empty() {
            // Closing tabs can move the active page; stale element refs must
            // not resolve against the wrong tab.
            state.ref_map.clear();
        }
    }

    let kept: Vec<Value> = keep_entries
        .iter()
        .map(|(tab_id, tab_generation, status)| {
            let mut entry = json!({
                "tabId": tab_id,
                "status": status,
            });
            if let (Some(tab_generation), Some(object)) = (tab_generation, entry.as_object_mut()) {
                object.insert("tabGeneration".to_string(), json!(tab_generation));
            }
            entry
        })
        .collect();
    Ok(json!({
        "closedTabIds": closed_tab_ids,
        "releasedTabIds": released_tab_ids,
        "kept": kept,
    }))
}

/// Resolves which tab a `tab_switch`/`tab_close` command addresses. Prefers
/// the stable `tabId` that `tab_list`/`tab_new` report; falls back to the
/// legacy positional `index` for older callers.
fn resolve_tab_index(cmd: &Value, mgr: &BrowserManager) -> Result<Option<usize>, String> {
    if let Some(tab_id_value) = cmd.get("tabId") {
        let tab_id = tab_id_value
            .as_u64()
            .filter(|id| *id > 0)
            .ok_or("'tabId' must be a positive integer")?;
        validate_tab_ownership(cmd, mgr, tab_id)?;
        let index = mgr.tab_index_by_id(tab_id).ok_or_else(|| {
            format!(
                "Unknown tabId {}. The tab may have been closed; run tab_list to see current tabs.",
                tab_id
            )
        })?;
        return Ok(Some(index));
    }
    let index = cmd
        .get("index")
        .and_then(|v| v.as_u64())
        .map(|i| i as usize);
    if let Some(index) = index {
        if let Some(tab_id) = mgr
            .tab_list()
            .get(index)
            .and_then(|tab| tab["tabId"].as_u64())
        {
            validate_tab_ownership(cmd, mgr, tab_id)?;
        }
    }
    Ok(index)
}

async fn handle_tab_switch(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;
    let index =
        resolve_tab_index(cmd, mgr)?.ok_or("Missing 'tabId' (or legacy 'index') parameter")?;
    let tab_id = mgr
        .tab_list()
        .get(index)
        .and_then(|tab| tab["tabId"].as_u64());
    state.ref_map.clear();
    let result = mgr.tab_switch(index).await?;
    if let (Some(owner_id), Some(tab_id)) = (command_owner_id(cmd), tab_id) {
        mgr.mark_owner_tab_active(owner_id, tab_id);
    }
    Ok(result)
}

async fn handle_tab_close(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;
    let mut index = resolve_tab_index(cmd, mgr)?;
    if index.is_none() {
        if let Some(owner_id) = command_owner_id(cmd) {
            let tab_id = mgr
                .active_tab_id_for_owner(Some(owner_id))
                .ok_or("Browser owner has no active tab to close")?;
            validate_tab_ownership(cmd, mgr, tab_id)?;
            index = mgr.tab_index_by_id(tab_id);
        }
    }
    state.ref_map.clear();
    let mut result = mgr.tab_close(index).await?;
    if let Some(owner_id) = command_owner_id(cmd) {
        result["activeTabId"] = json!(mgr.active_tab_id_for_owner(Some(owner_id)));
    }
    Ok(result)
}

async fn handle_viewport(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let width = cmd.get("width").and_then(|v| v.as_i64()).unwrap_or(1280) as i32;
    let height = cmd.get("height").and_then(|v| v.as_i64()).unwrap_or(720) as i32;
    let scale = cmd
        .get("deviceScaleFactor")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let mobile = cmd.get("mobile").and_then(|v| v.as_bool()).unwrap_or(false);

    mgr.set_viewport(width, height, scale, mobile).await?;
    Ok(json!({ "width": width, "height": height, "deviceScaleFactor": scale, "mobile": mobile }))
}

async fn handle_user_agent(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let ua = cmd
        .get("userAgent")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'userAgent' parameter")?;
    mgr.set_user_agent(ua).await?;
    Ok(json!({ "userAgent": ua }))
}

async fn handle_set_media(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let media = cmd.get("media").and_then(|v| v.as_str());

    let features = cmd.get("features").and_then(|v| v.as_object()).map(|m| {
        m.iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
            .collect::<Vec<(String, String)>>()
    });

    mgr.set_emulated_media(media, features).await?;
    Ok(json!({ "set": true }))
}

async fn handle_download(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let path = cmd
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;
    mgr.set_download_behavior(path).await?;
    // Remembered so waitfordownload can report the real on-disk path of the
    // completed download instead of echoing whatever the caller asked for.
    state.download_dir = Some(path.to_string());
    Ok(json!({ "downloadPath": path }))
}

// ---------------------------------------------------------------------------
// Phase 4 handlers
// ---------------------------------------------------------------------------

async fn handle_trace_start(state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    native_tracing::trace_start(&mgr.client, &session_id, &mut state.tracing_state).await
}

async fn handle_trace_stop(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let path = cmd.get("path").and_then(|v| v.as_str());
    native_tracing::trace_stop(&mgr.client, &session_id, &mut state.tracing_state, path).await
}

async fn handle_profiler_start(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let categories = cmd.get("categories").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    });
    native_tracing::profiler_start(
        &mgr.client,
        &session_id,
        &mut state.tracing_state,
        categories,
    )
    .await
}

async fn handle_profiler_stop(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let path = cmd.get("path").and_then(|v| v.as_str());
    native_tracing::profiler_stop(&mgr.client, &session_id, &mut state.tracing_state, path).await
}

async fn handle_recording_start(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let path = cmd
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;

    let recording_url = cmd
        .get("url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    let (client, new_session_id) = {
        let mgr = state.browser.as_mut().ok_or("Browser not launched")?;
        let old_session_id = mgr.active_session_id()?.to_string();

        // Capture current URL if no URL specified
        let nav_url = if let Some(u) = recording_url {
            u.to_string()
        } else {
            mgr.get_url()
                .await
                .unwrap_or_else(|_| "about:blank".to_string())
        };

        // Capture current cookies
        let cookies_result = mgr
            .client
            .send_command_no_params("Network.getAllCookies", Some(&old_session_id))
            .await
            .ok();

        // Create new browser context
        let ctx_result = mgr
            .client
            .send_command_no_params("Target.createBrowserContext", None)
            .await?;
        let context_id = ctx_result
            .get("browserContextId")
            .and_then(|v| v.as_str())
            .ok_or("Failed to get browserContextId")?
            .to_string();

        // Create page in new context
        let create_result: CreateTargetResult = mgr
            .client
            .send_command_typed(
                "Target.createTarget",
                &json!({ "url": "about:blank", "browserContextId": context_id }),
                None,
            )
            .await?;

        let attach_result: AttachToTargetResult = mgr
            .client
            .send_command_typed(
                "Target.attachToTarget",
                &AttachToTargetParams {
                    target_id: create_result.target_id.clone(),
                    flatten: true,
                },
                None,
            )
            .await?;

        let new_session_id = attach_result.session_id.clone();
        mgr.enable_domains_pub(&new_session_id).await?;

        // Transfer cookies to new context
        if let Some(ref cr) = cookies_result {
            if let Some(cookie_arr) = cr.get("cookies").and_then(|v| v.as_array()) {
                if !cookie_arr.is_empty() {
                    let _ = mgr
                        .client
                        .send_command(
                            "Network.setCookies",
                            Some(json!({ "cookies": cookie_arr })),
                            Some(&new_session_id),
                        )
                        .await;
                }
            }
        }

        // Add page and switch to it
        let recording_tab_id = mgr.add_page(super::browser::PageInfo {
            target_id: create_result.target_id,
            session_id: new_session_id.clone(),
            tab_id: 0,                     // assigned by add_page
            tab_generation: String::new(), // assigned by add_page
            url: nav_url.clone(),
            title: String::new(),
            target_type: "page".to_string(),
        });
        if let Some(owner_id) = command_owner_id(cmd) {
            mgr.record_owner_tab(owner_id, recording_tab_id);
        }

        // Navigate to URL
        if nav_url != "about:blank" {
            let _ = mgr
                .client
                .send_command(
                    "Page.navigate",
                    Some(json!({ "url": nav_url })),
                    Some(&new_session_id),
                )
                .await;
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }

        (mgr.client.clone(), new_session_id)
    };

    let result = recording::recording_start(&mut state.recording_state, path)?;
    state.start_recording_task(client, new_session_id).await?;

    Ok(result)
}

async fn handle_recording_stop(state: &mut DaemonState) -> Result<Value, String> {
    state.stop_recording_task().await?;
    recording::recording_stop(&mut state.recording_state)
}

async fn handle_recording_restart(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let path = cmd
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;

    let _ = state.stop_recording_task().await;
    let result = recording::recording_restart(&mut state.recording_state, path)?;

    if let Some(ref browser) = state.browser {
        let session_id = browser.active_session_id()?.to_string();
        state
            .start_recording_task(browser.client.clone(), session_id)
            .await?;
    }

    Ok(result)
}

async fn handle_pdf(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let params = json!({
        "printBackground": cmd.get("printBackground").and_then(|v| v.as_bool()).unwrap_or(true),
        "landscape": cmd.get("landscape").and_then(|v| v.as_bool()).unwrap_or(false),
        "preferCSSPageSize": cmd.get("preferCSSPageSize").and_then(|v| v.as_bool()).unwrap_or(false),
    });

    let result = mgr
        .client
        .send_command("Page.printToPDF", Some(params), Some(&session_id))
        .await?;

    let data = result
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or("No PDF data returned")?;

    let path = cmd.get("path").and_then(|v| v.as_str());
    let save_path = match path {
        Some(p) => p.to_string(),
        None => {
            let dir = dirs::home_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join(".stella-browser")
                .join("tmp")
                .join("pdfs");
            let _ = std::fs::create_dir_all(&dir);
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            dir.join(format!("page-{}.pdf", timestamp))
                .to_string_lossy()
                .to_string()
        }
    };

    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data)
        .map_err(|e| format!("Failed to decode PDF: {}", e))?;
    std::fs::write(&save_path, &bytes).map_err(|e| format!("Failed to save PDF: {}", e))?;

    Ok(json!({ "path": save_path }))
}

// ---------------------------------------------------------------------------
// Phase 8 handlers
// ---------------------------------------------------------------------------

async fn handle_focus(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::focus(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "focused": selector }))
}

async fn handle_clear(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::clear(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "cleared": selector }))
}

async fn handle_selectall(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::select_all(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "selected": selector }))
}

async fn handle_scrollintoview(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::scroll_into_view(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "scrolled": selector }))
}

async fn handle_dispatch(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;
    let event_type = cmd
        .get("event")
        .or_else(|| cmd.get("eventType"))
        .and_then(|v| v.as_str())
        .ok_or("Missing 'event' parameter")?;
    let event_init = cmd.get("eventInit");

    interaction::dispatch_event(
        &mgr.client,
        &session_id,
        &state.ref_map,
        selector,
        event_type,
        event_init,
    )
    .await?;
    Ok(json!({ "dispatched": event_type, "selector": selector }))
}

async fn handle_highlight(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    interaction::highlight(&mgr.client, &session_id, &state.ref_map, selector).await?;
    Ok(json!({ "highlighted": selector }))
}

async fn handle_tap(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let selector = cmd.get("selector").and_then(|v| v.as_str());

    // Route through Appium for iOS/WebDriver using coordinate-based tap
    if let Some(ref appium) = state.appium {
        if state.browser.is_none() {
            let x = cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(200.0);
            let y = cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(200.0);
            appium.tap(x, y).await?;
            return Ok(json!({ "tapped": true, "x": x, "y": y }));
        }
    }

    let sel = selector.ok_or("Missing 'selector' parameter")?;
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    interaction::tap_touch(&mgr.client, &session_id, &state.ref_map, sel).await?;
    Ok(json!({ "tapped": sel }))
}

async fn handle_boundingbox(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let bbox = super::element::get_element_bounding_box(
        &mgr.client,
        &session_id,
        &state.ref_map,
        selector,
    )
    .await?;
    Ok(bbox)
}

async fn handle_innertext(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let text =
        super::element::get_element_inner_text(&mgr.client, &session_id, &state.ref_map, selector)
            .await?;
    Ok(json!({ "text": text }))
}

async fn handle_innerhtml(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let html =
        super::element::get_element_inner_html(&mgr.client, &session_id, &state.ref_map, selector)
            .await?;
    Ok(json!({ "html": html }))
}

async fn handle_inputvalue(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let value =
        super::element::get_element_input_value(&mgr.client, &session_id, &state.ref_map, selector)
            .await?;
    Ok(json!({ "value": value }))
}

async fn handle_setvalue(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;
    let value = cmd
        .get("value")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'value' parameter")?;

    super::element::set_element_value(&mgr.client, &session_id, &state.ref_map, selector, value)
        .await?;
    Ok(json!({ "set": selector, "value": value }))
}

async fn handle_count(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let count = super::element::get_element_count(&mgr.client, &session_id, selector).await?;
    Ok(json!({ "count": count, "selector": selector }))
}

async fn handle_styles(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let properties = cmd.get("properties").and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect()
    });

    let styles = super::element::get_element_styles(
        &mgr.client,
        &session_id,
        &state.ref_map,
        selector,
        properties,
    )
    .await?;
    Ok(json!({ "styles": styles }))
}

async fn handle_bringtofront(state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    mgr.bring_to_front().await?;
    Ok(json!({ "broughtToFront": true }))
}

async fn handle_timezone(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let timezone = cmd
        .get("timezoneId")
        .or_else(|| cmd.get("timezone"))
        .and_then(|v| v.as_str())
        .ok_or("Missing 'timezoneId' parameter")?;
    mgr.set_timezone(timezone).await?;
    Ok(json!({ "timezoneId": timezone }))
}

async fn handle_locale(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let locale = cmd
        .get("locale")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'locale' parameter")?;
    mgr.set_locale(locale).await?;
    Ok(json!({ "locale": locale }))
}

async fn handle_geolocation(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let latitude = cmd
        .get("latitude")
        .and_then(|v| v.as_f64())
        .ok_or("Missing 'latitude' parameter")?;
    let longitude = cmd
        .get("longitude")
        .and_then(|v| v.as_f64())
        .ok_or("Missing 'longitude' parameter")?;
    let accuracy = cmd.get("accuracy").and_then(|v| v.as_f64());

    mgr.set_geolocation(latitude, longitude, accuracy).await?;
    Ok(json!({ "latitude": latitude, "longitude": longitude }))
}

async fn handle_permissions(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let permissions: Vec<String> = cmd
        .get("permissions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    mgr.grant_permissions(&permissions).await?;
    Ok(json!({ "granted": permissions }))
}

async fn handle_dialog(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let accept = cmd
        .get("response")
        .and_then(|v| v.as_str())
        .map(|r| r == "accept")
        .or_else(|| cmd.get("accept").and_then(|v| v.as_bool()))
        .unwrap_or(true);
    let prompt_text = cmd.get("promptText").and_then(|v| v.as_str());

    mgr.handle_dialog(accept, prompt_text).await?;
    Ok(json!({ "handled": true, "accepted": accept }))
}

async fn handle_upload(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let files: Vec<String> = cmd
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .or_else(|| {
            cmd.get("file")
                .and_then(|v| v.as_str())
                .map(|s| vec![s.to_string()])
        })
        .unwrap_or_default();

    mgr.upload_files(selector, &files).await?;
    Ok(json!({ "uploaded": files.len(), "selector": selector }))
}

async fn handle_addscript(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let content = cmd
        .get("content")
        .or_else(|| cmd.get("source"))
        .or_else(|| cmd.get("script"))
        .and_then(|v| v.as_str());
    let url = cmd.get("url").and_then(|v| v.as_str());

    if content.is_none() && url.is_none() {
        return Err("At least one of 'content' or 'url' is required".to_string());
    }

    if let Some(src_url) = url {
        let js = format!(
            r#"new Promise((resolve, reject) => {{
                const s = document.createElement('script');
                s.src = {};
                s.onload = () => resolve(true);
                s.onerror = () => reject(new Error('Failed to load script'));
                document.head.appendChild(s);
            }})"#,
            serde_json::to_string(src_url).unwrap_or_default()
        );
        mgr.evaluate(&js, None).await?;
    } else if let Some(source) = content {
        let js = format!(
            r#"(() => {{
                const s = document.createElement('script');
                s.textContent = {};
                document.head.appendChild(s);
            }})()"#,
            serde_json::to_string(source).unwrap_or_default()
        );
        mgr.evaluate(&js, None).await?;
    }

    Ok(json!({ "added": true }))
}

async fn handle_addinitscript(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let source = cmd
        .get("script")
        .or_else(|| cmd.get("source"))
        .or_else(|| cmd.get("content"))
        .and_then(|v| v.as_str())
        .ok_or("Missing 'script' parameter")?;

    let identifier = mgr.add_script_to_evaluate(source).await?;
    Ok(json!({ "added": true, "identifier": identifier }))
}

async fn handle_addstyle(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let content = cmd
        .get("content")
        .or_else(|| cmd.get("css"))
        .and_then(|v| v.as_str());
    let url = cmd.get("url").and_then(|v| v.as_str());

    if content.is_none() && url.is_none() {
        return Err("At least one of 'content' or 'url' is required".to_string());
    }

    if let Some(href) = url {
        let js = format!(
            r#"new Promise((resolve, reject) => {{
                const link = document.createElement('link');
                link.rel = 'stylesheet';
                link.href = {};
                link.onload = () => resolve(true);
                link.onerror = () => reject(new Error('Failed to load stylesheet'));
                document.head.appendChild(link);
            }})"#,
            serde_json::to_string(href).unwrap_or_default()
        );
        mgr.evaluate(&js, None).await?;
    } else if let Some(css) = content {
        let js = format!(
            r#"(() => {{
                const style = document.createElement('style');
                style.textContent = {};
                document.head.appendChild(style);
            }})()"#,
            serde_json::to_string(css).unwrap_or_default()
        );
        mgr.evaluate(&js, None).await?;
    }

    Ok(json!({ "added": true }))
}

async fn handle_clipboard(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let action = cmd
        .get("subAction")
        .or_else(|| cmd.get("operation"))
        .and_then(|v| v.as_str())
        .unwrap_or("read");

    let session_id = mgr.active_session_id()?.to_string();

    // cfg! is compile-time; assumes the browser runs on the same OS as the service binary.
    let modifier: i32 = if cfg!(target_os = "macos") { 4 } else { 2 };

    match action {
        "write" => {
            let text = cmd
                .get("text")
                .or_else(|| cmd.get("value"))
                .and_then(|v| v.as_str())
                .ok_or("Missing 'text' parameter")?;
            let js = format!(
                "navigator.clipboard.writeText({})",
                serde_json::to_string(text).unwrap_or_default()
            );
            mgr.evaluate(&js, None).await?;
            Ok(json!({ "written": text }))
        }
        "copy" => {
            interaction::press_key_with_modifiers(&mgr.client, &session_id, "c", Some(modifier))
                .await?;
            Ok(json!({ "copied": true }))
        }
        "paste" => {
            interaction::press_key_with_modifiers(&mgr.client, &session_id, "v", Some(modifier))
                .await?;
            Ok(json!({ "pasted": true }))
        }
        _ => {
            let result = mgr.evaluate("navigator.clipboard.readText()", None).await?;
            Ok(json!({ "text": result }))
        }
    }
}

async fn handle_wheel(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let x = cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let delta_x = cmd.get("deltaX").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let delta_y = cmd.get("deltaY").and_then(|v| v.as_f64()).unwrap_or(0.0);

    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({
                "type": "mouseWheel",
                "x": x,
                "y": y,
                "deltaX": delta_x,
                "deltaY": delta_y,
            })),
            Some(&session_id),
        )
        .await?;

    Ok(json!({ "scrolled": true, "deltaX": delta_x, "deltaY": delta_y }))
}

async fn handle_device(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let name = cmd
        .get("name")
        .or_else(|| cmd.get("device"))
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name' parameter")?;

    let (width, height, scale, mobile, ua) = match name.to_lowercase().as_str() {
        "iphone 12" | "iphone12" => (390, 844, 3.0, true, "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1"),
        "iphone 14" | "iphone14" => (390, 844, 3.0, true, "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"),
        "iphone 15" | "iphone15" => (393, 852, 3.0, true, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
        "ipad" | "ipad air" => (820, 1180, 2.0, true, "Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/604.1"),
        "ipad pro" => (1024, 1366, 2.0, true, "Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/604.1"),
        "pixel 5" | "pixel5" => (393, 851, 2.75, true, "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36"),
        "pixel 7" | "pixel7" => (412, 915, 2.625, true, "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36"),
        "galaxy s21" | "galaxys21" => (360, 800, 3.0, true, "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36"),
        _ => return Err(format!("Unknown device: {}. Supported: iPhone 12, iPhone 14, iPhone 15, iPad, iPad Pro, Pixel 5, Pixel 7, Galaxy S21", name)),
    };

    mgr.set_viewport(width, height, scale, mobile).await?;
    mgr.set_user_agent(ua).await?;

    Ok(json!({
        "device": name,
        "width": width,
        "height": height,
        "deviceScaleFactor": scale,
        "mobile": mobile,
    }))
}

// ---------------------------------------------------------------------------
// Screencast handlers
// ---------------------------------------------------------------------------

async fn handle_screencast_start(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    if state.screencasting {
        return Err("Screencast already active".to_string());
    }

    let format = cmd.get("format").and_then(|v| v.as_str()).unwrap_or("jpeg");
    let quality = cmd.get("quality").and_then(|v| v.as_i64()).unwrap_or(80) as i32;
    let max_width = cmd.get("maxWidth").and_then(|v| v.as_i64()).unwrap_or(1280) as i32;
    let max_height = cmd.get("maxHeight").and_then(|v| v.as_i64()).unwrap_or(720) as i32;

    stream::start_screencast(
        &mgr.client,
        &session_id,
        format,
        quality,
        max_width,
        max_height,
    )
    .await?;
    state.screencasting = true;

    if let Some(ref server) = state.stream_server {
        server.broadcast_status(true, true, max_width as u32, max_height as u32);
    }

    Ok(json!({ "started": true }))
}

async fn handle_screencast_stop(state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?;

    if !state.screencasting {
        return Err("No screencast active".to_string());
    }

    stream::stop_screencast(&mgr.client, session_id).await?;
    state.screencasting = false;

    if let Some(ref server) = state.stream_server {
        server.broadcast_status(true, false, 0, 0);
    }

    Ok(json!({ "stopped": true }))
}

// ---------------------------------------------------------------------------
// Wait variant handlers
// ---------------------------------------------------------------------------

async fn handle_waitforurl(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let url_pattern = cmd
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url' parameter")?;
    let timeout_ms = cmd.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30000);

    wait_for_url(&mgr.client, &session_id, url_pattern, timeout_ms).await?;
    let url = mgr.get_url().await.unwrap_or_default();
    Ok(json!({ "url": url }))
}

async fn handle_waitforloadstate(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let load_state = cmd.get("state").and_then(|v| v.as_str()).unwrap_or("load");
    let timeout_ms = cmd.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30000);

    let wait_until = WaitUntil::from_str(load_state);
    let _ = tokio::time::timeout(
        tokio::time::Duration::from_millis(timeout_ms),
        mgr.wait_for_lifecycle_external(wait_until, &session_id),
    )
    .await
    .map_err(|_| format!("Timeout waiting for load state: {}", load_state))?;

    Ok(json!({ "state": load_state }))
}

async fn handle_waitforfunction(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let expression = cmd
        .get("expression")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'expression' parameter")?;
    let timeout_ms = cmd.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30000);

    wait_for_function(&mgr.client, &session_id, expression, timeout_ms).await?;

    let result: super::cdp::types::EvaluateResult = mgr
        .client
        .send_command_typed(
            "Runtime.evaluate",
            &super::cdp::types::EvaluateParams {
                expression: format!("({})", expression),
                return_by_value: Some(true),
                await_promise: Some(true),
            },
            Some(&session_id),
        )
        .await?;

    Ok(json!({ "result": result.result.value.unwrap_or(Value::Null) }))
}

// ---------------------------------------------------------------------------
// Frame handlers
// ---------------------------------------------------------------------------

async fn handle_frame(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let selector = cmd.get("selector").and_then(|v| v.as_str());
    let name = cmd.get("name").and_then(|v| v.as_str());
    let url = cmd.get("url").and_then(|v| v.as_str());

    if selector.is_none() && name.is_none() && url.is_none() {
        return Err("At least one of 'selector', 'name', or 'url' is required".to_string());
    }

    let tree_result = mgr
        .client
        .send_command_no_params("Page.getFrameTree", Some(&session_id))
        .await?;

    fn find_frame(tree: &Value, name: Option<&str>, url: Option<&str>) -> Option<String> {
        let frame = tree.get("frame")?;
        let frame_name = frame.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let frame_url = frame.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let frame_id = frame.get("id").and_then(|v| v.as_str())?;

        if let Some(n) = name {
            if frame_name == n {
                return Some(frame_id.to_string());
            }
        }
        if let Some(u) = url {
            if frame_url.contains(u) {
                return Some(frame_id.to_string());
            }
        }

        if let Some(children) = tree.get("childFrames").and_then(|v| v.as_array()) {
            for child in children {
                if let Some(id) = find_frame(child, name, url) {
                    return Some(id);
                }
            }
        }
        None
    }

    let frame_tree = &tree_result["frameTree"];

    // If selector, resolve via JS to find the iframe's contentWindow
    if let Some(sel) = selector {
        let js = format!(
            r#"(() => {{
                const el = document.querySelector({});
                if (!el) return null;
                if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {{
                    return el.name || el.id || 'frame';
                }}
                return null;
            }})()"#,
            serde_json::to_string(sel).unwrap_or_default()
        );
        let result = mgr.evaluate(&js, None).await?;
        let frame_name = result.as_str().ok_or("Could not find frame for selector")?;
        if let Some(frame_id) = find_frame(frame_tree, Some(frame_name), None) {
            state.active_frame_id = Some(frame_id);
            return Ok(json!({ "frame": frame_name }));
        }
    }

    if let Some(frame_id) = find_frame(frame_tree, name, url) {
        let label = name.or(url).unwrap_or("frame");
        state.active_frame_id = Some(frame_id);
        return Ok(json!({ "frame": label }));
    }

    Err("Frame not found".to_string())
}

async fn handle_mainframe(state: &mut DaemonState) -> Result<Value, String> {
    state.active_frame_id = None;
    Ok(json!({ "frame": "main" }))
}

// ---------------------------------------------------------------------------
// Semantic locator handlers
// ---------------------------------------------------------------------------

async fn execute_subaction(
    cmd: &Value,
    state: &mut DaemonState,
    selector: &str,
) -> Result<Value, String> {
    let subaction = cmd
        .get("subaction")
        .and_then(|v| v.as_str())
        .unwrap_or("click");
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    match subaction {
        "click" => {
            interaction::click(
                &mgr.client,
                &session_id,
                &state.ref_map,
                selector,
                "left",
                1,
            )
            .await?;
            Ok(json!({ "clicked": selector }))
        }
        "fill" => {
            let value = cmd
                .get("value")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'value' for fill subaction")?;
            interaction::fill(&mgr.client, &session_id, &state.ref_map, selector, value).await?;
            Ok(json!({ "filled": selector }))
        }
        "check" => {
            interaction::check(&mgr.client, &session_id, &state.ref_map, selector).await?;
            Ok(json!({ "checked": selector }))
        }
        "hover" => {
            interaction::hover(&mgr.client, &session_id, &state.ref_map, selector).await?;
            Ok(json!({ "hovered": selector }))
        }
        "text" => {
            let text = super::element::get_element_text(
                &mgr.client,
                &session_id,
                &state.ref_map,
                selector,
            )
            .await?;
            Ok(json!({ "text": text }))
        }
        _ => Err(format!("Unknown subaction: {}", subaction)),
    }
}

async fn handle_getbyrole(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    state.browser.as_ref().ok_or("Browser not launched")?;
    let role = cmd
        .get("role")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'role' parameter")?;
    let name = cmd.get("name").and_then(|v| v.as_str());
    let exact = cmd.get("exact").and_then(|v| v.as_bool()).unwrap_or(false);

    // Route through the unified selector resolver: encode as a semantic
    // (aria=) selector and let the subaction resolve it like any other
    // selector string.
    let semantic = super::selector::SemanticSelector::by_role(role, name, exact)?;
    let selector = super::selector::encode_semantic_selector(&semantic);
    execute_subaction(cmd, state, &selector).await
}

async fn handle_semantic_locator(
    cmd: &Value,
    state: &mut DaemonState,
    kind: super::selector::SemanticKind,
    param_name: &str,
) -> Result<Value, String> {
    state.browser.as_ref().ok_or("Browser not launched")?;
    let value = cmd
        .get(param_name)
        .and_then(|v| v.as_str())
        .ok_or(format!("Missing '{}' parameter", param_name))?;
    let exact = cmd.get("exact").and_then(|v| v.as_bool()).unwrap_or(false);

    // Route through the unified selector resolver instead of bespoke per-kind
    // page scripts (previously half-duplicated the extension's selector.js).
    let semantic = super::selector::SemanticSelector::by_value(kind, value, exact)?;
    let selector = super::selector::encode_semantic_selector(&semantic);
    execute_subaction(cmd, state, &selector).await
}

async fn handle_getbytext(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    handle_semantic_locator(cmd, state, super::selector::SemanticKind::Text, "text").await
}

async fn handle_getbylabel(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    handle_semantic_locator(cmd, state, super::selector::SemanticKind::Label, "label").await
}

async fn handle_getbyplaceholder(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    handle_semantic_locator(
        cmd,
        state,
        super::selector::SemanticKind::Placeholder,
        "placeholder",
    )
    .await
}

async fn handle_getbyalttext(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    handle_semantic_locator(cmd, state, super::selector::SemanticKind::AltText, "text").await
}

async fn handle_getbytitle(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    handle_semantic_locator(cmd, state, super::selector::SemanticKind::Title, "text").await
}

async fn handle_getbytestid(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    handle_semantic_locator(cmd, state, super::selector::SemanticKind::TestId, "testId").await
}

async fn handle_nth(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;
    let index = cmd
        .get("index")
        .and_then(|v| v.as_i64())
        .ok_or("Missing 'index' parameter")?;

    let js = format!(
        r#"(() => {{
            const els = document.querySelectorAll({sel});
            const idx = {idx} < 0 ? els.length + {idx} : {idx};
            if (idx < 0 || idx >= els.length) return false;
            els[idx].setAttribute('data-stella-browser-located', 'true');
            return true;
        }})()"#,
        sel = serde_json::to_string(selector).unwrap_or_default(),
        idx = index,
    );

    let result: super::cdp::types::EvaluateResult = mgr
        .client
        .send_command_typed(
            "Runtime.evaluate",
            &super::cdp::types::EvaluateParams {
                expression: js,
                return_by_value: Some(true),
                await_promise: Some(false),
            },
            Some(&session_id),
        )
        .await?;

    if !result
        .result
        .value
        .as_ref()
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Err(format!(
            "No element at index {} for selector '{}'",
            index, selector
        ));
    }

    let located = "[data-stella-browser-located='true']";
    let action_result = execute_subaction(cmd, state, located).await;

    if let Some(ref browser) = state.browser {
        let _ = browser
            .evaluate(
                "document.querySelector('[data-stella-browser-located]')?.removeAttribute('data-stella-browser-located')",
                None,
            )
            .await;
    }

    action_result
}

async fn handle_find(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let _session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;

    let js = format!(
        r#"(() => {{
            const els = document.querySelectorAll({});
            return Array.from(els).map((el, i) => ({{
                index: i,
                tagName: el.tagName.toLowerCase(),
                text: el.textContent?.trim().substring(0, 100) || '',
                visible: el.offsetWidth > 0 && el.offsetHeight > 0,
            }}));
        }})()"#,
        serde_json::to_string(selector).unwrap_or_default()
    );

    let result = mgr.evaluate(&js, None).await?;
    Ok(json!({ "elements": result, "selector": selector }))
}

async fn handle_evalhandle(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let script = cmd
        .get("script")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'script' parameter")?;

    let result: super::cdp::types::EvaluateResult = mgr
        .client
        .send_command_typed(
            "Runtime.evaluate",
            &super::cdp::types::EvaluateParams {
                expression: script.to_string(),
                return_by_value: Some(false),
                await_promise: Some(true),
            },
            Some(&session_id),
        )
        .await?;

    let handle = result.result.object_id.unwrap_or_default();
    Ok(json!({ "handle": handle }))
}

// ---------------------------------------------------------------------------
// Advanced interaction handlers
// ---------------------------------------------------------------------------

async fn handle_drag(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let source = cmd
        .get("source")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'source' parameter")?;
    let target = cmd
        .get("target")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'target' parameter")?;

    // Shared actionability layer for both drag endpoints. The source must
    // win the hit-test (the pointer actually grabs it); the target only needs
    // to be visible with a stable point (drop zones are often overlaid by
    // placeholder/preview elements).
    let source_point =
        interaction::wait_for_actionable(&mgr.client, &session_id, &state.ref_map, source, true)
            .await?;
    let target_point =
        interaction::wait_for_actionable(&mgr.client, &session_id, &state.ref_map, target, false)
            .await?;
    let (sx, sy) = (source_point.x, source_point.y);
    let (tx, ty) = (target_point.x, target_point.y);

    // HTML5 drag-and-drop (dragstart/dragover/drop) is not triggered by raw
    // Input.dispatchMouseEvent sequences: Chromium synthesizes drag events
    // from OS-level drags, not injected mouse moves. Input.setInterceptDrags
    // makes Chromium surface the drag as an Input.dragIntercepted event whose
    // payload can be replayed with Input.dispatchDragEvent, which does fire
    // the HTML5 events. Interception is best-effort: if the command is
    // unsupported or no drag starts (plain, non-draggable content), this
    // falls back to the raw mouse drag and says so in the result.
    let intercepting = mgr
        .client
        .send_command(
            "Input.setInterceptDrags",
            Some(json!({ "enabled": true })),
            Some(&session_id),
        )
        .await
        .is_ok();
    let mut drag_events = if intercepting {
        Some(mgr.client.subscribe())
    } else {
        None
    };
    let mut drag_data: Option<Value> = None;
    let poll_intercepted = |rx: &mut Option<broadcast::Receiver<CdpEvent>>| {
        if let Some(rx) = rx.as_mut() {
            loop {
                match rx.try_recv() {
                    Ok(event) => {
                        if event.method == "Input.dragIntercepted" {
                            if let Some(data) = event.params.get("data") {
                                return Some(data.clone());
                            }
                        }
                    }
                    Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }
        None
    };

    // Mouse down at source
    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({ "type": "mouseMoved", "x": sx, "y": sy })),
            Some(&session_id),
        )
        .await?;
    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({ "type": "mousePressed", "x": sx, "y": sy, "button": "left", "clickCount": 1 })),
            Some(&session_id),
        )
        .await?;

    // Move in steps to target
    let steps = 10;
    for i in 1..=steps {
        let cx = sx + (tx - sx) * (i as f64) / (steps as f64);
        let cy = sy + (ty - sy) * (i as f64) / (steps as f64);
        mgr.client
            .send_command(
                "Input.dispatchMouseEvent",
                Some(json!({ "type": "mouseMoved", "x": cx, "y": cy })),
                Some(&session_id),
            )
            .await?;
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
        if drag_data.is_none() {
            drag_data = poll_intercepted(&mut drag_events);
        }
    }

    // A dragstart fired by the final moves can arrive slightly after the
    // move that triggered it; give interception a short grace window.
    if intercepting && drag_data.is_none() {
        for _ in 0..10 {
            tokio::time::sleep(tokio::time::Duration::from_millis(30)).await;
            drag_data = poll_intercepted(&mut drag_events);
            if drag_data.is_some() {
                break;
            }
        }
    }

    let result = if let Some(data) = drag_data {
        // Replay the intercepted drag over the target so the page sees the
        // full HTML5 sequence (dragEnter -> dragOver -> drop).
        let mut replay: Result<(), String> = Ok(());
        for event_type in ["dragEnter", "dragOver", "drop"] {
            if let Err(e) = mgr
                .client
                .send_command(
                    "Input.dispatchDragEvent",
                    Some(json!({ "type": event_type, "x": tx, "y": ty, "data": data })),
                    Some(&session_id),
                )
                .await
            {
                replay = Err(e);
                break;
            }
        }
        match replay {
            Ok(()) => {
                json!({ "dragged": true, "html5": true, "source": source, "target": target })
            }
            Err(e) => {
                // Don't leave the page mid-drag with the button down.
                let _ = mgr
                    .client
                    .send_command(
                        "Input.dispatchMouseEvent",
                        Some(json!({ "type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1 })),
                        Some(&session_id),
                    )
                    .await;
                let _ = mgr
                    .client
                    .send_command(
                        "Input.setInterceptDrags",
                        Some(json!({ "enabled": false })),
                        Some(&session_id),
                    )
                    .await;
                return Err(format!("HTML5 drop dispatch failed: {}", e));
            }
        }
    } else {
        // Raw mouse drag: works for pointer-event based UIs (sliders, canvas,
        // custom mouse handlers) but does NOT fire HTML5 dragstart/drop.
        mgr.client
            .send_command(
                "Input.dispatchMouseEvent",
                Some(json!({ "type": "mouseReleased", "x": tx, "y": ty, "button": "left", "clickCount": 1 })),
                Some(&session_id),
            )
            .await?;
        json!({
            "dragged": true,
            "html5": false,
            "source": source,
            "target": target,
            "note": "No HTML5 drag was detected, so a raw mouse drag was performed. Pages that rely on HTML5 dragstart/drop events may not respond; pointer-event based drag UIs will.",
        })
    };

    if intercepting {
        let _ = mgr
            .client
            .send_command(
                "Input.setInterceptDrags",
                Some(json!({ "enabled": false })),
                Some(&session_id),
            )
            .await;
    }

    Ok(result)
}

async fn handle_expose(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name' parameter")?;

    mgr.client
        .send_command(
            "Runtime.addBinding",
            Some(json!({ "name": name })),
            Some(&session_id),
        )
        .await?;

    Ok(json!({ "exposed": name }))
}

async fn handle_pause(_state: &DaemonState) -> Result<Value, String> {
    Ok(json!({ "paused": true, "note": "Use DevTools to inspect. The daemon remains running." }))
}

async fn handle_multiselect(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let _session_id = mgr.active_session_id()?.to_string();
    let selector = cmd
        .get("selector")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'selector' parameter")?;
    let values: Vec<String> = cmd
        .get("values")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let values_json = serde_json::to_string(&values).unwrap_or("[]".to_string());
    let js = format!(
        r#"(() => {{
            const select = document.querySelector({sel});
            if (!select) throw new Error('Select element not found');
            const vals = {vals};
            for (const opt of select.options) {{
                opt.selected = vals.includes(opt.value);
            }}
            select.dispatchEvent(new Event('change', {{ bubbles: true }}));
            return Array.from(select.selectedOptions).map(o => o.value);
        }})()"#,
        sel = serde_json::to_string(selector).unwrap_or_default(),
        vals = values_json,
    );

    let result = mgr.evaluate(&js, None).await?;
    Ok(json!({ "selected": result }))
}

async fn handle_responsebody(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let (client, session_id) = {
        let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
        (
            Arc::clone(&mgr.client),
            mgr.active_session_id()?.to_string(),
        )
    };
    let url_pattern = cmd
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url' parameter")?;
    let timeout_ms = cmd.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30000);
    let after = cmd.get("after").and_then(Value::as_u64).unwrap_or(0);

    // The command entry drain captures responses that completed between an
    // action and this wait. Prefer that bounded cache before subscribing for
    // future traffic; this makes `waitForResponse(pattern, () => click())`
    // race-free despite BrowserSession's serialized command transport.
    if let Some(entry) = state
        .tracked_requests
        .iter()
        .rev()
        .find(|entry| tracked_response_matches(entry, &session_id, url_pattern, after))
    {
        return Ok(json!({
            "url": entry.url,
            "method": entry.method,
            "status": entry.status.unwrap_or(0),
            "headers": entry.response_headers.clone().unwrap_or_else(|| json!({})),
            "body": entry.body.clone().unwrap_or_default(),
            "base64Encoded": entry.body_base64,
            "truncated": entry.body_truncated,
            "completed": entry.completed,
        }));
    }

    // Headers may have arrived during the command-entry drain while the body
    // is still loading. Poll CDP for that exact request instead of waiting for
    // another responseReceived event that will never be emitted.
    let pending_cached = state.tracked_requests.iter().rev().find(|entry| {
        entry.session_id == session_id
            && entry.timestamp >= after
            && entry.url.contains(url_pattern)
            && entry.status.is_some()
            && !entry.completed
    });
    if let Some(entry) = pending_cached {
        let request_id = entry.request_id.clone();
        let response_url = entry.url.clone();
        let method = entry.method.clone();
        let status = entry.status.unwrap_or(0);
        let headers = entry.response_headers.clone().unwrap_or_else(|| json!({}));
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);
        loop {
            match client
                .send_command(
                    "Network.getResponseBody",
                    Some(json!({ "requestId": request_id })),
                    Some(&session_id),
                )
                .await
            {
                Ok(body_result) => {
                    let body = body_result
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let (captured, truncated) = truncate_utf8(body, MAX_TRACKED_BODY_BYTES);
                    return Ok(json!({
                        "url": response_url,
                        "method": method,
                        "status": status,
                        "headers": headers,
                        "body": captured,
                        "base64Encoded": body_result
                            .get("base64Encoded")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        "truncated": truncated,
                        "completed": true,
                    }));
                }
                Err(_) if tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                }
                Err(_) => {
                    return Err(format!(
                        "Timeout waiting for response body matching '{}'",
                        url_pattern
                    ));
                }
            }
        }
    }

    client
        .send_command_no_params("Network.enable", Some(&session_id))
        .await?;
    state.request_tracking = true;

    let mut rx = client.subscribe();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(format!(
                "Timeout waiting for response matching '{}'",
                url_pattern
            ));
        }

        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(event)) => {
                if event.method == "Network.responseReceived"
                    && event.session_id.as_deref() == Some(&session_id)
                {
                    if let Some(resp_url) = event
                        .params
                        .get("response")
                        .and_then(|r| r.get("url"))
                        .and_then(|u| u.as_str())
                    {
                        if resp_url.contains(url_pattern) {
                            let request_id = event
                                .params
                                .get("requestId")
                                .and_then(|v| v.as_str())
                                .ok_or("No requestId in response event")?
                                .to_string();
                            let status = event
                                .params
                                .get("response")
                                .and_then(|r| r.get("status"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            let headers = event
                                .params
                                .get("response")
                                .and_then(|r| r.get("headers"))
                                .cloned()
                                .unwrap_or(json!({}));

                            loop {
                                let remaining =
                                    deadline.saturating_duration_since(tokio::time::Instant::now());
                                if remaining.is_zero() {
                                    return Err(format!(
                                        "Timeout waiting for response body matching '{}'",
                                        url_pattern
                                    ));
                                }
                                match tokio::time::timeout(remaining, rx.recv()).await {
                                    Ok(Ok(finished))
                                        if finished.session_id.as_deref() == Some(&session_id)
                                            && finished
                                                .params
                                                .get("requestId")
                                                .and_then(Value::as_str)
                                                == Some(request_id.as_str())
                                            && finished.method == "Network.loadingFinished" =>
                                    {
                                        break;
                                    }
                                    Ok(Ok(failed))
                                        if failed.session_id.as_deref() == Some(&session_id)
                                            && failed
                                                .params
                                                .get("requestId")
                                                .and_then(Value::as_str)
                                                == Some(request_id.as_str())
                                            && failed.method == "Network.loadingFailed" =>
                                    {
                                        return Err(format!(
                                            "Response matching '{}' failed to load: {}",
                                            url_pattern,
                                            failed
                                                .params
                                                .get("errorText")
                                                .and_then(Value::as_str)
                                                .unwrap_or("unknown network error")
                                        ));
                                    }
                                    Ok(Ok(_)) | Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                                    }
                                    Ok(Err(_)) => return Err("Event stream closed".to_string()),
                                    Err(_) => {
                                        return Err(format!(
                                            "Timeout waiting for response body matching '{}'",
                                            url_pattern
                                        ));
                                    }
                                }
                            }

                            let body_result = client
                                .send_command(
                                    "Network.getResponseBody",
                                    Some(json!({ "requestId": request_id })),
                                    Some(&session_id),
                                )
                                .await?;
                            let body = body_result
                                .get("body")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");

                            let (captured, truncated) = truncate_utf8(body, MAX_TRACKED_BODY_BYTES);
                            return Ok(json!({
                                "url": resp_url,
                                "body": captured,
                                "status": status,
                                "headers": headers,
                                "base64Encoded": body_result
                                    .get("base64Encoded")
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                                "truncated": truncated,
                                "completed": true,
                            }));
                        }
                    }
                }
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return Err("Event stream closed".to_string()),
            Err(_) => {
                return Err(format!(
                    "Timeout waiting for response matching '{}'",
                    url_pattern
                ));
            }
        }
    }
}

fn tracked_response_matches(
    entry: &TrackedRequest,
    session_id: &str,
    url_pattern: &str,
    after: u64,
) -> bool {
    entry.session_id == session_id
        && entry.timestamp >= after
        && entry.url.contains(url_pattern)
        && entry.status.is_some()
        && entry.completed
}

async fn handle_authenticated_request(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let requested_url = cmd
        .get("url")
        .and_then(Value::as_str)
        .ok_or("Missing 'url' parameter")?;
    let page_url = url::Url::parse(&mgr.active_url_protocol().await?)
        .map_err(|_| "The active tab does not have an HTTP(S) origin".to_string())?;
    let target_url = page_url
        .join(requested_url)
        .map_err(|_| "Authenticated request URL is invalid".to_string())?;
    let origin = |url: &url::Url| {
        (
            url.scheme().to_ascii_lowercase(),
            url.host_str().unwrap_or("").to_ascii_lowercase(),
            url.port_or_known_default(),
        )
    };
    if !matches!(target_url.scheme(), "http" | "https") || origin(&page_url) != origin(&target_url)
    {
        return Err(
            "Authenticated browser requests must stay on the active tab's origin".to_string(),
        );
    }
    let method = cmd
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    if !method
        .chars()
        .all(|character| character.is_ascii_uppercase() || character == '-')
    {
        return Err("Request method contains unsupported characters".to_string());
    }
    let headers: HashMap<String, String> = match cmd.get("headers") {
        None | Some(Value::Null) => HashMap::new(),
        Some(Value::Object(headers)) => headers
            .iter()
            .map(|(name, value)| {
                let lower = name.trim().to_ascii_lowercase();
                if lower.is_empty()
                    || matches!(lower.as_str(), "cookie" | "host" | "content-length")
                {
                    return Err(format!("Request header '{}' is not allowed", name));
                }
                value
                    .as_str()
                    .map(|value| (name.clone(), value.to_string()))
                    .ok_or_else(|| "Request headers must contain only string values".to_string())
            })
            .collect::<Result<_, _>>()?,
        _ => return Err("Request headers must be an object".to_string()),
    };
    let body = match cmd.get("body") {
        None | Some(Value::Null) => None,
        Some(Value::String(body)) => Some(body.clone()),
        _ => return Err("Request body must be a string".to_string()),
    };
    if (method == "GET" || method == "HEAD") && body.is_some() {
        return Err(format!("{} requests cannot have a body", method));
    }
    let timeout_ms = cmd
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .clamp(1, 240_000);
    let max_body_bytes = cmd
        .get("maxBodyBytes")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_TRACKED_BODY_BYTES as u64)
        .clamp(1, 1024 * 1024) as usize;
    let session_id = mgr.active_session_id()?.to_string();
    let target = target_url.as_str().to_string();
    let cookies =
        cookies::get_cookies(&mgr.client, &session_id, Some(vec![target.clone()])).await?;
    let cookie_header = cookies
        .into_iter()
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize authenticated request client".to_string())?;
    let request_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| "Request method is invalid".to_string())?;
    let mut request = client.request(request_method, &target);
    if !cookie_header.is_empty() {
        request = request.header(reqwest::header::COOKIE, cookie_header);
    }
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Authenticated request failed: {}", error.without_url()))?;
    let status = response.status();
    let response_headers: HashMap<String, String> = response
        .headers()
        .iter()
        .filter(|(name, _)| {
            !matches!(
                name.as_str().to_ascii_lowercase().as_str(),
                "set-cookie" | "set-cookie2"
            )
        })
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    let redirect_location = if status.is_redirection() {
        response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|location| target_url.join(location).ok())
            .map(|redirect| {
                if origin(&redirect) == origin(&target_url) {
                    redirect.to_string()
                } else {
                    "cross-origin redirect blocked".to_string()
                }
            })
    } else {
        None
    };
    let mut bytes = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Authenticated response failed: {}", error.without_url()))?
    {
        let remaining = max_body_bytes.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() == max_body_bytes {
            truncated = true;
            break;
        }
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok(json!({
        "url": target,
        "status": status.as_u16(),
        "ok": status.is_success(),
        "headers": response_headers,
        "body": body,
        "truncated": truncated,
        "redirect": redirect_location,
        "redirectFollowed": false,
    }))
}

async fn handle_authenticated_request_batch(
    cmd: &Value,
    state: &DaemonState,
) -> Result<Value, String> {
    use futures_util::{stream, StreamExt};

    let requests = cmd
        .get("requests")
        .and_then(Value::as_array)
        .ok_or("Authenticated request batch requires a requests array")?;
    if requests.is_empty() || requests.len() > 100 {
        return Err("Authenticated request batch must contain 1 to 100 requests".to_string());
    }
    let concurrency = cmd.get("concurrency").and_then(Value::as_u64).unwrap_or(4);
    if !(1..=4).contains(&concurrency) {
        return Err("Authenticated request batch concurrency must be from 1 to 4".to_string());
    }
    let default_timeout = cmd
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .clamp(1, 600_000);
    let results = stream::iter(requests.iter().cloned().enumerate())
        .map(|(index, mut request)| async move {
            let request_object = request
                .as_object_mut()
                .ok_or_else(|| format!("requests[{}] must be an object", index))?;
            request_object
                .entry("timeout".to_string())
                .or_insert(json!(default_timeout));
            handle_authenticated_request(&request, state)
                .await
                .map_err(|error| format!("requests[{}]: {}", index, error))
        })
        .buffered(concurrency as usize)
        .collect::<Vec<Result<Value, String>>>()
        .await;

    let mut successful = Vec::with_capacity(results.len());
    for result in results {
        successful.push(result?);
    }
    Ok(json!({ "responses": successful, "concurrency": concurrency }))
}

/// Waits for a download to complete and reports where it actually landed.
///
/// `Browser.downloadWillBegin`/`Page.downloadWillBegin` supply the download's
/// guid, source url, and suggested filename; the matching
/// `*.downloadProgress` event with state `completed` marks the finish. With
/// the download directory known (recorded by the `download` action or
/// STELLA_BROWSER_DOWNLOAD_PATH), the real path is `<dir>/<guid>`
/// (Browser.setDownloadBehavior "allowAndName") or `<dir>/<suggested>`
/// ("allow" from launch); whichever exists on disk wins and is returned with
/// `verified: true`. When neither can be confirmed, the response falls back
/// to the caller-requested `path` with `verified: false` so callers can no
/// longer mistake an echo of their own input for the download location.
async fn handle_waitfordownload(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let timeout_ms = cmd.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30000);

    let mut rx = mgr.client.subscribe();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(timeout_ms);

    // guid -> (url, suggestedFilename) from downloadWillBegin events.
    let mut announced: std::collections::HashMap<String, (String, String)> =
        std::collections::HashMap::new();

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("Timeout waiting for download".to_string());
        }

        let event = match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(event)) => event,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return Err("Event stream closed".to_string()),
            Err(_) => return Err("Timeout waiting for download".to_string()),
        };

        match event.method.as_str() {
            // Deprecated Page.* and current Browser.* variants carry the same
            // fields; which one fires depends on how download behavior was
            // configured (eventsEnabled) and the Chromium version.
            "Browser.downloadWillBegin" | "Page.downloadWillBegin" => {
                if let Some(guid) = event.params.get("guid").and_then(|v| v.as_str()) {
                    let url = event
                        .params
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let suggested = event
                        .params
                        .get("suggestedFilename")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    announced.insert(guid.to_string(), (url, suggested));
                }
            }
            "Browser.downloadProgress" | "Page.downloadProgress" => {
                let is_page_event = event.method.starts_with("Page.");
                if is_page_event && event.session_id.as_deref() != Some(&session_id) {
                    continue;
                }
                if event.params.get("state").and_then(|v| v.as_str()) != Some("completed") {
                    continue;
                }
                let guid = event
                    .params
                    .get("guid")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let (url, suggested) = announced
                    .get(guid)
                    .cloned()
                    .unwrap_or_else(|| (String::new(), String::new()));

                // Resolve the real on-disk location if the download directory
                // is known: allowAndName saves as <dir>/<guid>, plain allow
                // saves as <dir>/<suggestedFilename>.
                if let Some(dir) = state.download_dir.as_deref() {
                    let mut candidates: Vec<PathBuf> = Vec::new();
                    if !guid.is_empty() {
                        candidates.push(PathBuf::from(dir).join(guid));
                    }
                    if !suggested.is_empty() {
                        candidates.push(PathBuf::from(dir).join(&suggested));
                    }
                    if let Some(real) = candidates.iter().find(|p| p.exists()) {
                        return Ok(json!({
                            "path": real.to_string_lossy(),
                            "suggestedFilename": suggested,
                            "url": url,
                            "guid": guid,
                            "verified": true,
                        }));
                    }
                }

                // Could not verify a file on disk: report the caller's
                // requested path, explicitly marked unverified.
                let requested = cmd
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("download");
                return Ok(json!({
                    "path": requested,
                    "suggestedFilename": suggested,
                    "url": url,
                    "guid": guid,
                    "verified": false,
                    "note": "Download completed, but the reported path is the caller-requested value and was not verified on disk. Run the 'download' action first to set a download directory the daemon can verify against.",
                }));
            }
            _ => {}
        }
    }
}

async fn handle_window_new(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;

    // Create a new browser context
    let context_result = mgr
        .client
        .send_command_no_params("Target.createBrowserContext", None)
        .await?;
    let context_id = context_result
        .get("browserContextId")
        .and_then(|v| v.as_str())
        .ok_or("Failed to create browser context")?
        .to_string();

    let create_result: super::cdp::types::CreateTargetResult = mgr
        .client
        .send_command_typed(
            "Target.createTarget",
            &json!({ "url": "about:blank", "browserContextId": context_id }),
            None,
        )
        .await?;

    let attach: super::cdp::types::AttachToTargetResult = mgr
        .client
        .send_command_typed(
            "Target.attachToTarget",
            &super::cdp::types::AttachToTargetParams {
                target_id: create_result.target_id.clone(),
                flatten: true,
            },
            None,
        )
        .await?;

    let tab_id = mgr.add_page(super::browser::PageInfo {
        target_id: create_result.target_id,
        session_id: attach.session_id,
        tab_id: 0,                     // assigned by add_page
        tab_generation: String::new(), // assigned by add_page
        url: "about:blank".to_string(),
        title: String::new(),
        target_type: "page".to_string(),
    });
    if let Some(owner_id) = command_owner_id(cmd) {
        mgr.record_owner_tab(owner_id, tab_id);
    }

    if let Some(viewport) = cmd.get("viewport") {
        let width = viewport
            .get("width")
            .and_then(|v| v.as_i64())
            .unwrap_or(1280) as i32;
        let height = viewport
            .get("height")
            .and_then(|v| v.as_i64())
            .unwrap_or(720) as i32;
        mgr.set_viewport(width, height, 1.0, false).await?;
    }

    let total = mgr.page_count();
    let tab_id = mgr.active_tab_id();
    state.ref_map.clear();

    Ok(json!({ "tabId": tab_id, "index": total - 1, "total": total }))
}

async fn handle_diff_screenshot(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let baseline_path = cmd
        .get("baseline")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'baseline' parameter")?;

    let threshold = cmd.get("threshold").and_then(|v| v.as_f64()).unwrap_or(0.1);

    let options = ScreenshotOptions {
        selector: cmd
            .get("selector")
            .and_then(|v| v.as_str())
            .map(String::from),
        path: None,
        full_page: cmd
            .get("fullPage")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        format: "png".to_string(),
        quality: None,
        annotate: false,
        output_dir: None,
    };

    let result =
        screenshot::take_screenshot(&mgr.client, &session_id, &state.ref_map, &options).await?;

    let current_bytes =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &result.base64)
            .map_err(|e| format!("Failed to decode screenshot: {}", e))?;

    let baseline_bytes =
        std::fs::read(baseline_path).map_err(|e| format!("Failed to read baseline: {}", e))?;

    let result = diff::diff_screenshot(&baseline_bytes, &current_bytes, threshold)?;

    let output_path = cmd.get("output").and_then(|v| v.as_str());
    if let (Some(out_path), Some(ref diff_data)) = (output_path, &result.diff_image) {
        std::fs::write(out_path, diff_data)
            .map_err(|e| format!("Failed to write diff image: {}", e))?;
    }

    Ok(json!({
        "match": result.matched,
        "mismatchPercentage": result.mismatch_percentage,
        "totalPixels": result.total_pixels,
        "differentPixels": result.different_pixels,
        "diffPath": output_path,
        "dimensionMismatch": result.dimension_mismatch,
    }))
}

// ---------------------------------------------------------------------------
// Video and HAR handlers
// ---------------------------------------------------------------------------

async fn handle_video_start(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let path = cmd
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;

    if state.recording_state.active {
        return Err("A recording is already in progress".to_string());
    }

    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    recording::recording_start(&mut state.recording_state, path)?;
    state
        .start_recording_task(mgr.client.clone(), session_id)
        .await?;

    Ok(json!({
        "started": true,
        "note": "Video recording started. Use video_stop to save the recording."
    }))
}

async fn handle_video_stop(state: &mut DaemonState) -> Result<Value, String> {
    if !state.recording_state.active {
        return Ok(json!({
            "stopped": false,
            "note": "No video recording was started. Use recording_stop if you used recording_start."
        }));
    }

    state.stop_recording_task().await?;
    recording::recording_stop(&mut state.recording_state)
}

async fn handle_har_start(state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    mgr.client
        .send_command_no_params("Network.enable", Some(&session_id))
        .await?;
    state.har_recording = true;
    state.har_entries.clear();
    state.har_pending_bodies.clear();
    state.har_body_bytes = 0;
    Ok(json!({ "started": true }))
}

async fn handle_har_stop(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let path = har_output_path(cmd.get("path").and_then(|v| v.as_str()));

    // Requests that finished during the very last tick have not had their
    // bodies pulled yet; do it before the recording is torn down.
    har_collect_pending_bodies(state).await;
    state.har_recording = false;

    let bodies_captured = state
        .har_entries
        .iter()
        .filter(|e| e.response_body.is_some())
        .count();
    let entries: Vec<Value> = state.har_entries.drain(..).map(har_entry_to_json).collect();
    let request_count = entries.len();
    state.har_pending_bodies.clear();
    state.har_body_bytes = 0;
    let browser = har_browser_metadata(state).await;

    let mut log = json!({
        "version": "1.2",
        "creator": {
            "name": "stella-browser",
            "version": env!("CARGO_PKG_VERSION")
        },
        "entries": entries
    });
    if let Some(browser) = browser {
        log["browser"] = browser;
    }
    let har = json!({ "log": log });

    let har_str = serde_json::to_string_pretty(&har)
        .map_err(|e| format!("Failed to serialize HAR: {}", e))?;
    std::fs::write(&path, har_str).map_err(|e| format!("Failed to write HAR: {}", e))?;

    Ok(json!({
        "path": path,
        "requestCount": request_count,
        "bodiesCaptured": bodies_captured,
    }))
}

// ---------------------------------------------------------------------------
// HAR serialization helpers
// ---------------------------------------------------------------------------

/// Convert a `HarEntry` (collected from CDP events) into a HAR 1.2 entry object.
fn har_entry_to_json(e: HarEntry) -> Value {
    let started_date_time = har_wall_time_to_rfc3339(e.wall_time);

    let request_cookies = e
        .request_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("cookie"))
        .map(|(_, v)| har_parse_request_cookies(v))
        .unwrap_or_default();

    let query_string = har_parse_query_string(&e.url);

    let req_headers: Vec<Value> = e
        .request_headers
        .iter()
        .map(|(k, v)| json!({ "name": k, "value": v }))
        .collect();

    let resp_cookies: Vec<Value> = e
        .response_headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
        .map(|(_, v)| {
            let name_value = v.split(';').next().unwrap_or("");
            let (name, value) = name_value.split_once('=').unwrap_or((name_value, ""));
            json!({ "name": name.trim(), "value": value.trim() })
        })
        .collect();

    let resp_headers: Vec<Value> = e
        .response_headers
        .iter()
        .map(|(k, v)| json!({ "name": k, "value": v }))
        .collect();

    let (timings, total_time) =
        har_compute_timings(e.cdp_timing.as_ref(), e.loading_finished_timestamp);

    let mime_type = if e.mime_type.is_empty() {
        "application/octet-stream".to_string()
    } else {
        e.mime_type
    };

    let post_content_type = e
        .request_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("text/plain")
        .to_string();

    let mut request = json!({
        "method": e.method,
        "url": e.url,
        "httpVersion": e.http_version,
        "cookies": request_cookies,
        "headers": req_headers,
        "queryString": query_string,
        "headersSize": -1,
        "bodySize": e.request_body_size,
    });
    if let Some(body) = e.post_data {
        request["postData"] = json!({ "mimeType": post_content_type, "text": body });
    }

    let mut content = json!({
        "size": e.response_body_size,
        "mimeType": mime_type,
    });
    if let Some(body) = e.response_body {
        content["text"] = json!(body);
        if e.response_body_base64 {
            content["encoding"] = json!("base64");
        }
        if e.response_body_truncated {
            content["_truncated"] = json!(true);
        }
    }

    json!({
        "startedDateTime": started_date_time,
        "time": total_time,
        "request": request,
        "response": {
            "status": e.status.unwrap_or(0),
            "statusText": e.status_text,
            "httpVersion": e.http_version,
            "cookies": resp_cookies,
            "headers": resp_headers,
            "content": content,
            "redirectURL": e.redirect_url,
            "headersSize": -1,
            "bodySize": e.response_body_size,
        },
        "cache": {},
        "timings": timings,
        "_resourceType": e.resource_type,
    })
}

/// Per-body and per-recording caps. Copying every response would mean holding
/// bundles, fonts and images in memory for a recording that only needs the JSON.
const HAR_MAX_BODY_BYTES: usize = 512 * 1024;
const HAR_MAX_TOTAL_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Whether a recorded exchange is an API call worth keeping the body of. The
/// CDP resource type is the reliable signal; the MIME check catches JSON served
/// under an unexpected type.
fn har_is_api_shaped(resource_type: &str, mime_type: &str) -> bool {
    if resource_type == "XHR" || resource_type == "Fetch" {
        return true;
    }
    let mime = mime_type.to_ascii_lowercase();
    mime.contains("json") || mime.contains("graphql")
}

/// Pull queued response bodies out of the CDP buffer into their HAR entries.
/// Best-effort throughout: an evicted buffer or a detached target degrades the
/// report but must never fail the command that happened to trigger the drain.
async fn har_collect_pending_bodies(state: &mut DaemonState) {
    if state.har_pending_bodies.is_empty() {
        return;
    }

    let pending: Vec<String> = std::mem::take(&mut state.har_pending_bodies);
    let session_id = match state
        .browser
        .as_ref()
        .and_then(|mgr| mgr.active_session_id().ok())
    {
        Some(id) => id.to_string(),
        None => return,
    };

    for request_id in pending {
        if state.har_body_bytes >= HAR_MAX_TOTAL_BODY_BYTES {
            break;
        }
        if state
            .har_entries
            .iter()
            .rev()
            .find(|e| e.request_id == request_id)
            .map(|e| e.response_body.is_some())
            .unwrap_or(true)
        {
            continue;
        }

        let client = match state.browser.as_ref() {
            Some(mgr) => &mgr.client,
            None => return,
        };
        let result: Result<Value, String> = client
            .send_command(
                "Network.getResponseBody",
                Some(json!({ "requestId": request_id })),
                Some(&session_id),
            )
            .await;
        let Ok(value) = result else { continue };
        let Some(body) = value.get("body").and_then(|v| v.as_str()) else {
            continue;
        };
        let base64_encoded = value
            .get("base64Encoded")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let (text, truncated) = truncate_utf8(body, HAR_MAX_BODY_BYTES);
        state.har_body_bytes += text.len();

        if let Some(entry) = state
            .har_entries
            .iter_mut()
            .rev()
            .find(|e| e.request_id == request_id)
        {
            entry.response_body = Some(text);
            entry.response_body_base64 = base64_encoded;
            entry.response_body_truncated = truncated;
        }
    }
}

/// Pull completed observed response bodies while CDP still retains them.
/// Observation is deliberately bounded both per response and across the
/// daemon, so a tab that streams large assets cannot grow the bridge without
/// limit.
async fn tracked_collect_pending_bodies(state: &mut DaemonState) {
    if state.tracked_pending_bodies.is_empty() {
        return;
    }
    let pending = std::mem::take(&mut state.tracked_pending_bodies);
    for (session_id, request_id) in pending {
        if state.tracked_body_bytes >= MAX_TRACKED_TOTAL_BODY_BYTES {
            break;
        }
        if state
            .tracked_requests
            .iter()
            .rev()
            .find(|entry| entry.request_id == request_id && entry.session_id == session_id)
            .is_none_or(|entry| entry.body.is_some())
        {
            continue;
        }
        let Some(client) = state.browser.as_ref().map(|browser| &browser.client) else {
            return;
        };
        let Ok(value) = client
            .send_command(
                "Network.getResponseBody",
                Some(json!({ "requestId": request_id })),
                Some(&session_id),
            )
            .await
        else {
            continue;
        };
        let Some(body) = value.get("body").and_then(Value::as_str) else {
            continue;
        };
        let remaining = MAX_TRACKED_TOTAL_BODY_BYTES.saturating_sub(state.tracked_body_bytes);
        let body_limit = MAX_TRACKED_BODY_BYTES.min(remaining);
        let (text, truncated) = truncate_utf8(body, body_limit);
        let captured = text.len();
        if let Some(entry) = state
            .tracked_requests
            .iter_mut()
            .rev()
            .find(|entry| entry.request_id == request_id && entry.session_id == session_id)
        {
            entry.body = Some(text);
            entry.body_base64 = value
                .get("base64Encoded")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            entry.body_truncated = truncated;
            state.tracked_body_bytes += captured;
        }
    }
}

fn har_extract_headers(headers_val: Option<&Value>) -> Vec<(String, String)> {
    headers_val
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn har_cdp_protocol_to_http_version(protocol: &str) -> String {
    match protocol.to_ascii_lowercase().as_str() {
        "h2" => "HTTP/2.0".to_string(),
        "h3" => "HTTP/3.0".to_string(),
        "http/1.0" => "HTTP/1.0".to_string(),
        _ => "HTTP/1.1".to_string(),
    }
}

fn har_parse_query_string(url_str: &str) -> Vec<Value> {
    url::Url::parse(url_str)
        .map(|u| {
            u.query_pairs()
                .map(|(k, v)| json!({ "name": k.as_ref(), "value": v.as_ref() }))
                .collect()
        })
        .unwrap_or_default()
}

fn har_parse_request_cookies(cookie_header: &str) -> Vec<Value> {
    cookie_header
        .split(';')
        .filter_map(|pair| {
            let pair = pair.trim();
            if pair.is_empty() {
                return None;
            }
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some(json!({ "name": name.trim(), "value": value.trim() }))
        })
        .collect()
}

/// Compute HAR `timings` and total `time` (ms) from a CDP `ResourceTiming`
/// object and the optional `Network.loadingFinished` monotonic timestamp.
fn har_compute_timings(
    cdp_timing: Option<&Value>,
    loading_finished_ts: Option<f64>,
) -> (Value, f64) {
    let Some(t) = cdp_timing else {
        return (json!({ "send": 0, "wait": 0, "receive": 0 }), 0.0);
    };

    let get = |key: &str| t.get(key).and_then(|v| v.as_f64()).unwrap_or(-1.0);

    let request_time = get("requestTime");
    let dns_start = get("dnsStart");
    let dns_end = get("dnsEnd");
    let connect_start = get("connectStart");
    let connect_end = get("connectEnd");
    let ssl_start = get("sslStart");
    let ssl_end = get("sslEnd");
    let send_start = get("sendStart");
    let send_end = get("sendEnd");
    let recv_headers_start = get("receiveHeadersStart");
    let recv_headers_end = get("receiveHeadersEnd");

    let dns = if dns_start >= 0.0 && dns_end >= 0.0 {
        dns_end - dns_start
    } else {
        -1.0
    };
    let connect = if connect_start >= 0.0 && connect_end >= 0.0 {
        connect_end - connect_start
    } else {
        -1.0
    };
    let ssl = if ssl_start >= 0.0 && ssl_end >= 0.0 {
        ssl_end - ssl_start
    } else {
        -1.0
    };
    let send = (send_end - send_start).max(0.0);

    let wait_end = if recv_headers_start >= 0.0 {
        recv_headers_start
    } else {
        recv_headers_end
    };
    let wait = if send_end >= 0.0 && wait_end >= send_end {
        wait_end - send_end
    } else {
        0.0
    };

    let receive = loading_finished_ts
        .filter(|_| request_time >= 0.0 && recv_headers_end >= 0.0)
        .map(|lf_ts| {
            let recv_start_abs = request_time + recv_headers_end / 1000.0;
            ((lf_ts - recv_start_abs) * 1000.0).max(0.0)
        })
        .unwrap_or(0.0);

    let blocked = if dns_start > 0.0 {
        dns_start
    } else if connect_start > 0.0 {
        connect_start
    } else if send_start > 0.0 {
        send_start
    } else {
        -1.0
    };

    let total: f64 = [
        if blocked > 0.0 { blocked } else { 0.0 },
        if dns >= 0.0 { dns } else { 0.0 },
        if connect >= 0.0 { connect } else { 0.0 },
        send,
        wait,
        receive,
    ]
    .iter()
    .sum();

    let mut timings = json!({ "send": send, "wait": wait, "receive": receive });
    if blocked > 0.0 {
        timings["blocked"] = json!(blocked);
    }
    if dns >= 0.0 {
        timings["dns"] = json!(dns);
    }
    if connect >= 0.0 {
        timings["connect"] = json!(connect);
    }
    if ssl >= 0.0 {
        timings["ssl"] = json!(ssl);
    }

    (timings, total)
}

fn har_wall_time_to_rfc3339(wall_time: f64) -> String {
    if wall_time > 0.0 {
        let nanos = (wall_time * 1_000_000_000.0).round() as i128;
        if let Ok(dt) = OffsetDateTime::from_unix_timestamp_nanos(nanos) {
            if let Ok(s) = dt.format(&Rfc3339) {
                return s;
            }
        }
    }
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn har_output_path(explicit_path: Option<&str>) -> String {
    match explicit_path {
        Some(path) => path.to_string(),
        None => {
            let dir = get_har_dir();
            let _ = std::fs::create_dir_all(&dir);
            dir.join(format!("har-{}.har", unix_timestamp_millis()))
                .to_string_lossy()
                .to_string()
        }
    }
}

fn get_har_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        home.join(".stella-browser").join("tmp").join("har")
    } else {
        std::env::temp_dir().join("stella-browser").join("har")
    }
}

fn unix_timestamp_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

async fn har_browser_metadata(state: &DaemonState) -> Option<Value> {
    let mgr = state.browser.as_ref()?;
    if !mgr.is_connection_alive().await {
        return None;
    }

    let version = mgr
        .client
        .send_command_no_params("Browser.getVersion", None)
        .await
        .ok()?;
    browser_metadata_from_version(&version)
}

fn browser_metadata_from_version(version: &Value) -> Option<Value> {
    let product = version.get("product").and_then(|v| v.as_str())?;
    let (name, browser_version) = product.split_once('/').unwrap_or((product, ""));
    Some(json!({
        "name": name,
        "version": browser_version,
    }))
}

// ---------------------------------------------------------------------------
// Fetch interception resolver (routes + domain filter)
// ---------------------------------------------------------------------------

async fn resolve_fetch_paused(
    browser: &BrowserManager,
    domain_filter: Option<&DomainFilter>,
    routes: &[RouteEntry],
    request_rewrites: &[RequestRewriteEntry],
    paused: &FetchPausedRequest,
) {
    let session_id = &paused.session_id;

    // Domain filter check (takes priority over routes)
    if let Some(filter) = domain_filter {
        if let Ok(parsed) = url::Url::parse(&paused.url) {
            let scheme = parsed.scheme();
            if scheme != "http" && scheme != "https" {
                if paused.resource_type.eq_ignore_ascii_case("document") {
                    let _ = browser
                        .client
                        .send_command(
                            "Fetch.failRequest",
                            Some(json!({
                                "requestId": paused.request_id,
                                "errorReason": "BlockedByClient"
                            })),
                            Some(session_id),
                        )
                        .await;
                } else {
                    let _ = browser
                        .client
                        .send_command(
                            "Fetch.continueRequest",
                            Some(json!({ "requestId": paused.request_id })),
                            Some(session_id),
                        )
                        .await;
                }
                return;
            }

            if let Some(hostname) = parsed.host_str() {
                if !filter.is_allowed(hostname) {
                    if paused.resource_type.eq_ignore_ascii_case("document") {
                        let error_body = format!(
                            "<html><body><h1>Blocked</h1><p>Navigation to {} is not allowed by domain filter.</p></body></html>",
                            hostname
                        );
                        let encoded = base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            error_body.as_bytes(),
                        );
                        let _ = browser
                            .client
                            .send_command(
                                "Fetch.fulfillRequest",
                                Some(json!({
                                    "requestId": paused.request_id,
                                    "responseCode": 403,
                                    "responseHeaders": [
                                        { "name": "Content-Type", "value": "text/html" },
                                    ],
                                    "body": encoded,
                                })),
                                Some(session_id),
                            )
                            .await;
                    } else {
                        let _ = browser
                            .client
                            .send_command(
                                "Fetch.failRequest",
                                Some(json!({
                                    "requestId": paused.request_id,
                                    "errorReason": "BlockedByClient"
                                })),
                                Some(session_id),
                            )
                            .await;
                    }
                    return;
                }
            }
        }
    }

    // Route matching
    for route in routes {
        let matches = url_pattern_matches(&route.url_pattern, &paused.url);

        if matches {
            if route.abort {
                let _ = browser
                    .client
                    .send_command(
                        "Fetch.failRequest",
                        Some(json!({
                            "requestId": paused.request_id,
                            "errorReason": "Failed"
                        })),
                        Some(session_id),
                    )
                    .await;
                return;
            }

            if let Some(ref resp) = route.response {
                let status = resp.status.unwrap_or(200);
                let body_str = resp.body.as_deref().unwrap_or("");
                let encoded = base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    body_str.as_bytes(),
                );
                let mut headers = vec![];
                if let Some(ct) = &resp.content_type {
                    headers.push(json!({ "name": "Content-Type", "value": ct }));
                }
                if let Some(h) = &resp.headers {
                    for (k, v) in h {
                        headers.push(json!({ "name": k, "value": v }));
                    }
                }

                let _ = browser
                    .client
                    .send_command(
                        "Fetch.fulfillRequest",
                        Some(json!({
                            "requestId": paused.request_id,
                            "responseCode": status,
                            "responseHeaders": headers,
                            "body": encoded,
                        })),
                        Some(session_id),
                    )
                    .await;
                return;
            }
        }
    }

    // Request rewriting stays entirely at the CDP Fetch boundary. No page
    // global is patched, and rewrites are scoped to the exact attached tab
    // session that registered them.
    if let Some(rewrite) = request_rewrites.iter().rev().find(|rewrite| {
        rewrite.session_id == paused.session_id
            && url_pattern_matches(&rewrite.url_pattern, &paused.url)
    }) {
        let mut params = json!({ "requestId": paused.request_id });
        if let Some(method) = &rewrite.method {
            params["method"] = json!(method);
        }
        let rewritten_post_data = if let Some(json_patch) = &rewrite.json_patch {
            paused
                .post_data
                .as_deref()
                .and_then(|post_data| serde_json::from_str::<Value>(post_data).ok())
                .map(|mut body| {
                    merge_json_value(&mut body, json_patch);
                    body.to_string()
                })
                .or_else(|| rewrite.post_data.clone())
        } else {
            rewrite.post_data.clone()
        };
        if let Some(post_data) = rewritten_post_data {
            params["postData"] = json!(base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                post_data.as_bytes(),
            ));
        }
        if !rewrite.headers.is_empty() {
            let mut headers: HashMap<String, String> = paused
                .headers
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|value| (name.clone(), value.to_string()))
                })
                .collect();
            for (name, value) in &rewrite.headers {
                headers.insert(name.clone(), value.clone());
            }
            params["headers"] = json!(headers
                .into_iter()
                .map(|(name, value)| json!({ "name": name, "value": value }))
                .collect::<Vec<_>>());
        }
        let _ = browser
            .client
            .send_command("Fetch.continueRequest", Some(params), Some(session_id))
            .await;
        return;
    }

    // No matching route -- continue the request
    let _ = browser
        .client
        .send_command(
            "Fetch.continueRequest",
            Some(json!({ "requestId": paused.request_id })),
            Some(session_id),
        )
        .await;
}

fn url_pattern_matches(pattern: &str, url: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') {
        return url.contains(pattern);
    }
    let mut remainder = url;
    let mut first = true;
    for part in pattern.split('*').filter(|part| !part.is_empty()) {
        let Some(index) = remainder.find(part) else {
            return false;
        };
        if first && !pattern.starts_with('*') && index != 0 {
            return false;
        }
        remainder = &remainder[index + part.len()..];
        first = false;
    }
    pattern.ends_with('*') || remainder.is_empty()
}

/// RFC 7396-style JSON merge patch. Object keys recurse, null removes a key,
/// and scalar/array values replace the original. This supports changing a
/// nested request field while preserving every untouched field from the
/// page's actual request body.
fn merge_json_value(target: &mut Value, patch: &Value) {
    let Value::Object(patch_object) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let target_object = target.as_object_mut().expect("target converted to object");
    for (key, patch_value) in patch_object {
        if patch_value.is_null() {
            target_object.remove(key);
            continue;
        }
        merge_json_value(
            target_object.entry(key.clone()).or_insert(Value::Null),
            patch_value,
        );
    }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn handle_route(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let url_pattern = cmd
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url' parameter")?
        .to_string();
    let abort = cmd.get("abort").and_then(|v| v.as_bool()).unwrap_or(false);

    let response = cmd.get("response").and_then(|v| {
        if v.is_null() {
            return None;
        }
        Some(RouteResponse {
            status: v.get("status").and_then(|s| s.as_u64()).map(|s| s as u16),
            body: v.get("body").and_then(|s| s.as_str()).map(String::from),
            content_type: v
                .get("contentType")
                .and_then(|s| s.as_str())
                .map(String::from),
            headers: v.get("headers").and_then(|h| {
                h.as_object().map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
            }),
        })
    });

    state.routes.push(RouteEntry {
        url_pattern: url_pattern.clone(),
        response,
        abort,
    });

    // Re-enable Fetch with all route patterns combined.
    // When domain filtering is active, include a wildcard so all requests
    // continue to be intercepted for domain checks.
    let mut patterns: Vec<Value> = state
        .routes
        .iter()
        .map(|r| json!({ "urlPattern": r.url_pattern }))
        .collect();
    patterns.extend(
        state
            .request_rewrites
            .iter()
            .filter(|rewrite| rewrite.session_id == session_id)
            .map(|rewrite| json!({ "urlPattern": rewrite.url_pattern })),
    );
    if state.domain_filter.is_some() && !patterns.iter().any(|p| p["urlPattern"] == "*") {
        patterns.push(json!({ "urlPattern": "*" }));
    }

    mgr.client
        .send_command(
            "Fetch.enable",
            Some(json!({ "patterns": patterns })),
            Some(&session_id),
        )
        .await?;

    Ok(json!({ "routed": url_pattern }))
}

async fn handle_unroute(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let url = cmd.get("url").and_then(|v| v.as_str());

    match url {
        Some(pattern) => {
            state.routes.retain(|r| r.url_pattern != pattern);
        }
        None => {
            state.routes.clear();
        }
    }

    let rewrite_patterns: Vec<Value> = state
        .request_rewrites
        .iter()
        .filter(|rewrite| rewrite.session_id == session_id)
        .map(|rewrite| json!({ "urlPattern": rewrite.url_pattern }))
        .collect();
    if state.routes.is_empty() && rewrite_patterns.is_empty() {
        if state.domain_filter.is_some() {
            // Domain filtering still needs Fetch interception; reset to wildcard
            mgr.client
                .send_command(
                    "Fetch.enable",
                    Some(json!({ "patterns": [{ "urlPattern": "*" }] })),
                    Some(&session_id),
                )
                .await?;
        } else {
            mgr.client
                .send_command("Fetch.disable", None, Some(&session_id))
                .await?;
        }
    } else {
        let mut patterns: Vec<Value> = state
            .routes
            .iter()
            .map(|r| json!({ "urlPattern": r.url_pattern }))
            .collect();
        patterns.extend(rewrite_patterns);
        mgr.client
            .send_command(
                "Fetch.enable",
                Some(json!({ "patterns": patterns })),
                Some(&session_id),
            )
            .await?;
    }

    let label = url.unwrap_or("all");
    Ok(json!({ "unrouted": label }))
}

async fn handle_rewrite_request(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let (client, session_id) = {
        let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
        (
            Arc::clone(&mgr.client),
            mgr.active_session_id()?.to_string(),
        )
    };
    let url_pattern = cmd
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|pattern| !pattern.is_empty())
        .ok_or("Missing 'url' parameter")?
        .to_string();
    let method = cmd
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .map(|method| method.to_ascii_uppercase());
    if method.as_ref().is_some_and(|method| {
        !method
            .chars()
            .all(|character| character.is_ascii_uppercase() || character == '-')
    }) {
        return Err("Rewrite method contains unsupported characters".to_string());
    }
    let post_data = match cmd.get("postData") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err("Rewrite postData must be a string".to_string()),
    };
    let json_patch = match cmd.get("jsonPatch") {
        None | Some(Value::Null) => None,
        Some(Value::Object(patch)) => Some(Value::Object(patch.clone())),
        _ => return Err("Rewrite jsonPatch must be an object".to_string()),
    };
    let headers: HashMap<String, String> = match cmd.get("headers") {
        None | Some(Value::Null) => HashMap::new(),
        Some(Value::Object(headers)) => headers
            .iter()
            .map(|(name, value)| {
                value
                    .as_str()
                    .map(|value| (name.clone(), value.to_string()))
                    .ok_or_else(|| "Rewrite headers must contain only string values".to_string())
            })
            .collect::<Result<_, _>>()?,
        _ => return Err("Rewrite headers must be an object".to_string()),
    };
    if method.is_none() && post_data.is_none() && json_patch.is_none() && headers.is_empty() {
        return Err(
            "A request rewrite must change method, postData, jsonPatch, or headers".to_string(),
        );
    }

    state
        .request_rewrites
        .retain(|rewrite| rewrite.session_id != session_id || rewrite.url_pattern != url_pattern);
    state.request_rewrites.push(RequestRewriteEntry {
        session_id: session_id.clone(),
        url_pattern: url_pattern.clone(),
        method,
        post_data,
        json_patch,
        headers,
    });
    let patterns: Vec<Value> = state
        .routes
        .iter()
        .map(|route| json!({ "urlPattern": route.url_pattern }))
        .chain(
            state
                .request_rewrites
                .iter()
                .filter(|rewrite| rewrite.session_id == session_id)
                .map(|rewrite| json!({ "urlPattern": rewrite.url_pattern })),
        )
        .collect();
    client
        .send_command(
            "Fetch.enable",
            Some(json!({ "patterns": patterns })),
            Some(&session_id),
        )
        .await?;
    Ok(json!({ "rewritten": url_pattern }))
}

async fn handle_unrewrite_request(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let (client, session_id) = {
        let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
        (
            Arc::clone(&mgr.client),
            mgr.active_session_id()?.to_string(),
        )
    };
    let url_pattern = cmd.get("url").and_then(Value::as_str);
    state.request_rewrites.retain(|rewrite| {
        rewrite.session_id != session_id
            || url_pattern.is_some_and(|pattern| rewrite.url_pattern != pattern)
    });
    let mut patterns: Vec<Value> = state
        .routes
        .iter()
        .map(|route| json!({ "urlPattern": route.url_pattern }))
        .chain(
            state
                .request_rewrites
                .iter()
                .filter(|rewrite| rewrite.session_id == session_id)
                .map(|rewrite| json!({ "urlPattern": rewrite.url_pattern })),
        )
        .collect();
    if state.domain_filter.is_some() && !patterns.iter().any(|pattern| pattern["urlPattern"] == "*")
    {
        patterns.push(json!({ "urlPattern": "*" }));
    }
    if patterns.is_empty() {
        client
            .send_command("Fetch.disable", None, Some(&session_id))
            .await?;
    } else {
        client
            .send_command(
                "Fetch.enable",
                Some(json!({ "patterns": patterns })),
                Some(&session_id),
            )
            .await?;
    }
    Ok(json!({ "unrewritten": url_pattern.unwrap_or("all") }))
}

async fn handle_requests(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let (client, session_id) = {
        let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
        (
            Arc::clone(&mgr.client),
            mgr.active_session_id()?.to_string(),
        )
    };
    if cmd.get("clear").and_then(|v| v.as_bool()).unwrap_or(false) {
        state
            .tracked_requests
            .retain(|entry| entry.session_id != session_id);
        state
            .tracked_pending_bodies
            .retain(|(pending_session, _)| pending_session != &session_id);
        state.tracked_body_bytes = state
            .tracked_requests
            .iter()
            .filter_map(|entry| entry.body.as_ref())
            .map(String::len)
            .sum();
    }

    if !state.request_tracking {
        state.request_tracking = true;
    }
    client
        .send_command_no_params("Network.enable", Some(&session_id))
        .await?;

    let filter = cmd.get("filter").and_then(|v| v.as_str());
    let after = cmd.get("after").and_then(Value::as_u64).unwrap_or(0);
    let limit = cmd
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(MAX_TRACKED_REQUESTS as u64)
        .clamp(1, MAX_TRACKED_REQUESTS as u64) as usize;
    let mut requests: Vec<&TrackedRequest> = state
        .tracked_requests
        .iter()
        .rev()
        .filter(|request| {
            request.session_id == session_id
                && request.timestamp >= after
                && filter.is_none_or(|filter| request.url.contains(filter))
        })
        .take(limit)
        .collect();
    requests.reverse();

    Ok(json!({
        "requests": requests,
        "capacity": MAX_TRACKED_REQUESTS,
        "bodyCapacityBytes": MAX_TRACKED_TOTAL_BODY_BYTES,
    }))
}

async fn handle_http_credentials(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let username = cmd
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'username' parameter")?;
    let password = cmd
        .get("password")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'password' parameter")?;

    let encoded = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        format!("{}:{}", username, password),
    );

    let mut headers = std::collections::HashMap::new();
    headers.insert("Authorization".to_string(), format!("Basic {}", encoded));
    network::set_extra_headers(&mgr.client, &session_id, &headers).await?;

    Ok(json!({ "set": true }))
}

// ---------------------------------------------------------------------------
// Auth handlers
// ---------------------------------------------------------------------------

async fn handle_auth_save(cmd: &Value) -> Result<Value, String> {
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name'")?;
    let url = cmd
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'url'")?;
    let username = cmd
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'username'")?;
    let password = cmd
        .get("password")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'password'")?;
    let username_selector = cmd.get("usernameSelector").and_then(|v| v.as_str());
    let password_selector = cmd.get("passwordSelector").and_then(|v| v.as_str());
    let submit_selector = cmd.get("submitSelector").and_then(|v| v.as_str());
    auth::auth_save(
        name,
        url,
        username,
        password,
        username_selector,
        password_selector,
        submit_selector,
    )
}

async fn handle_auth_login(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let name = cmd
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'name'")?;
    let cred = auth::credentials_get_full(name)?;
    if cred.url.is_empty() {
        return Err("Credential has no URL".to_string());
    }
    let url = cred.url;
    let username = cred.username;
    let password = cred.password;

    let mgr = state.browser.as_mut().ok_or("Browser not launched")?;
    mgr.navigate(&url, WaitUntil::Load).await?;

    let session_id = mgr.active_session_id()?.to_string();

    let auto_user_selectors = [
        "input[type=email]",
        "input[name=email]",
        "input[type=text][name*=user]",
        "input[id*=user]",
        "input[type=text]",
    ];
    let auto_submit_selectors = [
        "button[type=submit]",
        "input[type=submit]",
        "button:not([type])",
    ];

    let username_sel = cmd
        .get("usernameSelector")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(cred.username_selector);
    let password_sel = cmd
        .get("passwordSelector")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(cred.password_selector);
    let submit_sel = cmd
        .get("submitSelector")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or(cred.submit_selector);

    // Find and fill username
    let user_sel = if let Some(s) = username_sel {
        s
    } else {
        let mut found = None;
        for sel in &auto_user_selectors {
            let js = format!(
                "!!document.querySelector({})",
                serde_json::to_string(sel).unwrap_or_default()
            );
            if let Ok(val) = mgr.evaluate(&js, None).await {
                if val.as_bool().unwrap_or(false) {
                    found = Some(sel.to_string());
                    break;
                }
            }
        }
        found.ok_or("Could not find username field")?
    };
    interaction::fill(
        &mgr.client,
        &session_id,
        &state.ref_map,
        &user_sel,
        &username,
    )
    .await?;

    // Find and fill password
    let pass_sel = password_sel.unwrap_or_else(|| "input[type=password]".to_string());
    interaction::fill(
        &mgr.client,
        &session_id,
        &state.ref_map,
        &pass_sel,
        &password,
    )
    .await?;

    // Find and click submit
    let sub_sel = if let Some(s) = submit_sel {
        s
    } else {
        let mut found = None;
        for sel in &auto_submit_selectors {
            let js = format!(
                "!!document.querySelector({})",
                serde_json::to_string(sel).unwrap_or_default()
            );
            if let Ok(val) = mgr.evaluate(&js, None).await {
                if val.as_bool().unwrap_or(false) {
                    found = Some(sel.to_string());
                    break;
                }
            }
        }
        found.ok_or("Could not find submit button")?
    };
    interaction::click(
        &mgr.client,
        &session_id,
        &state.ref_map,
        &sub_sel,
        "left",
        1,
    )
    .await?;

    // Wait for navigation after submit (with fallback timeout)
    let mut rx = mgr.client.subscribe();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
    let mut navigated = false;

    loop {
        let result = tokio::time::timeout_at(deadline, rx.recv()).await;
        match result {
            Ok(Ok(event)) => {
                if event.session_id.as_deref() == Some(&session_id) {
                    match event.method.as_str() {
                        "Page.frameNavigated" | "Page.loadEventFired" => {
                            navigated = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
            Ok(Err(_)) => break,
            Err(_) => break,
        }
    }

    if !navigated {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }

    Ok(json!({ "loggedIn": true, "name": name }))
}

// ---------------------------------------------------------------------------
// Confirmation handlers
// ---------------------------------------------------------------------------

async fn handle_confirm(_cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let pending = state
        .pending_confirmation
        .take()
        .ok_or("No pending confirmation")?;

    // Temporarily remove policy and confirm_actions to avoid re-triggering confirmation
    let policy = state.policy.take();
    let confirm_actions = state.confirm_actions.take();
    let result = Box::pin(execute_command(&pending.cmd, state)).await;
    state.policy = policy;
    state.confirm_actions = confirm_actions;

    Ok(json!({ "confirmed": true, "action": pending.action, "result": result }))
}

async fn handle_deny(_cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    let pending = state
        .pending_confirmation
        .take()
        .ok_or("No pending confirmation")?;

    Ok(json!({ "denied": true, "action": pending.action }))
}

// ---------------------------------------------------------------------------
// iOS handlers
// ---------------------------------------------------------------------------

async fn handle_swipe(cmd: &Value, state: &mut DaemonState) -> Result<Value, String> {
    // Route through Appium for iOS/WebDriver
    if let Some(ref appium) = state.appium {
        if state.browser.is_none() {
            let start_x = cmd.get("startX").and_then(|v| v.as_f64()).unwrap_or(200.0);
            let start_y = cmd.get("startY").and_then(|v| v.as_f64()).unwrap_or(400.0);
            let end_x = cmd.get("endX").and_then(|v| v.as_f64()).unwrap_or(200.0);
            let end_y = cmd.get("endY").and_then(|v| v.as_f64()).unwrap_or(100.0);

            if let Some(direction) = cmd.get("direction").and_then(|v| v.as_str()) {
                let distance = cmd
                    .get("distance")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(300.0);
                let (dx, dy) = match direction {
                    "up" => (0.0, -distance),
                    "down" => (0.0, distance),
                    "left" => (-distance, 0.0),
                    "right" => (distance, 0.0),
                    _ => (0.0, -distance),
                };
                let actual_end_x = start_x + dx;
                let actual_end_y = start_y + dy;
                let duration = cmd.get("duration").and_then(|v| v.as_u64()).unwrap_or(800);
                appium
                    .swipe(start_x, start_y, actual_end_x, actual_end_y, duration)
                    .await?;
                return Ok(json!({ "swiped": direction }));
            }

            let duration = cmd.get("duration").and_then(|v| v.as_u64()).unwrap_or(800);
            appium
                .swipe(start_x, start_y, end_x, end_y, duration)
                .await?;
            return Ok(json!({ "swiped": true, "from": [start_x, start_y], "to": [end_x, end_y] }));
        }
    }

    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();

    let start_x = cmd.get("startX").and_then(|v| v.as_f64()).unwrap_or(200.0);
    let start_y = cmd.get("startY").and_then(|v| v.as_f64()).unwrap_or(400.0);
    let end_x = cmd.get("endX").and_then(|v| v.as_f64()).unwrap_or(200.0);
    let end_y = cmd.get("endY").and_then(|v| v.as_f64()).unwrap_or(100.0);

    if let Some(direction) = cmd.get("direction").and_then(|v| v.as_str()) {
        let distance = cmd
            .get("distance")
            .and_then(|v| v.as_f64())
            .unwrap_or(300.0);
        let (dx, dy) = match direction {
            "up" => (0.0, -distance),
            "down" => (0.0, distance),
            "left" => (-distance, 0.0),
            "right" => (distance, 0.0),
            _ => (0.0, -distance),
        };
        let cx = start_x;
        let cy = start_y;

        mgr.client
            .send_command(
                "Input.dispatchTouchEvent",
                Some(json!({ "type": "touchStart", "touchPoints": [{ "x": cx, "y": cy }] })),
                Some(&session_id),
            )
            .await?;

        let steps = 10;
        for i in 1..=steps {
            let x = cx + dx * (i as f64) / (steps as f64);
            let y = cy + dy * (i as f64) / (steps as f64);
            mgr.client
                .send_command(
                    "Input.dispatchTouchEvent",
                    Some(json!({ "type": "touchMove", "touchPoints": [{ "x": x, "y": y }] })),
                    Some(&session_id),
                )
                .await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(16)).await;
        }

        mgr.client
            .send_command(
                "Input.dispatchTouchEvent",
                Some(json!({ "type": "touchEnd", "touchPoints": [] })),
                Some(&session_id),
            )
            .await?;

        return Ok(json!({ "swiped": direction }));
    }

    // Manual coordinates
    mgr.client
        .send_command(
            "Input.dispatchTouchEvent",
            Some(json!({ "type": "touchStart", "touchPoints": [{ "x": start_x, "y": start_y }] })),
            Some(&session_id),
        )
        .await?;

    let steps = 10;
    for i in 1..=steps {
        let x = start_x + (end_x - start_x) * (i as f64) / (steps as f64);
        let y = start_y + (end_y - start_y) * (i as f64) / (steps as f64);
        mgr.client
            .send_command(
                "Input.dispatchTouchEvent",
                Some(json!({ "type": "touchMove", "touchPoints": [{ "x": x, "y": y }] })),
                Some(&session_id),
            )
            .await?;
        tokio::time::sleep(tokio::time::Duration::from_millis(16)).await;
    }

    mgr.client
        .send_command(
            "Input.dispatchTouchEvent",
            Some(json!({ "type": "touchEnd", "touchPoints": [] })),
            Some(&session_id),
        )
        .await?;

    Ok(json!({ "swiped": true, "from": [start_x, start_y], "to": [end_x, end_y] }))
}

async fn handle_device_list() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        use super::webdriver::ios;
        let devices = ios::list_all_devices()?;
        Ok(ios::to_device_json(&devices))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("device_list is only available on macOS with Xcode".to_string())
    }
}

// ---------------------------------------------------------------------------
// Input event handlers
// ---------------------------------------------------------------------------

async fn handle_input_mouse(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let event_type = cmd
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("mouseMoved");
    let x = cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);

    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({
                "type": event_type, "x": x, "y": y,
                "button": cmd.get("button").and_then(|v| v.as_str()).unwrap_or("none"),
                "clickCount": cmd.get("clickCount").and_then(|v| v.as_i64()).unwrap_or(0),
                "deltaX": cmd.get("deltaX").and_then(|v| v.as_f64()).unwrap_or(0.0),
                "deltaY": cmd.get("deltaY").and_then(|v| v.as_f64()).unwrap_or(0.0),
            })),
            Some(&session_id),
        )
        .await?;
    Ok(json!({ "dispatched": event_type }))
}

async fn handle_input_keyboard(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let event_type = cmd
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("keyDown");

    let mut params = json!({ "type": event_type });
    for key in &["key", "code", "text"] {
        if let Some(v) = cmd.get(*key) {
            params[*key] = v.clone();
        }
    }

    mgr.client
        .send_command("Input.dispatchKeyEvent", Some(params), Some(&session_id))
        .await?;
    Ok(json!({ "dispatched": event_type }))
}

async fn handle_input_touch(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let event_type = cmd
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("touchStart");

    mgr.client
        .send_command(
            "Input.dispatchTouchEvent",
            Some(json!({
                "type": event_type,
                "touchPoints": cmd.get("touchPoints").unwrap_or(&json!([])),
            })),
            Some(&session_id),
        )
        .await?;
    Ok(json!({ "dispatched": event_type }))
}

async fn handle_keydown(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let key = cmd
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'key' parameter")?;

    // Enriched dispatch (key/code/windowsVirtualKeyCode/text) so pages that
    // rely on keyCode or keypress semantics observe a real key event.
    interaction::key_down(&mgr.client, &session_id, key).await?;
    Ok(json!({ "keydown": key }))
}

async fn handle_keyup(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let key = cmd
        .get("key")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'key' parameter")?;

    // Same key-info machinery as keydown/press so the pair matches.
    interaction::key_up(&mgr.client, &session_id, key).await?;
    Ok(json!({ "keyup": key }))
}

async fn handle_inserttext(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let text = cmd
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'text' parameter")?;

    mgr.client
        .send_command(
            "Input.insertText",
            Some(json!({ "text": text })),
            Some(&session_id),
        )
        .await?;
    Ok(json!({ "inserted": true }))
}

async fn handle_mousemove(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let x = cmd.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let y = cmd.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);

    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({ "type": "mouseMoved", "x": x, "y": y })),
            Some(&session_id),
        )
        .await?;
    Ok(json!({ "moved": true }))
}

async fn handle_mousedown(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let button = cmd.get("button").and_then(|v| v.as_str()).unwrap_or("left");

    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({ "type": "mousePressed", "x": 0, "y": 0, "button": button, "clickCount": 1 })),
            Some(&session_id),
        )
        .await?;
    Ok(json!({ "pressed": true }))
}

async fn handle_mouseup(cmd: &Value, state: &DaemonState) -> Result<Value, String> {
    let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
    let session_id = mgr.active_session_id()?.to_string();
    let button = cmd.get("button").and_then(|v| v.as_str()).unwrap_or("left");

    mgr.client
        .send_command(
            "Input.dispatchMouseEvent",
            Some(json!({ "type": "mouseReleased", "x": 0, "y": 0, "button": button, "clickCount": 1 })),
            Some(&session_id),
        )
        .await?;
    Ok(json!({ "released": true }))
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

fn success_response(id: &str, data: Value) -> Value {
    json!({
        "id": id,
        "success": true,
        "data": data,
    })
}

fn error_response(id: &str, error: &str) -> Value {
    json!({
        "id": id,
        "success": false,
        "error": error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::EnvGuard;

    #[test]
    fn chain_budget_is_derived_without_the_legacy_45_second_cap() {
        let default = json!({ "action": "chain", "steps": [{ "action": "healthcheck" }] });
        assert_eq!(
            chain_runtime_budget_ms(&default).unwrap(),
            MIN_CHAIN_RUNTIME_MS
        );
        let maximum = json!({
            "action": "chain",
            "timeout": MAX_CHAIN_RUNTIME_MS,
            "steps": [{ "action": "healthcheck" }]
        });
        assert_eq!(
            chain_runtime_budget_ms(&maximum).unwrap(),
            MAX_CHAIN_RUNTIME_MS
        );
        let invalid = json!({
            "action": "chain",
            "timeout": MAX_CHAIN_RUNTIME_MS + 1,
            "steps": [{ "action": "healthcheck" }]
        });
        assert!(chain_runtime_budget_ms(&invalid).is_err());
    }

    #[tokio::test]
    async fn chain_deadline_cancels_a_step_at_the_remaining_budget() {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(5);
        let error = within_chain_deadline(deadline, 5, "during test step", async {
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        })
        .await
        .unwrap_err();
        assert!(error.contains("5ms execution budget during test step"));
    }

    #[test]
    fn browser_provenance_fingerprints_the_bearer_lease() {
        let raw_lease = "raw-owner-lease-bearer-secret";
        let cmd = json!({
            "ownerId": "worker-1",
            "turnId": "turn-1",
            "ownerLeaseId": raw_lease,
        });
        let provenance = browser_error_provenance(&cmd, 7, "generation-1");
        assert!(!provenance.contains(raw_lease));
        assert!(provenance.contains("lease#="));
        assert!(provenance.contains(&lease_fingerprint(raw_lease)));
    }

    #[test]
    fn wait_probe_captures_bounded_page_and_frame_state() {
        let expression = wait_observation_expression("document.querySelector('#ready') !== null");
        assert!(expression.contains("matched = !!(document.querySelector('#ready') !== null)"));
        assert!(expression.contains("document.readyState"));
        assert!(expression.contains("querySelectorAll('iframe,frame')"));
        assert!(expression.contains("slice(0, 8)"));
        assert!(expression.contains("bodyTextSample"));
        assert!(expression.contains("slice(0, 500)"));
    }

    #[test]
    fn wait_timeout_reports_the_last_observed_page_state_and_transport_error() {
        let observed = json!({
            "matched": false,
            "url": "https://example.test/builds",
            "readyState": "complete",
            "frameCount": 1,
            "frames": [{ "name": "build-list", "visible": true }],
            "bodyTextSample": "Build 121 Ready to Submit"
        });
        let message = wait_timeout_message(
            60_000,
            "selector \"text=Build 121\" to become visible",
            Some(&observed),
            Some("execution context was destroyed"),
        );
        assert!(message.contains("Wait timed out after 60000ms"));
        assert!(message.contains("Build 121 Ready to Submit"));
        assert!(message.contains("build-list"));
        assert!(message.contains("execution context was destroyed"));
    }

    fn with_owner_lease(
        mut command: Value,
        owner_id: &str,
        turn_id: &str,
        lease_id: &str,
        issued_at: u64,
    ) -> Value {
        let object = command.as_object_mut().unwrap();
        object.insert("ownerId".to_string(), json!(owner_id));
        object.insert("sessionId".to_string(), json!(owner_id));
        object.insert("turnId".to_string(), json!(turn_id));
        object.insert("ownerLeaseId".to_string(), json!(lease_id));
        object.insert("ownerLeaseIssuedAt".to_string(), json!(issued_at));
        command
    }

    #[test]
    fn test_success_response_structure() {
        let resp = success_response("cmd-1", json!({"url": "https://example.com"}));
        assert_eq!(resp["id"], "cmd-1");
        assert_eq!(resp["success"], true);
        assert!(resp["data"].is_object());
        assert_eq!(resp["data"]["url"], "https://example.com");
    }

    #[test]
    fn test_error_response_structure() {
        let resp = error_response("cmd-2", "Something went wrong");
        assert_eq!(resp["id"], "cmd-2");
        assert_eq!(resp["success"], false);
        assert_eq!(resp["error"], "Something went wrong");
    }

    #[test]
    fn test_extension_success_response_preserves_request_id() {
        let response = json!({
            "id": "extension-id",
            "success": true,
            "data": { "value": 42 }
        });
        let normalized = normalize_extension_response("request-id", &response);
        assert_eq!(normalized["id"], "request-id");
        assert_eq!(normalized["success"], true);
        assert_eq!(normalized["data"]["value"], 42);
    }

    #[test]
    fn test_chain_validation_rejects_top_level_unknown_empty_and_oversized_actions() {
        let nested = json!({ "steps": [{ "action": "chain", "steps": [] }] });
        assert!(validate_chain_actions(&nested)
            .unwrap_err()
            .contains("top-level-only action chain"));

        for action in ["finalize_tabs", "close_owner", "release_owner_lease"] {
            let lifecycle = json!({ "steps": [{ "action": action }] });
            assert!(validate_chain_actions(&lifecycle)
                .unwrap_err()
                .contains(&format!("top-level-only action {}", action)));
        }

        assert!(validate_chain_actions(&json!({ "steps": [] }))
            .unwrap_err()
            .contains("at least one"));

        let unknown = json!({ "steps": [{ "action": "not_a_real_action" }] });
        assert!(validate_chain_actions(&unknown)
            .unwrap_err()
            .contains("Unknown chain action"));

        let steps = (0..=MAX_CHAIN_STEPS)
            .map(|_| json!({ "action": "click" }))
            .collect::<Vec<_>>();
        assert!(validate_chain_actions(&json!({ "steps": steps }))
            .unwrap_err()
            .contains("maximum"));
    }

    #[test]
    fn test_chain_validation_rejects_actions_outside_the_chain_allowlist() {
        for action in [
            "launch",
            "close",
            "state_save",
            "download",
            "highlight",
            "auth_login",
            "credentials_get",
        ] {
            let cmd = json!({ "steps": [{ "action": "title" }, { "action": action }] });
            let error = validate_chain_actions(&cmd).unwrap_err();
            assert!(
                error.contains("Chain step 1 action is not allowed"),
                "unexpected error for {}: {}",
                action,
                error
            );
            assert!(error.contains(action), "{}", error);
        }

        // Everything the JS client allows and the CDP backend knows must pass.
        let steps: Vec<Value> = [
            "navigate",
            "click",
            "fill",
            "press",
            "evaluate",
            "innertext",
            "inputvalue",
            "tab_switch",
            "cookies_get",
            "screenshot",
            "snapshot",
            "waitforurl",
            "drag",
            "keydown",
            "scrollintoview",
            "upload",
        ]
        .iter()
        .map(|action| json!({ "action": action }))
        .collect();
        let cmd = json!({ "steps": steps });
        let actions = validate_chain_actions(&cmd).unwrap();
        assert_eq!(actions.len(), 16);
    }

    #[tokio::test]
    async fn test_chain_disallowed_step_error_carries_step_index_via_execute() {
        let mut state = DaemonState::new();
        let cmd = json!({
            "id": "chain-bad-step",
            "action": "chain",
            "steps": [
                { "action": "title" },
                { "action": "launch" }
            ]
        });
        let response = execute_command(&cmd, &mut state).await;
        assert_eq!(response["success"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("Chain step 1 action is not allowed: launch"));
        assert!(state.browser.is_none());
    }

    #[tokio::test]
    async fn test_chain_reports_failing_step_index_and_aborts_by_default() {
        let mut state = DaemonState::new();
        // No browser: the first step's handler fails; the chain must surface
        // the failing step index and stop before the second step runs.
        let cmd = json!({
            "id": "chain-abort",
            "action": "chain",
            "steps": [
                { "action": "url" },
                { "action": "healthcheck" }
            ]
        });
        let response = handle_chain(&cmd, &mut state, "chain-abort").await;
        assert_eq!(response["success"], false);
        let error = response["error"].as_str().unwrap();
        assert!(
            error.starts_with("Chain step 0 (url) failed:"),
            "unexpected error: {}",
            error
        );
        let data = &response["data"];
        assert_eq!(data["total"], 2);
        assert_eq!(data["completed"], 0);
        assert!(data["totalDurationMs"].is_u64());
        let results = data["results"].as_array().unwrap();
        assert_eq!(results.len(), 1, "abortOnError must stop after step 0");
        assert_eq!(results[0]["step"], 0);
        assert_eq!(results[0]["action"], "url");
        assert_eq!(results[0]["success"], false);
        assert!(results[0]["error"]
            .as_str()
            .unwrap()
            .contains("Browser not launched"));
        assert!(results[0]["durationMs"].is_u64());
    }

    #[tokio::test]
    async fn test_chain_continues_past_failures_when_abort_on_error_is_false() {
        let mut state = DaemonState::new();
        let cmd = json!({
            "id": "chain-continue",
            "action": "chain",
            "abortOnError": false,
            "steps": [
                { "action": "url" },
                { "action": "healthcheck" }
            ]
        });
        let response = handle_chain(&cmd, &mut state, "chain-continue").await;
        // A failed step still fails the chain envelope, but every step ran and
        // the per-step results are preserved for the caller.
        assert_eq!(response["success"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("Chain step 0 (url) failed"));
        let data = &response["data"];
        assert_eq!(data["completed"], 1);
        assert_eq!(data["total"], 2);
        let results = data["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["success"], false);
        assert_eq!(results[1]["step"], 1);
        assert_eq!(results[1]["action"], "healthcheck");
        assert_eq!(results[1]["success"], true);
        assert_eq!(results[1]["data"]["status"], "ok");
    }

    #[tokio::test]
    async fn test_chain_rejects_invalid_step_tab_id_as_a_step_failure() {
        let mut state = DaemonState::new();
        let cmd = json!({
            "id": "chain-tab",
            "action": "chain",
            "steps": [{ "action": "title", "tabId": 0 }]
        });
        let response = handle_chain(&cmd, &mut state, "chain-tab").await;
        assert_eq!(response["success"], false);
        let results = response["data"]["results"].as_array().unwrap();
        assert_eq!(results[0]["step"], 0);
        assert!(results[0]["error"]
            .as_str()
            .unwrap()
            .contains("'tabId' must be a positive integer"));
    }

    #[tokio::test]
    async fn test_chain_requested_snapshot_failure_fails_the_chain() {
        let mut state = DaemonState::new();
        let cmd = json!({
            "id": "chain-snap",
            "action": "chain",
            "returnSnapshot": true,
            "steps": [{ "action": "healthcheck" }]
        });
        let response = handle_chain(&cmd, &mut state, "chain-snap").await;
        // All steps passed but the requested trailing snapshot could not be
        // captured, so the chain reports failure with the snapshot error.
        assert_eq!(response["success"], false);
        assert_eq!(response["data"]["completed"], 1);
        assert!(response["data"]["snapshotError"]
            .as_str()
            .unwrap()
            .contains("Browser not launched"));
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("Browser not launched"));
    }

    #[test]
    fn test_chain_random_delay_stays_within_bounds() {
        for _ in 0..64 {
            let delay = chain_random_delay_ms(300, 1_200);
            assert!(
                (300..=1_200).contains(&delay),
                "delay {} out of range",
                delay
            );
        }
        assert_eq!(chain_random_delay_ms(500, 500), 500);
        assert_eq!(chain_random_delay_ms(700, 100), 700);
    }

    #[tokio::test]
    async fn test_chain_policy_checks_each_nested_action() {
        let path = std::env::temp_dir().join(format!(
            "stella-browser-chain-policy-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, r#"{"default":"allow","deny":["click"]}"#).unwrap();

        let mut state = DaemonState::new();
        state.policy = Some(ActionPolicy::load(path.to_str().unwrap()).unwrap());
        let command = json!({
            "id": "chain-policy",
            "action": "chain",
            "steps": [{ "action": "click", "selector": "#submit" }]
        });
        let response = execute_command(&command, &mut state).await;
        assert_eq!(response["success"], false);
        assert!(response["error"].as_str().unwrap().contains("click"));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn test_extension_backend_rejects_chain_until_in_app_cdp_connects() {
        let mut state = DaemonState::new();
        state.backend_type = BackendType::Extension;
        let command = json!({
            "id": "chain-before-cdp",
            "action": "chain",
            "steps": [{ "action": "navigate", "url": "https://blocked.example.net" }]
        });
        let response = execute_command(&command, &mut state).await;
        assert_eq!(response["success"], false);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("In-app browser is not ready"));
        assert!(state.browser.is_none());
    }

    #[tokio::test]
    async fn test_owner_finalization_requires_explicit_owner() {
        let mut state = DaemonState::new();
        let finalize = json!({
            "id": "finalize",
            "action": "finalize_tabs",
            "keep": []
        });
        let response = execute_command(&finalize, &mut state).await;
        assert_eq!(response["success"], false);
        assert!(response["error"].as_str().unwrap().contains("ownerId"));

        let close_owner = json!({ "id": "close-owner", "action": "close_owner" });
        let response = execute_command(&close_owner, &mut state).await;
        assert_eq!(response["success"], false);
        assert!(response["error"].as_str().unwrap().contains("ownerId"));
    }

    #[tokio::test]
    async fn test_release_owner_lease_is_exact_and_idempotent_on_cdp() {
        let mut state = DaemonState::new();
        let claim = with_owner_lease(
            json!({ "id": "claim", "action": "healthcheck" }),
            "worker-1",
            "turn-1",
            "lease-1",
            1,
        );
        assert_eq!(execute_command(&claim, &mut state).await["success"], true);
        let release = with_owner_lease(
            json!({ "id": "release", "action": "release_owner_lease" }),
            "worker-1",
            "turn-1",
            "lease-1",
            1,
        );

        let response = execute_command(&release, &mut state).await;
        assert_eq!(response["success"], true, "response: {}", response);
        assert_eq!(response["data"]["released"], true);
        let response = execute_command(&release, &mut state).await;
        assert_eq!(response["success"], true, "response: {}", response);
        assert_eq!(response["data"]["released"], false);
        assert!(
            state.browser.is_none(),
            "lease release must not auto-launch"
        );
    }

    #[tokio::test]
    async fn test_released_and_superseded_owner_leases_fail_closed() {
        let mut state = DaemonState::new();
        let first = with_owner_lease(
            json!({ "id": "first", "action": "healthcheck" }),
            "worker-1",
            "turn-1",
            "lease-1",
            100,
        );
        assert_eq!(execute_command(&first, &mut state).await["success"], true);

        let release = with_owner_lease(
            json!({ "id": "release", "action": "release_owner_lease" }),
            "worker-1",
            "turn-1",
            "lease-1",
            100,
        );
        assert_eq!(
            execute_command(&release, &mut state).await["data"]["released"],
            true
        );

        let replay = execute_command(&first, &mut state).await;
        assert_eq!(replay["success"], false, "response: {}", replay);
        assert!(replay["error"]
            .as_str()
            .unwrap()
            .contains("Stale browser owner lease"));

        let newer = with_owner_lease(
            json!({ "id": "newer", "action": "healthcheck" }),
            "worker-1",
            "turn-2",
            "lease-2",
            200,
        );
        assert_eq!(execute_command(&newer, &mut state).await["success"], true);

        let stale_cleanup = with_owner_lease(
            json!({ "id": "stale", "action": "finalize_tabs", "keep": [] }),
            "worker-1",
            "turn-1",
            "lease-1",
            100,
        );
        let response = execute_command(&stale_cleanup, &mut state).await;
        assert_eq!(response["success"], false, "response: {}", response);
        assert!(response["error"]
            .as_str()
            .unwrap()
            .contains("Stale browser owner lease"));

        let stale_release = with_owner_lease(
            json!({ "id": "stale-release", "action": "release_owner_lease" }),
            "worker-1",
            "turn-1",
            "lease-1",
            100,
        );
        let response = execute_command(&stale_release, &mut state).await;
        assert_eq!(response["success"], true, "response: {}", response);
        assert_eq!(response["data"]["released"], false);

        // The stale release did not remove the current lease: the exact
        // newer capability remains valid without another lease rotation.
        let still_current = with_owner_lease(
            json!({ "id": "still-current", "action": "healthcheck" }),
            "worker-1",
            "turn-2",
            "lease-2",
            200,
        );
        assert_eq!(
            execute_command(&still_current, &mut state).await["success"],
            true
        );
    }

    #[test]
    fn test_owner_lease_identity_cannot_change_with_same_lease_id() {
        let mut registry = OwnerLeaseRegistry::default();
        let initial = with_owner_lease(
            json!({ "action": "healthcheck" }),
            "worker-1",
            "turn-1",
            "lease-1",
            100,
        );
        let claim = registry.validate_claim(&initial).unwrap().unwrap();
        registry.commit(&claim);

        let changed_turn = with_owner_lease(
            json!({ "action": "healthcheck" }),
            "worker-1",
            "turn-2",
            "lease-1",
            100,
        );
        assert!(registry
            .validate_claim(&changed_turn)
            .unwrap_err()
            .contains("lease identity does not match"));
    }

    #[test]
    fn test_equal_millisecond_leases_use_deterministic_lease_id_order() {
        let mut registry = OwnerLeaseRegistry::default();
        let first = with_owner_lease(
            json!({ "action": "healthcheck" }),
            "worker-1",
            "turn-1",
            "lease-1",
            100,
        );
        let claim = registry.validate_claim(&first).unwrap().unwrap();
        registry.commit(&claim);

        let higher = with_owner_lease(
            json!({ "action": "healthcheck" }),
            "worker-1",
            "turn-2",
            "lease-2",
            100,
        );
        let claim = registry.validate_claim(&higher).unwrap().unwrap();
        registry.commit(&claim);

        let lower = with_owner_lease(
            json!({ "action": "healthcheck" }),
            "worker-1",
            "turn-stale",
            "lease-0",
            100,
        );
        assert!(registry
            .validate_claim(&lower)
            .unwrap_err()
            .contains("Stale browser owner lease"));
    }

    #[tokio::test]
    async fn test_owner_finalization_without_browser_succeeds_with_empty_results() {
        let mut state = DaemonState::new();
        for cmd in [
            with_owner_lease(
                json!({ "id": "f1", "action": "finalize_tabs", "keep": [] }),
                "worker-1",
                "turn-1",
                "lease-1",
                1,
            ),
            // `keep` is optional; the owner lease still remains mandatory.
            with_owner_lease(
                json!({ "id": "f2", "action": "finalize_tabs" }),
                "worker-1",
                "turn-1",
                "lease-1",
                1,
            ),
            with_owner_lease(
                json!({ "id": "c1", "action": "close_owner" }),
                "worker-1",
                "turn-1",
                "lease-1",
                1,
            ),
        ] {
            let response = execute_command(&cmd, &mut state).await;
            assert_eq!(response["success"], true, "response: {}", response);
            assert_eq!(response["data"]["closedTabIds"], json!([]));
            assert_eq!(response["data"]["releasedTabIds"], json!([]));
            assert_eq!(response["data"]["kept"], json!([]));
        }
        assert!(state.browser.is_none(), "finalization must not auto-launch");
    }

    #[tokio::test]
    async fn test_finalize_tabs_echoes_keep_entries_in_kept() {
        let mut state = DaemonState::new();
        let cmd = with_owner_lease(
            json!({
                "id": "finalize-keep",
                "action": "finalize_tabs",
                "keep": [
                    { "tabId": 4, "status": "handoff" },
                    { "tabId": 9, "status": "deliverable" },
                ],
            }),
            "worker-1",
            "turn-1",
            "lease-1",
            1,
        );
        let response = execute_command(&cmd, &mut state).await;
        assert_eq!(response["success"], true, "response: {}", response);
        assert_eq!(
            response["data"]["kept"],
            json!([
                { "tabId": 4, "status": "handoff" },
                { "tabId": 9, "status": "deliverable" },
            ])
        );
        // No browser: the keep entries were never owned, so nothing was
        // actually released or closed.
        assert_eq!(response["data"]["closedTabIds"], json!([]));
        assert_eq!(response["data"]["releasedTabIds"], json!([]));
    }

    #[test]
    fn test_owner_finalization_validation_keeps_rejecting_malformed_keep() {
        let base = |keep: Value| {
            json!({
                "id": "finalize",
                "action": "finalize_tabs",
                "ownerId": "worker-1",
                "keep": keep,
            })
        };

        assert!(
            validate_owner_finalization(&base(json!("nope")), "finalize_tabs")
                .unwrap_err()
                .contains("keep must be an array")
        );
        assert!(validate_owner_finalization(
            &base(json!([{ "tabId": 0, "status": "handoff" }])),
            "finalize_tabs"
        )
        .unwrap_err()
        .contains("positive integer"));
        assert!(validate_owner_finalization(
            &base(json!([
                { "tabId": 2, "status": "handoff" },
                { "tabId": 2, "status": "handoff" },
            ])),
            "finalize_tabs"
        )
        .unwrap_err()
        .contains("duplicate"));
        assert!(validate_owner_finalization(
            &base(json!([{ "tabId": 2, "status": "keep" }])),
            "finalize_tabs"
        )
        .unwrap_err()
        .contains("invalid status"));
        assert!(validate_owner_finalization(
            &base(json!([{ "tabId": 2, "status": "handoff", "extra": true }])),
            "finalize_tabs"
        )
        .unwrap_err()
        .contains("unknown fields"));

        // Missing keep is valid at the action-shape layer; execute_command
        // separately requires and authenticates the complete owner lease.
        let no_keep = json!({ "id": "finalize", "action": "finalize_tabs", "ownerId": "worker-1" });
        assert!(validate_owner_finalization(&no_keep, "finalize_tabs").is_ok());
        // Lease validation is a separate execute_command concern.
        assert!(validate_owner_finalization(
            &json!({ "action": "close_owner", "ownerId": "worker-1" }),
            "close_owner"
        )
        .is_ok());
    }

    #[test]
    fn test_daemon_state_new() {
        let state = DaemonState::new();
        assert!(state.browser.is_none());
        assert!(state.domain_filter.is_none());
        assert_eq!(state.session_id, "default");
        assert!(!state.tracing_state.active);
        assert!(!state.recording_state.active);
    }

    #[test]
    fn test_launch_options_from_env_defaults() {
        let _guard = EnvGuard::new(&["STELLA_BROWSER_HEADED"]);
        let opts = launch_options_from_env();
        assert!(opts.headless);
        assert!(opts.args.is_empty());
        assert!(!opts.allow_file_access);
    }

    #[test]
    fn test_launch_options_from_env_headed_flag() {
        let _guard = EnvGuard::new(&["STELLA_BROWSER_HEADED"]);
        _guard.set("STELLA_BROWSER_HEADED", "1");
        let opts = launch_options_from_env();
        assert!(
            !opts.headless,
            "STELLA_BROWSER_HEADED=1 should set headless=false"
        );
    }

    #[test]
    fn test_requested_provider_uses_env_when_command_missing() {
        let _guard = EnvGuard::new(&["STELLA_BROWSER_PROVIDER"]);
        _guard.set("STELLA_BROWSER_PROVIDER", "extension");
        assert_eq!(requested_provider(None).as_deref(), Some("extension"));
    }

    #[test]
    fn test_requested_provider_prefers_command_over_env() {
        let _guard = EnvGuard::new(&["STELLA_BROWSER_PROVIDER"]);
        _guard.set("STELLA_BROWSER_PROVIDER", "extension");
        let cmd = json!({ "provider": "ios" });
        assert_eq!(requested_provider(Some(&cmd)).as_deref(), Some("ios"));
    }

    #[tokio::test]
    async fn test_execute_unknown_command() {
        let mut state = DaemonState::new();
        let cmd = json!({ "action": "unknown_action_xyz", "id": "test-1" });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], false);
        let error_msg = result["error"].as_str().unwrap();
        assert!(
            error_msg.contains("Not yet implemented"),
            "Unexpected error: {}",
            error_msg
        );
        assert!(state.browser.is_none());
    }

    #[tokio::test]
    async fn test_execute_empty_action() {
        let mut state = DaemonState::new();
        let cmd = json!({ "id": "test-2" });
        let result = execute_command(&cmd, &mut state).await;
        // Empty action triggers auto-launch which will fail without a browser
        assert_eq!(result["success"], false);
    }

    #[tokio::test]
    async fn test_execute_close_without_browser() {
        let mut state = DaemonState::new();
        let cmd = json!({ "action": "close", "id": "test-3" });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], true);
        assert_eq!(result["data"]["closed"], true);
    }

    #[tokio::test]
    async fn test_healthcheck_stays_local_for_extension_backend() {
        let mut state = DaemonState::new();
        state.backend_type = BackendType::Extension;
        let cmd = json!({ "action": "healthcheck", "id": "health-1" });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], true);
        assert_eq!(result["data"]["status"], "ok");
    }

    #[tokio::test]
    async fn test_extension_status_stays_local_for_extension_backend() {
        let mut state = DaemonState::new();
        state.backend_type = BackendType::Extension;
        let cmd = json!({ "action": "extension_status", "id": "extension-status-1" });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], true);
        assert_eq!(result["data"]["connected"], false);
        assert_eq!(result["data"]["authorized"], false);
        assert!(result["data"]["connectionGeneration"].is_null());
        assert!(result["data"]["daemonGeneration"].is_u64());
    }

    #[tokio::test]
    async fn test_extension_backend_rejects_real_browser_control() {
        let mut state = DaemonState::new();
        state.backend_type = BackendType::Extension;
        let cmd = json!({
            "action": "navigate",
            "url": "https://example.com",
            "id": "navigate-before-cdp"
        });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], false);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("In-app browser is not ready"));
        assert!(state.browser.is_none());
    }

    #[tokio::test]
    async fn test_explicit_external_browser_control_requires_connected_extension() {
        let mut state = DaemonState::new();
        state.backend_type = BackendType::Extension;
        let cmd = json!({
            "action": "navigate",
            "url": "https://example.com",
            "browserBackend": "extension",
            "id": "navigate-external"
        });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], false);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Extension not connected"));
        assert!(state.browser.is_none());
    }

    #[tokio::test]
    async fn test_cookie_export_requires_a_connected_extension_bridge() {
        let mut state = DaemonState::new();
        state.backend_type = BackendType::Extension;
        let cmd = json!({ "action": "cookies_export_all", "id": "cookies-export-1" });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], false);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("Browser extension is not connected"));
        assert!(state.browser.is_none());
    }

    #[tokio::test]
    async fn test_cookie_export_requires_extension_backend_without_auto_launch() {
        let mut state = DaemonState::new();
        let cmd = json!({ "action": "cookies_export_all", "id": "cookies-export-1" });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], false);
        assert!(result["error"]
            .as_str()
            .unwrap()
            .contains("requires the extension backend"));
        assert!(state.browser.is_none());
    }

    #[tokio::test]
    async fn test_navigate_without_browser() {
        let mut state = DaemonState::new();
        state.domain_filter = Some(DomainFilter::new("example.com"));
        let cmd = json!({
            "action": "navigate",
            "url": "https://blocked.com",
            "id": "test-4"
        });
        let result = execute_command(&cmd, &mut state).await;
        // Will fail because auto-launch fails, but the domain filter won't block since
        // auto-launch happens first
        assert_eq!(result["success"], false);
    }

    #[tokio::test]
    async fn test_credentials_roundtrip_via_actions() {
        let _lock = crate::native::auth::AUTH_TEST_MUTEX.lock().unwrap();
        let key_var = "STELLA_BROWSER_ENCRYPTION_KEY";
        let original = std::env::var(key_var).ok();
        // SAFETY: AUTH_TEST_MUTEX serializes all test access so no concurrent mutation.
        unsafe { std::env::set_var(key_var, "a".repeat(64)) };

        let mut state = DaemonState::new();

        let set_cmd = json!({
            "action": "credentials_set",
            "name": "test-cred-action",
            "username": "user",
            "password": "pass",
            "id": "c1"
        });
        let result = execute_command(&set_cmd, &mut state).await;
        assert_eq!(result["success"], true);

        let get_cmd = json!({
            "action": "credentials_get",
            "name": "test-cred-action",
            "id": "c2"
        });
        let result = execute_command(&get_cmd, &mut state).await;
        assert_eq!(result["success"], true);
        assert_eq!(result["data"]["username"], "user");

        let list_cmd = json!({ "action": "credentials_list", "id": "c3" });
        let result = execute_command(&list_cmd, &mut state).await;
        assert_eq!(result["success"], true);

        let del_cmd = json!({
            "action": "credentials_delete",
            "name": "test-cred-action",
            "id": "c4"
        });
        let result = execute_command(&del_cmd, &mut state).await;
        assert_eq!(result["success"], true);

        // SAFETY: AUTH_TEST_MUTEX serializes all test access so no concurrent mutation.
        match original {
            Some(val) => unsafe { std::env::set_var(key_var, val) },
            None => unsafe { std::env::remove_var(key_var) },
        }
    }

    #[tokio::test]
    async fn test_state_list_via_actions() {
        let mut state = DaemonState::new();
        let cmd = json!({ "action": "state_list", "id": "s1" });
        let result = execute_command(&cmd, &mut state).await;
        assert_eq!(result["success"], true);
        assert!(result["data"]["files"].is_array());
    }

    #[test]
    fn request_rewrite_patterns_and_json_merge_preserve_unpatched_fields() {
        assert!(url_pattern_matches(
            "https://api.example/*/generate",
            "https://api.example/v1/generate"
        ));
        assert!(!url_pattern_matches(
            "https://api.example/*/generate",
            "https://other.example/v1/generate"
        ));

        let mut body = json!({
            "prompt": "keep me",
            "parameters": {
                "width": 1024,
                "safety_tolerance": 1,
                "remove": true
            }
        });
        merge_json_value(
            &mut body,
            &json!({
                "parameters": {
                    "safety_tolerance": 3,
                    "remove": null
                }
            }),
        );
        assert_eq!(body["prompt"], "keep me");
        assert_eq!(body["parameters"]["width"], 1024);
        assert_eq!(body["parameters"]["safety_tolerance"], 3);
        assert!(body["parameters"].get("remove").is_none());
    }

    #[test]
    fn wait_for_response_cache_requires_completed_loading() {
        let mut entry = TrackedRequest {
            request_id: "request-1".to_string(),
            session_id: "session-1".to_string(),
            url: "https://example.test/api/result".to_string(),
            method: "POST".to_string(),
            headers: json!({}),
            post_data: None,
            post_data_truncated: false,
            timestamp: 10,
            resource_type: "Fetch".to_string(),
            status: Some(200),
            response_headers: Some(json!({})),
            mime_type: Some("application/json".to_string()),
            body: None,
            body_base64: false,
            body_truncated: false,
            completed: false,
            failure_text: None,
        };
        assert!(!tracked_response_matches(
            &entry,
            "session-1",
            "/api/result",
            10
        ));
        entry.completed = true;
        entry.body = Some(String::new());
        assert!(tracked_response_matches(
            &entry,
            "session-1",
            "/api/result",
            10
        ));
    }
}
