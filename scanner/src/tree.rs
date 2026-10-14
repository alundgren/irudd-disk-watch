use serde_json::json;
use std::io::{self, Write};
use std::sync::atomic::AtomicU64;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Clone, Copy, Default)]
pub struct Times {
    pub created_at: Option<u64>,
    pub last_written_at: Option<u64>,
}

impl Times {
    pub fn capture(created_at: Option<u64>, last_written_at: Option<u64>, started_at: u64) -> Self {
        // Recheck only newer candidates, so writes observed during a scan are kept
        // without letting future-dated files suppress valid descendant activity.
        let cutoff = if created_at.max(last_written_at).unwrap_or(0) > started_at { now_ms() } else { started_at };
        let valid = |time: Option<u64>| time.filter(|&time| time > 0 && time <= cutoff);
        Self { created_at: valid(created_at), last_written_at: valid(last_written_at) }
    }

    pub fn from_metadata(meta: &std::fs::Metadata, started_at: u64) -> Self {
        let millis = |time: std::io::Result<SystemTime>| {
            time.ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis().try_into().ok()
        };
        Self::capture(millis(meta.created()), millis(meta.modified()), started_at)
    }
}

pub struct FileEntry {
    pub name: String,
    pub size: u64,
    pub times: Times,
}

/// Live totals that the progress thread prints while a scan runs.
#[derive(Default)]
pub struct Counters {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
}

pub struct Dir {
    pub name: String,
    pub times: Times,
    pub size: u64,
    pub files: u64,
    pub subdirs: Vec<Dir>,
    pub big_files: Vec<FileEntry>,
    pub rest_size: u64,
    pub rest_files: u64,
}

impl Dir {
    pub fn new(name: String) -> Dir {
        Dir {
            name,
            times: Times::default(),
            size: 0,
            files: 0,
            subdirs: Vec::new(),
            big_files: Vec::new(),
            rest_size: 0,
            rest_files: 0,
        }
    }

    pub fn add_file(&mut self, name: String, size: u64, min_file_size: u64, times: Times) {
        self.size += size;
        self.files += 1;
        self.times.last_written_at = self.times.last_written_at.max(times.last_written_at);
        if size >= min_file_size {
            self.big_files.push(FileEntry { name, size, times });
        } else {
            self.rest_size += size;
            self.rest_files += 1;
        }
    }

    pub fn add_subdir(&mut self, sub: Dir) {
        self.size += sub.size;
        self.files += sub.files;
        self.times.last_written_at = self.times.last_written_at.max(sub.times.last_written_at);
        self.subdirs.push(sub);
    }
}

/// Prints the tree in pre-order: every dir line comes before its children.
pub fn emit(out: &mut impl Write, dir: &Dir, parent: Option<u64>, next_id: &mut u64) -> io::Result<()> {
    let id = *next_id;
    *next_id += 1;
    let line = json!({"t": "dir", "id": id, "parent": parent, "name": dir.name, "size": dir.size, "files": dir.files,
        "createdAt": dir.times.created_at, "lastWrittenAt": dir.times.last_written_at});
    writeln!(out, "{line}")?;
    for file in &dir.big_files {
        writeln!(out, "{}", json!({"t": "file", "parent": id, "name": file.name, "size": file.size,
            "createdAt": file.times.created_at, "lastWrittenAt": file.times.last_written_at}))?;
    }
    if dir.rest_files > 0 {
        writeln!(out, "{}", json!({"t": "rest", "parent": id, "size": dir.rest_size, "files": dir.rest_files}))?;
    }
    for sub in &dir.subdirs {
        emit(out, sub, Some(id), next_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_writes_propagate_without_replacing_folder_creation_or_accepting_future_dates() {
        let now = now_ms();
        let mut parent = Dir::new("parent".into());
        parent.times = Times::capture(Some(now - 100_000), Some(now - 50_000), now);
        let mut child = Dir::new("child".into());
        child.times = Times::capture(Some(now - 20_000), Some(now - 10_000), now);
        child.add_file("small".into(), 1, 1000, Times::capture(None, Some(now - 1000), now));
        child.add_file("future".into(), 1, 1000, Times::capture(None, Some(now + 60_000), now));
        parent.add_subdir(child);
        assert_eq!(parent.times.created_at, Some(now - 100_000));
        assert_eq!(parent.times.last_written_at, Some(now - 1000));
        assert!(parent.subdirs[0].big_files.is_empty());
        let mut out = Vec::new();
        emit(&mut out, &parent, None, &mut 1).unwrap();
        let first: serde_json::Value = serde_json::from_str(std::str::from_utf8(&out).unwrap().lines().next().unwrap()).unwrap();
        assert_eq!(first["lastWrittenAt"], now - 1000);
    }
}
