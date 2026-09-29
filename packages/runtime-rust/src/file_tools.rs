//! Native file access policy and the model-visible Read format.
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use stella_runtime_core::agent::ToolResult;

#[derive(Clone, Default)]
pub struct FileContext {
    pub data_dir: Option<PathBuf>,
    pub app_dir: Option<PathBuf>,
    pub workspace_root: Option<PathBuf>,
    pub scope: String,
}
#[derive(Default)]
pub struct FileTools {
    skills: Mutex<VecDeque<(String, PathBuf, u64, std::time::SystemTime)>>,
}
fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .context("Home directory is unavailable")
}
pub fn absolute(raw: &str) -> Result<PathBuf> {
    let expanded = if raw == "~" || raw == "$HOME" || raw == "%USERPROFILE%" {
        home()?
    } else if let Some(relative) = raw
        .strip_prefix("~/")
        .or_else(|| raw.strip_prefix("$HOME/"))
        .or_else(|| raw.strip_prefix("%USERPROFILE%/"))
    {
        home()?.join(relative)
    } else {
        PathBuf::from(raw)
    };
    if !expanded.is_absolute() {
        bail!("File tool paths must be absolute: {raw}");
    }
    let mut normalized = PathBuf::new();
    for component in expanded.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}
fn normalized(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}
fn within(value: &str, prefix: &str) -> bool {
    value == prefix
        || value
            .strip_prefix(prefix)
            .is_some_and(|s| s.starts_with('/'))
}
pub fn validate(path: &Path, context: &FileContext) -> Result<()> {
    if let Some(root) = &context.workspace_root
        && !path.starts_with(root)
    {
        bail!("Path is outside the shared session workspace");
    }
    let value = normalized(path);
    let mut blocked = vec![
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/boot",
        "/sys",
        "/proc",
        "/private/etc",
        "/private/var",
    ]
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    if cfg!(windows) {
        blocked.extend(
            ["c:/windows", "c:/program files", "c:/program files (x86)"]
                .into_iter()
                .map(String::from),
        );
    }
    let home = home()?;
    for name in [
        ".ssh",
        ".aws",
        ".gnupg",
        ".kube",
        ".docker",
        ".azure",
        ".config/gh",
        ".config/gcloud",
    ] {
        blocked.push(normalized(&home.join(name)));
    }
    if blocked.iter().any(|prefix| within(&value, prefix)) {
        bail!(
            "Path blocked: file operations in system or credential directories are not available"
        );
    }
    for name in [
        ".ssh/authorized_keys",
        ".ssh/id_rsa",
        ".ssh/id_ed25519",
        ".ssh/config",
        ".bashrc",
        ".zshrc",
        ".profile",
        ".bash_profile",
        ".zprofile",
        ".netrc",
        ".pgpass",
        ".npmrc",
        ".pypirc",
        ".git-credentials",
    ] {
        if value == normalized(&home.join(name)) {
            bail!("Path blocked: credential or shell configuration file");
        }
    }
    let mut roots = vec![home.join(".stella")];
    roots.extend(
        [
            context.data_dir.clone(),
            context.app_dir.clone(),
            std::env::var_os("STELLA_DATA_DIR").map(PathBuf::from),
        ]
        .into_iter()
        .flatten(),
    );
    for root in roots {
        if [
            ".env",
            "auth.json",
            "auth.lock",
            "config.json",
            "preferences.json",
            "connectors/.credentials.json",
        ]
        .iter()
        .any(|name| value == normalized(&root.join(name)))
            || ["mcp-tokens", "pairing", "skills/.hub"]
                .iter()
                .any(|name| within(&value, &normalized(&root.join(name))))
        {
            bail!("Path blocked: internal Stella credential or token file");
        }
    }
    Ok(())
}
fn open_file(path: &Path, context: &FileContext) -> Result<std::fs::File> {
    validate(path, context)?;
    if let Some(root) = &context.workspace_root {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::ffi::OsStrExt;
            let mut parent = std::fs::File::open(root)?;
            let parts = path.strip_prefix(root)?.components().collect::<Vec<_>>();
            for (index, component) in parts.iter().enumerate() {
                let Component::Normal(name) = component else {
                    bail!("Invalid scoped file path");
                };
                let name = std::ffi::CString::new(name.as_bytes())?;
                let flags = libc::O_RDONLY
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | if index + 1 < parts.len() {
                        libc::O_DIRECTORY
                    } else {
                        libc::O_NONBLOCK
                    };
                let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                parent = unsafe { std::fs::File::from_raw_fd(fd) };
            }
            return Ok(parent);
        }
        #[cfg(not(unix))]
        {
            let canonical = path.canonicalize()?;
            if !canonical.starts_with(root.canonicalize()?) {
                bail!("Path escapes the shared session workspace");
            }
        }
    }
    // Check the resolved target as well: a symlink cannot make protected files
    // readable through an otherwise innocuous filename.
    validate(&path.canonicalize()?, context)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    Ok(options.open(path)?)
}
fn hash_line(line: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    // TypeScript hashes UTF-16 code units, not UTF-8 bytes or Unicode scalars.
    for character in line.encode_utf16() {
        hash = (hash ^ u32::from(character)).wrapping_mul(0x01000193);
    }
    let mut value = hash % 46656;
    let mut output = [b'0'; 3];
    for index in (0..3).rev() {
        output[index] = b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize];
        value /= 36;
    }
    String::from_utf8(output.to_vec()).unwrap()
}
impl FileTools {
    pub fn read(&self, args: &Value, context: &FileContext) -> Result<ToolResult> {
        let path = absolute(
            args["file_path"]
                .as_str()
                .context("file_path is required")?,
        )?;
        let file = open_file(&path, context)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            bail!("Read requires a regular file");
        }
        if metadata.len() > 1_000_000 {
            bail!("File too large to read safely ({} bytes)", metadata.len());
        }
        let mut bytes = Vec::new();
        file.take(1_000_001).read_to_end(&mut bytes)?;
        if bytes.len() > 1_000_000 {
            bail!("File grew beyond the Read limit");
        }
        if let Ok(format) = image::guess_format(&bytes) {
            let mime = match format {
                image::ImageFormat::Png => "image/png",
                image::ImageFormat::Jpeg => "image/jpeg",
                image::ImageFormat::Gif => "image/gif",
                image::ImageFormat::WebP => "image/webp",
                _ => bail!("Unsupported image format"),
            };
            let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(16384);
            limits.max_image_height = Some(16384);
            limits.max_alloc = Some(400 * 1024 * 1024);
            reader.limits(limits);
            let decoded = reader
                .decode()
                .context("Image could not be decoded safely")?;
            if u64::from(decoded.width()) * u64::from(decoded.height()) > 100_000_000 {
                bail!("Image exceeds the pixel limit");
            }
            return Ok(ToolResult {
                content: vec![
                    json!({"type":"text","text":format!("Image file: {} ({}x{})",path.display(),decoded.width(),decoded.height())}),
                    json!({"type":"image","mimeType":mime,"data":STANDARD.encode(&bytes)}),
                ],
                details: json!({"path":path,"mimeType":mime,"width":decoded.width(),"height":decoded.height()}),
                is_error: false,
            });
        }
        let is_skill = path
            .file_name()
            .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("skill.md"))
            && !context.scope.is_empty();
        let modified = metadata.modified()?;
        if is_skill
            && self
                .skills
                .lock()
                .unwrap()
                .iter()
                .any(|(scope, cached, len, at)| {
                    scope == &context.scope
                        && cached == &path
                        && *len == metadata.len()
                        && *at == modified
                })
        {
            return Ok(ToolResult {
                content: vec![
                    json!({"type":"text","text":format!("Skill content unchanged since it was loaded earlier in this active context: {}. Use the earlier full Read result.",path.display())}),
                ],
                details: json!({"path":path,"unchanged":true,"dedup":true}),
                is_error: false,
            });
        }
        let data = String::from_utf8_lossy(&bytes).replace("\r\n", "\n");
        let lines = data.split('\n').collect::<Vec<_>>();
        let display = stella_runtime_core::redaction::tool_text(&data, true);
        let display = display.split('\n').collect::<Vec<_>>();
        let offset = args["offset"].as_u64().unwrap_or(1).max(1) as usize;
        let limit = args["limit"].as_u64().unwrap_or(2000).min(1_000_000) as usize;
        let end = (offset - 1).saturating_add(limit).min(lines.len());
        let body = lines
            .iter()
            .enumerate()
            .skip(offset - 1)
            .take(limit)
            .map(|(i, line)| {
                let shown = display.get(i).copied().unwrap_or("");
                let shown = if shown.encode_utf16().count() > 2000 {
                    format!(
                        "{}...",
                        String::from_utf16_lossy(
                            &shown.encode_utf16().take(2000).collect::<Vec<_>>()
                        )
                    )
                } else {
                    shown.into()
                };
                format!("{:>6}#{}\t{}", i + 1, hash_line(line), shown)
            })
            .collect::<Vec<_>>()
            .join("\n");
        if is_skill
            && offset == 1
            && limit >= lines.len()
            && lines.iter().all(|line| line.encode_utf16().count() <= 2000)
        {
            let mut skills = self.skills.lock().unwrap();
            skills.retain(|(scope, cached, _, _)| scope != &context.scope || cached != &path);
            skills.push_back((
                context.scope.clone(),
                path.clone(),
                metadata.len(),
                modified,
            ));
            while skills.len() > 200 {
                skills.pop_front();
            }
        }
        Ok(ToolResult {
            content: vec![
                json!({"type":"text","text":format!("File: {}\nFile has {} lines. Showing {offset}-{end}. Each line is prefixed with a LINE#HASH anchor usable with Edit's anchor parameters.\n\n{body}",path.display(),lines.len())}),
            ],
            details: json!({"path":path}),
            is_error: false,
        })
    }
    pub fn reset_context(&self, scope: &str) {
        self.skills
            .lock()
            .unwrap()
            .retain(|(current, _, _, _)| current != scope);
    }
}
