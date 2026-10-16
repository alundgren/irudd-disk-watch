//! Native Unix observation and cleanup for owner-controlled, quiescent trees.
use crate::worker::{self, Control, emit, hash, safe, string};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use std::ffi::{CStr, CString, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::{
    ffi::{OsStrExt, OsStringExt},
    fs::{MetadataExt, OpenOptionsExt},
};
use std::path::{Path, PathBuf};
use std::time::Instant;

#[cfg(target_os = "macos")]
mod macos_bulk;
#[cfg(target_os = "macos")]
mod macos_events;
#[cfg(target_os = "macos")]
mod macos_incremental;

#[derive(Debug)]
pub(crate) struct NativeError {
    message: String,
    code: Option<i32>,
}
impl From<std::io::Error> for NativeError {
    fn from(e: std::io::Error) -> Self {
        Self {
            message: e.to_string(),
            code: e.raw_os_error(),
        }
    }
}
impl From<serde_json::Error> for NativeError {
    fn from(e: serde_json::Error) -> Self {
        Self {
            message: e.to_string(),
            code: None,
        }
    }
}
impl From<String> for NativeError {
    fn from(message: String) -> Self {
        Self {
            message,
            code: None,
        }
    }
}
impl From<&str> for NativeError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(f)
    }
}
impl From<NativeError> for String {
    fn from(e: NativeError) -> Self {
        e.message
    }
}
type Result<T> = std::result::Result<T, NativeError>;
fn ioerr() -> NativeError {
    std::io::Error::last_os_error().into()
}

fn cstr(bytes: &[u8]) -> Result<CString> {
    CString::new(bytes).map_err(|_| NativeError::from("NUL in native path"))
}
fn open_at(parent: &File, name: &[u8], directory: bool) -> Result<File> {
    let name = cstr(name)?;
    #[cfg(target_os = "linux")]
    let observation_mode = libc::O_PATH;
    #[cfg(target_os = "macos")]
    let observation_mode = libc::O_EVTONLY;
    let flags = (if directory {
        libc::O_RDONLY
    } else {
        observation_mode
    }) | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        Err(ioerr())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
fn open_root(path: &Path) -> Result<File> {
    let mut file = File::open("/").map_err(NativeError::from)?;
    for part in path.components() {
        match part {
            std::path::Component::RootDir => (),
            std::path::Component::Normal(s) => file = open_at(&file, s.as_bytes(), true)?,
            _ => return Err("Root must be an absolute canonical path".into()),
        }
    }
    Ok(file)
}
fn stat_at(parent: &File, name: &[u8]) -> Result<libc::stat> {
    let mut stat = std::mem::MaybeUninit::uninit();
    let name = cstr(name)?;
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(ioerr());
    }
    Ok(unsafe { stat.assume_init() })
}
fn names(dir: &File) -> Result<Vec<Vec<u8>>> {
    // A new descriptor avoids sharing a directory stream offset with a prior walk.
    let fresh = open_at(dir, b".", true)?;
    use std::os::fd::IntoRawFd;
    let fd = fresh.into_raw_fd();
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(ioerr());
    }
    let mut result = Vec::new();
    loop {
        #[cfg(target_os = "linux")]
        unsafe {
            *libc::__errno_location() = 0;
        }
        #[cfg(target_os = "macos")]
        unsafe {
            *libc::__error() = 0;
        }
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::closedir(stream);
            }
            if error.raw_os_error().unwrap_or(0) != 0 {
                return Err(error.into());
            }
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            result.push(name.to_vec());
        }
    }
    Ok(result)
}
fn decode(text: &str) -> Result<Vec<u8>> {
    let bytes = B64
        .decode(text)
        .map_err(|_| NativeError::from("Invalid base64"))?;
    if B64.encode(&bytes) != text {
        return Err("Noncanonical base64".into());
    }
    Ok(bytes)
}
fn components(value: &Value) -> Result<Vec<Vec<u8>>> {
    let parts = value.as_array().ok_or("Expected component array")?;
    if parts.len() > 512 {
        return Err("Path depth exceeds 512".into());
    }
    parts
        .iter()
        .map(|v| {
            let bytes = decode(v.as_str().ok_or("Expected encoded component")?)?;
            if bytes.is_empty()
                || bytes == b"."
                || bytes == b".."
                || bytes.contains(&0)
                || bytes.contains(&b'/')
            {
                return Err("Invalid native component".into());
            }
            Ok(bytes)
        })
        .collect()
}
fn encoded(parts: &[Vec<u8>]) -> Value {
    json!(parts.iter().map(|p| B64.encode(p)).collect::<Vec<_>>())
}
pub fn label(bytes: &[u8]) -> String {
    let mut text = String::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                escape(s, &mut text);
                break;
            }
            Err(e) => {
                escape(
                    std::str::from_utf8(&rest[..e.valid_up_to()]).unwrap(),
                    &mut text,
                );
                let n = e.error_len().unwrap_or(rest.len() - e.valid_up_to());
                for b in &rest[e.valid_up_to()..e.valid_up_to() + n] {
                    text.push_str(&format!("\\x{b:02x}"));
                }
                rest = &rest[e.valid_up_to() + n..];
            }
        }
    }
    text
}
fn escape(s: &str, out: &mut String) {
    use unicode_general_category::{GeneralCategory, get_general_category};
    for ch in s.chars() {
        if ch == '\\' {
            out.push_str("\\\\");
        } else if matches!(
            get_general_category(ch),
            GeneralCategory::Control
                | GeneralCategory::Format
                | GeneralCategory::LineSeparator
                | GeneralCategory::ParagraphSeparator
        ) {
            let mut bytes = [0; 4];
            for byte in ch.encode_utf8(&mut bytes).as_bytes() {
                out.push_str(&format!("\\x{byte:02x}"));
            }
        } else {
            out.push(ch);
        }
    }
}

fn path_of(root: &Path, parts: &[Vec<u8>]) -> PathBuf {
    let mut p = root.to_owned();
    for part in parts {
        p.push(OsString::from_vec(part.clone()));
    }
    p
}
fn display(root: &Path, parts: &[Vec<u8>]) -> String {
    label(path_of(root, parts).as_os_str().as_bytes())
}
fn mount(file: &File) -> Result<String> {
    #[cfg(target_os = "linux")]
    {
        let info = fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))
            .map_err(NativeError::from)?;
        info.lines()
            .find_map(|s| s.strip_prefix("mnt_id:").map(str::trim))
            .map(str::to_owned)
            .ok_or("Kernel mount identity unavailable".into())
    }
    #[cfg(target_os = "macos")]
    {
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return Err(ioerr());
        }
        let stat = unsafe { stat.assume_init() };
        let bytes = unsafe {
            std::slice::from_raw_parts(
                (&stat.f_fsid as *const libc::fsid_t).cast::<u8>(),
                std::mem::size_of::<libc::fsid_t>(),
            )
        };
        Ok(u64::from_ne_bytes(
            bytes
                .try_into()
                .map_err(|_| "Unexpected filesystem identifier")?,
        )
        .to_string())
    }
}
fn identity(file: &File) -> Result<Value> {
    let m = file.metadata().map_err(NativeError::from)?;
    Ok(json!({"device":m.dev().to_string(),"inode":m.ino().to_string(),"mount":mount(file)?}))
}
fn leaf_identity(stat: &libc::stat, mount: &str) -> Value {
    json!({"device":stat.st_dev.to_string(),"inode":stat.st_ino.to_string(),"mount":mount})
}
fn stat_matches(stat: &libc::stat, file: &File) -> Result<bool> {
    let m = file.metadata().map_err(NativeError::from)?;
    Ok(stat.st_dev as u64 == m.dev() && stat.st_ino as u64 == m.ino())
}
fn root_path(root: &Value) -> Result<PathBuf> {
    let bytes = decode(string(root, "pathBytes")?)?;
    if bytes.contains(&0) {
        return Err("NUL in root".into());
    }
    let path = PathBuf::from(OsString::from_vec(bytes));
    if !path.is_absolute() {
        return Err("Relative root".into());
    }
    Ok(path)
}
fn inspect(path: &Path) -> Result<(File, Value)> {
    let file = open_root(path)?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(ioerr());
    }
    let stat = unsafe { stat.assume_init() };
    #[cfg(target_os = "macos")]
    let filesystem = unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    #[cfg(target_os = "linux")]
    let filesystem = format!("linux:{:x}", stat.f_type);
    #[cfg(target_os = "macos")]
    let read_only = stat.f_flags & libc::MNT_RDONLY as u32 != 0;
    #[cfg(target_os = "linux")]
    let read_only = {
        let mut v = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::fstatvfs(file.as_raw_fd(), v.as_mut_ptr()) } != 0 {
            return Err(ioerr());
        }
        unsafe { v.assume_init() }.f_flag & libc::ST_RDONLY != 0
    };
    let block = u64::try_from(stat.f_bsize).map_err(|_| "Invalid block size")?;
    let total = safe(
        (stat.f_blocks as u64)
            .checked_mul(block)
            .ok_or("Capacity overflow")?,
    )?;
    let free = safe(
        (stat.f_bavail as u64)
            .checked_mul(block)
            .ok_or("Capacity overflow")?,
    )?;
    let root = json!({"path":label(path.as_os_str().as_bytes()),"pathBytes":B64.encode(path.as_os_str().as_bytes()),"identity":identity(&file)?,"filesystem":filesystem,"capacity":{"total":total,"free":free},"observedAt":crate::tree::now_ms(),"readOnly":read_only});
    Ok((file, root))
}
fn checked_root(root: &Value) -> Result<(PathBuf, File, Value)> {
    let path = root_path(root)?;
    let (file, live) = inspect(&path)?;
    if root["identity"] != live["identity"] || root["filesystem"] != live["filesystem"] {
        return Err("Tracked root or mount changed".into());
    }
    Ok((path, file, live))
}
fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(NativeError::from)?;
    }
    let meta = fs::symlink_metadata(path).map_err(NativeError::from)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err("Worker state must be an owner-only directory".into());
    }
    Ok(())
}
use std::os::unix::fs::DirBuilderExt;
fn state_file(path: &Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(NativeError::from)
}
fn lock(_state: &Path, wait: bool) -> Result<File> {
    let path = PathBuf::from(format!("/tmp/disk-watch-delete-{}.lock", unsafe {
        libc::geteuid()
    }));
    let file = state_file(&path)?;
    let meta = file.metadata().map_err(NativeError::from)?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
    {
        return Err("Account cleanup lock is not an owner-only regular file".into());
    }
    if unsafe {
        libc::flock(
            file.as_raw_fd(),
            libc::LOCK_EX | if wait { 0 } else { libc::LOCK_NB },
        )
    } != 0
    {
        return Err("Another cleanup operation is active".into());
    }
    let live = fs::symlink_metadata(&path).map_err(NativeError::from)?;
    if live.dev() != meta.dev() || live.ino() != meta.ino() {
        return Err("Account cleanup lock was replaced".into());
    }
    Ok(file)
}

