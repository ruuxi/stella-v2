use anyhow::{Context, Result, bail};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use stella_runtime::{
    rpc::{Service, serve},
    storage::Store,
};

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut database = None;
    let mut listen = "stdio://".to_string();
    let mut stella_root = None;
    let mut idle_shutdown_ms = 300_000_u64;
    let mut migrate = false;
    let mut run = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--database" => {
                database = Some(PathBuf::from(
                    args.next().context("--database requires a path")?,
                ))
            }
            "--listen" => listen = args.next().context("--listen requires a URL")?,
            "--stella-root" => {
                stella_root = Some(PathBuf::from(
                    args.next().context("--stella-root requires a path")?,
                ))
            }
            "--idle-shutdown-ms" => {
                idle_shutdown_ms = args
                    .next()
                    .context("--idle-shutdown-ms requires milliseconds")?
                    .parse()?
            }
            "--migrate" => migrate = true,
            "--run" => run = true,
            "--version" => {
                println!(
                    "stella-runtime {} (Rust; protocol v1; schema 3)",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(());
            }
            "--help" => {
                println!(
                    "stella-runtime [--listen stdio://|unix://PATH|pipe://PIPE] [--database PATH]\nstella-runtime --migrate --database PATH"
                );
                return Ok(());
            }
            _ => bail!("Unknown argument: {arg}"),
        }
    }
    if run {
        use tokio::io::AsyncReadExt;
        let mut input = String::new();
        tokio::io::stdin()
            .take(4 * 1024 * 1024)
            .read_to_string(&mut input)
            .await?;
        let request = serde_json::from_str(&input)?;
        let mut store = Store::open(database.as_deref().context("--run requires --database")?)?;
        return stella_runtime::execution::run(request, &mut store).await;
    }
    if migrate {
        let store = Store::open(
            database
                .as_deref()
                .context("--migrate requires --database")?,
        )?;
        println!("{}", store.diagnostics()?);
        return Ok(());
    }
    let lifecycle = stella_root
        .as_deref()
        .map(stella_runtime::lifecycle::Lifecycle::acquire)
        .transpose()?;
    let service = Arc::new(Mutex::new(Service::new(database)?));
    if listen == "stdio://" {
        let result = tokio::select! {
            result=serve(tokio::io::stdin(), tokio::io::stdout(), service.clone())=>result,
            signal=stella_runtime::lifecycle::shutdown_signal()=>signal,
        };
        stella_runtime::rpc::shutdown(&service).await;
        return result;
    }
    #[cfg(unix)]
    if let Some(path) = listen.strip_prefix("unix://") {
        use std::os::unix::fs::PermissionsExt;
        if path.is_empty() {
            bail!("Missing socket path");
        }
        if let Some(owner) = &lifecycle {
            owner.prepare_socket(std::path::Path::new(path))?;
        }
        // Without an exclusive root lock, never remove an existing endpoint.
        let listener = tokio::net::UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        let mut idle_tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tokio::select! {
                accepted=listener.accept()=>{
                    let (socket,_)=accepted?;
                    let (read,write)=socket.into_split();
                    let service=service.clone();
                    tokio::spawn(async move { if let Err(error)=serve(read,write,service).await {eprintln!("RPC connection: {error:#}");} });
                }
                signal=stella_runtime::lifecycle::shutdown_signal()=>{
                    signal?;
                    stella_runtime::rpc::shutdown(&service).await;
                    remove_socket(path)?;return Ok(());
                }
                _=idle_tick.tick()=>{
                    let idle={let state=service.lock().unwrap();state.is_idle(idle_shutdown_ms)};
                    if idle {remove_socket(path)?;return Ok(());}
                }
            }
        }
    }
    #[cfg(windows)]
    if let Some(path) = listen.strip_prefix("pipe://") {
        use tokio::net::windows::named_pipe::ServerOptions;
        if !path.starts_with(r"\\.\pipe\") {
            bail!("Expected Windows named pipe path");
        }
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(path)?;
        let mut idle_tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tokio::select! {
                result=server.connect()=>result?,
                signal=stella_runtime::lifecycle::shutdown_signal()=>{
                    signal?;stella_runtime::rpc::shutdown(&service).await;return Ok(());
                }
                _=idle_tick.tick()=>{
                    if service.lock().unwrap().is_idle(idle_shutdown_ms){return Ok(());}
                    continue;
                }
            }
            let connected = server;
            server = ServerOptions::new().create(path)?;
            let (read, write) = tokio::io::split(connected);
            let service = service.clone();
            tokio::spawn(async move {
                if let Err(error) = serve(read, write, service).await {
                    eprintln!("RPC connection: {error:#}");
                }
            });
        }
    }
    bail!("Unsupported listener on this platform: {listen}")
}

#[cfg(unix)]
fn remove_socket(path: &str) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
