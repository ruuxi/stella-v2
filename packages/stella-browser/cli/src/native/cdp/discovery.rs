use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use super::types::BrowserVersionInfo;

const DEFAULT_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

pub async fn discover_cdp_url(host: &str, port: u16) -> Result<String, String> {
    discover_cdp_url_with_timeout(host, port, DEFAULT_DISCOVERY_TIMEOUT).await
}

pub async fn discover_cdp_url_with_timeout(
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<String, String> {

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

    let list_err = match fetch_cdp_list(host, port, timeout).await {
        Ok(ws_url) => return Ok(rewrite_ws_host(&ws_url, host, port)),
        Err(e) => e,
    };

    match discover_cdp_ws(host, port, timeout).await {
        Ok(ws_url) => Ok(ws_url),
        Err(ws_err) => Err(format!(
            "All CDP discovery methods failed for {}:{}: /json/version: {}; /json/list: {}; WebSocket: {}",
            host, port, version_err, list_err, ws_err
        )),
    }
}

fn bracket_ipv6(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]", host)
    } else {
        host.to_string()
    }
}

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

fn rewrite_ws_host(ws_url: &str, host: &str, port: u16) -> String {
    if let Ok(mut parsed) = url::Url::parse(ws_url) {
        let _ = parsed.set_host(Some(&bracket_ipv6(host)));
        let _ = parsed.set_port(Some(port));
        parsed.to_string()
    } else {
        ws_url.to_string()
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const HTTP_404: &str =
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    fn http_200(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{}",
            body.len(), body
        )
    }

    async fn accept_http(listener: &TcpListener, response: &str) {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        let _ = s.read(&mut buf).await;
        s.write_all(response.as_bytes()).await.unwrap();
    }

    #[tokio::test]
    async fn discovers_ws_url_from_json_version() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            accept_http(
                &listener,
                &http_200(r#"{"webSocketDebuggerUrl":"ws://127.0.0.1:1234/"}"#),
            )
            .await;
        });

        let ws_url = discover_cdp_url("127.0.0.1", port).await.unwrap();
        assert_eq!(ws_url, format!("ws://127.0.0.1:{}/", port));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn returns_error_when_version_returns_invalid_json() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            accept_http(&listener, &http_200("not-json")).await;

        });

        let err = discover_cdp_url("127.0.0.1", port).await.unwrap_err();
        assert!(err.contains("Invalid /json/version response"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn falls_back_to_json_list_on_version_404() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            accept_http(&listener, HTTP_404).await;
            accept_http(
                &listener,
                &http_200(r#"[{"type":"browser","webSocketDebuggerUrl":"ws://127.0.0.1:1234/devtools/browser/abc"}]"#),
            ).await;
        });

        let ws_url = discover_cdp_url("127.0.0.1", port).await.unwrap();
        assert!(ws_url.contains("/devtools/browser/abc"));
        assert!(ws_url.contains(&port.to_string()));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn falls_back_to_ws_when_http_returns_404() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {

            accept_http(&listener, HTTP_404).await;
            accept_http(&listener, HTTP_404).await;

            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            if let Some(Ok(Message::Text(text))) = ws.next().await {
                let req: serde_json::Value = serde_json::from_str(&text).unwrap();
                let id = req.get("id").unwrap();
                let reply = format!(
                    r#"{{"id":{},"result":{{"protocolVersion":"1.3","product":"Chrome/136"}}}}"#,
                    id
                );
                ws.send(Message::Text(reply)).await.unwrap();
            }
            let _ = ws.close(None).await;
        });

        let ws_url = discover_cdp_url("127.0.0.1", port).await.unwrap();
        assert_eq!(ws_url, format!("ws://127.0.0.1:{}/devtools/browser", port));
        server.await.unwrap();
    }

    #[test]
    fn rewrite_ws_host_replaces_host_and_port() {
        let original = "ws://127.0.0.1:9222/devtools/browser/abc";
        let rewritten = rewrite_ws_host(original, "10.211.55.12", 9223);
        assert_eq!(rewritten, "ws://10.211.55.12:9223/devtools/browser/abc");
    }

    #[test]
    fn rewrite_ws_host_handles_ipv6() {
        let original = "ws://127.0.0.1:9222/devtools/browser/abc";
        let rewritten = rewrite_ws_host(original, "::1", 9222);
        assert_eq!(rewritten, "ws://[::1]:9222/devtools/browser/abc");
    }
}
