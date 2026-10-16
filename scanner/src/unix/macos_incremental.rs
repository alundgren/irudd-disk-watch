//! Private, disposable scan cache. Deletion never reads it and still validates saved identities live.
use super::macos_events::{self, Dirty, Monitor};
use super::{Control, File, Node, Result, Scan, private_dir, state_file};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LINE: u64 = 64 * 1024 * 1024;
const MAX_AGE: u64 = 24 * 60 * 60 * 1000;

#[derive(Default, Clone, Copy, Serialize, Deserialize)]
pub(super) struct Counts {
    pub dirs: u64,
    pub errors: u64,
    pub symlinks: u64,
    pub special: u64,
    pub mounts: u64,
    pub uncached_entries: u64,
}
impl Counts {
    pub fn capture(scan: &Scan<'_>) -> Self {
        Self {
            dirs: scan.dirs,
            errors: scan.errors,
            symlinks: scan.symlinks,
            special: scan.special,
            mounts: scan.mounts,
            uncached_entries: scan.uncached_entries,
        }
    }
    pub fn difference(self, before: Self) -> Self {
        Self {
            dirs: self.dirs - before.dirs,
            errors: self.errors - before.errors,
            symlinks: self.symlinks - before.symlinks,
            special: self.special - before.special,
            mounts: self.mounts - before.mounts,
            uncached_entries: self.uncached_entries - before.uncached_entries,
        }
    }
    pub fn restore(self, scan: &mut Scan<'_>, node: &Node) {
        scan.dirs += self.dirs;
        scan.errors += self.errors;
        scan.symlinks += self.symlinks;
        scan.special += self.special;
        scan.mounts += self.mounts;
        scan.uncached_entries += self.uncached_entries;
        scan.count += node.files;
        scan.bytes += node.size;
        scan.reused_dirs += self.dirs;
    }
}
#[derive(Serialize, Deserialize)]
struct Header {
    version: u32,
    key: Value,
    event_id: u64,
    full_at: u64,
    generation: u32,
}
#[derive(Serialize, Deserialize)]
struct Line {
    depth: usize,
    node: Node,
}
#[derive(Serialize)]
struct BorrowedLine<'a> {
    depth: usize,
    node: &'a Node,
}