fn durable(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(NativeError::from)?;
    if bytes.len() > worker::MAX_FRAME {
        return Err("State record exceeds protocol frame limit".into());
    }
    let parent = path.parent().ok_or("No state parent")?;
    let temp = parent.join(format!(
        ".write-{}-{}",
        std::process::id(),
        crate::tree::now_ms()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(NativeError::from)?;
    let result = (|| {
        file.write_all(&bytes).map_err(NativeError::from)?;
        file.sync_all().map_err(NativeError::from)?;
        fs::rename(&temp, path).map_err(NativeError::from)?;
        File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(NativeError::from)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn read_json(path: &Path) -> Result<Option<Value>> {
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    file.take((worker::MAX_FRAME + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(NativeError::from)?;
    if bytes.len() > worker::MAX_FRAME {
        return Err("State record exceeds limit".into());
    }
    Ok(Some(
        serde_json::from_slice(&bytes).map_err(NativeError::from)?,
    ))
}
pub fn worker_identity(state: &Path) -> Result<Value> {
    private_dir(state)?;
    let identity_lock = state_file(&state.join("identity.lock"))?;
    if unsafe { libc::flock(identity_lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(ioerr());
    }
    let path = state.join("installation.json");
    let id = if let Some(v) = read_json(&path)? {
        string(&v, "id")?.to_owned()
    } else {
        let mut random = [0u8; 32];
        File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut random))
            .map_err(NativeError::from)?;
        let id = hash(&random);
        durable(&path, &json!({"id":id}))?;
        id
    };
    Ok(
        json!({"id":id,"account":unsafe { libc::geteuid() }.to_string(),"os":std::env::consts::OS,"version":1,"capabilities":{"scan":true,"delete":true}}),
    )
}

#[cfg(target_os = "macos")]
fn mac_stat_observation(
    current: &libc::stat,
    mount: &str,
    started: u64,
) -> Result<(Value, crate::tree::Times, u64)> {
    let millis = |seconds: i64, nanos: i64| -> Option<u64> {
        let seconds = u64::try_from(seconds).ok()?;
        let nanos = u64::try_from(nanos).ok()?;
        seconds
            .checked_mul(1000)?
            .checked_add(nanos / 1_000_000)
            .filter(|v| *v <= worker::MAX_SAFE)
    };
    let times = crate::tree::Times::capture(
        millis(current.st_birthtime, current.st_birthtime_nsec),
        millis(current.st_mtime, current.st_mtime_nsec),
        started,
    );
    let size = safe(u64::try_from(current.st_size).map_err(|_| "Invalid native file length")?)?;
    Ok((leaf_identity(current, mount), times, size))
}

fn regular_observation(
    parent: &File,
    name: &[u8],
    stat: &libc::stat,
    started: u64,
) -> Result<(Value, crate::tree::Times, u64)> {
    #[cfg(target_os = "linux")]
    {
        let file = open_at(parent, name, false)?;
        if !stat_matches(stat, &file)? {
            return Err("File changed during observation".into());
        }
        let meta = file.metadata().map_err(NativeError::from)?;
        Ok((
            identity(&file)?,
            crate::tree::Times::from_metadata(&meta, started),
            safe(meta.len())?,
        ))
    }
    #[cfg(target_os = "macos")]
    {
        let name = cstr(name)?;
        let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
        attrs.bitmapcount = 5;
        attrs.commonattr = libc::ATTR_CMN_FSID;
        let mut buffer = [0u32; 3];
        if unsafe {
            libc::getattrlistat(
                parent.as_raw_fd(),
                name.as_ptr(),
                (&mut attrs as *mut libc::attrlist).cast(),
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(&buffer),
                (libc::FSOPT_NOFOLLOW | libc::FSOPT_RETURN_REALDEV) as _,
            )
        } != 0
        {
            return Err(ioerr());
        }
        if buffer[0] as usize != std::mem::size_of_val(&buffer) {
            return Err("Unexpected native filesystem attribute length".into());
        }
        let mut fsid = [0u8; 8];
        fsid[..4].copy_from_slice(&buffer[1].to_ne_bytes());
        fsid[4..].copy_from_slice(&buffer[2].to_ne_bytes());
        let mount = u64::from_ne_bytes(fsid).to_string();
        let current = stat_at(parent, name.to_bytes())?;
        if current.st_dev != stat.st_dev
            || current.st_ino != stat.st_ino
            || current.st_mode & libc::S_IFMT != libc::S_IFREG
        {
            return Err("File changed during observation".into());
        }
        mac_stat_observation(&current, &mount, started)
    }
}

struct ScanEntry {
    name: Vec<u8>,
    #[cfg(target_os = "macos")]
    metadata: Option<macos_bulk::Metadata>,
}

enum ScanEntries<'a> {
    Names(std::vec::IntoIter<Vec<u8>>, &'a Control),
    #[cfg(target_os = "macos")]
    Bulk(macos_bulk::Entries<'a>),
}

impl Iterator for ScanEntries<'_> {
    type Item = Result<ScanEntry>;
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Names(names, control) => names.next().map(|name| {
                control.check()?;
                Ok(ScanEntry {
                    name,
                    #[cfg(target_os = "macos")]
                    metadata: None,
                })
            }),
            #[cfg(target_os = "macos")]
            Self::Bulk(entries) => entries.next(),
        }
    }
}

fn scan_entries<'a>(dir: &File, control: &'a Control) -> Result<ScanEntries<'a>> {
    control.check()?;
    #[cfg(target_os = "macos")]
    if let Some(entries) = macos_bulk::Entries::open(dir, control)? {
        return Ok(ScanEntries::Bulk(entries));
    }
    Ok(ScanEntries::Names(names(dir)?.into_iter(), control))
}

#[cfg_attr(target_os = "macos", derive(serde::Serialize, serde::Deserialize))]
struct Node {
    is_dir: bool,
    name: Vec<u8>,
    identity: Value,
    times: crate::tree::Times,
    size: u64,
    files: u64,
    rest_size: u64,
    rest_files: u64,
    #[cfg_attr(target_os = "macos", serde(skip))]
    dirs: Vec<Node>,
    big: Vec<Node>,
    #[cfg(target_os = "macos")]
    stats: macos_incremental::Counts,
}
struct Scan<'a> {
    control: &'a Control,
    root: &'a Path,
    mount: String,
    device: u64,
    excludes: Vec<Vec<Vec<u8>>>,
    min: u64,
    errors: u64,
    symlinks: u64,
    special: u64,
    mounts: u64,
    samples: Vec<(String, String)>,
    dirs: u64,
    count: u64,
    bytes: u64,
    last_progress: Instant,
    started: u64,
    #[cfg(target_os = "macos")]
    dirty: Option<macos_events::Dirty>,
    #[cfg(target_os = "macos")]
    uncached_entries: u64,
    #[cfg(target_os = "macos")]
    reused_dirs: u64,
}
impl Scan<'_> {
    #[cfg(target_os = "macos")]
    fn reset_capture(&mut self) {
        self.errors = 0;
        self.symlinks = 0;
        self.special = 0;
        self.mounts = 0;
        self.dirs = 0;
        self.count = 0;
        self.bytes = 0;
        self.uncached_entries = 0;
        self.reused_dirs = 0;
        self.samples.clear();
    }

    fn error(&mut self, parts: &[Vec<u8>], message: NativeError) {
        self.errors += 1;
        if self.samples.len() < 500 {
            self.samples
                .push((display(self.root, parts), message.to_string()));
        }
    }
    #[cfg(any(target_os = "macos", test))]
    fn directory(&mut self, dir: &File, name: Vec<u8>, parts: &mut Vec<Vec<u8>>) -> Result<Node> {
        self.directory_cached(dir, name, parts, None)
    }
    fn directory_cached(
        &mut self,
        dir: &File,
        name: Vec<u8>,
        parts: &mut Vec<Vec<u8>>,
        previous: Option<Node>,
    ) -> Result<Node> {
        self.control.check()?;
        #[cfg(target_os = "macos")]
        let before = macos_incremental::Counts::capture(self);
        #[cfg(target_os = "macos")]
        if let Some(node) = &previous {
            if node.stats.errors == 0
                && node.stats.uncached_entries == 0
                && self
                    .dirty
                    .as_ref()
                    .is_some_and(|dirty| !dirty.affects(parts))
                && identity(dir)? == node.identity
            {
                node.stats.restore(self, node);
                return Ok(previous.unwrap());
            }
        }
        let result = self.read_directory(dir, name, parts, previous);
        #[cfg(target_os = "macos")]
        let result = result.map(|mut node| {
            node.stats = macos_incremental::Counts::capture(self).difference(before);
            node
        });
        result
    }
    fn read_directory(
        &mut self,
        dir: &File,
        name: Vec<u8>,
        parts: &mut Vec<Vec<u8>>,
        previous: Option<Node>,
    ) -> Result<Node> {
        let mut previous: std::collections::HashMap<Vec<u8>, Node> = previous
            .map(|node| {
                node.dirs
                    .into_iter()
                    .map(|child| (child.name.clone(), child))
                    .collect()
            })
            .unwrap_or_default();
        if parts.len() > 512 {
            return Err("Directory nesting exceeds 512".into());
        }
        let meta = dir.metadata().map_err(NativeError::from)?;
        #[cfg(target_os = "macos")]
        {
            let future = |time: std::io::Result<std::time::SystemTime>| {
                time.ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .is_some_and(|time| time.as_millis() > self.started as u128)
            };
            if future(meta.created()) || future(meta.modified()) {
                self.uncached_entries += 1;
            }
        }
        let mut node = Node {
            is_dir: true,
            name,
            identity: identity(dir)?,
            times: crate::tree::Times::from_metadata(&meta, self.started),
            size: 0,
            files: 0,
            rest_size: 0,
            rest_files: 0,
            dirs: Vec::new(),
            big: Vec::new(),
            #[cfg(target_os = "macos")]
            stats: macos_incremental::Counts::default(),
        };
        self.dirs += 1;
        let entries = match scan_entries(dir, self.control) {
            Ok(v) => v,
            Err(e) if parts.is_empty() => return Err(e),
            Err(e) => {
                self.error(parts, e);
                return Ok(node);
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    self.control.check()?;
                    if parts.is_empty() {
                        return Err(error);
                    }
                    self.error(parts, error);
                    break;
                }
            };
            let name = entry.name;
            self.control.check()?;
            parts.push(name.clone());
            if self.excludes.iter().any(|e| parts.starts_with(e)) {
                parts.pop();
                continue;
            }
            let result = (|| -> Result<Option<Node>> {
                let stat = stat_at(dir, &name)?;
                let kind = stat.st_mode & libc::S_IFMT;
                if kind == libc::S_IFLNK {
                    self.symlinks += 1;
                    return Ok(None);
                }
                if kind != libc::S_IFREG && kind != libc::S_IFDIR {
                    self.special += 1;
                    return Ok(None);
                }
                if stat.st_dev as u64 != self.device {
                    self.mounts += 1;
                    return Ok(None);
                }
                if kind == libc::S_IFDIR {
                    let file = open_at(dir, &name, true)?;
                    if !stat_matches(&stat, &file)? {
                        return Err("Entry identity changed".into());
                    }
                    if mount(&file)? != self.mount {
                        self.mounts += 1;
                        return Ok(None);
                    }
                    return self
                        .directory_cached(&file, name.clone(), parts, previous.remove(&name))
                        .map(Some);
                }
                #[cfg(target_os = "macos")]
                {
                    let future = |seconds: i64, nanos: i64| {
                        seconds >= 0
                            && seconds as u128 * 1000 + nanos.max(0) as u128 / 1_000_000
                                > self.started as u128
                    };
                    if stat.st_nlink > 1
                        || future(stat.st_mtime, stat.st_mtime_nsec)
                        || future(stat.st_birthtime, stat.st_birthtime_nsec)
                    {
                        self.uncached_entries += 1;
                    }
                }
                #[cfg(target_os = "macos")]
                let observed = if let Some(metadata) = entry.metadata {
                    if !metadata.matches_regular(&stat) {
                        return Err("File changed during bulk observation".into());
                    }
                    mac_stat_observation(&stat, &metadata.mount.to_string(), self.started)
                } else {
                    regular_observation(dir, &name, &stat, self.started)
                };
                #[cfg(target_os = "linux")]
                let observed = regular_observation(dir, &name, &stat, self.started);
                let (observation, times, size) = observed?;
                if observation["mount"] != self.mount {
                    self.mounts += 1;
                    return Ok(None);
                }
                self.count = safe(self.count + 1)?;
                self.bytes = safe(self.bytes.checked_add(size).ok_or("Byte total overflow")?)?;
                Ok(Some(Node {
                    is_dir: false,
                    name: name.clone(),
                    identity: observation,
                    times,
                    size,
                    files: 1,
                    rest_size: 0,
                    rest_files: 0,
                    dirs: Vec::new(),
                    big: Vec::new(),
                    #[cfg(target_os = "macos")]
                    stats: macos_incremental::Counts::default(),
                }))
            })();
            match result {
                Ok(Some(child)) => {
                    node.size = safe(
                        node.size
                            .checked_add(child.size)
                            .ok_or("Byte total overflow")?,
                    )?;
                    node.files = safe(node.files + child.files)?;
                    node.times.last_written_at =
                        node.times.last_written_at.max(child.times.last_written_at);
                    // Directories have a native directory identity, regardless of their totals.
                    let is_dir = child.is_dir;
                    if is_dir {
                        node.dirs.push(child)
                    } else if child.size >= self.min {
                        node.big.push(child)
                    } else {
                        node.rest_size += child.size;
                        node.rest_files += 1;
                    }
                }
                Ok(None) => (),
                Err(e) => {
                    self.control.check()?;
                    self.error(parts, e);
                }
            }
            parts.pop();
            if self.last_progress.elapsed().as_millis() >= 250 {
                emit(
                    &json!({"t":"progress","files":self.count,"dirs":self.dirs,"bytes":self.bytes}),
                )?;
                self.last_progress = Instant::now();
            }
        }
        Ok(node)
    }
}
fn emit_node(node: &Node, parent: Option<u64>, next: &mut u64, control: &Control) -> Result<()> {
    control.check()?;
    let id = *next;
    *next += 1;
    let mut record = json!({"t":"dir","id":id,"parent":parent,"name":label(&node.name),"identity":node.identity,"size":node.size,"files":node.files,"createdAt":node.times.created_at,"lastWrittenAt":node.times.last_written_at});
    if parent.is_some() {
        record["nameBytes"] = json!(B64.encode(&node.name));
    }
    emit(&record)?;
    for f in &node.big {
        control.check()?;
        emit(
            &json!({"t":"file","parent":id,"name":label(&f.name),"nameBytes":B64.encode(&f.name),"identity":f.identity,"size":f.size,"createdAt":f.times.created_at,"lastWrittenAt":f.times.last_written_at}),
        )?;
    }
    if node.rest_files > 0 {
        emit(&json!({"t":"rest","parent":id,"size":node.rest_size,"files":node.rest_files}))?;
    }
    for child in &node.dirs {
        emit_node(child, Some(id), next, control)?;
    }
    Ok(())
}
fn scan(state: &Path, request: &Value, control: &Control) -> Result<()> {
    let started = Instant::now();
    let (path, file, root) = checked_root(&request["root"])?;
    let min = request["minFileSize"]
        .as_u64()
        .ok_or("Invalid minFileSize")?;
    safe(min)?;
    let excludes = request["excludes"]
        .as_array()
        .ok_or("Expected excludes array")?
        .iter()
        .map(components)
        .collect::<Result<Vec<_>>>()?;
    if excludes.iter().any(Vec::is_empty) {
        return Err("Cannot exclude the tracked root".into());
    }
    let mut scan = Scan {
        control,
        root: &path,
        mount: mount(&file)?,
        device: file.metadata().map_err(NativeError::from)?.dev(),
        excludes,
        min,
        errors: 0,
        symlinks: 0,
        special: 0,
        mounts: 0,
        samples: Vec::new(),
        dirs: 0,
        count: 0,
        bytes: 0,
        last_progress: Instant::now(),
        started: crate::tree::now_ms(),
        #[cfg(target_os = "macos")]
        dirty: None,
        #[cfg(target_os = "macos")]
        uncached_entries: 0,
        #[cfg(target_os = "macos")]
        reused_dirs: 0,
    };
    emit(&json!({"t":"root","root":root}))?;
    #[cfg(not(target_os = "macos"))]
    let _ = state;
    #[cfg(target_os = "macos")]
    let mut session = None;
    #[cfg(target_os = "macos")]
    let mut fallback: Option<String> = None;
    #[cfg(not(target_os = "macos"))]
    let fallback: Option<String> = None;
    #[cfg(target_os = "macos")]
    if request["incremental"] == true {
        match macos_incremental::Session::prepare(state, request, &file, control) {
            Ok(prepared) => {
                fallback = prepared.fallback.clone();
                session = Some(prepared);
            }
            Err(reason) => {
                control.check()?;
                fallback = Some(reason.to_string());
            }
        }
    }
    #[cfg(target_os = "macos")]
    let previous = session.as_mut().and_then(|session| {
        scan.dirty = Some(session.dirty.clone());
        session.previous.take()
    });
    #[cfg(not(target_os = "macos"))]
    let previous = None;
    let tree = scan.directory_cached(
        &file,
        path.file_name()
            .map(|s| s.as_bytes().to_vec())
            .unwrap_or_else(|| b"/".to_vec()),
        &mut Vec::new(),
        previous,
    )?;
    #[cfg(target_os = "macos")]
    let mut tree = tree;
    #[cfg(target_os = "macos")]
    if let Some(prepared) = &session {
        let mut cacheable = true;
        match prepared.changes(control) {
            Ok(dirty) if dirty.is_empty() => (),
            Ok(dirty) if scan.reused_dirs > 0 => {
                // Changes to previously reused folders must be observed before publishing this tree.
                scan.reset_capture();
                scan.dirty = Some(dirty);
                let name = tree.name.clone();
                tree = scan.directory_cached(&file, name, &mut Vec::new(), Some(tree))?;
                if prepared
                    .changes(control)
                    .map_or(true, |dirty| !dirty.is_empty())
                {
                    scan.reset_capture();
                    scan.dirty = None;
                    fallback = Some("Full scan used because folders kept changing".into());
                    cacheable = false;
                    tree = scan.directory(&file, tree.name.clone(), &mut Vec::new())?;
                }
            }
            Ok(_) => (), // A full baseline keeps its pre-scan checkpoint, so these edits replay next time.
            Err(reason) => {
                cacheable = false;
                fallback = Some(reason.to_string());
                if scan.reused_dirs > 0 {
                    scan.reset_capture();
                    scan.dirty = None;
                    tree = scan.directory(&file, tree.name.clone(), &mut Vec::new())?;
                }
            }
        }
        checked_root(&request["root"])?;
        if cacheable {
            if let Err(reason) = prepared.save(&tree, control) {
                control.check()?;
                fallback = Some(format!("Quick-scan baseline was not saved: {reason}"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    let method = if scan.reused_dirs > 0 {
        "incremental"
    } else {
        "walk"
    };
    #[cfg(not(target_os = "macos"))]
    let method = "walk";
    checked_root(&request["root"])?;
    control.check()?;
    emit_node(&tree, None, &mut 1, control)?;
    for (path, message) in &scan.samples {
        emit(&json!({"t":"error","path":path,"message":message}))?;
    }
    emit(
        &json!({"t":"done","size":tree.size,"files":tree.files,"dirs":scan.dirs,"errors":scan.errors,"ms":started.elapsed().as_millis() as u64,"method":method,"fallback":fallback,"policy":"regular-files-single-mount-no-symlink-traversal","skipped":{"symlinks":scan.symlinks,"special":scan.special,"mounts":scan.mounts},"coverage":if scan.errors==0 {"complete"} else {"partial"}}),
    ).map_err(NativeError::from)
}
#[cfg(target_os = "macos")]
fn actual_component(parent: &File, name: &[u8]) -> Result<Vec<u8>> {
    let name = cstr(name)?;
    let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
    attrs.bitmapcount = 5;
    attrs.commonattr = libc::ATTR_CMN_NAME;
    let mut buffer = [0u32; 1024];
    if unsafe {
        libc::getattrlistat(
            parent.as_raw_fd(),
            name.as_ptr(),
            (&mut attrs as *mut libc::attrlist).cast(),
            buffer.as_mut_ptr().cast(),
            std::mem::size_of_val(&buffer),
            libc::FSOPT_NOFOLLOW as _,
        )
    } != 0
    {
        return Err(ioerr());
    }
    let start = 4i64
        .checked_add(buffer[1] as i32 as i64)
        .ok_or("Invalid native name offset")?;
    let length = buffer[2] as usize;
    if start < 12
        || length < 2
        || start as usize + length > buffer[0] as usize
        || buffer[0] as usize > std::mem::size_of_val(&buffer)
    {
        return Err("Invalid native name attribute".into());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>().add(start as usize), length)
    };
    if bytes[length - 1] != 0
        || bytes[..length - 1].contains(&0)
        || bytes[..length - 1].contains(&b'/')
    {
        return Err("Invalid native name bytes".into());
    }
    Ok(bytes[..length - 1].to_vec())
}
#[cfg(target_os = "linux")]
fn actual_component(_parent: &File, name: &[u8]) -> Result<Vec<u8>> {
    Ok(name.to_vec())
}
fn resolved(request: &Value) -> Result<Value> {
    let (root_path, root, _) = checked_root(&request["root"])?;
    let parts = if request.get("components").is_some() {
        components(&request["components"])?
    } else {
        let typed = Path::new(string(request, "path")?);
        let path = if typed.is_absolute() {
            typed.to_owned()
        } else {
            root_path.join(typed)
        };
        let relative = path
            .strip_prefix(&root_path)
            .map_err(|_| "Path is outside the tracked root")?;
        let mut parts = Vec::new();
        for part in relative.components() {
            match part {
                std::path::Component::Normal(s) => parts.push(s.as_bytes().to_vec()),
                _ => return Err("Input cannot contain relative traversal".into()),
            }
        }
        parts
    };
    let typed = request.get("components").is_none();
    let mut canonical_parts = parts.clone();
    let mut current = root;
    let root_mount = mount(&current)?;
    for (i, name) in parts.iter().enumerate() {
        let stat = stat_at(&current, name)?;
        let kind = stat.st_mode & libc::S_IFMT;
        if typed {
            canonical_parts[i] = actual_component(&current, name)?;
            let actual = stat_at(&current, &canonical_parts[i])?;
            if actual.st_ino != stat.st_ino || actual.st_dev != stat.st_dev {
                return Err("Input name changed during resolution".into());
            }
        }
        if kind == libc::S_IFREG && i + 1 == parts.len() {
            let (observation, _, _) =
                regular_observation(&current, name, &stat, crate::tree::now_ms())?;
            if observation["mount"] != root_mount {
                return Err("Unexpected file mount".into());
            }
            return Ok(
                json!({"path":display(&root_path,&canonical_parts),"components":encoded(&canonical_parts),"kind":"file","identity":observation}),
            );
        }
        if kind != libc::S_IFDIR {
            return Err("Only directories may contain resolved targets".into());
        }
        let child = open_at(&current, name, true)?;
        if !stat_matches(&stat, &child)? || mount(&child)? != root_mount {
            return Err("Entry or mount changed".into());
        }
        current = child;
    }
    Ok(
        json!({"path":display(&root_path,&canonical_parts),"components":encoded(&canonical_parts),"kind":if current.metadata().map_err(|e|e.to_string())?.is_dir(){"dir"}else{"file"},"identity":identity(&current)?}),
    )
}
fn policy_file(state: &Path, root: &Value) -> PathBuf {
    state.join(format!(
        "cleanup-{}.json",
        hash(
            &serde_json::to_vec(
                &json!({"pathBytes":root["pathBytes"],"identity":root["identity"]})
            )
            .unwrap()
        )
    ))
}
#[cfg(target_os = "macos")]
fn reject_extended_acl(file: &File) -> Result<()> {
    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
        fn acl_valid(acl: *mut libc::c_void) -> libc::c_int;
        fn acl_get_entry(
            acl: *mut libc::c_void,
            id: libc::c_int,
            entry: *mut *mut libc::c_void,
        ) -> libc::c_int;
        fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
    }
    let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), 0x100) };
    if acl.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOENT) {
            return Ok(());
        }
        return Err(error.into());
    }
    let result = (|| {
        if unsafe { acl_valid(acl) } != 0 {
            return Err(ioerr());
        }
        let mut entry = std::ptr::null_mut();
        if unsafe { acl_get_entry(acl, 0, &mut entry) } == 0 {
            return Err("Cleanup does not support extended ACL directories".into());
        }
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.raw_os_error(),
            Some(libc::EINVAL) | Some(libc::ENOENT)
        ) {
            return Err(error.into());
        }
        Ok(())
    })();
    unsafe {
        acl_free(acl);
    }
    result
}
#[cfg(target_os = "linux")]
fn mount_filesystem<'a>(info: &'a str, id: &str) -> Option<&'a str> {
    info.lines().find_map(|line| {
        let (fields, filesystem) = line.split_once(" - ")?;
        (fields.split_ascii_whitespace().next() == Some(id))
            .then(|| filesystem.split_ascii_whitespace().next())
            .flatten()
    })
}
fn cleanup_filesystem(root: &File, live: &Value) -> Result<()> {
    #[cfg(target_os = "macos")]
    let supported = {
        let _ = root;
        live["filesystem"] == "apfs"
    };
    #[cfg(target_os = "linux")]
    let supported = {
        // The ext magic also identifies ext2/ext3; require the actual mounted type.
        let info = fs::read_to_string("/proc/self/mountinfo").map_err(NativeError::from)?;
        live["filesystem"] == "linux:ef53" && mount_filesystem(&info, &mount(root)?) == Some("ext4")
    };
    if !supported {
        return Err("Cleanup is supported only on verified APFS and ext4 roots; this filesystem remains scan-only".into());
    }
    Ok(())
}
fn eligible(root: &File, live: &Value) -> Result<()> {
    if unsafe { libc::geteuid() } == 0 || live["path"] == "/" {
        return Err("Cleanup is unavailable for elevated accounts and filesystem roots".into());
    }
    #[cfg(target_os = "macos")]
    reject_extended_acl(root)?;
    let meta = root.metadata().map_err(NativeError::from)?;
    if meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o022 != 0
        || meta.mode() & 0o300 != 0o300
        || live["readOnly"] != false
    {
        return Err("Cleanup requires an owner-controlled writable root without group or other write permission".into());
    }
    Ok(())
}

