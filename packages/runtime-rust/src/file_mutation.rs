//! Descriptor-anchored file mutation. Never truncate before the opened inode
//! passes the regular-file, link-count, path-policy and entry-identity checks.
use crate::file_tools::{FileContext, validate};
use anyhow::{Context, Result, bail};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub struct Entry {
    pub path: PathBuf,
    #[cfg(unix)]
    parent: File,
    #[cfg(unix)]
    name: std::ffi::CString,
}
impl Entry {
    pub fn locate(path: &Path, context: &FileContext, create: bool) -> Result<Self> {
        validate(path, context)?;
        let mut policy = context.clone();
        policy.workspace_root = None;
        #[cfg(unix)]
        {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::{ffi::OsStrExt, fs::OpenOptionsExt},
            };
            let (root, relative) = if let Some(root) = &context.workspace_root {
                let canonical = root.canonicalize()?;
                validate(&canonical, &policy)?;
                (canonical, path.strip_prefix(root)?.to_path_buf())
            } else {
                // Resolve existing aliases once, then pin every parent with a
                // descriptor. Missing parent components are created beneath it.
                let mut ancestor = path.to_path_buf();
                let mut suffix = Vec::new();
                while !ancestor.try_exists()? {
                    suffix.push(
                        ancestor
                            .file_name()
                            .context("Invalid file path")?
                            .to_owned(),
                    );
                    ancestor.pop();
                }
                let mut resolved = ancestor.canonicalize()?;
                for part in suffix.iter().rev() {
                    resolved.push(part);
                }
                validate(&resolved, &policy)?;
                (
                    PathBuf::from("/"),
                    resolved.strip_prefix("/")?.to_path_buf(),
                )
            };
            let parts = relative.components().collect::<Vec<_>>();
            if parts.is_empty() {
                bail!("A file path must name a file below the root");
            }
            let mut parent = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(root)?;
            for component in &parts[..parts.len() - 1] {
                let std::path::Component::Normal(part) = component else {
                    bail!("Invalid file path component");
                };
                let part = std::ffi::CString::new(part.as_bytes())?;
                let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
                let mut fd = unsafe { libc::openat(parent.as_raw_fd(), part.as_ptr(), flags) };
                if fd < 0
                    && create
                    && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
                {
                    let created =
                        unsafe { libc::mkdirat(parent.as_raw_fd(), part.as_ptr(), 0o755) };
                    if created < 0
                        && std::io::Error::last_os_error().kind()
                            != std::io::ErrorKind::AlreadyExists
                    {
                        return Err(std::io::Error::last_os_error().into());
                    }
                    fd = unsafe { libc::openat(parent.as_raw_fd(), part.as_ptr(), flags) };
                }
                if fd < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                parent = unsafe { File::from_raw_fd(fd) };
            }
            let std::path::Component::Normal(name) = parts.last().unwrap() else {
                bail!("Invalid file basename");
            };
            Ok(Self {
                path: path.into(),
                parent,
                name: std::ffi::CString::new(name.as_bytes())?,
            })
        }
        #[cfg(not(unix))]
        {
            if create {
                std::fs::create_dir_all(path.parent().context("Missing parent")?)?;
            }
            let parent = path.parent().context("Missing parent")?.canonicalize()?;
            validate(&parent, &policy)?;
            if let Some(root) = &context.workspace_root {
                if !parent.starts_with(root.canonicalize()?) {
                    bail!("Path escapes the workspace");
                }
                let mut prefix = root.clone();
                for component in path.strip_prefix(root)?.components() {
                    prefix.push(component);
                    if let Ok(meta) = std::fs::symlink_metadata(&prefix) {
                        if meta.is_symlink() {
                            bail!("Symbolic links are not permitted in scoped file paths");
                        }
                    }
                }
            }
            Ok(Self {
                path: parent.join(path.file_name().context("Missing filename")?),
            })
        }
    }
    pub fn open(&self, write: bool, create: bool) -> Result<File> {
        #[cfg(unix)]
        let file = {
            use std::os::fd::{AsRawFd, FromRawFd};
            let flags = (if write { libc::O_RDWR } else { libc::O_RDONLY })
                | libc::O_NOFOLLOW
                | libc::O_NONBLOCK
                | libc::O_CLOEXEC
                | if create {
                    libc::O_CREAT | libc::O_EXCL
                } else {
                    0
                };
            let fd =
                unsafe { libc::openat(self.parent.as_raw_fd(), self.name.as_ptr(), flags, 0o666) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            unsafe { File::from_raw_fd(fd) }
        };
        #[cfg(not(unix))]
        let file = OpenOptions::new()
            .read(true)
            .write(write)
            .create_new(create)
            .open(&self.path)?;
        self.check(&file)?;
        Ok(file)
    }
    pub fn check(&self, file: &File) -> Result<()> {
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            bail!("File operation requires a regular file");
        }
        #[cfg(unix)]
        {
            use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            let result = unsafe {
                libc::fstatat(
                    self.parent.as_raw_fd(),
                    self.name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            };
            if result < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let stat = unsafe { stat.assume_init() };
            if metadata.nlink() != 1
                || stat.st_nlink != 1
                || metadata.dev() != stat.st_dev
                || metadata.ino() != stat.st_ino
                || stat.st_mode & libc::S_IFMT != libc::S_IFREG
            {
                bail!("File changed or is not a singly linked regular file");
            }
        }
        #[cfg(not(unix))]
        {
            let entry = std::fs::symlink_metadata(&self.path)?;
            if !entry.is_file() || entry.is_symlink() {
                bail!("File entry changed or is a symbolic link");
            }
        }
        Ok(())
    }
    pub fn write(&self, file: &mut File, bytes: &[u8]) -> Result<()> {
        self.check(file)?;
        file.seek(SeekFrom::Start(0))?;
        file.set_len(0)?;
        file.write_all(bytes)?;
        file.set_len(bytes.len() as u64)?;
        file.sync_data()?;
        file.seek(SeekFrom::Start(0))?;
        let mut actual = Vec::new();
        file.take(bytes.len() as u64 + 1).read_to_end(&mut actual)?;
        if actual != bytes {
            bail!("Write verification failed: file bytes differ from intent");
        }
        self.check(file)?;
        Ok(())
    }
    pub fn delete(&self, file: &File) -> Result<()> {
        self.check(file)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), 0) } < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        #[cfg(not(unix))]
        std::fs::remove_file(&self.path)?;
        Ok(())
    }
}

pub fn read_text(file: &mut File) -> Result<String> {
    if file.metadata()?.len() > 1_000_000 {
        bail!("File exceeds the 1,000,000 byte editing limit");
    }
    let mut bytes = Vec::new();
    file.take(1_000_001).read_to_end(&mut bytes)?;
    if bytes.len() > 1_000_000 {
        bail!("File grew beyond the editing limit");
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
