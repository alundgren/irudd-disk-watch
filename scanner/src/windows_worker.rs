//! Windows worker mode inspects roots; scanning and deletion use the direct CLI.
use crate::worker::{Result, hash, safe, string};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::*;
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
pub fn worker_identity(state: &Path) -> Result<Value> {
    fs::create_dir_all(state).map_err(|e| e.to_string())?;
    let path = state.join("installation.id");
    let id = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            let mut random = [0u8; 32];
            if unsafe {
                windows_sys::Win32::Security::Cryptography::BCryptGenRandom(
                    std::ptr::null_mut(),
                    random.as_mut_ptr(),
                    random.len() as u32,
                    windows_sys::Win32::Security::Cryptography::BCRYPT_USE_SYSTEM_PREFERRED_RNG,
                )
            } < 0
            {
                return Err("Native random generation failed".into());
            }
            let id = hash(&random);
            file.write_all(id.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            id
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let mut id = String::new();
            File::open(path)
                .and_then(|f| f.take(128).read_to_string(&mut id))
                .map_err(|e| e.to_string())?;
            if id.len() != 64 {
                return Err("Invalid worker identity file".into());
            }
            id
        }
        Err(e) => return Err(e.to_string()),
    };
    let account = native_account()?;
    Ok(
        json!({"id":id,"account":account,"os":"windows","version":1,"capabilities":{"scan":false,"delete":false}}),
    )
}
fn native_account() -> Result<String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER,
            TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let result = (|| {
        let mut required = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
        }
        if required == 0 || required > 65536 {
            return Err("Invalid account token length".into());
        }
        let mut data = vec![0u64; (required as usize).div_ceil(8)];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                data.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let user = unsafe { &*(data.as_ptr().cast::<TOKEN_USER>()) };
        let mut sid = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut sid) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut len = 0;
        while unsafe { *sid.add(len) } != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(sid, len) });
        unsafe {
            LocalFree(sid.cast());
        }
        Ok(text)
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}
fn display_path(text: &str) -> String {
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(text).to_owned()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extended_paths_keep_drive_and_unc_roots() {
        assert_eq!(
            display_path(r"\\?\UNC\server\share\folder"),
            r"\\server\share\folder"
        );
        assert_eq!(display_path(r"\\?\C:\folder"), r"C:\folder");
    }
}
fn inspect(path: &Path) -> Result<Value> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !path.is_dir() {
        return Err("Tracked root must be a directory".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let info = unsafe { info.assume_init() };
    let mut volume = vec![0u16; 32768];
    let input = wide(&path);
    if unsafe { GetVolumePathNameW(input.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut filesystem = [0u16; 256];
    let mut flags = 0;
    let mut serial = 0;
    if unsafe {
        GetVolumeInformationW(
            volume.as_ptr(),
            std::ptr::null_mut(),
            0,
            &mut serial,
            std::ptr::null_mut(),
            &mut flags,
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let (mut free, mut total) = (0, 0);
    let capacity = if unsafe {
        GetDiskFreeSpaceExW(input.as_ptr(), &mut free, &mut total, std::ptr::null_mut())
    } != 0
    {
        json!({"total":safe(total)?,"free":safe(free)?})
    } else {
        Value::Null
    };
    let path_text = path.to_string_lossy();
    let display = display_path(&path_text);
    let filesystem = String::from_utf16_lossy(
        &filesystem[..filesystem
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(filesystem.len())],
    );
    let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
    Ok(
        json!({"path":display,"pathBytes":B64.encode(display.as_bytes()),"identity":{"device":info.dwVolumeSerialNumber.to_string(),"inode":index.to_string(),"mount":serial.to_string()},"filesystem":filesystem,"capacity":capacity,"observedAt":crate::tree::now_ms(),"readOnly":flags & windows_sys::Win32::System::SystemServices::FILE_READ_ONLY_VOLUME != 0}),
    )
}
pub fn dispatch(request: &Value) -> Result<Option<Value>> {
    if request["op"] != "inspect" {
        return Err("Use the direct Windows scanner CLI for scanning and deletion".into());
    }
    let root = if request.get("root").is_some() {
        let root = &request["root"];
        let live = inspect(Path::new(string(root, "path")?))?;
        if root["identity"] != live["identity"] || root["filesystem"] != live["filesystem"] {
            return Err("Tracked root or volume changed".into());
        }
        live
    } else {
        inspect(Path::new(string(request, "path")?))?
    };
    Ok(Some(root))
}
