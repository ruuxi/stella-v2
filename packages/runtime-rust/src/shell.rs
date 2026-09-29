//! Native pipes and PTY/ConPTY sessions, owned by the conversation/thread.
use crate::{file_tools::FileContext, storage::now_ms, work::Work};
use anyhow::{Context, Result, bail};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use stella_runtime_core::agent::ToolResult;
use tokio::sync::{Mutex as AsyncMutex, watch};

const CAP: usize = 1024 * 1024;
type PreparedShell = (String, Vec<String>, PathBuf, BTreeMap<String, String>);
type SpawnedShell = (
    Box<dyn Child + Send + Sync>,
    Box<dyn Write + Send>,
    Option<Box<dyn MasterPty + Send>>,
);
fn find_shell(name: &str) -> Option<String> {
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = directory.join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        });
        if path.is_file() {
            return Some(path.to_string_lossy().into_owned());
        }
    }
    None
}
fn default_shell() -> String {
    #[cfg(unix)]
    {
        let mut buffer = vec![0_u8; 32768];
        let mut record = std::mem::MaybeUninit::<libc::passwd>::uninit();
        let mut found = std::ptr::null_mut();
        if unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                record.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut found,
            )
        } == 0
            && !found.is_null()
        {
            let record = unsafe { record.assume_init() };
            if !record.pw_shell.is_null() {
                let shell = unsafe { std::ffi::CStr::from_ptr(record.pw_shell) }.to_string_lossy();
                let path = PathBuf::from(shell.as_ref());
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if [
                    "bash",
                    "zsh",
                    "fish",
                    "sh",
                    "dash",
                    "ksh",
                    "pwsh",
                    "powershell",
                ]
                .contains(&name.as_ref())
                    && path.is_file()
                {
                    return shell.into_owned();
                }
            }
        }
        let fallbacks = if cfg!(target_os = "macos") {
            ["zsh", "bash"]
        } else {
            ["bash", "zsh"]
        };
        for name in fallbacks {
            if let Some(path) = find_shell(name) {
                return path;
            }
            let path = format!("/bin/{name}");
            if PathBuf::from(&path).is_file() {
                return path;
            }
        }
        "/bin/sh".into()
    }
    #[cfg(windows)]
    {
        let program = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        let system = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        for (name, fallback) in [
            ("pwsh", format!("{program}\\PowerShell\\7\\pwsh.exe")),
            (
                "powershell",
                format!("{system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            ),
        ] {
            if let Some(path) = find_shell(name) {
                return path;
            }
            if PathBuf::from(&fallback).is_file() {
                return fallback;
            }
        }
        "cmd.exe".into()
    }
}
fn boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}
#[derive(Default)]
struct Output {
    head: String,
    tail: String,
    start: u64,
    end: u64,
}
impl Output {
    fn add(&mut self, text: &str) {
        self.end += text.len() as u64;
        let head = boundary(text, (CAP / 2).saturating_sub(self.head.len()));
        self.head.push_str(&text[..head]);
        self.tail.push_str(&text[head..]);
        if self.tail.len() > CAP / 2 {
            let mut remove = self.tail.len() - CAP / 2;
            while !self.tail.is_char_boundary(remove) {
                remove += 1;
            }
            self.tail.drain(..remove);
        }
    }
    fn drain(&mut self, budget: usize) -> (String, u64, u64, u64, usize) {
        let original = self.end - self.start;
        let missing = original.saturating_sub((self.head.len() + self.tail.len()) as u64);
        let text = if missing > 0 {
            format!(
                "{}\n[... {missing} bytes omitted ...]\n{}",
                self.head, self.tail
            )
        } else {
            format!("{}{}", self.head, self.tail)
        };
        self.head.clear();
        self.tail.clear();
        let start = self.start;
        self.start = self.end;
        let omitted = text.len().saturating_sub(budget);
        let shown = if omitted > 0 {
            let head = boundary(&text, budget / 2);
            let tail = boundary(&text, text.len().saturating_sub(budget - budget / 2));
            format!(
                "{}\n[... output truncated ...]\n{}",
                &text[..head],
                &text[tail..]
            )
        } else {
            text
        };
        (shown, start, self.end, missing, omitted)
    }
}
struct Interaction {
    sequence: u64,
    chunk: u64,
    writes: VecDeque<(String, String, i64)>,
}
struct Session {
    id: String,
    scope: String,
    owner: Value,
    generation: String,
    cwd: PathBuf,
    command: String,
    pid: Option<u32>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<Output>,
    activity: watch::Sender<u64>,
    exit: watch::Sender<Option<i64>>,
    interaction: AsyncMutex<Interaction>,
    completed: std::sync::atomic::AtomicI64,
}
impl Session {
    fn running(&self) -> bool {
        self.exit.borrow().is_none()
    }
    fn changed(&self) {
        self.activity.send_modify(|n| *n += 1);
    }
    fn kill(&self) -> Result<()> {
        if !self.running() {
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid
            && unsafe { libc::kill(-(pid as i32), libc::SIGKILL) } == 0
        {
            return Ok(());
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let status = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()?;
            if status.success() {
                return Ok(());
            }
        }
        self.killer.lock().unwrap().kill()?;
        Ok(())
    }
    async fn wait_exit(&self) {
        let mut receiver = self.exit.subscribe();
        while receiver.borrow_and_update().is_none() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }
    async fn terminate(&self) -> Result<()> {
        if !self.running() {
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
            if tokio::time::timeout(Duration::from_secs(1), self.wait_exit())
                .await
                .is_ok()
            {
                return Ok(());
            }
        }
        self.kill()?;
        tokio::time::timeout(Duration::from_secs(2), self.wait_exit())
            .await
            .context("Shell process did not settle after termination")?;
        Ok(())
    }
    async fn wait(&self, millis: u64, first_activity: bool) {
        let mut activity = self.activity.subscribe();
        let mut exit = self.exit.subscribe();
        if !self.running() {
            return;
        }
        if first_activity && {
            let output = self.output.lock().unwrap();
            output.end > output.start
        } {
            return;
        }
        let timeout = tokio::time::sleep(Duration::from_millis(millis));
        tokio::pin!(timeout);
        loop {
            tokio::select! {_= &mut timeout=>break,_=exit.changed()=>break,_=activity.changed()=>{if first_activity{break;}}}
        }
        if !self.running() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    fn result(
        &self,
        interaction: &mut Interaction,
        operation: &str,
        started: Instant,
        budget: usize,
        receipt: Value,
    ) -> ToolResult {
        let (text, start, end, raw_omitted, presentation_omitted) =
            self.output.lock().unwrap().drain(budget.saturating_mul(4));
        let running = self.running();
        interaction.chunk += 1;
        let mut details = json!({"session_id":if running{Some(&self.id)}else{None},"shell_session_id":self.id,"worker_generation":self.generation,"session_owner":self.owner,"interaction_sequence":interaction.sequence,"chunk_id":format!("{}:{}:{}",self.generation,self.id,interaction.chunk),"output_cursor":end,"operation":operation,"running":running,"exit_code":*self.exit.borrow(),"wall_time_seconds":started.elapsed().as_secs_f64(),"original_token_count":(end-start).div_ceil(4),"cwd":self.cwd,"command":self.command,"original_output_bytes":end-start,"raw_output_omitted_bytes":raw_omitted,"raw_output_truncated":raw_omitted>0,"presentation_output_omitted_bytes":presentation_omitted,"presentation_output_truncated":presentation_omitted>0,"chunk_receipt":{"kind":"delta","start_byte":start,"end_byte":end,"next_cursor":end,"operation":operation}});
        if let Some(receipt) = receipt.as_object() {
            for (key, value) in receipt {
                details[key] = value.clone();
                details["chunk_receipt"][key] = value.clone();
            }
        }
        let status = if running {
            format!("Process running with session ID {}", self.id)
        } else {
            format!(
                "Process exited with code {}",
                self.exit.borrow().unwrap_or(-1)
            )
        };
        let text = stella_runtime_core::redaction::tool_text(&text, false);
        ToolResult {
            content: vec![
                json!({"type":"text","text":format!("Wall time: {:.4} seconds\n{status}\nOriginal token count: {}\nOutput:\n{text}",started.elapsed().as_secs_f64(),(end-start).div_ceil(4))}),
            ],
            details,
            is_error: false,
        }
    }
}
struct Admission {
    session: Arc<Session>,
    work: Option<crate::work::Guard>,
    released: bool,
}
impl Drop for Admission {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.session.kill();
            let session = self.session.clone();
            let work = self.work.take();
            tokio::spawn(async move {
                session.wait_exit().await;
                drop(work);
            });
        }
    }
}
pub struct Shells {
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    pruned: Mutex<BTreeMap<String, (String, i64, i64)>>,
    generation: String,
}
impl Default for Shells {
    fn default() -> Self {
        Self {
            sessions: Default::default(),
            pruned: Default::default(),
            generation: ulid::Ulid::new().to_string(),
        }
    }
}
impl Drop for Shells {
    fn drop(&mut self) {
        for session in self.sessions.get_mut().unwrap().values() {
            let _ = session.kill();
        }
    }
}
fn budget(args: &Value) -> Result<usize> {
    match args.get("max_output_tokens") {
        None | Some(Value::Null) => Ok(10000),
        Some(value) => Ok(value
            .as_u64()
            .filter(|v| *v <= 9007199254740991)
            .context("max_output_tokens must be a non-negative safe integer")?
            .min(100000) as usize),
    }
}
fn milliseconds(args: &Value, default: u64, max: u64) -> u64 {
    args["yield_time_ms"]
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|n| n.max(0.0).min(max as f64) as u64)
        .unwrap_or(default)
}
fn shell(context: &FileContext, args: &Value) -> Result<PreparedShell> {
    let command = args["cmd"]
        .as_str()
        .or_else(|| args["command"].as_str())
        .context("cmd is required")?;
    if command.trim().is_empty() {
        bail!("cmd is required");
    }
    let cwd = args["workdir"]
        .as_str()
        .or_else(|| args["working_directory"].as_str())
        .map(PathBuf::from)
        .or(context.workspace_root.clone())
        .or(context.app_dir.clone())
        .unwrap_or(std::env::current_dir()?);
    let cwd = cwd
        .canonicalize()
        .context("workdir must be an existing directory")?;
    if !cwd.is_dir() {
        bail!("workdir must be a directory");
    }
    if let Some(root) = &context.workspace_root
        && !cwd.starts_with(root.canonicalize()?)
    {
        bail!("Shell workdir must stay inside the workspace");
    }
    let home = crate::file_tools::home()?.to_string_lossy().into_owned();
    if let Some(reason) = stella_runtime_core::shell_guard::reason(
        command,
        &cwd.to_string_lossy(),
        &home,
        &std::env::vars().collect(),
    ) {
        bail!(
            "Command blocked: this operation is potentially destructive and has been denied for safety. ({reason})"
        );
    }
    let executable = args["shell"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(default_shell);
    let name = PathBuf::from(&executable)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let options = if name == "cmd" {
        vec!["/d".into(), "/s".into(), "/c".into(), command.into()]
    } else if name == "pwsh" || name == "powershell" {
        use base64::Engine;
        let source = format!(
            "$global:LASTEXITCODE = 0\n{command}\n$__stella_command_succeeded = $?\n$__stella_native_exit = $global:LASTEXITCODE\nif ($__stella_command_succeeded) {{ exit 0 }}\nif ($__stella_native_exit -ne 0) {{ exit $__stella_native_exit }}\nexit 1"
        );
        let encoded = base64::engine::general_purpose::STANDARD.encode(
            source
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        let mut options = vec!["-NoLogo".into(), "-NoProfile".into()];
        if args["tty"] != true {
            options.push("-NonInteractive".into());
        }
        options.extend(["-EncodedCommand".into(), encoded]);
        options
    } else {
        vec![
            if args["login"] == false { "-c" } else { "-lc" }.into(),
            command.into(),
        ]
    };
    let mut env = std::env::vars()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "STELLA_SITE_AUTH_TOKEN"
                    | "STELLA_NATIVE_OAUTH_BACKEND_AUTH_TOKEN"
                    | "STELLA_LLM_PROXY_TOKEN"
                    | "STELLA_AUTH_TOKEN"
                    | "STELLA_ADMIN_API_SECRET"
                    | "CONVEX_DEPLOY_KEY"
                    | "CLOUDFLARE_API_TOKEN"
            ) && !key.starts_with("STELLA_VERIFY_")
        })
        .collect::<BTreeMap<_, _>>();
    env.entry(if cfg!(windows) {
        "USERPROFILE".into()
    } else {
        "HOME".into()
    })
    .or_insert(home);
    let mut paths = Vec::new();
    if let Some(data) = &context.data_dir {
        paths.push(data.join("bin"));
    }
    paths.push(cwd.join("node_modules/.bin"));
    if let Some(app) = &context.app_dir {
        paths.push(app.join("node_modules/.bin"));
    }
    paths.retain(|p| p.is_dir());
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    env.insert(
        "PATH".into(),
        std::env::join_paths(paths)?.to_string_lossy().into_owned(),
    );
    Ok((executable, options, cwd, env))
}
fn reader(session: Arc<Session>, mut input: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut bytes = [0; 16384];
        let mut pending = Vec::new();
        loop {
            match input.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => pending.extend_from_slice(&bytes[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
            let mut consumed = 0;
            while consumed < pending.len() {
                match std::str::from_utf8(&pending[consumed..]) {
                    Ok(text) => {
                        session.output.lock().unwrap().add(text);
                        consumed = pending.len();
                    }
                    Err(error) => {
                        let valid = error.valid_up_to();
                        if valid > 0 {
                            session.output.lock().unwrap().add(
                                std::str::from_utf8(&pending[consumed..consumed + valid]).unwrap(),
                            );
                            consumed += valid;
                        }
                        if let Some(length) = error.error_len() {
                            session.output.lock().unwrap().add("\u{fffd}");
                            consumed += length;
                        } else {
                            break;
                        }
                    }
                }
            }
            pending.drain(..consumed);
            session.changed();
        }
        if !pending.is_empty() {
            session
                .output
                .lock()
                .unwrap()
                .add(&String::from_utf8_lossy(&pending));
            session.changed();
        }
    });
}
impl Shells {
    fn prune(&self) {
        use std::sync::atomic::Ordering;
        let mut sessions = self.sessions.lock().unwrap();
        let mut completed = sessions
            .values()
            .filter(|s| !s.running())
            .cloned()
            .collect::<Vec<_>>();
        completed.sort_by_key(|s| s.completed.load(Ordering::Relaxed));
        let mut retained = completed.len();
        let mut pruned = self.pruned.lock().unwrap();
        pruned.retain(|_, (_, _, at)| now_ms() - *at < 10 * 60 * 1000);
        for session in completed {
            if retained <= 64
                && now_ms() - session.completed.load(Ordering::Relaxed) < 30 * 60 * 1000
            {
                break;
            }
            if session.interaction.try_lock().is_err() {
                continue;
            }
            sessions.remove(&session.id);
            retained -= 1;
            pruned.insert(
                session.id.clone(),
                (
                    session.scope.clone(),
                    session.exit.borrow().unwrap_or(-1),
                    now_ms(),
                ),
            );
        }
        while pruned.len() > 16 {
            let oldest = pruned
                .iter()
                .min_by_key(|(_, (_, _, at))| *at)
                .map(|(key, _)| key.clone())
                .unwrap();
            pruned.remove(&oldest);
        }
    }
    fn spawn(&self, args: &Value, context: &FileContext, owner: Value) -> Result<Arc<Session>> {
        self.prune();
        let (executable, options, cwd, env) = shell(context, args)?;
        let mut readers: Vec<Box<dyn Read + Send>> = Vec::new();
        let (mut child, writer, master): SpawnedShell = if args["tty"] == true {
            let pair = portable_pty::native_pty_system().openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })?;
            let mut command = CommandBuilder::new(executable);
            command.args(options);
            command.cwd(&cwd);
            command.env_clear();
            for (key, value) in env {
                command.env(key, value);
            }
            let child = pair.slave.spawn_command(command)?;
            readers.push(pair.master.try_clone_reader()?);
            let writer = pair.master.take_writer()?;
            drop(pair.slave);
            (child, writer, Some(pair.master))
        } else {
            let mut command = std::process::Command::new(executable);
            command
                .args(options)
                .current_dir(&cwd)
                .env_clear()
                .envs(env)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            let mut child = command.spawn()?;
            let writer = Box::new(child.stdin.take().context("Missing shell stdin")?);
            readers.push(Box::new(
                child.stdout.take().context("Missing shell stdout")?,
            ));
            readers.push(Box::new(
                child.stderr.take().context("Missing shell stderr")?,
            ));
            (Box::new(child), writer, None)
        };
        let id = ulid::Ulid::new().to_string();
        let session = Arc::new(Session {
            id: id.clone(),
            scope: context.scope.clone(),
            owner,
            generation: self.generation.clone(),
            cwd,
            command: args["cmd"]
                .as_str()
                .or_else(|| args["command"].as_str())
                .unwrap_or("")
                .into(),
            pid: child.process_id(),
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(master),
            killer: Mutex::new(child.clone_killer()),
            output: Default::default(),
            activity: watch::channel(0).0,
            exit: watch::channel(None).0,
            interaction: AsyncMutex::new(Interaction {
                sequence: 0,
                chunk: 0,
                writes: VecDeque::new(),
            }),
            completed: Default::default(),
        });
        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(id, session.clone());
        }
        for input in readers {
            reader(session.clone(), input);
        }
        let owned = session.clone();
        std::thread::spawn(move || {
            let exit = child
                .wait()
                .map(|status| i64::from(status.exit_code()))
                .unwrap_or(-1);
            owned
                .completed
                .store(now_ms(), std::sync::atomic::Ordering::Relaxed);
            owned.exit.send_replace(Some(exit));
            owned.changed();
        });
        Ok(session)
    }
    pub async fn exec(
        self: &Arc<Self>,
        args: Value,
        context: FileContext,
        owner: Value,
        work: Arc<Work>,
    ) -> Result<ToolResult> {
        let started = Instant::now();
        let budget = budget(&args)?;
        let wait = milliseconds(&args, 10000, 30000);
        // Spawn has no await: cancellation cannot abandon a process between
        // creation and installing its admission guard.
        let session = self.spawn(&args, &context, owner)?;
        let mut admission = Admission {
            session: session.clone(),
            work: Some(work.enter()),
            released: false,
        };
        let mut interaction = session.interaction.lock().await;
        interaction.sequence += 1;
        session.wait(wait, false).await;
        let result = session.result(&mut interaction, "exec", started, budget, json!({}));
        admission.released = true;
        Ok(result)
    }
    pub async fn interact(
        self: &Arc<Self>,
        args: Value,
        scope: &str,
        work: Arc<Work>,
    ) -> Result<ToolResult> {
        let started = Instant::now();
        let budget = budget(&args)?;
        let id = args["session_id"]
            .as_str()
            .context("session_id is required")?;
        self.prune();
        let session = self.sessions.lock().unwrap().get(id).cloned();
        let Some(session) = session else {
            if let Some((owner, code, _)) = self.pruned.lock().unwrap().get(id)
                && owner == scope
            {
                bail!(
                    "Session {id} completed with exit code {code} and was pruned from runtime worker generation {}",
                    self.generation
                );
            }
            bail!("Unknown shell session");
        };
        if session.scope != scope {
            bail!("Shell session belongs to a different conversation or agent thread");
        }
        let chars = args["chars"].as_str().unwrap_or("").to_owned();
        let operation = args["operation"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(if chars.is_empty() { "poll" } else { "write" });
        if !["write", "poll", "terminate", "close_stdin", "resize"].contains(&operation) {
            bail!("Invalid shell interaction operation");
        }
        let write_id = args
            .get("write_id")
            .filter(|v| !v.is_null())
            .map(|value| value.as_str().context("write_id must be a string"))
            .transpose()?;
        if let Some(id) = write_id
            && (id.trim().is_empty() || id.len() > 256 || operation != "write")
        {
            bail!("write_id must contain 1–256 characters and is only valid for write");
        }
        if !chars.is_empty() && operation != "write" {
            bail!("chars is only valid for write");
        }
        let mut interaction = session.interaction.lock().await;
        interaction.sequence += 1;
        let mut receipt = json!({});
        match operation {
            "write" => {
                let digest = format!("{:x}", Sha256::digest(chars.as_bytes()));
                interaction
                    .writes
                    .retain(|(_, _, at)| now_ms() - at < 10 * 60 * 1000);
                let duplicate =
                    write_id.and_then(|id| interaction.writes.iter().find(|(key, _, _)| key == id));
                if let Some((_, previous, _)) = duplicate
                    && previous != &digest
                {
                    bail!("write_id was already accepted with different characters");
                }
                if let Some(id) = write_id {
                    receipt = json!({"write_id":id,"write_deduplicated":duplicate.is_some()});
                }
                if duplicate.is_none() {
                    if !session.running() {
                        bail!("Shell session has already exited");
                    }
                    let owned = session.clone();
                    let work = work.enter();
                    let mut operation_guard = Admission {
                        session: session.clone(),
                        work: None,
                        released: false,
                    };
                    tokio::time::timeout(
                        Duration::from_secs(30),
                        tokio::task::spawn_blocking(move || -> Result<()> {
                            let _work = work;
                            let mut writer = owned.writer.lock().unwrap();
                            let writer = writer.as_mut().context("Shell stdin is closed")?;
                            writer.write_all(chars.as_bytes())?;
                            writer.flush()?;
                            Ok(())
                        }),
                    )
                    .await
                    .context("Shell write timed out")???;
                    operation_guard.released = true;
                    if let Some(id) = write_id {
                        interaction.writes.push_back((id.into(), digest, now_ms()));
                        while interaction.writes.len() > 256 {
                            interaction.writes.pop_front();
                        }
                    }
                }
            }
            "terminate" => {
                session.terminate().await?;
            }
            "close_stdin" => {
                if session.master.lock().unwrap().is_some() {
                    bail!(
                        "close_stdin is pipe-only; use a terminal EOF/control sequence for PTY sessions"
                    );
                }
                session.writer.lock().unwrap().take();
            }
            "resize" => {
                let cols = args["cols"]
                    .as_u64()
                    .filter(|v| (1..=1000).contains(v))
                    .context("cols must be an integer from 1 to 1000")?
                    as u16;
                let rows = args["rows"]
                    .as_u64()
                    .filter(|v| (1..=1000).contains(v))
                    .context("rows must be an integer from 1 to 1000")?
                    as u16;
                if !session.running() {
                    bail!("resize requires a running PTY session");
                }
                session
                    .master
                    .lock()
                    .unwrap()
                    .as_ref()
                    .context("resize is PTY-only")?
                    .resize(PtySize {
                        cols,
                        rows,
                        pixel_width: 0,
                        pixel_height: 0,
                    })?;
                receipt = json!({"terminal_size":{"cols":cols,"rows":rows}});
            }
            _ => {}
        }
        let poll = operation == "poll";
        session
            .wait(
                milliseconds(
                    &args,
                    if poll { 5000 } else { 250 },
                    if poll { 300000 } else { 30000 },
                ),
                poll,
            )
            .await;
        Ok(session.result(&mut interaction, operation, started, budget, receipt))
    }
    pub async fn kill_all(&self) -> Result<usize> {
        self.kill_matching(None).await
    }
    pub async fn kill_by_port(&self, port: u16) -> Result<usize> {
        self.kill_matching(Some(port.to_string())).await
    }
    async fn kill_matching(&self, port: Option<String>) -> Result<usize> {
        let sessions = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.running() && port.as_ref().is_none_or(|port| s.command.contains(port)))
            .cloned()
            .collect::<Vec<_>>();
        let count = sessions.len();
        let mut joins = tokio::task::JoinSet::new();
        for session in sessions {
            joins.spawn(async move { session.terminate().await });
        }
        while let Some(result) = joins.join_next().await {
            result??;
        }
        Ok(count)
    }
}
