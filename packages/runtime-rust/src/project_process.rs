//! Owned process groups for app servers and dependency installation.
use anyhow::{Context, Result, bail};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::watch,
};

pub struct Process {
    pub pid: u32,
    exit: watch::Receiver<Option<i32>>,
    output: Arc<Mutex<Vec<u8>>>,
    stop: tokio::sync::Mutex<()>,
    stopped: std::sync::atomic::AtomicBool,
}
impl Process {
    pub fn spawn(
        executable: &str,
        args: &[String],
        cwd: &Path,
        env: &BTreeMap<String, String>,
    ) -> Result<Arc<Self>> {
        let mut command = tokio::process::Command::new(executable);
        command
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().context("Could not start app process")?;
        let pid = child.id().context("Spawned app has no process ID")?;
        let (send, exit) = watch::channel(None);
        let output = Arc::new(Mutex::new(Vec::new()));
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(drain(stdout, output.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain(stderr, output.clone()));
        }
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
            send.send_replace(Some(code));
        });
        Ok(Arc::new(Self {
            pid,
            exit,
            output,
            stop: Default::default(),
            stopped: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    pub fn running(&self) -> bool {
        self.exit.borrow().is_none()
    }
    pub fn output(&self) -> String {
        String::from_utf8_lossy(&self.output.lock().unwrap())
            .trim()
            .to_owned()
    }
    pub async fn wait(&self) -> i32 {
        let mut exit = self.exit.clone();
        loop {
            if let Some(code) = *exit.borrow() {
                return code;
            }
            if exit.changed().await.is_err() {
                return -1;
            }
        }
    }
    pub async fn stop(&self) -> Result<()> {
        let _single = self.stop.lock().await;
        if self.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        #[cfg(unix)]
        {
            let group = -(self.pid as i32);
            // Grandchildren can retain the group after the direct child exits.
            unsafe {
                libc::kill(group, libc::SIGTERM);
            }
            let end = tokio::time::Instant::now() + std::time::Duration::from_millis(1500);
            while unsafe { libc::kill(group, 0) } == 0 && tokio::time::Instant::now() < end {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            if unsafe { libc::kill(group, 0) } == 0 {
                unsafe {
                    libc::kill(group, libc::SIGKILL);
                }
            }
        }
        #[cfg(windows)]
        {
            if self.running() {
                tokio::process::Command::new("taskkill")
                    .args(["/pid", &self.pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .await?;
            }
        }
        if tokio::time::timeout(std::time::Duration::from_secs(3), self.wait())
            .await
            .is_err()
        {
            bail!("App process did not exit after termination");
        }
        self.stopped
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        if self.running() {
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
        // Windows shutdown uses taskkill while the Tokio process reaper is live.
    }
}
async fn drain(mut input: impl AsyncRead + Unpin, output: Arc<Mutex<Vec<u8>>>) {
    let mut bytes = [0; 8192];
    loop {
        match input.read(&mut bytes).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let mut output = output.lock().unwrap();
                output.extend_from_slice(&bytes[..n]);
                let excess = output.len().saturating_sub(4000);
                output.drain(..excess);
            }
        }
    }
}

pub fn environment() -> BTreeMap<String, String> {
    let mut env = std::env::vars()
        .filter(|(name, _)| {
            !matches!(
                name.as_str(),
                "STELLA_AUTH_TOKEN"
                    | "STELLA_ADMIN_API_SECRET"
                    | "CONVEX_DEPLOY_KEY"
                    | "CLOUDFLARE_API_TOKEN"
            ) && !name.starts_with("STELLA_VERIFY_")
        })
        .collect::<BTreeMap<_, _>>();
    if let Some(home) = dirs::home_dir() {
        env.entry(if cfg!(windows) { "USERPROFILE" } else { "HOME" }.into())
            .or_insert_with(|| home.to_string_lossy().into_owned());
    }
    env.insert("FORCE_COLOR".into(), "0".into());
    env.insert("BROWSER".into(), "none".into());
    env
}
