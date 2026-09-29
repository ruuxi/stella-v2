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
    let mut migrate = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--database" => {
                database = Some(PathBuf::from(
                    args.next().context("--database requires a path")?,
                ))
            }
            "--listen" => listen = args.next().context("--listen requires a URL")?,
            "--migrate" => migrate = true,
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
    if migrate {
        let store = Store::open(
            database
                .as_deref()
                .context("--migrate requires --database")?,
        )?;
        println!("{}", store.diagnostics()?);
        return Ok(());
    }
    let service = Arc::new(Mutex::new(Service::new(database)?));
    if listen == "stdio://" {
        return serve(tokio::io::stdin(), tokio::io::stdout(), service).await;
    }
    #[cfg(unix)]
    if let Some(path) = listen.strip_prefix("unix://") {
        use std::os::unix::fs::PermissionsExt;
        if path.is_empty() {
            bail!("Missing socket path");
        }
        // Never remove an existing endpoint: it may belong to a live runtime.
        let listener = tokio::net::UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        loop {
            tokio::select! {
                accepted=listener.accept()=>{
                    let (socket,_)=accepted?;
                    let (read,write)=socket.into_split();
                    let service=service.clone();
                    tokio::spawn(async move { if let Err(error)=serve(read,write,service).await {eprintln!("RPC connection: {error:#}");} });
                }
                _=tokio::signal::ctrl_c()=>{std::fs::remove_file(path)?;return Ok(());}
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
        loop {
            server.connect().await?;
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