use rayon::prelude::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
#[derive(Clone)]
struct Guard {
    root: Value,
    root_path: PathBuf,
    links: Vec<(Arc<File>, Vec<u8>, Arc<File>)>,
    mount: String,
    device: u64,
}
impl Guard {
    fn validate(&self, control: &Control, stop: &AtomicBool) -> Result<()> {
        control.check()?;
        if stop.load(Ordering::SeqCst) {
            return Err("Cleanup stopped after a detected change or failure".into());
        }
        checked_root(&self.root)?;
        for (parent, name, child) in &self.links {
            let stat = stat_at(parent, name)?;
            if !stat_matches(&stat, child)? || mount(child)? != self.mount {
                return Err("Ancestor identity or mount changed; cleanup stopped".into());
            }
        }
        Ok(())
    }
    fn descend(&self, parent: Arc<File>, name: Vec<u8>, child: Arc<File>) -> Self {
        let mut next = self.clone();
        next.links.push((parent, name, child));
        next
    }
}
#[derive(Debug)]
struct Failure {
    path: String,
    message: String,
    code: Option<i32>,
}
fn failure(path: String, error: NativeError) -> Failure {
    Failure {
        path,
        message: error.message,
        code: error.code,
    }
}

fn remove_entry(
    parent: Arc<File>,
    name: Vec<u8>,
    parts: Vec<Vec<u8>>,
    expected: Value,
    kind: &str,
    guard: &Guard,
    control: &Control,
    stop: &AtomicBool,
) -> std::result::Result<(), Failure> {
    let path = display(&guard.root_path, &parts);
    let checked = (|| -> Result<(libc::stat, bool)> {
        guard.validate(control, stop)?;
        let stat = stat_at(&parent, &name)?;
        let mode = stat.st_mode & libc::S_IFMT;
        let is_dir = mode == libc::S_IFDIR;
        if stat.st_dev as u64 != guard.device
            || leaf_identity(&stat, &guard.mount) != expected
            || is_dir != (kind == "dir")
        {
            return Err("Target identity, kind or mount changed; cleanup stopped".into());
        }
        if !is_dir && mode != libc::S_IFREG && mode != libc::S_IFLNK {
            return Err("Special files cannot be removed by cleanup".into());
        }
        if mode == libc::S_IFREG {
            let (observation, _, _) =
                regular_observation(&parent, &name, &stat, crate::tree::now_ms())?;
            if observation != expected {
                return Err("Target identity or mount changed".into());
            }
        }
        Ok((stat, is_dir))
    })()
    .map_err(|e| failure(path.clone(), e))?;
    let (original, is_dir) = checked;
    if is_dir {
        if parts.len() > 512 {
            return Err(failure(path, "Directory nesting exceeds 512".into()));
        }
        let child = Arc::new(open_at(&parent, &name, true).map_err(|e| failure(path.clone(), e))?);
        if !stat_matches(&original, &child).map_err(|e| failure(path.clone(), e))?
            || mount(&child).map_err(|e| failure(path.clone(), e))? != guard.mount
        {
            return Err(failure(path, "Directory changed before traversal".into()));
        }
        let live = json!({"readOnly":false});
        eligible(&child, &live).map_err(|e| failure(path.clone(), e))?;
        let next = guard.descend(parent.clone(), name.clone(), child.clone());
        let entries = names(&child).map_err(|e| failure(path.clone(), e))?;
        // The pool bounds active workers; descendants are discovered once, without a count pass.
        entries.into_par_iter().try_for_each(|entry| {
            let mut nested = parts.clone();
            nested.push(entry.clone());
            let stat = stat_at(&child, &entry).map_err(|e| {
                stop.store(true, Ordering::SeqCst);
                failure(display(&guard.root_path, &nested), e)
            })?;
            let kind = if stat.st_mode & libc::S_IFMT == libc::S_IFDIR {
                "dir"
            } else {
                "file"
            };
            let result = remove_entry(
                child.clone(),
                entry,
                nested,
                leaf_identity(&stat, &guard.mount),
                kind,
                &next,
                control,
                stop,
            );
            if result.is_err() {
                stop.store(true, Ordering::SeqCst);
            }
            result
        })?;
    }
    #[cfg(test)]
    BEFORE_UNLINK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().take() {
            hook();
        }
    });
    guard
        .validate(control, stop)
        .map_err(|e| failure(path.clone(), e))?;
    let live = stat_at(&parent, &name).map_err(|e| failure(path.clone(), e))?;
    if live.st_dev != original.st_dev
        || live.st_ino != original.st_ino
        || live.st_mode & libc::S_IFMT != original.st_mode & libc::S_IFMT
    {
        return Err(failure(
            path,
            "Leaf replaced before unlink; cleanup stopped".into(),
        ));
    }
    let native = cstr(&name).map_err(|e| failure(path.clone(), e))?;
    if unsafe {
        libc::unlinkat(
            parent.as_raw_fd(),
            native.as_ptr(),
            if is_dir { libc::AT_REMOVEDIR } else { 0 },
        )
    } != 0
    {
        let error = std::io::Error::last_os_error();
        return Err(Failure {
            path,
            message: error.to_string(),
            code: error.raw_os_error(),
        });
    }
    Ok(())
}
fn receipt_path(state: &Path, id: &str) -> PathBuf {
    state.join(format!("delete-{}.json", hash(id.as_bytes())))
}
fn operation_id(request: &Value) -> Result<&str> {
    let id = string(request, "operationId")?;
    if id.is_empty() || id.len() > 256 {
        return Err("Invalid operationId".into());
    }
    Ok(id)
}
fn status(state: &Path, id: &str) -> Result<Value> {
    let path = receipt_path(state, id);
    let Some(mut receipt) = read_json(&path)? else {
        return Ok(json!({"operationId":id,"state":"unknown","deleted":[],"failed":[]}));
    };
    if receipt["state"] == "running" {
        if let Ok(_guard) = lock(state, false) {
            receipt["state"] = json!("interrupted");
            durable(&path, &receipt)?;
        }
    }
    Ok(receipt)
}
fn check_receipt_capacity(state: &Path) -> Result<()> {
    let count = fs::read_dir(state)
        .map_err(NativeError::from)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name.starts_with("delete-") && name.ends_with(".json")
        })
        .count();
    if count >= 10_000 {
        return Err(
            "Receipt storage is full; cleanup requires deliberate receipt maintenance".into(),
        );
    }
    Ok(())
}

