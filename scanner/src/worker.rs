//! One operation per process, with a separate bounded control reader.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

pub const MAX_FRAME: usize = 4 * 1024 * 1024;
pub const MAX_SAFE: u64 = 9_007_199_254_740_991;
pub type Result<T> = std::result::Result<T, String>;
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
pub fn safe(n: u64) -> Result<u64> {
    if n > MAX_SAFE {
        Err("Numeric measure exceeds JavaScript safe integer".into())
    } else {
        Ok(n)
    }
}
pub fn emit(value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FRAME {
        return Err("Output frame exceeds limit".into());
    }
    let mut out = io::stdout().lock();
    out.write_all(&bytes)
        .and_then(|_| out.write_all(b"\n"))
        .and_then(|_| out.flush())
        .map_err(|e| e.to_string())
}
fn read_frame(reader: &mut impl BufRead) -> Result<Value> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|e| e.to_string())?;
        if available.is_empty() {
            return Err("Control input closed".into());
        }
        let end = available.iter().position(|&b| b == b'\n');
        let count = end.map_or(available.len(), |i| i + 1);
        if bytes.len() + count > MAX_FRAME + 1 {
            return Err("Input frame exceeds limit".into());
        }
        bytes.extend_from_slice(&available[..count]);
        reader.consume(count);
        if end.is_some() {
            break;
        }
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid JSON frame: {e}"))
}
#[derive(Clone)]
pub struct Control {
    stopped: Arc<AtomicBool>,
    last: Arc<Mutex<Instant>>,
}
impl Control {
    fn start(mut input: impl BufRead + Send + 'static, id: String) -> Self {
        let state = Self {
            stopped: Arc::new(AtomicBool::new(false)),
            last: Arc::new(Mutex::new(Instant::now())),
        };
        let other = state.clone();
        std::thread::spawn(move || {
            loop {
                match read_frame(&mut input) {
                    Ok(v) if v["requestId"] == id && v["op"] == "ping" => {
                        *other.last.lock().unwrap() = Instant::now()
                    }
                    _ => {
                        other.stopped.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        });
        let watchdog = state.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(250));
                if watchdog.check().is_err() {
                    // Give cleanup time to persist its interrupted receipt before forcing a
                    // blocked output writer or filesystem call to terminate.
                    std::thread::sleep(Duration::from_secs(2));
                    std::process::exit(1);
                }
            }
        });
        state
    }
    pub fn check(&self) -> Result<()> {
        if self.stopped.load(Ordering::SeqCst)
            || self.last.lock().unwrap().elapsed() > Duration::from_secs(20)
        {
            Err("Operation cancelled or controller disconnected".into())
        } else {
            Ok(())
        }
    }
    #[cfg(test)]
    pub fn testing() -> Self {
        Self {
            stopped: Arc::new(AtomicBool::new(false)),
            last: Arc::new(Mutex::new(Instant::now())),
        }
    }
}
pub fn state_path() -> Result<PathBuf> {
    let args: Vec<_> = std::env::args().skip(2).collect();
    if !args.is_empty() {
        if args.len() != 2 || args[0] != "--state-dir" || !Path::new(&args[1]).is_absolute() {
            return Err("Expected --state-dir ABSOLUTE_PRIVATE_DIRECTORY".into());
        }
        return Ok(PathBuf::from(&args[1]));
    }
    #[cfg(unix)]
    {
        let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
        #[cfg(target_os = "macos")]
        let tail = "Library/Application Support/Disk Watch/native-worker";
        #[cfg(not(target_os = "macos"))]
        let tail = ".local/state/disk-watch/native-worker";
        Ok(PathBuf::from(home).join(tail))
    }
    #[cfg(windows)]
    {
        Ok(
            PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?)
                .join("Disk Watch/native-worker"),
        )
    }
}
fn execute() -> Result<()> {
    let mut input = io::BufReader::new(io::stdin());
    let request = read_frame(&mut input)?;
    if request["v"] != 1 {
        return Err("Unsupported protocol version".into());
    }
    let id = string(&request, "requestId")?;
    if id.is_empty() || id.len() > 256 {
        return Err("Invalid requestId".into());
    }
    let op = string(&request, "op")?;
    let state = state_path()?;
    #[cfg(unix)]
    let worker = crate::unix::worker_identity(&state)?;
    #[cfg(windows)]
    let worker = crate::windows_worker::worker_identity(&state)?;
    emit(&json!({"t":"hello","v":1,"requestId":id,"worker":worker}))?;
    if op != "hello"
        && (request["expectedWorker"]["id"] != worker["id"]
            || request["expectedWorker"]["account"] != worker["account"])
    {
        return Err("Worker installation or account changed".into());
    }
    let control = Control::start(input, id.to_owned());
    if op == "hello" {
        return emit(&json!({"t":"result","value":worker}));
    }
    #[cfg(unix)]
    let value = crate::unix::dispatch(&state, &request, &worker, &control)?;
    #[cfg(windows)]
    let value = {
        control.check()?;
        crate::windows_worker::dispatch(&request)?
    };
    if let Some(value) = value {
        emit(&json!({"t":"result","value":value}))?;
    }
    Ok(())
}
pub fn run() -> i32 {
    match execute() {
        Ok(()) => 0,
        Err(message) => {
            let _ = emit(
                &json!({"t":"fatal","message":message.chars().take(4096).collect::<String>()}),
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_is_bounded_and_requires_newline() {
        assert!(read_frame(&mut io::Cursor::new(b"{}".to_vec())).is_err());
        assert!(read_frame(&mut io::Cursor::new(vec![b' '; MAX_FRAME + 2])).is_err());
        assert_eq!(
            read_frame(&mut io::Cursor::new(b"{\"v\":1}\n".to_vec())).unwrap()["v"],
            1
        );
    }
    #[test]
    fn eof_cancel_and_deadline_stop_operations() {
        let c = Control::testing();
        assert!(c.check().is_ok());
        *c.last.lock().unwrap() = Instant::now() - Duration::from_secs(21);
        assert!(c.check().is_err());
        let c = Control::testing();
        c.stopped.store(true, Ordering::SeqCst);
        assert!(c.check().is_err());
    }
}
