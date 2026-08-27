use serde_json::{json, Value};
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::connection::get_socket_dir;

const DEFAULT_SESSION: &str = "stella-app-bridge";
const DEFAULT_PORT: u16 = 39040;

const DAEMON_CONNECT_ATTEMPTS: u32 = 5;
const DAEMON_CONNECT_RETRY_DELAY: Duration = Duration::from_millis(400);

const DAEMON_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

const BRIDGE_IDLE_TICK: Duration = Duration::from_millis(500);

fn read_bridge_token(session: &str) -> Option<String> {
    let token_path = get_socket_dir().join(format!("{}.ext-token", session));
    fs::read_to_string(&token_path).ok().map(|s| s.trim().to_string())
}

fn read_bridge_port(session: &str) -> u16 {
    let port_path = get_socket_dir().join(format!("{}.ext-port", session));
    fs::read_to_string(&port_path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn inject_token_if_needed(payload: &mut Value, token: &str) {
    if let Some(obj) = payload.as_object_mut() {
        if obj.get("type").and_then(|v| v.as_str()) != Some("hello") {
            return;
        }
        let current = obj
            .get("token")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if current.is_empty() && !token.is_empty() {
            obj.insert("token".to_string(), json!(token));
        }
    }
}

fn read_chrome_frame(stdin: &mut io::StdinLock) -> io::Result<Vec<u8>> {
    let mut len_buf = [0u8; 4];
    stdin.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 64 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native message too large",
        ));
    }
    let mut buf = vec![0u8; len];
    stdin.read_exact(&mut buf)?;
    Ok(buf)
}

fn write_chrome_frame(stdout: &mut io::StdoutLock, payload: &[u8]) -> io::Result<()> {
    if payload.len() > 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "host→extension message exceeds Chrome 1 MiB limit",
        ));
    }
    let len = payload.len() as u32;
    stdout.write_all(&len.to_le_bytes())?;
    stdout.write_all(payload)?;
    stdout.flush()
}

fn set_tcp_keepalive(stream: &TcpStream) {
    use socket2::SockRef;

    let sock = SockRef::from(stream);
    let _ = sock.set_keepalive(true);
    let _ = sock.set_tcp_keepalive(
        &socket2::TcpKeepalive::new()
            .with_time(Duration::from_secs(60))
            .with_interval(Duration::from_secs(10)),
    );
}

fn send_frame_to_tcp(tcp: &mut TcpStream, buf: &[u8], bridge_token: &str) -> bool {

    let needs_injection = !bridge_token.is_empty()
        && buf.windows(b"\"hello\"".len()).any(|w| w == b"\"hello\"");

    let written = if needs_injection {
        let mut value: Value = match serde_json::from_slice(buf) {
            Ok(v) => v,
            Err(_) => return true,
        };
        inject_token_if_needed(&mut value, bridge_token);
        let mut line = match serde_json::to_string(&value) {
            Ok(l) => l,
            Err(_) => return true,
        };
        line.push('\n');
        tcp.write_all(line.as_bytes())
    } else {
        tcp.write_all(buf).and_then(|_| tcp.write_all(b"\n"))
    };

    written.and_then(|_| tcp.flush()).is_ok()
}

fn connect_to_daemon(session: &str) -> Option<TcpStream> {
    let addr = SocketAddr::from(([127, 0, 0, 1], read_bridge_port(session)));
    for attempt in 0..DAEMON_CONNECT_ATTEMPTS {
        if let Ok(tcp) = TcpStream::connect_timeout(&addr, DAEMON_CONNECT_TIMEOUT) {
            return Some(tcp);
        }
        if attempt + 1 < DAEMON_CONNECT_ATTEMPTS {
            std::thread::sleep(DAEMON_CONNECT_RETRY_DELAY);
        }
    }
    None
}

fn bridge(tcp: TcpStream, bridge_token: &str, frame_rx: &Receiver<Vec<u8>>) {
    let tcp_read = match tcp.try_clone() {
        Ok(t) => t,
        Err(_) => return,
    };
    let mut tcp_write = tcp;

    let tcp_to_chrome = std::thread::spawn(move || {
        let stdout = io::stdout();
        let mut stdout = stdout.lock();
        let mut reader = io::BufReader::new(tcp_read);
        let mut line = String::new();
        loop {
            line.clear();
            let n = match reader.read_line(&mut line) {
                Ok(n) => n,
                Err(_) => break,
            };
            if n == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Err(e) = write_chrome_frame(&mut stdout, trimmed.as_bytes()) {
                let _ = writeln!(
                    std::io::stderr(),
                    "native-host: dropping oversized message ({} bytes): {}",
                    trimmed.len(),
                    e
                );
                continue;
            }
        }
    });

    loop {
        if tcp_to_chrome.is_finished() {
            break;
        }
        match frame_rx.recv_timeout(BRIDGE_IDLE_TICK) {
            Ok(buf) => {
                if !send_frame_to_tcp(&mut tcp_write, &buf, bridge_token) {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = tcp_write.shutdown(std::net::Shutdown::Both);
    let _ = tcp_to_chrome.join();
}

pub fn run_native_host() -> Result<(), String> {
    let session =
        std::env::var("STELLA_BROWSER_SESSION").unwrap_or_else(|_| DEFAULT_SESSION.to_string());

    let (frame_tx, frame_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        loop {
            match read_chrome_frame(&mut stdin) {
                Ok(buf) => {
                    if frame_tx.send(buf).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let hello = match frame_rx.recv() {
        Ok(buf) => buf,
        Err(_) => return Ok(()),
    };

    let mut tcp = match connect_to_daemon(&session) {
        Some(tcp) => tcp,
        None => {
            return Err(
                "Stella browser bridge is not running. Open Stella first.".to_string(),
            )
        }
    };

    set_tcp_keepalive(&tcp);

    let bridge_token = read_bridge_token(&session).unwrap_or_default();
    if !send_frame_to_tcp(&mut tcp, &hello, &bridge_token) {
        return Err("Stella browser bridge closed during handshake.".to_string());
    }

    bridge(tcp, &bridge_token, &frame_rx);
    Ok(())
}
