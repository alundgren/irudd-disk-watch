//! Builds the tree by listing folders. Works on any file system without
//! administrator rights, but is slower than reading the MFT.

use crate::tree::{Counters, Dir, Times, now_ms};
use rayon::prelude::*;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_REPORTED_ERRORS: usize = 500;

pub struct Walker<'a> {
    pub excludes: HashSet<String>,
    pub min_file_size: u64,
    pub counters: &'a Counters,
    pub errors: Mutex<Vec<(String, String)>>,
    pub error_count: AtomicU64,
}

pub fn exclude_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}

impl Walker<'_> {
    fn record_error(&self, path: &Path, err: &io::Error) {
        self.error_count.fetch_add(1, Ordering::Relaxed);
        let mut errors = self.errors.lock().unwrap();
        if errors.len() < MAX_REPORTED_ERRORS {
            errors.push((path.to_string_lossy().into_owned(), err.to_string()));
        }
    }

    pub fn walk(&self, path: &Path, name: String) -> Dir {
        let started_at = now_ms();
        let times = fs::metadata(path).ok().map(|meta| Times::from_metadata(&meta, started_at)).unwrap_or_default();
        self.walk_dir(path, name, times, started_at)
    }

    fn walk_dir(&self, path: &Path, name: String, times: Times, started_at: u64) -> Dir {
        self.counters.dirs.fetch_add(1, Ordering::Relaxed);
        let mut dir = Dir::new(name);
        dir.times = times;
        let mut subdir_paths = Vec::new();

        let entries = match fs::read_dir(path) {
            Ok(entries) => entries,
            Err(err) => {
                self.record_error(path, &err);
                return dir;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(err) => {
                    self.record_error(path, &err);
                    continue;
                }
            };
            let child = entry.path();
            if self.excludes.contains(&exclude_key(&child)) {
                continue;
            }
            // On Windows, DirEntry metadata comes from the directory listing itself,
            // so this costs no extra syscall per file.
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(err) => {
                    self.record_error(&entry.path(), &err);
                    continue;
                }
            };
            // Junctions and symlinks point at data that is counted elsewhere.
            if meta.file_type().is_symlink() {
                continue;
            }
            let entry_name = entry.file_name().to_string_lossy().into_owned();
            let times = Times::from_metadata(&meta, started_at);
            if meta.is_dir() {
                subdir_paths.push((child, entry_name, times));
                continue;
            }
            self.counters.files.fetch_add(1, Ordering::Relaxed);
            self.counters.bytes.fetch_add(meta.len(), Ordering::Relaxed);
            dir.add_file(entry_name, meta.len(), self.min_file_size, times);
        }

        let subdirs: Vec<Dir> = subdir_paths
            .into_par_iter()
            .map(|(child, child_name, times)| self.walk_dir(&child, child_name, times, started_at))
            .collect();
        for sub in subdirs {
            dir.add_subdir(sub);
        }
        dir
    }
}