fn read_line(reader: &mut impl BufRead) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(MAX_LINE + 1).read_until(b'\n', &mut bytes)?;
    if bytes.len() as u64 > MAX_LINE || bytes.last() != Some(&b'\n') {
        return Err("Truncated or oversized quick-scan cache record".into());
    }
    Ok(bytes)
}
fn load(path: &Path, control: &Control) -> Result<(Header, Node)> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > MAX_BYTES
    {
        return Err("Quick-scan cache is unavailable".into());
    }
    let mut reader = BufReader::new(file);
    let header_line = read_line(&mut reader)?;
    let header: Header = serde_json::from_slice(&header_line)?;
    let mut digest = Sha256::new();
    digest.update(&header_line);
    let mut stack: Vec<(usize, Node)> = vec![];
    loop {
        control.check()?;
        let bytes = read_line(&mut reader)?;
        if bytes.starts_with(b"sha256:") {
            let expected = format!("sha256:{:x}\n", digest.finalize());
            if bytes != expected.as_bytes() || !reader.fill_buf()?.is_empty() {
                return Err("Quick-scan cache checksum failed".into());
            }
            break;
        }
        digest.update(&bytes);
        let Line { depth, mut node } = serde_json::from_slice(&bytes)?;
        if depth > 512
            || !node.is_dir
            || node.name.contains(&0)
            || (node.name.contains(&b'/') && !(depth == 0 && node.name == b"/"))
        {
            return Err("Invalid cached directory".into());
        }
        let first = stack
            .iter()
            .rposition(|(d, _)| *d <= depth)
            .map_or(0, |i| i + 1);
        if stack[first..].iter().any(|(d, _)| *d != depth + 1) {
            return Err("Invalid cached directory nesting".into());
        }
        node.dirs = stack.drain(first..).map(|(_, n)| n).collect();
        stack.push((depth, node));
    }
    if stack.len() != 1 || stack[0].0 != 0 {
        return Err("Quick-scan cache has no single root".into());
    }
    Ok((header, stack.pop().unwrap().1))
}
fn save(path: &Path, header: &Header, tree: &Node, control: &Control) -> Result<()> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    let result = (|| {
        let mut out = BufWriter::new(file);
        let mut digest = Sha256::new();
        let mut total = 0u64;
        let mut write = |bytes: Vec<u8>| -> Result<()> {
            control.check()?;
            total += bytes.len() as u64 + 1;
            if total > MAX_BYTES || bytes.len() as u64 > MAX_LINE {
                return Err("Quick-scan cache exceeds its size limit".into());
            }
            out.write_all(&bytes)?;
            out.write_all(b"\n")?;
            digest.update(&bytes);
            digest.update(b"\n");
            Ok(())
        };
        write(serde_json::to_vec(header)?)?;
        fn visit(
            node: &Node,
            depth: usize,
            write: &mut impl FnMut(Vec<u8>) -> Result<()>,
        ) -> Result<()> {
            for child in &node.dirs {
                visit(child, depth + 1, write)?;
            }
            write(serde_json::to_vec(&BorrowedLine { depth, node })?)
        }
        visit(tree, 0, &mut write)?;
        writeln!(out, "sha256:{:x}", digest.finalize())?;
        out.flush()?;
        out.get_ref().sync_all()?;
        fs::rename(&temp, path)?;
        File::open(path.parent().unwrap())?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(super) struct Session {
    monitor: Monitor,
    header: Header,
    path: PathBuf,
    _lock: File,
    volume_file: File,
    pub previous: Option<Node>,
    pub dirty: Dirty,
    pub fallback: Option<String>,
}
impl Session {
    pub fn prepare(state: &Path, request: &Value, file: &File, control: &Control) -> Result<Self> {
        if request["root"]["filesystem"] != "apfs" {
            return Err("Quick scan currently supports local APFS roots".into());
        }
        let (uuid, relative) = macos_events::volume(file)?;
        let directory = state.join("scan-cache-v1");
        private_dir(&directory)?;
        let name = super::worker::hash(
            request["root"]["pathBytes"]
                .as_str()
                .ok_or("Missing root path")?
                .as_bytes(),
        );
        let path = directory.join(format!("{name}.cache"));
        let lock = state_file(&directory.join(format!("{name}.lock")))?;
        let meta = lock.metadata()?;
        if !meta.is_file()
            || meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
            || meta.nlink() != 1
            || unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0
        {
            return Err("Another quick scan is updating this baseline".into());
        }
        // A killed writer can leave only a disposable temporary file. The per-root lock
        // ensures no current writer owns one of these files.
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            if entry
                .file_name()
                .as_encoded_bytes()
                .starts_with(format!("{name}.tmp-").as_bytes())
            {
                let meta = fs::symlink_metadata(entry.path())?;
                if meta.is_file()
                    && meta.uid() == unsafe { libc::geteuid() }
                    && meta.nlink() == 1
                    && meta.mode() & 0o077 == 0
                {
                    fs::remove_file(entry.path())?;
                }
            }
        }
        let key = json!({"root":request["root"]["identity"],"uuid":uuid,"relative":relative,"min":request["minFileSize"],"excludes":request["excludes"],"account":unsafe {libc::geteuid()}});
        let now = crate::tree::now_ms();
        let event_id = macos_events::current_id();
        if event_id == 0 {
            return Err("Change history has no valid checkpoint".into());
        }
        let loaded = load(&path, control);
        let (previous, full_at, generation, since, fallback) = match loaded {
            Ok((h, node))
                if h.version == 1
                    && h.key == key
                    && h.event_id > 0
                    && h.event_id <= event_id
                    && now >= h.full_at
                    && now - h.full_at < MAX_AGE
                    && h.generation < 10 =>
            {
                (Some(node), h.full_at, h.generation + 1, h.event_id, None)
            }
            Ok(_) => (
                None,
                now,
                0,
                event_id,
                Some("Full scan refreshed an expired or changed baseline".into()),
            ),
            Err(_) => (
                None,
                now,
                0,
                event_id,
                Some("Full scan built a quick-scan baseline".into()),
            ),
        };
        let monitor = Monitor::start(file, relative, since, control)?;
        let (dirty, previous, fallback) = match monitor.drain(control) {
            Ok(dirty) => (dirty, previous, fallback),
            Err(reason) => (Dirty::all(), None, Some(reason.to_string())),
        };
        // Advance only through events drained before observation. The global current ID can be
        // ahead of delivery; persisting it here could permanently skip a delayed write.
        let checkpoint = monitor.checkpoint();
        Ok(Self {
            monitor,
            header: Header {
                version: 1,
                key,
                event_id: checkpoint,
                full_at,
                generation,
            },
            path,
            _lock: lock,
            volume_file: file.try_clone()?,
            previous,
            dirty,
            fallback,
        })
    }
    pub fn changes(&self, control: &Control) -> Result<Dirty> {
        let (uuid, _) = macos_events::volume(&self.volume_file)?;
        if self.header.key["uuid"] != uuid {
            return Err("Volume change history was replaced during scanning".into());
        }
        self.monitor.drain(control)
    }
    pub fn save(&self, tree: &Node, control: &Control) -> Result<()> {
        save(&self.path, &self.header, tree, control)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupted_or_truncated_cache_is_rejected() {
        let path = std::env::temp_dir().join(format!("dw-bad-cache-{}", std::process::id()));
        let _ = fs::remove_file(&path);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        file.write_all(b"{}\nsha256:bad\n").unwrap();
        assert!(load(&path, &Control::testing()).is_err());
        fs::write(&path, b"truncated").unwrap();
        assert!(load(&path, &Control::testing()).is_err());
        fs::remove_file(path).unwrap();
    }
}
