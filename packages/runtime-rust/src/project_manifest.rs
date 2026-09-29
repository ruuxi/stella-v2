//! User-app manifests and ordinary package-script discovery.
use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::LazyLock,
};

#[derive(Clone, Debug)]
pub enum Readiness {
    Http { path: String, timeout: u64 },
    Tcp { timeout: u64 },
    Process { delay: u64 },
}
#[derive(Clone, Debug, Deserialize)]
pub struct NamedPort {
    pub id: String,
    pub protocol: String,
}
#[derive(Clone, Debug)]
pub struct Process {
    pub id: String,
    pub command: String,
    pub args: Vec<String>,
    pub port: bool,
    pub ports: Vec<NamedPort>,
    pub readiness: Readiness,
}
#[derive(Clone, Debug)]
pub struct Runtime {
    pub frontend: String,
    pub processes: Vec<Process>,
}
#[derive(Clone, Debug)]
pub struct Project {
    pub slug: String,
    pub path: PathBuf,
    pub meta: Value,
    pub runtime: Option<Runtime>,
    pub scripts: BTreeMap<String, String>,
    pub dependencies: BTreeSet<String>,
}
pub fn slug(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn string(value: &Value, key: &str, max: usize) -> Result<String> {
    let text = value[key]
        .as_str()
        .context("Manifest field must be a string")?
        .trim();
    if text.is_empty() || text.encode_utf16().count() > max || text.contains('\0') {
        bail!("Invalid manifest {key}");
    }
    Ok(text.into())
}
fn bounded(value: &Value, key: &str, default: u64, min: u64, max: u64) -> Result<u64> {
    let Some(value) = value.get(key) else {
        return Ok(default);
    };
    value
        .as_u64()
        .filter(|v| (min..=max).contains(v))
        .context("Invalid readiness duration")
}
fn parse_runtime(value: &Value) -> Result<Runtime> {
    let frontend = string(value, "frontend", 32)?;
    if !slug(&frontend) {
        bail!("Invalid frontend process ID");
    }
    let processes = value["processes"]
        .as_array()
        .filter(|p| (1..=8).contains(&p.len()))
        .context("Runtime requires 1 to 8 processes")?;
    let mut parsed = Vec::new();
    let mut ids = BTreeSet::new();
    let mut env_names = BTreeSet::new();
    for value in processes {
        let id = string(value, "id", 32)?;
        if !slug(&id) || !ids.insert(id.clone()) {
            bail!("Invalid or duplicate process ID");
        }
        let command = string(value, "command", 512)?;
        let args = value
            .get("args")
            .map(|v| serde_json::from_value::<Vec<String>>(v.clone()))
            .transpose()?
            .unwrap_or_default();
        if args.len() > 128
            || args
                .iter()
                .any(|s| s.contains('\0') || s.encode_utf16().count() > 4096)
        {
            bail!("Invalid process arguments");
        }
        let port = match value.get("port") {
            None => false,
            Some(v) if v == "auto" => true,
            _ => bail!("Process port must be auto"),
        };
        let ports = value
            .get("ports")
            .map(|v| serde_json::from_value::<Vec<NamedPort>>(v.clone()))
            .transpose()?
            .unwrap_or_default();
        if ports.len() > 8 {
            bail!("Too many named ports");
        }
        if port && !env_names.insert(suffix(&id)) {
            bail!("Duplicate process port environment name");
        }
        let mut port_ids = BTreeSet::new();
        for p in &ports {
            if !slug(&p.id)
                || !matches!(p.protocol.as_str(), "tcp" | "udp")
                || !port_ids.insert(p.id.clone())
                || !env_names.insert(format!("{}_{}", suffix(&id), suffix(&p.id)))
            {
                bail!("Invalid or colliding named port");
            }
        }
        let readiness = match value.get("readiness") {
            None if port => Readiness::Tcp { timeout: 30000 },
            None => Readiness::Process { delay: 250 },
            Some(r) => match r["type"].as_str() {
                Some("process") => Readiness::Process {
                    delay: bounded(r, "delayMs", 250, 50, 10000)?,
                },
                Some("tcp") if port => Readiness::Tcp {
                    timeout: bounded(r, "timeoutMs", 30000, 1000, 120000)?,
                },
                Some("http") if port => {
                    let path = r
                        .get("path")
                        .map(|p| p.as_str().context("Readiness path must be a string"))
                        .transpose()?
                        .unwrap_or("/");
                    if !path.starts_with('/')
                        || path.starts_with("//")
                        || path.chars().any(|c| c.is_whitespace() || c == '\\')
                    {
                        bail!("HTTP readiness path must be loopback-relative");
                    }
                    Readiness::Http {
                        path: path.into(),
                        timeout: bounded(r, "timeoutMs", 30000, 1000, 120000)?,
                    }
                }
                _ => bail!("Invalid readiness; HTTP/TCP requires an automatic port"),
            },
        };
        parsed.push(Process {
            id,
            command,
            args,
            port,
            ports,
            readiness,
        });
    }
    let front = parsed
        .iter()
        .find(|p| p.id == frontend)
        .context("Frontend must name a declared process")?;
    if !front.port || matches!(front.readiness, Readiness::Process { .. }) {
        bail!("Frontend requires an automatic port and HTTP or TCP readiness");
    }
    Ok(Runtime {
        frontend,
        processes: parsed,
    })
}
pub fn suffix(value: &str) -> String {
    value.to_ascii_uppercase().replace('-', "_")
}

pub async fn regular_json(path: &Path) -> Result<Value> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("Project metadata must be a regular file");
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let file = options.open(path).await?;
    if !file.metadata().await?.is_file() {
        bail!("Project metadata must be a regular file");
    }
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
    if bytes.len() > 1024 * 1024 {
        bail!("Project metadata exceeds 1 MiB");
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if !value.is_object() {
        bail!("Project metadata must contain a JSON object");
    }
    Ok(value)
}
pub async fn resolve(root: &Path, name: &str) -> Result<Project> {
    if !slug(name) {
        bail!("Invalid app slug");
    }
    let root = tokio::fs::canonicalize(root).await?;
    let path = root.join(name);
    let metadata = tokio::fs::symlink_metadata(&path).await?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("App project must be a regular directory");
    }
    if tokio::fs::canonicalize(&path).await? != path {
        bail!("App project escapes apps directory");
    }
    let manifest = regular_json(&path.join("stella.app.json")).await?;
    if manifest["schemaVersion"] != 1 || manifest["slug"] != name {
        bail!("Invalid app manifest schema or slug");
    }
    let label = string(&manifest, "name", 120)?;
    let created = string(&manifest, "createdAt", 128)?;
    if chrono::DateTime::parse_from_rfc3339(&created).is_err()
        && chrono::NaiveDate::parse_from_str(&created, "%Y-%m-%d").is_err()
    {
        bail!("createdAt must be an ISO date string");
    }
    let runtime = manifest.get("runtime").map(parse_runtime).transpose()?;
    let package = regular_json(&path.join("package.json")).await?;
    let scripts = package["scripts"]
        .as_object()
        .into_iter()
        .flat_map(|s| s.iter())
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
        .collect();
    let dependencies = ["dependencies", "devDependencies"]
        .into_iter()
        .flat_map(|field| {
            package[field]
                .as_object()
                .into_iter()
                .flat_map(|o| o.keys().cloned())
        })
        .collect();
    Ok(Project {
        slug: name.into(),
        path,
        meta: json!({"label":label,"createdAt":created}),
        runtime,
        scripts,
        dependencies,
    })
}

