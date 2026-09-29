//! Existing host control-file ownership for detached native workers.
use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub struct Lifecycle {
    directory: PathBuf,
    pid: String,
}
impl Lifecycle {
    pub fn acquire(root: &Path) -> Result<Self> {
        let root = root.canonicalize().context("Stella root must exist")?;
        let hash = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
        let state = std::env::var_os("STELLA_RUNTIME_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|v| PathBuf::from(v).join(".stella")))
            .context("Missing runtime state directory")?;
        let directory = state.join("runtime").join(&hash[..16]);
        std::fs::create_dir_all(&directory)?;
        let lock = directory.join("runtime.lock");
        if let Ok(value) = std::fs::read_to_string(&lock) {
            let pid = value
                .trim()
                .parse::<u32>()
                .context("Invalid runtime lock owner")?;
            if !alive(pid) {
                std::fs::remove_file(&lock)?;
            }
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options
            .open(&lock)
            .context("Another runtime owns this Stella root")?;
        let owner = Self {
            directory,
            pid: std::process::id().to_string(),
        };
        file.write_all(owner.pid.as_bytes())?;
        std::fs::write(owner.directory.join("runtime.pid"), &owner.pid)?;
        std::fs::write(
            owner.directory.join("root.txt"),
            format!("{}\n", root.display()),
        )?;
        let exe = std::env::current_exe()?;
        let digest = Sha256::digest(std::fs::read(exe)?);
        std::fs::write(
            owner.directory.join("build-stamp.txt"),
            format!("rust:{digest:x}\n"),
        )?;
        if let Ok(path) = std::env::var("STELLA_HOST_EXECUTABLE_PATH") {
            std::fs::write(
                owner.directory.join("host-executable.txt"),
                format!("{path}\n"),
            )?;
        }
        Ok(owner)
    }
    /// Only remove a stale endpoint after taking this root's exclusive lock.
    #[cfg(unix)]
    pub fn prepare_socket(&self, path: &Path) -> Result<()> {
        if path.exists() {
            match std::os::unix::net::UnixStream::connect(path) {
                Ok(_) => bail!("A live runtime is already listening at {}", path.display()),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound
                    ) =>
                {
                    std::fs::remove_file(path)?
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
}
impl Drop for Lifecycle {
    fn drop(&mut self) {
        for name in ["runtime.pid", "runtime.lock"] {
            let path = self.directory.join(name);
            if std::fs::read_to_string(&path)
                .ok()
                .is_some_and(|v| v.trim() == self.pid)
            {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // kill(0) probes existence without delivering a signal.
        unsafe {
            libc::kill(pid as libc::pid_t, 0) == 0
                || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
    }
    #[cfg(windows)]
    {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .map(|r| String::from_utf8_lossy(&r.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(true)
    }
}
pub async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {result=tokio::signal::ctrl_c()=>result?,_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}
