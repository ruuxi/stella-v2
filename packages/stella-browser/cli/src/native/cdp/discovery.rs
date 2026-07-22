use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use super::types::BrowserVersionInfo;

/// Default timeout for CDP discovery HTTP requests.
const DEFAULT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Discover the CDP WebSocket URL for the given host and port.
///
/// Tries three methods in order: `/json/version`, `/json/list`, and a direct
/// WebSocket connection to `/devtools/browser`. The returned URL has its
/// host/port rewritten to match the requested target.
pub async fn discover_cdp_url(host: &str, port: u16) -> Result<String, String> {
    discover_cdp_url_with_timeout(host, port, DEFAULT_DISCOVERY_TIMEOUT).await
}

/// Like [`discover_cdp_url`] but with a custom request timeout.
pub async fn discover_cdp_url_with_timeout(
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<String, String> {
    // Primary: /json/version (standard path)
    let version_err = match fetch_cdp_info(host, port, timeout).await {
        Ok(info) => {
            if let Some(ws_url) = info.web_socket_debugger_url {
                return Ok(rewrite_ws_host(&ws_url, host, port));
            }
            format!(
                "No webSocketDebuggerUrl in /json/version at {}:{}",
                host, port
            )
        }
        Err(e) => e,
    };

    // Fallback: /json/list (returns target list; look for the browser target)
    let list_err = match fetch_cdp_list(host, port, timeout).await {
        Ok(ws_url) => return Ok(rewrite_ws_host(&ws_url, host, port)),
        Err(e) => e,
    };

    // Final fallback: direct WebSocket at /devtools/browser.
    // Chrome 136+ with UI-based remote debugging (chrome://inspect) exposes
    // CDP over WebSocket but does not serve HTTP discovery endpoints.
    match discover_cdp_ws(host, port, timeout).await {
        Ok(ws_url) => Ok(ws_url),
        Err(ws_err) => Err(format!(
            "All CDP discovery methods failed for {}:{}: /json/version: {}; /json/list: {}; WebSocket: {}",
            host, port, version_err, list_err, ws_err
        )),
    }
}

/// Bracket an IPv6 address for use in URLs. No-op for IPv4 or already-bracketed addresses.
fn bracket_ipv6(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    }
}

/// Fetch `/json/version` from the given host:port and parse the response.
async fn fetch_cdp_info(
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<BrowserVersionInfo, String> {
    let url = format!("http://{}:{}/json/version", bracket_ipv6(host), port);

    let body = tokio::time::timeout(timeout, reqwest_get_string(&url))
        .await
        .map_err(|_| format!("Timeout connecting to CDP at {}:{}", host, port))?
        .map_err(|e| format!("Failed to connect to CDP at {}:{}: {}", host, port, e))?;

    serde_json::from_str(&body).map_err(|e| format!("Invalid /json/version response: {}", e))
}

/// Rewrite the host and port in a WebSocket URL to match the target we
/// actually connected to. Chrome's `/json/version` always returns
/// `ws://127.0.0.1:<local-port>/...` which is unreachable when the
/// browser is on a remote machine or behind a port-forward.
fn rewrite_ws_host(ws_url: &str, host: &str, port: u16) -> String {
    if let Ok(mut parsed) = url::Url::parse(ws_url) {
        let _ = parsed.set_host(Some(&bracket_ipv6(host)));
        let _ = parsed.set_port(Some(port));
        parsed.to_string()
    } else {
        ws_url.to_string()
    }
}

/// Fetch `/json/list` and extract the `webSocketDebuggerUrl` from the first
/// target with `type == "browser"`, or the first target if none has that type.
async fn fetch_cdp_list(host: &str, port: u16, timeout: Duration) -> Result<String, String> {
    let url = format!("http://{}:{}/json/list", bracket_ipv6(host), port);

    let body = tokio::time::timeout(timeout, reqwest_get_string(&url))
        .await
        .map_err(|_| format!("Timeout connecting to /json/list at {}:{}", host, port))?
        .map_err(|e| {
            format!(
                "Failed to connect to /json/list at {}:{}: {}",
                host, port, e
            )
        })?;

    let targets: Vec<serde_json::Value> =
        serde_json::from_str(&body).map_err(|e| format!("Invalid /json/list response: {}", e))?;

    // Prefer targets with type "browser", fall back to first target with a ws URL
    let browser_target = targets
        .iter()
        .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("browser"));

    let target = browser_target.or_else(|| targets.first());

    target
        .and_then(|t| t.get("webSocketDebuggerUrl"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "No webSocketDebuggerUrl found in /json/list targets".to_string())
}

/// Discover a CDP endpoint by connecting directly to `ws://host:port/devtools/browser`
/// and verifying it responds to `Browser.getVersion`.
/// Returns the WebSocket URL on success.
async fn discover_cdp_ws(host: &str, port: u16, timeout: Duration) -> Result<String, String> {
    let ws_url = format!("ws://{}:{}/devtools/browser", bracket_ipv6(host), port);

    tokio::time::timeout(timeout, async {
        let (mut ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| format!("WebSocket connect failed at {}: {}", ws_url, e))?;

        let cmd = r#"{"id":1,"method":"Browser.getVersion"}"#;
        ws_stream
            .send(Message::Text(cmd.into()))
            .await
            .map_err(|e| format!("Failed to send command: {}", e))?;

        #[derive(serde::Deserialize)]
        struct CdpReply {
            id: u64,
        }

        let mut result: Result<(), String> = Err("No valid CDP response received".to_string());
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if serde_json::from_str::<CdpReply>(&text).is_ok_and(|r| r.id == 1) {
                        result = Ok(());
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => continue,
            }
        }

        let _ = ws_stream.close(None).await;
        result
    })
    .await
    .map_err(|_| format!("Timeout connecting to WebSocket at {}", ws_url))?
    .map(|()| ws_url)
}

async fn reqwest_get_string(url: &str) -> Result<String, String> {
    let resp = reqwest::get(url).await.map_err(|e| e.to_string())?;
    resp.text().await.map_err(|e| e.to_string())
}