fn delete(state: &Path, request: &Value, worker: &Value, control: &Control) -> Result<Value> {
    let id = operation_id(request)?;
    let targets = request["targets"].as_array().ok_or("Expected targets")?;
    if targets.is_empty() || targets.len() > 1000 {
        return Err("Cleanup requires between 1 and 1000 targets".into());
    }
    let digest = hash(
        &serde_json::to_vec(
            &json!({"operationId":id,"root":request["root"],"targets":targets,"worker":worker}),
        )
        .map_err(NativeError::from)?,
    );
    let receipt_file = receipt_path(state, id);
    if let Some(receipt) = read_json(&receipt_file)? {
        if receipt["digest"] != digest {
            return Err("Operation ID already belongs to a different request".into());
        }
        return status(state, id);
    }
    let _lock = lock(state, false)?;
    if let Some(receipt) = read_json(&receipt_file)? {
        if receipt["digest"] != digest {
            return Err("Operation ID already belongs to a different request".into());
        }
        return Ok(receipt);
    }
    let (root_path, root, live) = checked_root(&request["root"])?;
    cleanup_filesystem(&root, &live)?;
    eligible(&root, &live)?;
    if read_json(&policy_file(state, &request["root"]))?.is_none_or(|p| p["enabled"] != true) {
        return Err("Cleanup is disabled for this root".into());
    }
    let root = Arc::new(root);
    let root_mount = mount(&root)?;
    let device = root.metadata().map_err(NativeError::from)?.dev();
    let guard = Guard {
        root: request["root"].clone(),
        root_path,
        links: Vec::new(),
        mount: root_mount,
        device,
    };
    let mut parsed = Vec::new();
    for target in targets {
        let parts = components(&target["components"])?;
        if parts.len() < 2 {
            return Err("Root and immediate children cannot be deleted".into());
        }
        let kind = string(target, "kind")?;
        if kind != "file" && kind != "dir" {
            return Err("Invalid target kind".into());
        }
        let path = string(target, "path")?;
        if path.len() > 8192 {
            return Err("Target display path exceeds limit".into());
        }
        if target["identity"]["device"].as_str().is_none()
            || target["identity"]["inode"].as_str().is_none()
            || target["identity"]["mount"].as_str().is_none()
        {
            return Err("Target has no saved native identity".into());
        }
        if parsed
            .iter()
            .any(|(prior, _, _, _): &(Vec<Vec<u8>>, String, String, Value)| {
                parts.starts_with(prior) || prior.starts_with(&parts)
            })
        {
            return Err("Overlapping cleanup targets".into());
        }
        parsed.push((
            parts,
            path.to_owned(),
            kind.to_owned(),
            target["identity"].clone(),
        ));
    }
    let anticipated=parsed.iter().map(|(parts,path,_,_)|json!({"path":path,"failedPath":display(&guard.root_path,parts),"message":"x".repeat(256),"errorDomain":"posix","errorCode":2147483647,"processLookup":"unavailable"})).collect::<Vec<_>>();
    // Reserve space for one deeply nested failing descendant as well as every
    // selected path. Later targets stop at their ancestors after the first failure.
    if serde_json::to_vec(&anticipated)
        .map_err(NativeError::from)?
        .len()
        + 2 * 1024 * 1024
        + serde_json::to_vec(&request["root"])
            .map_err(NativeError::from)?
            .len()
        > worker::MAX_FRAME
    {
        return Err("Selected paths exceed bounded deletion receipt capacity".into());
    }
    let mut receipt = json!({"operationId":id,"digest":digest,"state":"running","worker":worker,"root":request["root"],"deleted":[],"failed":[],"startedAt":crate::tree::now_ms()});
    check_receipt_capacity(state)?;
    durable(&receipt_file, &receipt)?;
    let stop = AtomicBool::new(false);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .stack_size(8 * 1024 * 1024)
        .build()
        .map_err(|e| NativeError::from(e.to_string()))?;
    for (parts, path, kind, expected) in parsed {
        let result = pool.install(|| {
            let mut parent = root.clone();
            let mut target_guard = guard.clone();
            for (i, part) in parts[..parts.len() - 1].iter().enumerate() {
                target_guard
                    .validate(control, &stop)
                    .map_err(|e| failure(display(&guard.root_path, &parts[..=i]), e))?;
                let stat = stat_at(&parent, part)
                    .map_err(|e| failure(display(&guard.root_path, &parts[..=i]), e))?;
                let child = Arc::new(
                    open_at(&parent, part, true)
                        .map_err(|e| failure(display(&guard.root_path, &parts[..=i]), e))?,
                );
                if !stat_matches(&stat, &child).map_err(|e| failure(path.clone(), e))?
                    || mount(&child).map_err(|e| failure(path.clone(), e))? != guard.mount
                {
                    return Err(failure(path.clone(), "Ancestor or mount changed".into()));
                }
                eligible(&child, &json!({"readOnly":false}))
                    .map_err(|e| failure(path.clone(), e))?;
                target_guard = target_guard.descend(parent, part.clone(), child.clone());
                parent = child;
            }
            remove_entry(
                parent,
                parts.last().unwrap().clone(),
                parts,
                expected,
                &kind,
                &target_guard,
                control,
                &stop,
            )
        });
        match result {
            Ok(()) => receipt["deleted"].as_array_mut().unwrap().push(json!(path)),
            Err(e) => {
                stop.store(true, Ordering::SeqCst);
                receipt["failed"].as_array_mut().unwrap().push(json!({"path":path,"failedPath":e.path,"message":e.message,"errorDomain":"posix","errorCode":e.code,"processLookup":"unavailable"}));
            }
        }
        durable(&receipt_file, &receipt)?;
    }
    receipt["state"] = json!(if control.check().is_err() {
        "interrupted"
    } else {
        "completed"
    });
    receipt["finishedAt"] = json!(crate::tree::now_ms());
    durable(&receipt_file, &receipt)?;
    Ok(receipt)
}
pub fn dispatch(
    state: &Path,
    request: &Value,
    worker: &Value,
    control: &Control,
) -> Result<Option<Value>> {
    control.check()?;
    match string(request, "op")? {
        "inspect" => {
            let (_, root) = if request.get("root").is_some() {
                let (_, file, root) = checked_root(&request["root"])?;
                (file, root)
            } else {
                let selected = if request.get("pathBytes").is_some() {
                    root_path(request)?
                } else {
                    PathBuf::from(string(request, "path")?)
                };
                let path = fs::canonicalize(selected).map_err(NativeError::from)?;
                inspect(&path)?
            };
            Ok(Some(root))
        }
        "resolve" => resolved(request).map(Some),
        "scan" => {
            scan(state, request, control)?;
            Ok(None)
        }
        "cleanup" => {
            let _lock = lock(state, false)?;
            let (_, file, root) = checked_root(&request["root"])?;
            let enabled = request["enabled"]
                .as_bool()
                .ok_or("Expected enabled boolean")?;
            if enabled {
                cleanup_filesystem(&file, &root)?;
                eligible(&file, &root)?;
            }
            durable(
                &policy_file(state, &request["root"]),
                &json!({"enabled":enabled,"root":root,"worker":worker}),
            )?;
            Ok(Some(json!({"enabled":enabled})))
        }
        "delete" => delete(state, request, worker, control).map(Some),
        "deleteStatus" => status(state, operation_id(request)?).map(Some),
        _ => Err("Unsupported worker operation".into()),
    }
}

