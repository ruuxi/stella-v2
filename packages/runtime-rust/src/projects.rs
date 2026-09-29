//! Native app discovery and generation-fenced process-set supervision.
use crate::{
    project_manifest::{self, Project, Readiness},
    project_process::Process,
};
use anyhow::{Context, Result, bail};
use notify::{RecursiveMode, Watcher};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Notify, broadcast};

pub struct Projects {
    root: PathBuf,
    bun: String,
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
    ports: tokio::sync::Mutex<BTreeMap<String, u16>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    watched: Mutex<BTreeSet<PathBuf>>,
    changed: Arc<Notify>,
    notifications: broadcast::Sender<Value>,
    stopping: AtomicBool,
}
struct Entry {
    slug: String,
    operation: tokio::sync::Mutex<()>,
    desired: AtomicBool,
    generation: AtomicU64,
    state: Mutex<Value>,
    children: Mutex<Vec<Arc<Process>>>,
}
impl Entry {
    fn new(slug: &str) -> Self {
        Self {
            slug: slug.into(),
            operation: Default::default(),
            desired: AtomicBool::new(true),
            generation: AtomicU64::new(0),
            state: Mutex::new(json!({"slug":slug,"url":null,"status":"stopped"})),
            children: Default::default(),
        }
    }
    fn valid(&self, generation: u64) -> bool {
        self.desired.load(Ordering::SeqCst) && self.generation.load(Ordering::SeqCst) == generation
    }
}
impl Projects {
    pub async fn open(
        workspace: PathBuf,
        bun: Option<String>,
        notifications: broadcast::Sender<Value>,
    ) -> Result<Arc<Self>> {
        let root = workspace.join("apps");
        tokio::fs::create_dir_all(&root).await?;
        let root = tokio::fs::canonicalize(root).await?;
        let changed = Arc::new(Notify::new());
        let signal = changed.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event
                    && !matches!(event.kind, notify::EventKind::Access(_))
                    && event.paths.iter().any(|p| {
                        !p.file_name()
                            .is_some_and(|n| n.to_string_lossy().starts_with('.'))
                    })
                {
                    signal.notify_one();
                }
            })?;
        watcher.watch(&root, RecursiveMode::NonRecursive)?;
        let mut ports = BTreeMap::new();
        let mut used = BTreeSet::new();
        if let Ok(value) =
            project_manifest::regular_json(&root.join(".stella-app-ports.json")).await
            && value["schemaVersion"] == 1
            && let Some(stored) = value["ports"].as_object()
        {
            for (key, value) in stored {
                let valid = key
                    .split_once(':')
                    .map(|(name, qualifier)| {
                        project_manifest::slug(name)
                            && !qualifier.is_empty()
                            && qualifier.len() <= 65
                            && qualifier.as_bytes()[0].is_ascii_lowercase()
                            && qualifier
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                    })
                    .unwrap_or_else(|| project_manifest::slug(key));
                if valid
                    && let Some(port) = value.as_u64().filter(|p| (41000..61000).contains(p))
                    && used.insert(port)
                {
                    ports.insert(key.clone(), port as u16);
                }
            }
        }
        let service = Arc::new(Self {
            root,
            bun: bun
                .or_else(|| std::env::var("STELLA_BUN_PATH").ok())
                .unwrap_or_else(|| "bun".into()),
            entries: Default::default(),
            ports: tokio::sync::Mutex::new(ports),
            watcher: Mutex::new(Some(watcher)),
            watched: Default::default(),
            changed,
            notifications,
            stopping: AtomicBool::new(false),
        });
        service.refresh_watches().await?;
        let weak = Arc::downgrade(&service);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
            loop {
                let Some(service) = weak.upgrade() else {
                    break;
                };
                if service.stopping.load(Ordering::SeqCst) {
                    break;
                }
                tokio::select! {
                    _=service.changed.notified()=>{
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        if let Err(error)=service.refresh_watches().await{eprintln!("Project watcher: {error}");}
                        service.notify();
                    }
                    _=tick.tick()=>service.supervise(),
                }
            }
        });
        Ok(service)
    }
    fn notify(&self) {
        let _ = self
            .notifications
            .send(json!({"method":"projects.updated"}));
    }
    pub fn has_active_work(&self) -> bool {
        self.entries.lock().unwrap().values().any(|entry| {
            entry.desired.load(Ordering::SeqCst)
                || entry.operation.try_lock().is_err()
                || entry.children.lock().unwrap().iter().any(|p| p.running())
        })
    }
    fn state(&self, entry: &Entry, status: &str, url: Option<String>, error: Option<String>) {
        let mut state = json!({"slug":entry.slug,"url":url,"status":status});
        if let Some(error) = error {
            state["error"] = json!(error);
        }
        *entry.state.lock().unwrap() = state;
        self.notify();
    }
    async fn names(&self) -> Result<BTreeSet<String>> {
        let mut names = BTreeSet::new();
        let mut directory = tokio::fs::read_dir(&self.root).await?;
        while let Some(entry) = directory.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if project_manifest::slug(&name) && entry.file_type().await?.is_dir() {
                names.insert(name);
            }
        }
        Ok(names)
    }
    async fn refresh_watches(&self) -> Result<()> {
        let names = self.names().await?;
        let removed = {
            let entries = self.entries.lock().unwrap();
            entries
                .iter()
                .filter(|(name, _)| !names.contains(*name))
                .map(|(_, entry)| entry.clone())
                .collect::<Vec<_>>()
        };
        for entry in removed {
            self.stop_entry(&entry).await?;
        }
        let wanted = names
            .iter()
            .map(|n| self.root.join(n))
            .collect::<BTreeSet<_>>();
        let mut watched = self.watched.lock().unwrap();
        let mut watcher = self.watcher.lock().unwrap();
        if let Some(watcher) = watcher.as_mut() {
            for path in watched.difference(&wanted) {
                let _ = watcher.unwatch(path);
            }
            let mut next = watched
                .intersection(&wanted)
                .cloned()
                .collect::<BTreeSet<_>>();
            for path in wanted.difference(&watched) {
                if watcher.watch(path, RecursiveMode::NonRecursive).is_ok() {
                    next.insert(path.clone());
                }
            }
            *watched = next;
        }
        Ok(())
    }
    pub async fn list(&self) -> Result<Value> {
        self.refresh_watches().await?;
        let mut apps = Vec::new();
        for name in self.names().await? {
            if let Ok(project) = project_manifest::resolve(&self.root, &name).await {
                let status = self
                    .entries
                    .lock()
                    .unwrap()
                    .get(&name)
                    .map(|e| e.state.lock().unwrap()["status"].clone())
                    .unwrap_or_else(|| json!("stopped"));
                apps.push(json!({"slug":name,"meta":project.meta,"status":status}));
            }
        }
        Ok(json!({"apps":apps}))
    }
    pub async fn start(self: &Arc<Self>, slug: &str) -> Result<Value> {
        if !project_manifest::slug(slug) {
            bail!("Invalid app slug");
        }
        if self.stopping.load(Ordering::SeqCst) {
            return Ok(
                json!({"slug":slug,"url":null,"status":"error","error":"App service is stopping"}),
            );
        }
        let project = project_manifest::resolve(&self.root, slug).await?;
        let entry = self
            .entries
            .lock()
            .unwrap()
            .entry(slug.into())
            .or_insert_with(|| Arc::new(Entry::new(slug)))
            .clone();
        entry.desired.store(true, Ordering::SeqCst);
        let _operation = entry.operation.lock().await;
        if self.stopping.load(Ordering::SeqCst) || !entry.desired.load(Ordering::SeqCst) {
            return Ok(json!({"slug":slug,"url":null,"status":"stopped"}));
        }
        if entry.state.lock().unwrap()["status"] == "running"
            && entry.children.lock().unwrap().iter().all(|p| p.running())
        {
            return Ok(entry.state.lock().unwrap().clone());
        }
        self.launch(&entry, project).await;
        Ok(entry.state.lock().unwrap().clone())
    }
    pub async fn stop(&self, slug: &str) -> Result<Value> {
        if !project_manifest::slug(slug) {
            bail!("Invalid app slug");
        }
        let entry = self.entries.lock().unwrap().get(slug).cloned();
        if let Some(entry) = entry {
            self.stop_entry(&entry).await?;
        }
        Ok(json!({"slug":slug,"status":"stopped"}))
    }
    async fn stop_entry(&self, entry: &Arc<Entry>) -> Result<()> {
        entry.desired.store(false, Ordering::SeqCst);
        entry.generation.fetch_add(1, Ordering::SeqCst);
        let _operation = entry.operation.lock().await;
        self.state(entry, "stopping", None, None);
        let result = stop_children(entry).await;
        self.state(entry, "stopped", None, None);
        result
    }
    pub async fn shutdown(&self) -> Result<()> {
        self.stopping.store(true, Ordering::SeqCst);
        self.changed.notify_one();
        self.watcher.lock().unwrap().take();
        let entries = self
            .entries
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in &entries {
            entry.desired.store(false, Ordering::SeqCst);
            entry.generation.fetch_add(1, Ordering::SeqCst);
        }
        let mut failed = None;
        for entry in entries {
            if let Err(error) = self.stop_entry(&entry).await {
                failed = Some(error);
            }
        }
        if let Some(error) = failed {
            return Err(error);
        }
        Ok(())
    }
    async fn launch(&self, entry: &Arc<Entry>, project: Project) {
        let generation = entry.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let result = self.launch_inner(entry, &project, generation).await;
        if let Err(error) = result {
            let stopped = stop_children(entry).await;
            if !entry.valid(generation) || self.stopping.load(Ordering::SeqCst) {
                self.state(entry, "stopped", None, None);
            } else {
                // A failed start is terminal until explicitly retried. Crash
                // recovery gets one launch, matching the existing service.
                entry.desired.store(false, Ordering::SeqCst);
                let detail =
                    stella_runtime_core::redaction::tool_text(&format!("{error:#}"), false);
                self.state(
                    entry,
                    "error",
                    None,
                    Some(if let Err(stop) = stopped {
                        format!("{detail}; teardown: {stop}")
                    } else {
                        detail
                    }),
                );
            }
        }
    }
    async fn launch_inner(
        &self,
        entry: &Arc<Entry>,
        project: &Project,
        generation: u64,
    ) -> Result<()> {
        self.state(entry, "installing", None, None);
        let dependencies = project.path.join(
            if project.runtime.is_some() || !project.scripts.is_empty() {
                "node_modules"
            } else {
                "node_modules/vite"
            },
        );
        if !tokio::fs::metadata(dependencies)
            .await
            .is_ok_and(|m| m.is_dir())
        {
            let child = Process::spawn(
                &self.bun,
                &["install".into(), "--silent".into()],
                &project.path,
                &crate::project_process::environment(),
            )?;
            entry.children.lock().unwrap().push(child.clone());
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);
            while child.running() {
                self.check(entry, generation)?;
                if tokio::time::Instant::now() >= deadline {
                    bail!("Dependency installation timed out");
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            if child.wait().await != 0 {
                bail!("Dependency installation failed: {}", child.output());
            }
            // Keep the install group until teardown: a lifecycle script can
            // leave descendants even after the install process exits.
        }
        self.check(entry, generation)?;
        self.state(entry, "starting", None, None);
        let runtime = project_manifest::detect(project)?;
        let mut ports = BTreeMap::new();
        let mut named = BTreeMap::new();
        for process in &runtime.processes {
            self.check(entry, generation)?;
            if process.port {
                ports.insert(
                    process.id.clone(),
                    self.port(
                        &project.slug,
                        &process.id,
                        process.id == runtime.frontend,
                        None,
                        "tcp",
                    )
                    .await?,
                );
            }
            for p in &process.ports {
                named.insert(
                    format!("{}:{}", process.id, p.id),
                    self.port(&project.slug, &process.id, false, Some(&p.id), &p.protocol)
                        .await?,
                );
            }
        }
        let mut shared = crate::project_process::environment();
        shared.insert("STELLA_APP_SLUG".into(), project.slug.clone());
        for (id, port) in &ports {
            let suffix = project_manifest::suffix(id);
            shared.insert(format!("STELLA_APP_PORT_{suffix}"), port.to_string());
            shared.insert(
                format!("STELLA_APP_URL_{suffix}"),
                format!("http://127.0.0.1:{port}"),
            );
        }
        for (id, port) in &named {
            let (process, name) = id.split_once(':').unwrap();
            shared.insert(
                format!(
                    "STELLA_APP_PORT_{}_{}",
                    project_manifest::suffix(process),
                    project_manifest::suffix(name)
                ),
                port.to_string(),
            );
        }
        let mut servers = Vec::new();
        for definition in &runtime.processes {
            self.check(entry, generation)?;
            let mut env = shared.clone();
            env.insert("STELLA_APP_PROCESS_ID".into(), definition.id.clone());
            let own = ports.get(&definition.id).copied();
            if let Some(port) = own {
                env.insert("PORT".into(), port.to_string());
                env.insert("STELLA_APP_PORT".into(), port.to_string());
            }
            for p in &definition.ports {
                env.insert(
                    format!("STELLA_APP_PORT_{}", project_manifest::suffix(&p.id)),
                    named[&format!("{}:{}", definition.id, p.id)].to_string(),
                );
            }
            let args = definition
                .args
                .iter()
                .map(|arg| expand(arg, &env))
                .collect::<Result<Vec<_>>>()?;
            let executable = if definition.command == "bun" {
                &self.bun
            } else {
                &definition.command
            };
            let child = Process::spawn(executable, &args, &project.path, &env)?;
            entry.children.lock().unwrap().push(child.clone());
            servers.push(child.clone());
            self.ready(entry, generation, &child, &definition.readiness, own)
                .await
                .with_context(|| format!("Process {} readiness failed", definition.id))?;
        }
        self.check(entry, generation)?;
        if servers.iter().any(|child| !child.running()) {
            bail!("An app process exited during startup");
        }
        // Finished install processes are not supervised as app-server crashes.
        let previous = std::mem::replace(&mut *entry.children.lock().unwrap(), servers);
        for process in previous {
            if !process.running() {
                process.stop().await?;
            }
        }
        self.state(
            entry,
            "running",
            Some(format!("http://127.0.0.1:{}/", ports[&runtime.frontend])),
            None,
        );
        Ok(())
    }
    fn check(&self, entry: &Entry, generation: u64) -> Result<()> {
        if !entry.valid(generation) || self.stopping.load(Ordering::SeqCst) {
            bail!("App start canceled");
        }
        Ok(())
    }
    async fn ready(
        &self,
        entry: &Entry,
        generation: u64,
        child: &Process,
        readiness: &Readiness,
        port: Option<u16>,
    ) -> Result<()> {
        let timeout = match readiness {
            Readiness::Http { timeout, .. } | Readiness::Tcp { timeout } => *timeout,
            Readiness::Process { delay } => *delay,
        };
        let start = tokio::time::Instant::now();
        let mut consecutive = 0;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_millis(500))
            .build()?;
        loop {
            self.check(entry, generation)?;
            if !child.running() {
                bail!("Process exited before it was ready");
            }
            if matches!(readiness, Readiness::Process { .. }) {
                if start.elapsed().as_millis() >= timeout as u128 {
                    return Ok(());
                }
            } else {
                if start.elapsed().as_millis() >= timeout as u128 {
                    bail!("Process readiness timed out");
                }
                let port = port.context("Process has no readiness port")?;
                let ready = match readiness {
                    Readiness::Http { path, .. } => client
                        .get(format!("http://127.0.0.1:{port}{path}"))
                        .send()
                        .await
                        .is_ok_and(|r| (200..400).contains(&r.status().as_u16())),
                    _ => tokio::time::timeout(
                        std::time::Duration::from_millis(250),
                        tokio::net::TcpStream::connect(("127.0.0.1", port)),
                    )
                    .await
                    .is_ok_and(|r| r.is_ok()),
                };
                consecutive = if ready { consecutive + 1 } else { 0 };
                if consecutive >= 2 && child.running() {
                    return Ok(());
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(if consecutive > 0 {
                100
            } else {
                25
            }))
            .await;
        }
    }
    async fn port(
        &self,
        slug: &str,
        process: &str,
        frontend: bool,
        name: Option<&str>,
        protocol: &str,
    ) -> Result<u16> {
        let key = if frontend {
            slug.to_owned()
        } else {
            format!(
                "{slug}:{process}{}",
                name.map(|n| format!("-{n}")).unwrap_or_default()
            )
        };
        let mut ports = self.ports.lock().await;
        if let Some(port) = ports.get(&key)
            && available(*port, protocol).await
        {
            return Ok(*port);
        }
        ports.remove(&key);
        let claimed = ports.values().copied().collect::<BTreeSet<_>>();
        let hash = key
            .encode_utf16()
            .fold(2166136261u32, |h, c| (h ^ c as u32).wrapping_mul(16777619));
        for offset in 0..20000 {
            let port = (41000 + ((hash % 20000 + offset) % 20000)) as u16;
            if claimed.contains(&port) || !available(port, protocol).await {
                continue;
            }
            ports.insert(key.clone(), port);
            if let Err(error) = crate::catalog::write_cache(
                &self.root.join(".stella-app-ports.json"),
                &json!({"schemaVersion":1,"ports":*ports}),
            )
            .await
            {
                ports.remove(&key);
                return Err(error);
            }
            return Ok(port);
        }
        bail!("No loopback port is available for this app")
    }
    fn supervise(self: &Arc<Self>) {
        let entries = self
            .entries
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in entries {
            if !entry.desired.load(Ordering::SeqCst)
                || entry.state.lock().unwrap()["status"] != "running"
            {
                continue;
            }
            let failed = entry.children.lock().unwrap().iter().any(|p| !p.running());
            if !failed {
                continue;
            }
            let generation = entry.generation.fetch_add(1, Ordering::SeqCst) + 1;
            self.state(
                &entry,
                "error",
                None,
                Some("An app process exited; restarting its process set".into()),
            );
            let service = self.clone();
            tokio::spawn(async move {
                let _operation = entry.operation.lock().await;
                if !entry.valid(generation) {
                    return;
                }
                if let Err(error) = stop_children(&entry).await {
                    entry.desired.store(false, Ordering::SeqCst);
                    service.state(&entry, "error", None, Some(error.to_string()));
                    return;
                }
                // A stop/restart request invalidates this generation, so an old
                // recovery cannot launch over a newer process set.
                for _ in 0..80 {
                    if !entry.valid(generation) || service.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                match project_manifest::resolve(&service.root, &entry.slug).await {
                    Ok(project) => service.launch(&entry, project).await,
                    Err(error) => {
                        entry.desired.store(false, Ordering::SeqCst);
                        service.state(&entry, "error", None, Some(error.to_string()));
                    }
                }
            });
        }
    }
}
async fn stop_children(entry: &Entry) -> Result<()> {
    let children = std::mem::take(&mut *entry.children.lock().unwrap());
    let mut jobs = tokio::task::JoinSet::new();
    for child in children {
        jobs.spawn(async move { child.stop().await });
    }
    let mut failure = None;
    while let Some(result) = jobs.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failure = Some(error),
            Err(error) => failure = Some(error.into()),
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}
async fn available(port: u16, protocol: &str) -> bool {
    if protocol == "udp" {
        tokio::net::UdpSocket::bind(("127.0.0.1", port))
            .await
            .is_ok()
    } else {
        tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .is_ok()
    }
}
fn expand(arg: &str, env: &BTreeMap<String, String>) -> Result<String> {
    static VARIABLE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\$\{([A-Z][A-Z0-9_]*)\}").unwrap());
    let mut missing = None;
    let result = VARIABLE.replace_all(arg, |c: &regex::Captures| {
        env.get(&c[1]).cloned().unwrap_or_else(|| {
            missing = Some(c[1].to_owned());
            String::new()
        })
    });
    if let Some(name) = missing {
        bail!("Process argument references unknown environment variable {name}");
    }
    Ok(result.into_owned())
}
