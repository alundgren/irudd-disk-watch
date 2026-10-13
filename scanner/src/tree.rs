use serde_json::json;
use std::io::{self, Write};
use std::sync::atomic::AtomicU64;

/// Live totals that the progress thread prints while a scan runs.
#[derive(Default)]
pub struct Counters {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
}

pub struct Dir {
    pub name: String,
    pub size: u64,
    pub files: u64,
    pub subdirs: Vec<Dir>,
    pub big_files: Vec<(String, u64)>,
    pub rest_size: u64,
    pub rest_files: u64,
}

impl Dir {
    pub fn new(name: String) -> Dir {
        Dir {
            name,
            size: 0,
            files: 0,
            subdirs: Vec::new(),
            big_files: Vec::new(),
            rest_size: 0,
            rest_files: 0,
        }
    }

    pub fn add_file(&mut self, name: String, size: u64, min_file_size: u64) {
        self.size += size;
        self.files += 1;
        if size >= min_file_size {
            self.big_files.push((name, size));
        } else {
            self.rest_size += size;
            self.rest_files += 1;
        }
    }

    pub fn add_subdir(&mut self, sub: Dir) {
        self.size += sub.size;
        self.files += sub.files;
        self.subdirs.push(sub);
    }
}

/// Prints the tree in pre-order: every dir line comes before its children.
pub fn emit(out: &mut impl Write, dir: &Dir, parent: Option<u64>, next_id: &mut u64) -> io::Result<()> {
    let id = *next_id;
    *next_id += 1;
    let line = json!({"t": "dir", "id": id, "parent": parent, "name": dir.name, "size": dir.size, "files": dir.files});
    writeln!(out, "{line}")?;
    for (name, size) in &dir.big_files {
        writeln!(out, "{}", json!({"t": "file", "parent": id, "name": name, "size": size}))?;
    }
    if dir.rest_files > 0 {
        writeln!(out, "{}", json!({"t": "rest", "parent": id, "size": dir.rest_size, "files": dir.rest_files}))?;
    }
    for sub in &dir.subdirs {
        emit(out, sub, Some(id), next_id)?;
    }
    Ok(())
}