static FRONTEND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|[\s"'])(?:bunx\s+|bun\s+x\s+|npx\s+)?(?:vite|next(?:\s+dev)?|astro\s+dev|remix\s+dev|webpack(?:-dev-server)?|react-scripts\s+start)(?:$|[\s"'])"#).unwrap()
});
static FRONTEND_SCRIPT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|:)(?:web|frontend|client|ui)(?:$|:)").unwrap());
static DEV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:dev|start)(?:[:-]|$)|[:-](?:dev|start)$").unwrap());
static SIBLING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:dev|start):(?:api|server|backend|worker|workers|job|jobs|queue|livekit|realtime|socket|db|database)(?::|$)|^(?:api|server|backend|worker|workers|job|jobs|queue|livekit|realtime|socket|db|database):(?:dev|start)$").unwrap()
});
static WORKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|:)(?:worker|workers|job|jobs|queue)(?:$|:)").unwrap());
static AGGREGATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|[\s"'])(?:concurrently|npm-run-all|run-p|turbo\s+dev|nx\s+(?:run-many|affected)|bun\s+run\s+--parallel)(?:$|[\s"'])|(?:^|[\s"'])(?:node|bun)\s+(?:\./)?scripts/(?:dev|start)\.[cm]?[jt]s(?:$|[\s"'])"#).unwrap()
});
static BACKEND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|[\s"'])(?:(?:node|bun|tsx?|nodemon)\b[^\n]*\b(?:api|backend|server)[./_\w-]*|(?:convex|wrangler)\s+dev)(?:$|[\s"'])"#).unwrap()
});
fn references(command: &str, name: &str) -> bool {
    Regex::new(&format!(
        r#"(?i)(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?{}(?:$|[\s"'])"#,
        regex::escape(name)
    ))
    .unwrap()
    .is_match(command)
}
fn automatic(
    name: &str,
    id: &str,
    frontend: bool,
    worker: bool,
    command: &str,
    aggregate: bool,
) -> Process {
    static VITE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:^|\s)vite(?:\s|$)").unwrap());
    let mut args = vec!["run".into(), name.into()];
    if frontend && !aggregate && VITE.is_match(command) {
        args.extend(
            [
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                "${PORT}",
                "--strictPort",
            ]
            .map(str::to_owned),
        );
    }
    Process {
        id: id.into(),
        command: "bun".into(),
        args,
        port: !worker,
        ports: vec![],
        readiness: if worker {
            Readiness::Process { delay: 250 }
        } else {
            Readiness::Tcp { timeout: 30000 }
        },
    }
}
pub fn detect(project: &Project) -> Result<Runtime> {
    if let Some(runtime) = &project.runtime {
        return Ok(runtime.clone());
    }
    let scripts = &project.scripts;
    let entries = scripts
        .iter()
        .filter(|(name, command)| !name.is_empty() && !command.trim().is_empty())
        .collect::<Vec<_>>();
    if entries.is_empty() {
        if !project.dependencies.is_empty() && !project.dependencies.contains("vite") {
            bail!("No standard frontend dev script was found");
        }
        return Ok(Runtime {
            frontend: "frontend".into(),
            processes: vec![Process {
                id: "frontend".into(),
                command: "bun".into(),
                args: [
                    "x",
                    "vite",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "${PORT}",
                    "--strictPort",
                ]
                .map(str::to_owned)
                .into(),
                port: true,
                ports: vec![],
                readiness: Readiness::Tcp { timeout: 30000 },
            }],
        });
    }
    let dev = scripts
        .get("dev")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let siblings = entries
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|n| *n != "dev" && SIBLING.is_match(n))
        .collect::<Vec<_>>();
    let candidates = entries
        .iter()
        .filter(|(name, command)| {
            name.as_str() != "dev"
                && DEV.is_match(name)
                && (FRONTEND_SCRIPT.is_match(name) || FRONTEND.is_match(command))
        })
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>();
    let split = candidates.len() == 1
        && !siblings.is_empty()
        && dev.is_some_and(|d| {
            references(d, candidates[0]) && siblings.iter().all(|s| references(d, s))
        });
    let aggregate = !split
        && dev.is_some_and(|d| AGGREGATE.is_match(d) || siblings.iter().any(|s| references(d, s)));
    if aggregate {
        return Ok(Runtime {
            frontend: "frontend".into(),
            processes: vec![automatic(
                "dev",
                "frontend",
                true,
                false,
                dev.unwrap(),
                true,
            )],
        });
    }
    let mut dev_backend = false;
    let frontend = if let Some(dev) = dev {
        if FRONTEND.is_match(dev) {
            if !candidates.is_empty() {
                bail!("Frontend discovery is ambiguous between dev and other scripts");
            }
            "dev"
        } else if split {
            candidates[0]
        } else if candidates.len() == 1 && BACKEND.is_match(dev) {
            dev_backend = true;
            candidates[0]
        } else if !candidates.is_empty() {
            bail!(
                "dev does not clearly own the frontend; use an aggregate script or manifest runtime"
            );
        } else {
            "dev"
        }
    } else if candidates.len() == 1 {
        candidates[0]
    } else {
        bail!("No unambiguous frontend dev script was found");
    };
    let mut auxiliaries = if dev_backend { vec!["dev"] } else { vec![] };
    auxiliaries.extend(siblings.into_iter().filter(|s| *s != frontend));
    let mut ids = BTreeSet::from(["frontend".to_string()]);
    let mut processes = Vec::new();
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^a-z0-9]+").unwrap());
    for name in auxiliaries {
        let normal = ID
            .replace_all(&name.to_ascii_lowercase(), "-")
            .trim_matches('-')
            .to_owned();
        let mut id = if normal
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_lowercase)
        {
            normal
        } else {
            format!("process-{normal}")
        };
        id.truncate(id.len().min(32));
        if !ids.insert(id.clone()) {
            bail!("Process discovery produced duplicate IDs");
        }
        processes.push(automatic(
            name,
            &id,
            false,
            WORKER.is_match(name),
            &scripts[name],
            false,
        ));
    }
    processes.push(automatic(
        frontend,
        "frontend",
        true,
        false,
        &scripts[frontend],
        false,
    ));
    if processes.len() > 8 {
        bail!("Process discovery exceeds the eight-process limit");
    }
    Ok(Runtime {
        frontend: "frontend".into(),
        processes,
    })
}
