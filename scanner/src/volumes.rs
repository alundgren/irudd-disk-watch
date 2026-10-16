//! Mounted-volume choices are observations. Root inspection authorizes later work.
use crate::worker::{Control, Result, hash, safe};
use serde_json::{Value, json};
const LIMIT: usize = 1024;
#[derive(Default)]
struct Discovery {
    rows: Vec<Value>,
    errors: u64,
    truncated: bool,
    encoded_bytes: usize,
}
impl Discovery {
    fn add(&mut self, row: Value) -> bool {
        if self.rows.iter().any(|existing| existing["id"] == row["id"]) {
            return true;
        }
        let size = serde_json::to_vec(&row)
            .map(|bytes| bytes.len())
            .unwrap_or(usize::MAX);
        if self.rows.len() == LIMIT
            || self.encoded_bytes.saturating_add(size) > crate::worker::MAX_FRAME - 4096
        {
            self.truncated = true;
            return false;
        }
        self.encoded_bytes += size;
        self.rows.push(row);
        true
    }
}
pub fn discover(control: &Control) -> Result<Value> {
    control.check()?;
    let observed = crate::tree::now_ms();
    let result = platform(control)?;
    control.check()?;
    Ok(
        json!({"observedAt":observed,"volumes":result.rows,"truncated":result.truncated,"errors":result.errors}),
    )
}
#[cfg(unix)]
fn unix_row(
    path: &[u8],
    mount: &str,
    filesystem: &str,
    kind: &str,
    read_only: bool,
    capacity: Value,
    recommended: bool,
) -> Value {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let name = if path == b"/" {
        "Root filesystem".into()
    } else {
        crate::unix::label(path.rsplit(|&b| b == b'/').next().unwrap_or(path))
    };
    let key =
        serde_json::to_vec(&json!([std::env::consts::OS, STANDARD.encode(path), mount])).unwrap();
    json!({"id":format!("{}-{}",std::env::consts::OS,hash(&key)),"name":name,"path":crate::unix::label(path),"pathBytes":STANDARD.encode(path),"os":std::env::consts::OS,"mount":mount,"filesystem":filesystem,"kind":kind,"readOnly":read_only,"capacity":capacity,"recommended":recommended})
}
#[cfg(unix)]
fn capacity(blocks: u64, available: u64, block_size: u64) -> Result<Value> {
    Ok(
        json!({"total":safe(blocks.checked_mul(block_size).ok_or("Capacity overflow")?)?,"free":safe(available.checked_mul(block_size).ok_or("Capacity overflow")?)?}),
    )
}
#[cfg(target_os = "macos")]
fn local_mac_name(path: &std::path::Path) -> Result<String> {
    use std::os::unix::ffi::OsStrExt;
    let path =
        std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| "Invalid mount path")?;
    let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
    attrs.bitmapcount = 5;
    attrs.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_NAME;
    let mut buffer = [0u32; 1024];
    if unsafe {
        libc::getattrlist(
            path.as_ptr(),
            (&mut attrs as *mut libc::attrlist).cast(),
            buffer.as_mut_ptr().cast(),
            std::mem::size_of_val(&buffer),
            (libc::FSOPT_NOFOLLOW | libc::FSOPT_RETURN_REALDEV) as _,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let start = 4i64 + buffer[1] as i32 as i64;
    let length = buffer[2] as usize;
    if start < 12
        || length < 2
        || start as usize + length > buffer[0] as usize
        || buffer[0] as usize > std::mem::size_of_val(&buffer)
    {
        return Err("Invalid native volume name".into());
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>().add(start as usize), length)
    };
    if bytes[length - 1] != 0 || bytes[..length - 1].contains(&0) {
        return Err("Invalid volume name bytes".into());
    }
    Ok(crate::unix::label(&bytes[..length - 1]))
}
#[cfg(target_os = "macos")]
fn platform(control: &Control) -> Result<Discovery> {
    use std::{
        ffi::CStr,
        os::unix::{ffi::OsStringExt, fs::MetadataExt},
    };
    let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if count < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let allocated = (count as usize + 16).min(4096);
    let mut buffer: Vec<libc::statfs> = (0..allocated)
        .map(|_| unsafe { std::mem::zeroed() })
        .collect();
    let returned = unsafe {
        libc::getfsstat(
            buffer.as_mut_ptr(),
            (buffer.len() * std::mem::size_of::<libc::statfs>()) as _,
            libc::MNT_NOWAIT,
        )
    };
    if returned < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut result = Discovery::default();
    result.truncated = count as usize > allocated || returned as usize >= allocated;
    for entry in buffer.iter().take((returned as usize).min(allocated)) {
        control.check()?;
        if result.rows.len() == LIMIT {
            result.truncated = true;
            break;
        }
        let path = unsafe { CStr::from_ptr(entry.f_mntonname.as_ptr()) }.to_bytes();
        let filesystem = unsafe { CStr::from_ptr(entry.f_fstypename.as_ptr()) }.to_string_lossy();
        if matches!(filesystem.as_ref(), "devfs" | "autofs" | "fdesc" | "procfs") {
            continue;
        }
        if !path.starts_with(b"/") || path.is_empty() {
            result.errors += 1;
            continue;
        }
        let fsid_bytes = unsafe {
            std::slice::from_raw_parts((&entry.f_fsid as *const libc::fsid_t).cast::<u8>(), 8)
        };
        let mount = u64::from_ne_bytes(fsid_bytes.try_into().unwrap()).to_string();
        let local = entry.f_flags & libc::MNT_LOCAL as u32 != 0;
        let system = path == b"/"
            || path.starts_with(b"/System/Volumes/") && path != b"/System/Volumes/Data";
        let read_only = entry.f_flags & libc::MNT_RDONLY as u32 != 0;
        // MNT_REMOVABLE is a native mount flag, independent of whether media uses USB.
        let kind = if system {
            "system"
        } else if !local {
            "network"
        } else if entry.f_flags & 0x200 != 0 {
            "removable"
        } else {
            "local"
        };
        let recommended = local
            && !read_only
            && !system
            && (path == b"/System/Volumes/Data"
                || entry.f_flags & libc::MNT_DONTBROWSE as u32 == 0);
        let bytes_capacity = if entry.f_bsize > 0 {
            capacity(entry.f_blocks, entry.f_bavail, entry.f_bsize as u64)
        } else {
            Err("Invalid cached block size".into())
        };
        let bytes_capacity = match bytes_capacity {
            Ok(v) => v,
            Err(_) => {
                result.errors += 1;
                Value::Null
            }
        };
        let mut row = unix_row(
            path,
            &mount,
            &filesystem,
            kind,
            read_only,
            bytes_capacity,
            recommended,
        );
        if local
            && matches!(
                filesystem.as_ref(),
                "apfs" | "hfs" | "msdos" | "exfat" | "ntfs" | "cd9660" | "udf" | "ufs"
            )
        {
            let native_path = std::path::PathBuf::from(std::ffi::OsString::from_vec(path.to_vec()));
            match std::fs::symlink_metadata(&native_path) {
                Ok(meta) => row["device"] = json!(meta.dev().to_string()),
                Err(_) => result.errors += 1,
            }
            match local_mac_name(&native_path) {
                Ok(name) => row["name"] = json!(name),
                Err(_) => result.errors += 1,
            }
        }
        if !result.add(row) {
            break;
        }
    }
    Ok(result)
}
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct Mount {
    id: String,
    device: u64,
    path: Vec<u8>,
    filesystem: String,
    read_only: bool,
}
#[cfg(target_os = "linux")]
fn mount_path(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            let code = bytes.get(i + 1..i + 4).ok_or("Truncated mount escape")?;
            out.push(match code {
                b"040" => b' ',
                b"011" => b'\t',
                b"012" => b'\n',
                b"134" => b'\\',
                _ => return Err("Invalid mount escape".into()),
            });
            i += 4;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    if !out.starts_with(b"/") || out.contains(&0) {
        return Err("Invalid mount path".into());
    }
    Ok(out)
}
#[cfg(target_os = "linux")]
fn parse_mount(line: &[u8]) -> Result<Mount> {
    let fields = line.split(|&b| b == b' ').collect::<Vec<_>>();
    let split = fields
        .iter()
        .position(|&v| v == b"-")
        .ok_or("Missing mount separator")?;
    if split < 6 || fields.len() < split + 4 {
        return Err("Truncated mount entry".into());
    }
    let text = |bytes: &[u8]| {
        std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| "Invalid mount metadata".to_owned())
    };
    let id = text(fields[0])?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid mount ID".into());
    }
    let device = text(fields[2])?;
    let (major, minor) = device.split_once(':').ok_or("Invalid native device")?;
    let major = major.parse::<u32>().map_err(|_| "Invalid device major")?;
    let minor = minor.parse::<u32>().map_err(|_| "Invalid device minor")?;
    let read_only = fields[5].split(|&b| b == b',').any(|v| v == b"ro");
    Ok(Mount {
        id,
        device: libc::makedev(major, minor),
        path: mount_path(fields[4])?,
        filesystem: text(fields[split + 1])?,
        read_only,
    })
}
#[cfg(target_os = "linux")]
fn pseudo(filesystem: &str, path: &[u8]) -> bool {
    if path == b"/" {
        return false;
    }
    matches!(
        filesystem,
        "proc"
            | "sysfs"
            | "devtmpfs"
            | "devpts"
            | "cgroup"
            | "cgroup2"
            | "securityfs"
            | "pstore"
            | "debugfs"
            | "tracefs"
            | "configfs"
            | "bpf"
            | "autofs"
            | "mqueue"
            | "hugetlbfs"
            | "nsfs"
            | "fusectl"
            | "binfmt_misc"
            | "rpc_pipefs"
            | "efivarfs"
    ) || (filesystem == "tmpfs"
        && [b"/dev".as_slice(), b"/run", b"/sys", b"/proc"]
            .iter()
            .any(|prefix| {
                path == *prefix || path.starts_with(&[prefix.to_vec(), b"/".to_vec()].concat())
            }))
}
#[cfg(target_os = "linux")]
fn network(filesystem: &str) -> bool {
    matches!(
        filesystem,
        "nfs" | "nfs4" | "cifs" | "smb3" | "smbfs" | "9p" | "ceph" | "glusterfs" | "afs" | "davfs"
    ) || filesystem.starts_with("fuse.sshfs")
        || filesystem.starts_with("fuse.rclone")
}
#[cfg(target_os = "linux")]
fn local_filesystem(name: &str) -> bool {
    matches!(
        name,
        "ext4"
            | "ext3"
            | "ext2"
            | "xfs"
            | "btrfs"
            | "vfat"
            | "exfat"
            | "ntfs"
            | "ntfs3"
            | "f2fs"
            | "zfs"
            | "overlay"
            | "tmpfs"
            | "ramfs"
            | "iso9660"
            | "udf"
            | "squashfs"
    )
}
#[cfg(target_os = "linux")]
fn local_directory(path: &std::path::Path) -> Result<bool> {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.is_dir())
        .map_err(|e| e.to_string())
}
#[cfg(target_os = "linux")]
fn linux_capacity(path: &[u8]) -> Result<Value> {
    let path = std::ffi::CString::new(path).map_err(|_| "Invalid mount path")?;
    let mut data = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::statvfs(path.as_ptr(), data.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let data = unsafe { data.assume_init() };
    capacity(data.f_blocks, data.f_bavail, data.f_frsize)
}
#[cfg(target_os = "linux")]
fn removable(device: u64) -> bool {
    let path = std::path::PathBuf::from(format!(
        "/sys/dev/block/{}:{}",
        libc::major(device),
        libc::minor(device)
    ));
    let Ok(path) = std::fs::canonicalize(path) else {
        return false;
    };
    [Some(path.as_path()), path.parent()]
        .into_iter()
        .flatten()
        .any(|path| {
            std::fs::read(path.join("removable")).is_ok_and(|bytes| bytes.starts_with(b"1"))
        })
}
#[cfg(target_os = "linux")]
fn platform(control: &Control) -> Result<Discovery> {
    use std::io::Read;
    const BYTES: usize = 8 * 1024 * 1024;
    let mut data = Vec::new();
    std::fs::File::open("/proc/self/mountinfo")
        .map_err(|e| e.to_string())?
        .take(BYTES as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    let mut result = Discovery::default();
    if data.len() > BYTES {
        result.truncated = true;
        data.truncate(
            data.iter()
                .take(BYTES)
                .rposition(|&b| b == b'\n')
                .unwrap_or(0),
        );
    }
    for line in data.split(|&b| b == b'\n').filter(|line| !line.is_empty()) {
        control.check()?;
        if result.rows.len() == LIMIT {
            result.truncated = true;
            break;
        }
        let entry = match parse_mount(line) {
            Ok(v) => v,
            Err(_) => {
                result.errors += 1;
                continue;
            }
        };
        if pseudo(&entry.filesystem, &entry.path) {
            continue;
        }
        let net = network(&entry.filesystem);
        let system = entry.path == b"/boot" || entry.path.starts_with(b"/boot/");
        let kind = if net {
            "network"
        } else if system {
            "system"
        } else if removable(entry.device) {
            "removable"
        } else {
            "local"
        };
        let local = local_filesystem(&entry.filesystem) && !net;
        if local {
            use std::os::unix::ffi::OsStringExt;
            let path = std::path::PathBuf::from(std::ffi::OsString::from_vec(entry.path.clone()));
            match local_directory(&path) {
                Ok(false) => continue,
                Ok(true) => (),
                Err(_) => result.errors += 1,
            }
        }
        let bytes = if !local {
            Value::Null
        } else {
            match linux_capacity(&entry.path) {
                Ok(v) => v,
                Err(_) => {
                    result.errors += 1;
                    Value::Null
                }
            }
        };
        // Container layers (such as Docker's overlay mounts) and mounts without a readable capacity are
        // listed but not suggested, so the root filesystem is the usual recommendation.
        let recommended = local
            && !system
            && !entry.read_only
            && !matches!(entry.filesystem.as_str(), "tmpfs" | "overlay" | "squashfs")
            && !bytes.is_null();
        let mut row = unix_row(
            &entry.path,
            &entry.id,
            &entry.filesystem,
            kind,
            entry.read_only,
            bytes,
            recommended,
        );
        row["device"] = json!(entry.device.to_string());
        if !result.add(row) {
            break;
        }
    }
    Ok(result)
}

#[cfg(windows)]
fn windows_paths(buffer: &[u16]) -> Vec<String> {
    buffer
        .split(|&c| c == 0)
        .take_while(|part| !part.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}
#[cfg(windows)]
fn windows_row(path: &str, result: &mut Discovery) -> Option<Value> {
    use windows_sys::Win32::{
        Storage::FileSystem::*,
        System::{SystemServices::FILE_READ_ONLY_VOLUME, WindowsProgramming::*},
    };
    let wide = path.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
    if matches!(kind, DRIVE_UNKNOWN | DRIVE_NO_ROOT_DIR) {
        return None;
    }
    let id = format!("windows-{}", hash(path.to_lowercase().as_bytes()));
    if kind == DRIVE_REMOTE {
        return Some(
            json!({"id":id,"name":format!("Network drive ({path})"),"path":path,"os":"windows","filesystem":null,"kind":"network","readOnly":null,"capacity":null,"recommended":false}),
        );
    }
    let mut label = [0u16; 256];
    let mut filesystem = [0u16; 256];
    let mut serial = 0;
    let mut flags = 0;
    let known = unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            label.as_mut_ptr(),
            label.len() as _,
            &mut serial,
            std::ptr::null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as _,
        )
    } != 0;
    if !known {
        result.errors += 1;
        return None;
    }
    let decode = |words: &[u16]| {
        String::from_utf16_lossy(
            &words[..words.iter().position(|&c| c == 0).unwrap_or(words.len())],
        )
    };
    let name = decode(&label);
    let name = if name.is_empty() {
        path.to_owned()
    } else {
        name
    };
    let mut free = 0;
    let mut total = 0;
    let capacity = if unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut())
    } != 0
    {
        match (safe(total), safe(free)) {
            (Ok(total), Ok(free)) => json!({"total":total,"free":free}),
            _ => {
                result.errors += 1;
                Value::Null
            }
        }
    } else {
        result.errors += 1;
        Value::Null
    };
    let read_only = flags & FILE_READ_ONLY_VOLUME != 0;
    Some(
        json!({"id":id,"name":name,"path":path,"os":"windows","filesystem":decode(&filesystem),"kind":if matches!(kind,DRIVE_REMOVABLE|DRIVE_CDROM){"removable"}else{"local"},"readOnly":read_only,"capacity":capacity,"recommended":matches!(kind,DRIVE_FIXED|DRIVE_REMOVABLE)&&!read_only,"device":serial.to_string(),"mount":serial.to_string()}),
    )
}
#[cfg(windows)]
fn platform(control: &Control) -> Result<Discovery> {
    use windows_sys::Win32::{
        Foundation::{ERROR_NO_MORE_FILES, GetLastError, INVALID_HANDLE_VALUE},
        Storage::FileSystem::*,
        System::Diagnostics::Debug::{
            SEM_FAILCRITICALERRORS, SEM_NOOPENFILEERRORBOX, SetThreadErrorMode,
        },
    };
    let mut old_mode = 0;
    if unsafe {
        SetThreadErrorMode(
            SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX,
            &mut old_mode,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let result = (|| {
        let mut result = Discovery::default();
        let mut paths = Vec::new();
        let mut logical = vec![0u16; 32768];
        let length = unsafe { GetLogicalDriveStringsW(logical.len() as _, logical.as_mut_ptr()) };
        if length == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if length as usize >= logical.len() {
            result.truncated = true;
            result.errors += 1;
        } else {
            paths.extend(windows_paths(&logical));
        }
        let mut name = vec![0u16; 1024];
        let handle = unsafe { FindFirstVolumeW(name.as_mut_ptr(), name.len() as _) };
        if handle == INVALID_HANDLE_VALUE {
            result.errors += 1;
        } else {
            let enumeration = (|| -> Result<()> {
                for index in 0..4096 {
                    control.check()?;
                    let mut mount_paths = vec![0u16; 32768];
                    let mut needed = 0;
                    if unsafe {
                        GetVolumePathNamesForVolumeNameW(
                            name.as_ptr(),
                            mount_paths.as_mut_ptr(),
                            mount_paths.len() as _,
                            &mut needed,
                        )
                    } != 0
                    {
                        paths.extend(windows_paths(&mount_paths));
                    } else {
                        result.errors += 1;
                        if needed as usize > mount_paths.len() {
                            result.truncated = true;
                        }
                    }
                    if paths.len() > 4096 {
                        result.truncated = true;
                        break;
                    }
                    if unsafe { FindNextVolumeW(handle, name.as_mut_ptr(), name.len() as _) } == 0 {
                        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
                            result.errors += 1;
                        }
                        break;
                    }
                    if index == 4095 {
                        result.truncated = true;
                    }
                }
                Ok(())
            })();
            unsafe {
                FindVolumeClose(handle);
            }
            enumeration?;
        }
        let mut seen = std::collections::HashSet::new();
        for path in paths {
            control.check()?;
            if !seen.insert(path.to_lowercase()) {
                continue;
            }
            if result.rows.len() == LIMIT {
                result.truncated = true;
                break;
            }
            if let Some(row) = windows_row(&path, &mut result) {
                if !result.add(row) {
                    break;
                }
            }
        }
        Ok(result)
    })();
    unsafe {
        SetThreadErrorMode(old_mode, std::ptr::null_mut());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_rows_are_bounded_and_ids_are_unique() {
        let mut d = Discovery::default();
        d.add(json!({"id":"same"}));
        d.add(json!({"id":"same"}));
        assert_eq!(d.rows.len(), 1);
        for n in 1..LIMIT + 1 {
            d.add(json!({"id":n.to_string()}));
        }
        assert_eq!(d.rows.len(), LIMIT);
        assert!(d.truncated);
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn mountinfo_paths_preserve_raw_bytes_and_decode_only_native_escapes() {
        let row=parse_mount(b"42 1 8:17 / /media/a\\040b\\134c\\011d\\012\xff rw shared:2 future:ok - ext4 /dev/vdb1 rw").unwrap();
        assert_eq!(row.path, b"/media/a b\\c\td\n\xff");
        assert_eq!(row.id, "42");
        assert_eq!(row.device, libc::makedev(8, 17));
        assert!(!row.read_only);
        assert_eq!(row.filesystem, "ext4");
        for path in [b"/bad\\".as_slice(), b"/bad\\123", b"relative", b"/bad\0"] {
            assert!(mount_path(path).is_err());
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn mountinfo_handles_bind_ids_readonly_network_and_pseudo_policy() {
        let a = parse_mount(b"42 1 8:17 / /media/a ro - ext4 /dev/vdb1 rw").unwrap();
        let b = parse_mount(b"43 1 8:17 /dir /media/b rw - ext4 /dev/vdb1 rw").unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(a.device, b.device);
        assert!(a.read_only);
        assert!(pseudo("proc", b"/proc"));
        assert!(pseudo("tmpfs", b"/run/user/1000"));
        assert!(!pseudo("tmpfs", b"/mnt/ram"));
        assert!(network("nfs4"));
        assert!(network("fuse.sshfs"));
        assert!(!network("ext4"));
        assert!(parse_mount(b"missing fields").is_err());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn local_file_mounts_are_not_directory_choices_and_root_is_retained() {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!(
            "disk-watch-volume-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        std::fs::write(path.join("file"), b"fixture").unwrap();
        std::fs::create_dir(path.join("directory")).unwrap();
        let directory = local_directory(&path.join("directory"));
        let file = local_directory(&path.join("file"));
        std::fs::remove_dir_all(&path).unwrap();
        assert!(directory.unwrap());
        assert!(!file.unwrap());
        assert!(!pseudo("proc", b"/"));
        assert!(!pseudo("tmpfs", b"/"));
        assert!(local_directory(std::path::Path::new("/")).unwrap());
    }
    #[cfg(windows)]
    #[test]
    fn windows_multistring_keeps_drive_and_folder_mounts() {
        let words = "C:\\\0C:\\Mounted volume\\\0\0"
            .encode_utf16()
            .collect::<Vec<_>>();
        assert_eq!(windows_paths(&words), vec!["C:\\", "C:\\Mounted volume\\"]);
    }
}