#[cfg(test)]
thread_local! {static BEFORE_UNLINK:std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    static CLEANUP_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut random = [0; 16];
            File::open("/dev/urandom")
                .unwrap()
                .read_exact(&mut random)
                .unwrap();
            let path =
                std::env::temp_dir().join(format!("disk-watch-worker-test-{}", hash(&random)));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
        fn dir(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn request(root: &Value, op: &str) -> Value {
        json!({"op":op,"root":root})
    }
    fn observed(root: &Value, parts: &[&[u8]]) -> Value {
        resolved(&json!({"root":root,"components":encoded(&parts.iter().map(|v|v.to_vec()).collect::<Vec<_>>())})).unwrap()
    }
    #[test]
    fn deliberate_reinspection_uses_saved_root_bytes_without_old_mount_identity() {
        let fixture = Fixture::new();
        let path = fixture.dir("root\\name\n");
        let (_, root) = inspect(&path).unwrap();
        let mut stale = root.clone();
        stale["identity"]["mount"] = json!("0");
        assert!(checked_root(&stale).is_err());
        let request = json!({"op":"inspect","pathBytes":root["pathBytes"]});
        let observed = dispatch(&fixture.0, &request, &json!({}), &Control::testing())
            .unwrap()
            .unwrap();
        assert_eq!(observed["pathBytes"], root["pathBytes"]);
        assert_eq!(observed["identity"], root["identity"]);
    }
    #[test]
    fn unsupported_cleanup_filesystems_are_refused() {
        let fixture = Fixture::new();
        let (file, mut live) = inspect(&fixture.0).unwrap();
        cleanup_filesystem(&file, &live).unwrap();
        live["filesystem"] = json!("unsupported");
        assert!(
            cleanup_filesystem(&file, &live)
                .unwrap_err()
                .to_string()
                .contains("scan-only")
        );
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn cleanup_mount_type_uses_descriptor_mount_id_and_ignores_optional_fields() {
        let info = "12 1 8:1 / /data rw shared:4 master:2 future:ok - ext4 /dev/vda rw\n13 1 8:1 / /other rw - ext3 /dev/vdb rw\n14 1 0:1 / /net rw - nfs server:/data rw";
        assert_eq!(mount_filesystem(info, "12"), Some("ext4"));
        assert_eq!(mount_filesystem(info, "13"), Some("ext3"));
        assert_eq!(mount_filesystem(info, "14"), Some("nfs"));
        assert_eq!(mount_filesystem(info, "1"), None);
        assert_eq!(mount_filesystem("12 malformed", "12"), None);
    }
    #[test]
    fn canonical_label_corpus_matches_controller() {
        let corpus: Value =
            serde_json::from_str(include_str!("../tests/unix-labels.json")).unwrap();
        for row in corpus.as_array().unwrap() {
            let bytes = decode(row["bytes"].as_str().unwrap()).unwrap();
            assert_eq!(
                label(&bytes),
                row["label"].as_str().unwrap(),
                "{}",
                row["case"]
            );
        }
    }
    #[test]
    fn raw_names_round_trip_and_display_cannot_collide() {
        for bytes in [
            b"a\\x80".as_slice(),
            b"a\x80",
            b"line\nfile",
            b"quote'`$:-",
            b"\xc3\xa9",
        ] {
            assert_eq!(decode(&B64.encode(bytes)).unwrap(), bytes);
        }
        assert_ne!(label(b"a\\x80"), label(b"a\x80"));
        assert_ne!(label(b"line\nfile"), label(b"line\\u{a}file"));
        for invalid in ["", "Lg==", "Li4=", "Lw==", "AA==", "YQ"] {
            assert!(components(&json!([invalid])).is_err());
        }
    }
    #[test]
    fn alias_inspection_and_symlink_ancestor_refusal() {
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        fixture.dir("root/child");
        fs::write(root.join("child/file"), b"test").unwrap();
        symlink("child", root.join("alias")).unwrap();
        let (_, observation) = inspect(&root).unwrap();
        assert!(resolved(&json!({"root":observation,"components":encoded(&[b"alias".to_vec(),b"file".to_vec()])})).is_err());
        assert!(resolved(&json!({"root":observation,"path":"child/../child/file"})).is_err());
        assert_eq!(observed(&observation, &[b"child", b"file"])["kind"], "file");
    }
    #[test]
    fn scan_exact_bytes_times_exclusions_and_special_file_coverage() {
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        fixture.dir("root/dir");
        #[cfg(target_os = "linux")]
        let raw = b"file\xff\\\n";
        #[cfg(target_os = "macos")]
        let raw = b"file\xc3\xa9\\\n";
        fs::write(
            root.join("dir").join(OsString::from_vec(raw.to_vec())),
            b"abc",
        )
        .unwrap();
        fs::write(root.join("small"), b"a").unwrap();
        let fifo = cstr(root.join("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let (file, observation) = inspect(&root).unwrap();
        let control = Control::testing();
        let mut scan = Scan {
            control: &control,
            root: &root,
            mount: mount(&file).unwrap(),
            device: file.metadata().unwrap().dev(),
            excludes: vec![],
            min: 2,
            errors: 0,
            symlinks: 0,
            special: 0,
            mounts: 0,
            samples: Vec::new(),
            dirs: 0,
            count: 0,
            bytes: 0,
            last_progress: Instant::now(),
            started: crate::tree::now_ms(),
            #[cfg(target_os = "macos")]
            dirty: None,
            #[cfg(target_os = "macos")]
            uncached_entries: 0,
            #[cfg(target_os = "macos")]
            reused_dirs: 0,
        };
        let node = scan
            .directory(&file, b"root".to_vec(), &mut Vec::new())
            .unwrap();
        assert_eq!(node.size, 4);
        assert_eq!(node.files, 2);
        assert_eq!(node.rest_files, 1);
        assert_eq!(node.dirs[0].big[0].name, raw);
        assert_eq!(
            node.dirs[0].big[0].identity["mount"],
            observation["identity"]["mount"]
        );
        assert!(node.times.last_written_at.is_some());
        assert_eq!(scan.errors, 0);
        assert_eq!(scan.special, 1);
        scan.excludes = vec![vec![b"dir".to_vec()]];
        let node = scan
            .directory(&file, b"root".to_vec(), &mut Vec::new())
            .unwrap();
        assert_eq!(node.size, 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bulk_metadata_matches_fresh_observation_and_rejects_replaced_files() {
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        fs::write(root.join("leaf"), b"old").unwrap();
        symlink("leaf", root.join("link")).unwrap();
        let dir = open_root(&root).unwrap();
        let entries = macos_bulk::read(&dir, &Control::testing())
            .unwrap()
            .expect("Bulk API must be available on APFS");
        let metadata = entries
            .iter()
            .find(|entry| entry.name == b"leaf")
            .unwrap()
            .metadata
            .unwrap();
        assert_ne!(
            entries
                .iter()
                .find(|entry| entry.name == b"link")
                .unwrap()
                .metadata
                .unwrap()
                .kind,
            1
        );
        File::options()
            .write(true)
            .open(root.join("leaf"))
            .unwrap()
            .set_len(57)
            .unwrap();
        let stat = stat_at(&dir, b"leaf").unwrap();
        assert!(metadata.matches_regular(&stat));
        let started = crate::tree::now_ms();
        let bulk = mac_stat_observation(&stat, &metadata.mount.to_string(), started).unwrap();
        let ordinary = regular_observation(&dir, b"leaf", &stat, started).unwrap();
        assert_eq!(bulk.0, ordinary.0);
        assert_eq!(bulk.1.created_at, ordinary.1.created_at);
        assert_eq!(bulk.1.last_written_at, ordinary.1.last_written_at);
        assert_eq!(bulk.2, 57);
        assert_eq!(bulk.2, ordinary.2);
        fs::rename(root.join("leaf"), root.join("original")).unwrap();
        fs::write(root.join("leaf"), b"replacement").unwrap();
        assert!(!metadata.matches_regular(&stat_at(&dir, b"leaf").unwrap()));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bulk_system_file_uses_physical_volume_identity() {
        let dir = open_root(Path::new("/usr/bin")).unwrap();
        let entries = macos_bulk::read(&dir, &Control::testing())
            .unwrap()
            .unwrap();
        let metadata = entries
            .iter()
            .find(|entry| entry.name == b"true")
            .unwrap()
            .metadata
            .unwrap();
        let stat = stat_at(&dir, b"true").unwrap();
        let ordinary = regular_observation(&dir, b"true", &stat, crate::tree::now_ms()).unwrap();
        assert!(
            metadata.matches_regular(&stat),
            "bulk {metadata:?}, stat dev={} inode={} mode={}, dir mount={}, ordinary={}",
            stat.st_dev,
            stat.st_ino,
            stat.st_mode,
            mount(&dir).unwrap(),
            ordinary.0
        );
        assert_eq!(metadata.mount.to_string(), mount(&dir).unwrap());
        assert_eq!(ordinary.0["mount"], metadata.mount.to_string());
    }
    #[test]
    fn cleanup_default_off_depth_guard_and_no_replay() {
        let _test_lock = CLEANUP_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let state = fixture.dir("state");
        let root = fixture.dir("root");
        fixture.dir("root/child");
        fs::write(root.join("child/file"), b"data").unwrap();
        let (_, observation) = inspect(&root).unwrap();
        let worker = worker_identity(&state).unwrap();
        let target = observed(&observation, &[b"child", b"file"]);
        let control = Control::testing();
        let mut req = json!({"op":"delete","root":observation,"operationId":"operation-1","targets":[target]});
        assert!(delete(&state, &req, &worker, &control).is_err());
        let mut opt = request(&observation, "cleanup");
        opt["enabled"] = json!(true);
        dispatch(&state, &opt, &worker, &control).unwrap();
        let receipt = delete(&state, &req, &worker, &control).unwrap();
        assert_eq!(receipt["state"], "completed");
        assert_eq!(receipt["deleted"].as_array().unwrap().len(), 1);
        assert!(!root.join("child/file").exists());
        fs::write(root.join("child/file"), b"replacement").unwrap();
        assert_eq!(delete(&state, &req, &worker, &control).unwrap(), receipt);
        assert_eq!(fs::read(root.join("child/file")).unwrap(), b"replacement");
        req["targets"][0]["identity"]["inode"] = json!("0");
        assert!(delete(&state, &req, &worker, &control).is_err());
        req["operationId"] = json!("depth");
        req["targets"] = json!([observed(&observation, &[b"child"])]);
        assert!(delete(&state, &req, &worker, &control).is_err());
    }
    #[test]
    fn recursive_cleanup_unlinks_symlinks_and_preserves_hardlink_name() {
        let _test_lock = CLEANUP_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let state = fixture.dir("state");
        let root = fixture.dir("root");
        fixture.dir("root/child/tree");
        let outside = fixture.dir("outside");
        fs::write(outside.join("sentinel"), b"safe").unwrap();
        fs::hard_link(outside.join("sentinel"), root.join("child/tree/hard")).unwrap();
        symlink(&outside, root.join("child/tree/link")).unwrap();
        fs::write(root.join("child/tree/file"), b"data").unwrap();
        let (_, observation) = inspect(&root).unwrap();
        let worker = worker_identity(&state).unwrap();
        let control = Control::testing();
        dispatch(
            &state,
            &json!({"op":"cleanup","root":observation,"enabled":true}),
            &worker,
            &control,
        )
        .unwrap();
        let receipt=delete(&state,&json!({"root":observation,"operationId":"tree","targets":[observed(&observation,&[b"child",b"tree"])]}),&worker,&control).unwrap();
        assert_eq!(receipt["failed"], json!([]));
        assert!(!root.join("child/tree").exists());
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"safe");
    }
    #[test]
    fn moved_open_ancestor_aborts_before_outside_mutation() {
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        fixture.dir("root/child");
        let outside = fixture.dir("outside");
        fs::write(root.join("child/file"), b"safe").unwrap();
        let (file, observation) = inspect(&root).unwrap();
        let parent = Arc::new(file);
        let child = Arc::new(open_at(&parent, b"child", true).unwrap());
        let guard = Guard {
            root: observation.clone(),
            root_path: root.clone(),
            links: Vec::new(),
            mount: mount(&parent).unwrap(),
            device: parent.metadata().unwrap().dev(),
        }
        .descend(parent, b"child".to_vec(), child.clone());
        let expected = observed(&observation, &[b"child", b"file"])["identity"].clone();
        fs::rename(root.join("child"), outside.join("moved")).unwrap();
        let stop = AtomicBool::new(false);
        assert!(
            remove_entry(
                child,
                b"file".to_vec(),
                vec![b"child".to_vec(), b"file".to_vec()],
                expected,
                "file",
                &guard,
                &Control::testing(),
                &stop
            )
            .is_err()
        );
        assert_eq!(fs::read(outside.join("moved/file")).unwrap(), b"safe");
    }
    #[test]
    fn replaced_leaf_and_root_are_refused() {
        let _test_lock = CLEANUP_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        fixture.dir("root/child");
        fs::write(root.join("child/file"), b"original").unwrap();
        let state = fixture.dir("state");
        let worker = worker_identity(&state).unwrap();
        let (_, observation) = inspect(&root).unwrap();
        let target = observed(&observation, &[b"child", b"file"]);
        let control = Control::testing();
        dispatch(
            &state,
            &json!({"op":"cleanup","root":observation,"enabled":true}),
            &worker,
            &control,
        )
        .unwrap();
        fs::rename(root.join("child/file"), root.join("child/original")).unwrap();
        fs::write(root.join("child/file"), b"replacement").unwrap();
        let receipt = delete(
            &state,
            &json!({"root":observation,"operationId":"replaced","targets":[target]}),
            &worker,
            &control,
        )
        .unwrap();
        assert_eq!(receipt["failed"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read(root.join("child/file")).unwrap(), b"replacement");
        fs::rename(&root, fixture.0.join("old-root")).unwrap();
        fixture.dir("root");
        assert!(checked_root(&observation).is_err());
    }
    #[test]
    fn lock_serializes_overlapping_roots_and_running_receipt_becomes_interrupted() {
        let _test_lock = CLEANUP_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let state = fixture.dir("state");
        worker_identity(&state).unwrap();
        let guard = lock(&state, false).unwrap();
        assert!(lock(&state, false).is_err());
        let another_state = fixture.dir("another-state");
        assert!(lock(&another_state, false).is_err());
        let path = receipt_path(&state, "crash");
        durable(
            &path,
            &json!({"operationId":"crash","digest":"d","state":"running","deleted":[],"failed":[]}),
        )
        .unwrap();
        assert_eq!(status(&state, "crash").unwrap()["state"], "running");
        drop(guard);
        assert_eq!(status(&state, "crash").unwrap()["state"], "interrupted");
        assert_eq!(status(&state, "absent").unwrap()["state"], "unknown");
    }
    #[test]
    fn leaf_swap_at_final_check_stops_unlink() {
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        fixture.dir("root/child");
        fs::write(root.join("child/file"), b"original").unwrap();
        let (file, observation) = inspect(&root).unwrap();
        let parent = Arc::new(file);
        let child = Arc::new(open_at(&parent, b"child", true).unwrap());
        let guard = Guard {
            root: observation.clone(),
            root_path: root.clone(),
            links: Vec::new(),
            mount: mount(&parent).unwrap(),
            device: parent.metadata().unwrap().dev(),
        }
        .descend(parent, b"child".to_vec(), child.clone());
        let expected = observed(&observation, &[b"child", b"file"])["identity"].clone();
        let swap_root = root.clone();
        BEFORE_UNLINK.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                fs::rename(
                    swap_root.join("child/file"),
                    swap_root.join("child/original"),
                )
                .unwrap();
                fs::write(swap_root.join("child/file"), b"replacement").unwrap();
            }))
        });
        assert!(
            remove_entry(
                child,
                b"file".to_vec(),
                vec![b"child".to_vec(), b"file".to_vec()],
                expected,
                "file",
                &guard,
                &Control::testing(),
                &AtomicBool::new(false)
            )
            .is_err()
        );
        assert_eq!(fs::read(root.join("child/file")).unwrap(), b"replacement");
        assert_eq!(fs::read(root.join("child/original")).unwrap(), b"original");
    }
    #[test]
    fn changed_mount_and_filesystem_root_cleanup_are_refused() {
        let fixture = Fixture::new();
        let path = fixture.dir("root");
        let (_, mut root) = inspect(&path).unwrap();
        root["identity"]["mount"] = json!("0");
        assert!(checked_root(&root).is_err());
        let (file, mut live) = inspect(&path).unwrap();
        live["path"] = json!("/");
        assert!(eligible(&file, &live).is_err());
    }
    #[test]
    fn unreadable_regular_files_keep_totals_and_can_be_unlinked() {
        let _test_lock = CLEANUP_TEST_LOCK.lock().unwrap();
        let fixture = Fixture::new();
        let state = fixture.dir("state");
        let root = fixture.dir("root");
        fixture.dir("root/child");
        let path = root.join("child/unreadable");
        fs::write(&path, b"unreadable-data").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0)).unwrap();
        let (file, observation) = inspect(&root).unwrap();
        let control = Control::testing();
        let mut scan = Scan {
            control: &control,
            root: &root,
            mount: mount(&file).unwrap(),
            device: file.metadata().unwrap().dev(),
            excludes: vec![],
            min: 0,
            errors: 0,
            symlinks: 0,
            special: 0,
            mounts: 0,
            samples: Vec::new(),
            dirs: 0,
            count: 0,
            bytes: 0,
            last_progress: Instant::now(),
            started: crate::tree::now_ms(),
            #[cfg(target_os = "macos")]
            dirty: None,
            #[cfg(target_os = "macos")]
            uncached_entries: 0,
            #[cfg(target_os = "macos")]
            reused_dirs: 0,
        };
        let tree = scan
            .directory(&file, b"root".to_vec(), &mut Vec::new())
            .unwrap();
        assert_eq!(tree.size, 15);
        assert_eq!(tree.files, 1);
        assert_eq!(scan.errors, 0);
        let target = observed(&observation, &[b"child", b"unreadable"]);
        let worker = worker_identity(&state).unwrap();
        dispatch(
            &state,
            &json!({"op":"cleanup","root":observation,"enabled":true}),
            &worker,
            &control,
        )
        .unwrap();
        let receipt = delete(
            &state,
            &json!({"root":observation,"operationId":"unreadable","targets":[target]}),
            &worker,
            &control,
        )
        .unwrap();
        assert_eq!(receipt["failed"], json!([]));
        assert!(!path.exists());
    }
    #[test]
    fn unreadable_directory_is_unknown_and_partial() {
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        let hidden = fixture.dir("root/private");
        fs::write(hidden.join("unseen"), b"data").unwrap();
        fs::set_permissions(&hidden, fs::Permissions::from_mode(0)).unwrap();
        let file = open_root(&root).unwrap();
        let control = Control::testing();
        let mut scan = Scan {
            control: &control,
            root: &root,
            mount: mount(&file).unwrap(),
            device: file.metadata().unwrap().dev(),
            excludes: vec![],
            min: 0,
            errors: 0,
            symlinks: 0,
            special: 0,
            mounts: 0,
            samples: Vec::new(),
            dirs: 0,
            count: 0,
            bytes: 0,
            last_progress: Instant::now(),
            started: crate::tree::now_ms(),
            #[cfg(target_os = "macos")]
            dirty: None,
            #[cfg(target_os = "macos")]
            uncached_entries: 0,
            #[cfg(target_os = "macos")]
            reused_dirs: 0,
        };
        let tree = scan
            .directory(&file, b"root".to_vec(), &mut Vec::new())
            .unwrap();
        fs::set_permissions(&hidden, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(tree.size, 0);
        assert_eq!(scan.errors, 1);
        assert_eq!(scan.special + scan.symlinks + scan.mounts, 0);
    }
    #[test]
    fn native_errno_survives_descriptor_open_failure() {
        let fixture = Fixture::new();
        let path = fixture.dir("root");
        let file = open_root(&path).unwrap();
        assert_eq!(
            open_at(&file, b"missing", true).unwrap_err().code,
            Some(libc::ENOENT)
        );
        let failure = failure(
            "selected".into(),
            open_at(&file, b"missing", true).unwrap_err(),
        );
        assert_eq!(failure.code, Some(libc::ENOENT));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn extended_acl_cleanup_is_refused() {
        let fixture = Fixture::new();
        let path = fixture.dir("root");
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone allow add_file"])
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        let (file, live) = inspect(&path).unwrap();
        assert!(eligible(&file, &live).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn typed_apfs_aliases_return_actual_component_bytes() {
        let fixture = Fixture::new();
        let path = fixture.dir("root");
        fixture.dir("root/Folder");
        fs::write(path.join("Folder/FiLe"), b"data").unwrap();
        fs::write(path.join("Folder/é"), b"data").unwrap();
        let (_, root) = inspect(&path).unwrap();
        if path.join("fOlDeR/fIlE").exists() {
            let resolved = resolved(&json!({"root":root,"path":"fOlDeR/fIlE"})).unwrap();
            assert_eq!(
                resolved["components"],
                encoded(&[b"Folder".to_vec(), b"FiLe".to_vec()])
            );
        }
        if path.join("Folder/e\u{301}").exists() {
            let resolved = resolved(&json!({"root":root,"path":"Folder/e\u{301}"})).unwrap();
            assert_eq!(
                resolved["components"],
                encoded(&[b"Folder".to_vec(), "é".as_bytes().to_vec()])
            );
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn system_regular_file_mount_matches_descriptor_without_data_reads() {
        let parent = open_root(Path::new("/bin")).unwrap();
        let stat = stat_at(&parent, b"ls").unwrap();
        let (observed, _, size) =
            regular_observation(&parent, b"ls", &stat, crate::tree::now_ms()).unwrap();
        assert!(size > 0);
        assert_eq!(observed["device"], stat.st_dev.to_string());
        assert_eq!(observed["mount"], mount(&parent).unwrap());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn actual_system_data_boundary_stays_distinct_from_owned_fixture() {
        let fixture = Fixture::new();
        let path = fixture.dir("root");
        fs::write(path.join("unreadable"), b"fixture").unwrap();
        fs::set_permissions(path.join("unreadable"), fs::Permissions::from_mode(0)).unwrap();
        let parent = open_root(&path).unwrap();
        let stat = stat_at(&parent, b"unreadable").unwrap();
        let (observed, _, size) =
            regular_observation(&parent, b"unreadable", &stat, crate::tree::now_ms()).unwrap();
        assert_eq!(size, 7);
        assert_eq!(observed["mount"], mount(&parent).unwrap());
        let system = open_root(Path::new("/bin")).unwrap();
        let data = open_root(Path::new("/System/Volumes/Data")).unwrap();
        if mount(&system).unwrap() != mount(&data).unwrap() {
            assert_ne!(mount(&system).unwrap(), observed["mount"]);
            assert_eq!(mount(&data).unwrap(), observed["mount"]);
        }
    }
    #[test]
    fn group_writable_cleanup_root_is_refused() {
        let fixture = Fixture::new();
        let root = fixture.dir("root");
        fs::set_permissions(&root, fs::Permissions::from_mode(0o770)).unwrap();
        let (file, live) = inspect(&root).unwrap();
        assert!(eligible(&file, &live).is_err());
    }
}
