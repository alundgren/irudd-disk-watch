//! Read-only snapshots of processes using a failed deletion path.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Wdk::Storage::FileSystem::{FileProcessIdsUsingFileInformation, NtQueryInformationFile};
use windows_sys::Win32::Foundation::{
    ERROR_MORE_DATA, FILETIME, INVALID_HANDLE_VALUE, STATUS_BUFFER_OVERFLOW,
    STATUS_BUFFER_TOO_SMALL, STATUS_INFO_LENGTH_MISMATCH,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileVersionInfoSizeW,
    GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;
use windows_sys::Win32::System::RestartManager::{
    CCH_RM_SESSION_KEY, RM_PROCESS_INFO, RmEndSession, RmGetList, RmRegisterResources, RmStartSession,
};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

fn text(value: &[u16]) -> Option<String> {
    let end = value.iter().position(|&c| c == 0).unwrap_or(value.len());
    (end > 0).then(|| String::from_utf16_lossy(&value[..end]))
}

// A zero-access handle can query users even when an existing handle denies reads.
// OPEN_REPARSE_POINT keeps diagnosis on the link itself, like deletion.
fn handle_users(path: &Path) -> Result<Vec<u32>, String> {
    let file = OpenOptions::new()
        .access_mode(0)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("Could not query open handles: {error}"))?;
    for capacity in [256usize, 1024, 4096, 16384, 65536] {
        // ULONG count followed by an aligned, pointer-sized process ID array.
        let mut buffer = vec![0usize; capacity + 1];
        let mut status_block = IO_STATUS_BLOCK::default();
        let status = unsafe {
            NtQueryInformationFile(
                file.as_raw_handle(), &mut status_block, buffer.as_mut_ptr().cast(),
                (buffer.len() * size_of::<usize>()) as u32, FileProcessIdsUsingFileInformation,
            )
        };
        if status == 0 {
            let count = buffer[0] as u32 as usize;
            if count > capacity || status_block.Information < (count + 1) * size_of::<usize>() {
                return Err("Windows returned an incomplete open-handle list.".into());
            }
            return Ok(buffer[1..count + 1].iter().filter_map(|&pid| u32::try_from(pid).ok())
                .filter(|&pid| pid != 0 && pid != std::process::id()).collect());
        }
        if ![STATUS_INFO_LENGTH_MISMATCH, STATUS_BUFFER_OVERFLOW, STATUS_BUFFER_TOO_SMALL].contains(&status) {
            return Err(format!("Windows could not query open handles on this path (NT status 0x{:08X}).", status as u32));
        }
    }
    Err("The open-handle list exceeded the diagnostic limit.".into())
}

struct RestartSession(u32);
impl Drop for RestartSession {
    fn drop(&mut self) {
        unsafe { RmEndSession(self.0); }
    }
}

fn file_users(path: &Path) -> Result<Vec<RM_PROCESS_INFO>, String> {
    let mut handle = 0;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    let code = unsafe { RmStartSession(&mut handle, 0, key.as_mut_ptr()) };
    if code != 0 { return Err(format!("Restart Manager could not start: {}", io::Error::from_raw_os_error(code as i32))); }
    let session = RestartSession(handle);
    let filename = wide(path.as_os_str());
    let code = unsafe { RmRegisterResources(session.0, 1, &filename.as_ptr(), 0, null(), 0, null()) };
    if code != 0 { return Err(format!("Restart Manager could not query this file: {}", io::Error::from_raw_os_error(code as i32))); }
    let mut apps = Vec::<RM_PROCESS_INFO>::new();
    for _ in 0..5 {
        let mut needed = 0;
        let mut count = apps.len() as u32;
        let mut reasons = 0;
        let code = unsafe { RmGetList(session.0, &mut needed, &mut count,
            if apps.is_empty() { null_mut() } else { apps.as_mut_ptr() }, &mut reasons) };
        if code == 0 {
            if count as usize > apps.len() { return Err("Restart Manager returned an incomplete process list.".into()); }
            apps.truncate(count as usize);
            return Ok(apps);
        }
        if code != ERROR_MORE_DATA { return Err(format!("Restart Manager could not identify file users: {}", io::Error::from_raw_os_error(code as i32))); }
        if needed > 4096 { return Err("The Restart Manager process list exceeded the diagnostic limit.".into()); }
        apps.resize(needed.max(count + 1) as usize, RM_PROCESS_INFO::default());
    }
    Err("The processes using this file kept changing during lookup.".into())
}

fn process_names() -> BTreeMap<u32, String> {
    let mut names = BTreeMap::new();
    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() { return names; }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut valid = unsafe { Process32FirstW(handle.as_raw_handle(), &mut entry) };
    while valid != 0 {
        if let Some(name) = text(&entry.szExeFile) { names.insert(entry.th32ProcessID, name); }
        valid = unsafe { Process32NextW(handle.as_raw_handle(), &mut entry) };
    }
    names
}

