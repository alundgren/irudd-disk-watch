//! Walks a directory tree in parallel and prints it as NDJSON on stdout.
//!
//! While walking it prints `progress` lines. When the walk finishes it prints the
//! tree in pre-order (every dir line comes before its children), then `error`
//! lines, then a final `done` line. Files under `--min-file-size` are folded into
//! one `rest` line per directory.

use rayon::prelude::*;
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

const MAX_REPORTED_ERRORS: usize = 500;

struct Args {
    root: PathBuf,
    excludes: HashSet<String>,
    min_file_size: u64,
    threads: usize,
    background: bool,
}

struct Dir {
    name: String,
    size: u64,
    files: u64,
    subdirs: Vec<Dir>,
    big_files: Vec<(String, u64)>,
    rest_size: u64,
    rest_files: u64,
}

#[derive(Default)]
struct Counters {
    files: AtomicU64,
    dirs: AtomicU64,
    bytes: AtomicU64,
}

struct Walker {
    excludes: HashSet<String>,
    min_file_size: u64,
    counters: Counters,
    errors: Mutex<Vec<(String, String)>>,
    error_count: AtomicU64,
}

fn exclude_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .replace('/', "\\")
        .to_lowercase()
}

impl Walker {
    fn record_error(&self, path: &Path, err: &io::Error) {
        self.error_count.fetch_add(1, Ordering::Relaxed);
        let mut errors = self.errors.lock().unwrap();
        if errors.len() < MAX_REPORTED_ERRORS {
            errors.push((path.to_string_lossy().into_owned(), err.to_string()));
        }
    }

    fn walk(&self, path: &Path, name: String) -> Dir {
        self.counters.dirs.fetch_add(1, Ordering::Relaxed);
        let mut dir = Dir {
            name,
            size: 0,
            files: 0,
            subdirs: Vec::new(),
            big_files: Vec::new(),
            rest_size: 0,
            rest_files: 0,
        };
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
            if meta.is_dir() {
                let child = entry.path();
                if !self.excludes.contains(&exclude_key(&child)) {
                    subdir_paths.push((child, entry_name));
                }
                continue;
            }
            let size = meta.len();
            self.counters.files.fetch_add(1, Ordering::Relaxed);
            self.counters.bytes.fetch_add(size, Ordering::Relaxed);
            dir.size += size;
            dir.files += 1;
            if size >= self.min_file_size {
                dir.big_files.push((entry_name, size));
            } else {
                dir.rest_size += size;
                dir.rest_files += 1;
            }
        }

        dir.subdirs = subdir_paths
            .into_par_iter()
            .map(|(child, child_name)| self.walk(&child, child_name))
            .collect();
        for sub in &dir.subdirs {
            dir.size += sub.size;
            dir.files += sub.files;
        }
        dir
    }
}

fn emit(out: &mut impl Write, dir: &Dir, parent: Option<u64>, next_id: &mut u64) -> io::Result<()> {
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

fn parse_args() -> Result<Args, String> {
    let mut root = None;
    let mut excludes = HashSet::new();
    let mut min_file_size = 1024 * 1024;
    let mut threads = std::thread::available_parallelism().map_or(8, |n| n.get());
    let mut background = true;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--exclude" => {
                let value = it.next().ok_or("--exclude needs a path")?;
                excludes.insert(exclude_key(Path::new(&value)));
            }
            "--min-file-size" => {
                let value = it.next().ok_or("--min-file-size needs a number")?;
                min_file_size = value.parse().map_err(|_| "--min-file-size must be a number")?;
            }
            "--threads" => {
                let value = it.next().ok_or("--threads needs a number")?;
                threads = value.parse().map_err(|_| "--threads must be a number")?;
            }
            "--no-background" => background = false,
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}")),
            _ if root.is_none() => root = Some(PathBuf::from(arg)),
            _ => return Err(format!("unexpected argument {arg}")),
        }
    }
    let root = root.ok_or("usage: dw-scan <root> [--exclude <dir>]... [--min-file-size <bytes>] [--threads <n>] [--no-background]")?;
    Ok(Args { root, excludes, min_file_size, threads, background })
}

/// Lowers CPU, I/O and memory priority so a scan does not disturb foreground work.
fn enter_background_mode() {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, PROCESS_MODE_BACKGROUND_BEGIN, SetPriorityClass};
    unsafe {
        SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_BEGIN);
    }
}

fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    if args.background {
        enter_background_mode();
    }
    let started = Instant::now();
    let walker = Walker {
        excludes: args.excludes,
        min_file_size: args.min_file_size,
        counters: Counters::default(),
        errors: Mutex::new(Vec::new()),
        error_count: AtomicU64::new(0),
    };
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(args.threads)
        .stack_size(16 * 1024 * 1024)
        .build()
        .expect("thread pool");

    let walking = AtomicBool::new(true);
    let root = std::thread::scope(|scope| {
        scope.spawn(|| {
            while walking.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(250));
                let c = &walker.counters;
                let line = json!({
                    "t": "progress",
                    "files": c.files.load(Ordering::Relaxed),
                    "dirs": c.dirs.load(Ordering::Relaxed),
                    "bytes": c.bytes.load(Ordering::Relaxed),
                });
                let mut out = io::stdout().lock();
                if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                    std::process::exit(1);
                }
            }
        });
        let root_name = args.root.to_string_lossy().into_owned();
        let root = pool.install(|| walker.walk(&args.root, root_name));
        walking.store(false, Ordering::Relaxed);
        root
    });

    let result = (|| -> io::Result<()> {
        let mut out = BufWriter::with_capacity(1 << 20, io::stdout().lock());
        emit(&mut out, &root, None, &mut 1)?;
        for (path, message) in walker.errors.lock().unwrap().iter() {
            writeln!(out, "{}", json!({"t": "error", "path": path, "message": message}))?;
        }
        let done = json!({
            "t": "done",
            "size": root.size,
            "files": root.files,
            "dirs": walker.counters.dirs.load(Ordering::Relaxed),
            "errors": walker.error_count.load(Ordering::Relaxed),
            "ms": started.elapsed().as_millis() as u64,
        });
        writeln!(out, "{done}")?;
        out.flush()
    })();
    if result.is_err() {
        std::process::exit(1);
    }
}
