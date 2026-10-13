//! Scans a drive or folder and prints its tree as NDJSON on stdout.
//!
//! While scanning it prints `progress` lines. When the scan finishes it prints the
//! tree in pre-order (every dir line comes before its children), then `error`
//! lines, then a final `done` line that names the method used. Files under
//! `--min-file-size` are folded into one `rest` line per directory.
//!
//! `--method auto` reads the NTFS MFT when it can and falls back to listing folders.

mod mft;
mod tree;
mod walk;

use serde_json::json;
use std::collections::HashSet;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tree::{Counters, Dir, emit};
use walk::{Walker, exclude_key};

#[derive(Clone, Copy, PartialEq)]
enum Method {
    Auto,
    Mft,
    Walk,
}

struct Args {
    root: PathBuf,
    excludes: Vec<String>,
    min_file_size: u64,
    threads: usize,
    background: bool,
    method: Method,
}

fn parse_args() -> Result<Args, String> {
    let mut root = None;
    let mut excludes = Vec::new();
    let mut min_file_size = 1024 * 1024;
    let mut threads = std::thread::available_parallelism().map_or(8, |n| n.get());
    let mut background = true;
    let mut method = Method::Auto;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--exclude" => excludes.push(it.next().ok_or("--exclude needs a path")?),
            "--min-file-size" => {
                let value = it.next().ok_or("--min-file-size needs a number")?;
                min_file_size = value.parse().map_err(|_| "--min-file-size must be a number")?;
            }
            "--threads" => {
                let value = it.next().ok_or("--threads needs a number")?;
                threads = value.parse().map_err(|_| "--threads must be a number")?;
            }
            "--method" => {
                method = match it.next().as_deref() {
                    Some("auto") => Method::Auto,
                    Some("mft") => Method::Mft,
                    Some("walk") => Method::Walk,
                    _ => return Err("--method must be auto, mft or walk".into()),
                }
            }
            "--no-background" => background = false,
            _ if arg.starts_with("--") => return Err(format!("unknown flag {arg}")),
            _ if root.is_none() => root = Some(PathBuf::from(arg)),
            _ => return Err(format!("unexpected argument {arg}")),
        }
    }
    let root = root.ok_or(
        "usage: dw-scan <root> [--exclude <dir>]... [--min-file-size <bytes>] [--threads <n>] \
         [--method auto|mft|walk] [--no-background]",
    )?;
    Ok(Args { root, excludes, min_file_size, threads, background, method })
}

/// Lowers CPU, I/O and memory priority so a scan does not disturb foreground work.
fn enter_background_mode() {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, PROCESS_MODE_BACKGROUND_BEGIN, SetPriorityClass};
    unsafe {
        SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_BEGIN);
    }
}

struct Outcome {
    root: Dir,
    method: &'static str,
    fallback: Option<String>,
    errors: Vec<(String, String)>,
    error_count: u64,
}

fn walk(args: &Args, counters: &Counters, fallback: Option<String>) -> Outcome {
    let walker = Walker {
        excludes: args.excludes.iter().map(|e| exclude_key(Path::new(e))).collect::<HashSet<_>>(),
        min_file_size: args.min_file_size,
        counters,
        errors: Mutex::new(Vec::new()),
        error_count: AtomicU64::new(0),
    };
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(args.threads)
        .stack_size(16 * 1024 * 1024)
        .build()
        .expect("thread pool");
    let root = pool.install(|| walker.walk(&args.root, args.root.to_string_lossy().into_owned()));
    Outcome {
        root,
        method: "walk",
        fallback,
        errors: walker.errors.into_inner().unwrap(),
        error_count: walker.error_count.load(Ordering::Relaxed),
    }
}

fn scan(args: &Args, counters: &Counters) -> Result<Outcome, String> {
    if args.method == Method::Walk {
        return Ok(walk(args, counters, None));
    }
    match mft::scan(&args.root, &args.excludes, args.min_file_size, counters) {
        Ok(root) => Ok(Outcome { root, method: "mft", fallback: None, errors: Vec::new(), error_count: 0 }),
        Err(reason) if args.method == Method::Auto => {
            for counter in [&counters.files, &counters.dirs, &counters.bytes] {
                counter.store(0, Ordering::Relaxed);
            }
            Ok(walk(args, counters, Some(reason)))
        }
        Err(reason) => Err(reason),
    }
}

fn write_result(outcome: &Outcome, scan_ms: u64) -> io::Result<()> {
    let mut out = BufWriter::with_capacity(1 << 20, io::stdout().lock());
    emit(&mut out, &outcome.root, None, &mut 1)?;
    for (path, message) in &outcome.errors {
        writeln!(out, "{}", json!({"t": "error", "path": path, "message": message}))?;
    }
    let mut dirs = 0u64;
    let mut stack = vec![&outcome.root];
    while let Some(dir) = stack.pop() {
        dirs += 1;
        stack.extend(&dir.subdirs);
    }
    let done = json!({
        "t": "done",
        "size": outcome.root.size,
        "files": outcome.root.files,
        "dirs": dirs,
        "errors": outcome.error_count,
        "ms": scan_ms,
        "method": outcome.method,
        "fallback": outcome.fallback,
    });
    writeln!(out, "{done}")?;
    out.flush()
}

fn run(args: Args) -> i32 {
    if args.background {
        enter_background_mode();
    }
    let started = Instant::now();
    let counters = Counters::default();
    let scanning = AtomicBool::new(true);
    let result = std::thread::scope(|scope| {
        let progress = scope.spawn(|| {
            while scanning.load(Ordering::Relaxed) {
                std::thread::park_timeout(Duration::from_millis(250));
                let line = json!({
                    "t": "progress",
                    "files": counters.files.load(Ordering::Relaxed),
                    "dirs": counters.dirs.load(Ordering::Relaxed),
                    "bytes": counters.bytes.load(Ordering::Relaxed),
                });
                let mut out = io::stdout().lock();
                if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                    std::process::exit(1);
                }
            }
        });
        let result = scan(&args, &counters);
        scanning.store(false, Ordering::Relaxed);
        progress.thread().unpark();
        result
    });
    let scan_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(outcome) => match write_result(&outcome, scan_ms) {
            Ok(()) => 0,
            Err(_) => 1,
        },
        Err(reason) => {
            eprintln!("{reason}");
            1
        }
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
    // Building and printing the tree recurses once per folder level.
    let code = std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(move || run(args))
        .expect("scan thread")
        .join()
        .unwrap_or(1);
    std::process::exit(code);
}