fn version_name(path: &str) -> Option<String> {
    let filename = wide(std::ffi::OsStr::new(path));
    let size = unsafe { GetFileVersionInfoSizeW(filename.as_ptr(), null_mut()) };
    if size == 0 || size > 1024 * 1024 { return None; }
    let mut data = vec![0u32; (size as usize).div_ceil(4)];
    if unsafe { GetFileVersionInfoW(filename.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 { return None; }
    let query = |key: &str| -> Option<(*const u16, usize)> {
        let is_translation = key == r"\VarFileInfo\Translation";
        let key = wide(std::ffi::OsStr::new(key));
        let mut ptr = null_mut();
        let mut len = 0;
        if unsafe { VerQueryValueW(data.as_ptr().cast(), key.as_ptr(), &mut ptr, &mut len) } == 0 || ptr.is_null() { None }
        else {
            let start = data.as_ptr() as usize;
            let address = ptr as usize;
            let bytes = (len as usize).checked_mul(if is_translation { 1 } else { 2 })?;
            if address < start || address % 2 != 0 || address.checked_add(bytes)? > start + size as usize {
                None
            } else { Some((ptr.cast(), len as usize)) }
        }
    };
    let (languages, bytes) = query(r"\VarFileInfo\Translation")?;
    let languages = unsafe { std::slice::from_raw_parts(languages, bytes / 2) };
    for pair in languages.chunks_exact(2) {
        for field in ["FileDescription", "ProductName"] {
            let key = format!(r"\StringFileInfo\{:04x}{:04x}\{field}", pair[0], pair[1]);
            if let Some((value, len)) = query(&key)
                && let Some(name) = text(unsafe { std::slice::from_raw_parts(value, len) }) {
                return Some(name);
            }
        }
    }
    None
}

fn same_time(a: FILETIME, b: FILETIME) -> bool {
    a.dwLowDateTime == b.dwLowDateTime && a.dwHighDateTime == b.dwHighDateTime
}

fn process_info(pid: u32, rm: Option<&RM_PROCESS_INFO>, names: &BTreeMap<u32, String>) -> Value {
    let mut executable = None;
    let mut note = None;
    let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if !raw.is_null() {
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let times = unsafe { GetProcessTimes(handle.as_raw_handle(), &mut created, &mut exited, &mut kernel, &mut user) };
        if rm.is_some_and(|info| times == 0 || !same_time(created, info.Process.ProcessStartTime)) {
            return json!({ "pid": pid, "processName": null, "programName": null,
                "executablePath": null, "serviceName": null, "source": "restart_manager",
                "note": "The process exited or its PID changed during lookup. Metadata is unavailable." });
        }
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(handle.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut len) } != 0 {
            executable = text(&buffer[..len as usize]);
        } else { note = Some("Windows did not allow reading the executable path."); }
    } else {
        if let Some(info) = rm {
            return json!({ "pid": pid, "processName": null, "programName": text(&info.strAppName),
                "executablePath": null, "serviceName": text(&info.strServiceShortName), "source": "restart_manager",
                "note": "The process exited or Windows did not allow verifying this PID. Program details are from the lookup snapshot." });
        }
        note = Some("The process exited or Windows did not allow reading its executable path.");
    }
    let process_name = executable.as_ref().and_then(|path| Path::new(path).file_name())
        .map(|name| name.to_string_lossy().into_owned()).or_else(|| names.get(&pid).cloned());
    let program_name = rm.and_then(|info| text(&info.strAppName))
        .or_else(|| executable.as_deref().and_then(version_name));
    json!({ "pid": pid, "processName": process_name, "programName": program_name,
        "executablePath": executable, "serviceName": rm.and_then(|info| text(&info.strServiceShortName)),
        "source": if rm.is_some() { "restart_manager" } else { "open_handle" }, "note": note })
}

pub fn diagnose(path: &Path, error_code: Option<i32>) -> Value {
    if !matches!(error_code, Some(5 | 32 | 33 | 145)) {
        return json!({ "status": "not_checked", "processes": [],
            "note": "This failure does not indicate a file lock. Process lookup was not needed." });
    }
    let native = handle_users(path);
    // Restart Manager follows file names and rejects directories. Avoid links too.
    let is_file = fs::symlink_metadata(path).is_ok_and(|meta|
        meta.is_file() && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0);
    let rm = if is_file { Some(file_users(path)) } else { None };
    let mut users = BTreeMap::<u32, Option<RM_PROCESS_INFO>>::new();
    if let Ok(pids) = &native { for &pid in pids { users.insert(pid, None); } }
    if let Some(Ok(apps)) = &rm { for &app in apps {
        if app.Process.dwProcessId != 0 && app.Process.dwProcessId != std::process::id() {
            users.insert(app.Process.dwProcessId, Some(app));
        }
    } }
    let names = if users.is_empty() { BTreeMap::new() } else { process_names() };
    let processes: Vec<_> = users.iter().map(|(&pid, rm)| process_info(pid, rm.as_ref(), &names)).collect();
    let mut notes = vec!["This is a snapshot after deletion failed. Processes with open handles may allow deletion; Windows does not identify which handle caused the failure. One failed operation is shown per queued path. Owners can change before you retry.".to_owned()];
    if let Err(error) = &native { notes.push(error.clone()); }
    if let Some(Err(error)) = &rm { notes.push(error.clone()); }
    let status = if !processes.is_empty() { "found" }
        else if native.is_ok() || matches!(&rm, Some(Ok(_))) { "none" } else { "unavailable" };
    json!({ "status": status, "processes": processes, "note": notes.join(" ") })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delete::{Kind, Target, delete_path};
    use std::io::{BufRead, Read, Write};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows_sys::Win32::Storage::FileSystem::{FILE_ADD_FILE, FILE_LIST_DIRECTORY};

    struct FixtureLock(Child, io::BufReader<std::process::ChildStdout>);
    impl FixtureLock {
        fn new(path: &Path, mode: &str) -> Self {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "locks::tests::hold_fixture", "--ignored", "--nocapture"])
                .env("DISK_WATCH_LOCK_TEST_PATH", path)
                .env("DISK_WATCH_LOCK_TEST_MODE", mode)
                .creation_flags(0x08000000)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
            let mut output = io::BufReader::new(child.stdout.take().unwrap());
            loop {
                let mut line = String::new();
                assert!(output.read_line(&mut line).unwrap() > 0, "lock fixture exited before ready");
                if line.trim() == "LOCK_READY" { break; }
            }
            Self(child, output)
        }
    }
    impl Drop for FixtureLock {
        fn drop(&mut self) {
            drop(self.0.stdin.take());
            let _ = self.1.read_to_end(&mut Vec::new());
            let _ = self.0.wait();
        }
    }

    #[test]
    #[ignore = "child-process fixture invoked by lock tests"]
    fn hold_fixture() {
        let path = std::env::var_os("DISK_WATCH_LOCK_TEST_PATH").expect("fixture path");
        let mode = std::env::var("DISK_WATCH_LOCK_TEST_MODE").unwrap();
        let _file = if mode == "file" {
            OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(path).unwrap()
        } else {
            OpenOptions::new()
                .access_mode(if mode == "ancestor" { FILE_ADD_FILE } else { FILE_LIST_DIRECTORY })
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path).unwrap()
        };
        println!("LOCK_READY");
        io::stdout().flush().unwrap();
        let _ = io::stdin().read(&mut [0u8; 1]);
    }

    #[test]
    fn reports_child_file_directory_and_ancestor_owners_after_guards_drop() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let owned = std::env::temp_dir().join(format!("dw-lock-test-{unique}"));
        let root = owned.join("tracked");
        let folder = root.join("project").join("cache");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("locked.txt");
        fs::write(&file, b"keep").unwrap();
        fs::write(folder.join("good.txt"), b"remove").unwrap();
        let lock = FixtureLock::new(&file, "file");
        let other_lock = FixtureLock::new(&file, "file");
        let failure = delete_path(&root, &Target { path: folder.clone(), kind: Kind::Dir }).unwrap_err();
        assert!(failure.path.ends_with("cache/locked.txt"));
        assert!(!folder.join("good.txt").exists());
        let info = diagnose(&failure.path, failure.error.raw_os_error());
        assert_eq!(info["status"], "found", "{info}");
        let process = info["processes"].as_array().unwrap().iter().find(|p| p["pid"] == lock.0.id()).expect("child PID");
        assert!(process["processName"].as_str().unwrap().starts_with("dw_scan-"));
        assert!(process["executablePath"].as_str().unwrap().ends_with(".exe"));
        assert_eq!(process["source"], "restart_manager", "{info}");
        assert!(info["processes"].as_array().unwrap().iter().any(|p| p["pid"] == other_lock.0.id()), "{info}");
        assert!(info["processes"].as_array().unwrap().iter().all(|p| p["pid"] != std::process::id()));
        drop(lock);
        drop(other_lock);
        fs::remove_file(&file).unwrap();

        for (path, mode) in [(&folder, "directory"), (&owned, "ancestor")] {
            let lock = FixtureLock::new(path, mode);
            let failure = delete_path(&root, &Target { path: folder.clone(), kind: Kind::Dir }).unwrap_err();
            assert!(failure.path.ends_with(path.file_name().unwrap()), "{failure:?}");
            let info = diagnose(&failure.path, failure.error.raw_os_error());
            assert_eq!(info["status"], "found", "{info}");
            assert!(info["processes"].as_array().unwrap().iter().any(|p| p["pid"] == lock.0.id()), "{info}");
            drop(lock);
        }
        delete_path(&root, &Target { path: folder.clone(), kind: Kind::Dir }).unwrap();
        fs::remove_dir_all(owned).unwrap();
    }

    #[test]
    fn distinguishes_empty_unavailable_and_non_lock_errors() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let folder = std::env::temp_dir().join(format!("dw-no-lock-{unique}"));
        fs::create_dir(&folder).unwrap();
        assert_eq!(diagnose(&folder, Some(32))["status"], "none");
        assert_eq!(diagnose(&folder, None)["status"], "not_checked");
        fs::remove_dir(folder.clone()).unwrap();
        assert_eq!(diagnose(&folder, Some(32))["status"], "unavailable");
    }
}
