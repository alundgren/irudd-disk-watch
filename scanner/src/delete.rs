//! Deletes files and folder trees in parallel using Rayon.
//!
//! Optimized for huge folder trees such as `node_modules` with hundreds of
//! thousands of tiny files: files in each directory are unlinked in parallel,
//! subdirectories are recursed in parallel, read-only attributes are cleared
//! automatically on permission error, and junctions/symlinks are removed as
//! links without traversing into their targets.

use rayon::prelude::*;
use serde_json::json;
use std::fs;
use std::io;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    FILE_WRITE_ATTRIBUTES,
};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    File,
    Dir,
}

pub struct Target {
    pub path: PathBuf,
    pub kind: Kind,
}

#[derive(Debug)]
pub struct DeleteFailure {
    pub path: PathBuf,
    pub error: io::Error,
}

fn at(path: &Path) -> impl FnOnce(io::Error) -> DeleteFailure + '_ {
    |error| DeleteFailure { path: path.to_path_buf(), error }
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
    }
}

fn is_safe_delete_target(root: &Path, path: &Path) -> bool {
    let ordinary = |path: &Path| {
        path.is_absolute() && path.components().all(|component| match component {
            Component::Prefix(prefix) => matches!(
                prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::UNC(_, _)
            ),
            Component::CurDir | Component::ParentDir => false,
            _ => true,
        })
    };
    let root_parts: Vec<_> = root.components().collect();
    let path_parts: Vec<_> = path.components().collect();
    ordinary(root) && ordinary(path) && path_parts.len() >= root_parts.len() + 2
        && root_parts.iter().zip(&path_parts).all(|(a, b)| {
            a.as_os_str().to_string_lossy().to_lowercase()
                == b.as_os_str().to_string_lossy().to_lowercase()
        })
}

fn to_verbatim_path(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw.starts_with(r"\\?\") {
        return path.to_path_buf();
    }
    if let Some(rest) = raw.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{rest}"));
    }
    PathBuf::from(format!(r"\\?\{raw}"))
}

fn clear_readonly(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        && let Ok(meta) = file.metadata()
    {
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return;
        }
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = file.set_permissions(perms);
        }
    }
}

fn open_guard(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

// Holding each ordinary ancestor without write/delete sharing prevents replacement
// or reparse retargeting while descendant paths are used by the delete workers.
fn guard_ancestors(path: &Path) -> Result<Vec<fs::File>, DeleteFailure> {
    let mut guards = Vec::new();
    for parent in path.ancestors().skip(1).collect::<Vec<_>>().into_iter().rev() {
        let guard = open_guard(parent).map_err(at(parent))?;
        let meta = guard.metadata().map_err(at(parent))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !meta.is_dir() {
            return Err(at(parent)(io::Error::other("Deletion cannot pass through a reparse point or non-directory ancestor.")));
        }
        guards.push(guard);
    }
    Ok(guards)
}

fn is_transient_windows_error(err: &io::Error) -> bool {
    // 5 = ERROR_ACCESS_DENIED, 32 = ERROR_SHARING_VIOLATION, 145 = ERROR_DIR_NOT_EMPTY
    matches!(err.raw_os_error(), Some(5 | 32 | 145))
        || err.kind() == io::ErrorKind::PermissionDenied
        || err.kind() == io::ErrorKind::DirectoryNotEmpty
}

fn remove_file_force(path: &Path) -> io::Result<()> {
    for delay_ms in [0u64, 2, 8, 25] {
        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        match fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) if delay_ms == 0 && err.kind() == io::ErrorKind::PermissionDenied => {
                clear_readonly(path);
            }
            Err(err) if is_transient_windows_error(&err) => continue,
            Err(err) => return Err(err),
        }
    }
    fs::remove_file(path).or_else(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(err)
        }
    })
}

fn remove_empty_dir_force(path: &Path) -> io::Result<()> {
    for delay_ms in [0u64, 2, 8, 25] {
        if delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        }
        match fs::remove_dir(path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) if delay_ms == 0 && err.kind() == io::ErrorKind::PermissionDenied => {
                clear_readonly(path);
            }
            Err(err) if is_transient_windows_error(&err) => continue,
            Err(err) => return Err(err),
        }
    }
    fs::remove_dir(path).or_else(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            Ok(())
        } else {
            Err(err)
        }
    })
}

fn remove_link(path: &Path, directory: bool) -> io::Result<()> {
    if directory {
        remove_empty_dir_force(path)
    } else {
        remove_file_force(path)
    }
}

fn delete_dir_recursive(path: &Path) -> Result<(), DeleteFailure> {
    let guard = match open_guard(path) {
        Ok(guard) => guard,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(at(path)(err)),
    };
    let meta = guard.metadata().map_err(at(path))?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        drop(guard);
        return remove_link(path, meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0).map_err(at(path));
    }
    if !meta.is_dir() {
        drop(guard);
        return remove_file_force(path).map_err(at(path));
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(at(path)(err)),
    };

    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut first_err: Option<DeleteFailure> = None;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                if first_err.is_none() {
                    first_err = Some(at(path)(err));
                }
                continue;
            }
        };
        let child = entry.path();
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(err) => {
                if first_err.is_none() {
                    first_err = Some(at(&child)(err));
                }
                continue;
            }
        };
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            files.push((child, Some(meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0)));
        } else if meta.is_dir() {
            dirs.push(child);
        } else {
            files.push((child, None));
        }
    }

    let (file_err, dir_err) = rayon::join(
        || {
            files
                .par_iter()
                .with_min_len(16)
                .filter_map(|(file, link_directory)| {
                    if let Some(directory) = link_directory {
                        remove_link(file, *directory).map_err(at(file)).err()
                    } else {
                        remove_file_force(file).map_err(at(file)).err()
                    }
                })
                .reduce_with(|a, _| a)
        },
        || {
            dirs.par_iter()
                .filter_map(|dir| delete_dir_recursive(dir).err())
                .reduce_with(|a, _| a)
        },
    );

    if let Some(err) = first_err.or(file_err).or(dir_err) {
        return Err(err);
    }

    drop(guard);
    remove_empty_dir_force(path).map_err(at(path))
}

pub fn delete_path(root: &Path, target: &Target) -> Result<(), DeleteFailure> {
    let path = &target.path;
    if !is_safe_delete_target(root, path) {
        return Err(at(path)(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Root and top-level paths cannot be deleted.",
        )));
    }
    let verbatim = to_verbatim_path(path);
    let _ancestors = match guard_ancestors(&verbatim) {
        Ok(guards) => guards,
        Err(err) if err.error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let guard = match open_guard(&verbatim) {
        Ok(guard) => guard,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(at(&verbatim)(err)),
    };
    let meta = guard.metadata().map_err(at(&verbatim))?;
    let directory = meta.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0;
    if directory != (target.kind == Kind::Dir) {
        return Err(at(&verbatim)(io::Error::other("The item type changed since it was staged. Scan again before deleting it.")));
    }
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        drop(guard);
        remove_link(&verbatim, directory).map_err(at(&verbatim))
    } else if directory {
        drop(guard);
        delete_dir_recursive(&verbatim)
    } else {
        drop(guard);
        remove_file_force(&verbatim).map_err(at(&verbatim))
    }
}

pub fn run_delete(root: PathBuf, targets: Vec<Target>) -> i32 {
    let threads = std::thread::available_parallelism().map_or(16, |n| (n.get() * 2).clamp(16, 64));
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .stack_size(16 * 1024 * 1024)
        .build()
        .expect("delete thread pool");
    let results: Vec<(String, Result<(), DeleteFailure>)> = pool.install(|| {
        targets
            .par_iter()
            .map(|target| {
                let text = target.path.to_string_lossy().into_owned();
                let res = delete_path(&root, target);
                (text, res)
            })
            .collect()
    });

    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    for (path, res) in results {
        match res {
            Ok(()) => deleted.push(path),
            Err(failure) => failed.push(json!({
                "path": path,
                "failedPath": display_path(&failure.path),
                "message": failure.error.to_string(),
                "errorCode": failure.error.raw_os_error(),
                "lockInfo": crate::locks::diagnose(&failure.path, failure.error.raw_os_error()),
            })),
        }
    }

    println!("{}", json!({ "deleted": deleted, "failed": failed }));
    if failed.is_empty() { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn deletes_nested_dirs_and_readonly_files() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("dw-del-test-{unique}"));
        let target = root.join("project").join("node_modules");
        let nested = target.join("pkg").join("dist");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("index.js");
        fs::write(&file, b"hello").unwrap();
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file, perms).unwrap();

        delete_path(&root, &Target { path:target.clone(), kind:Kind::Dir }).unwrap();
        assert!(!target.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_root_and_top_level_paths() {
        let root = Path::new(r"C:\");
        assert!(!is_safe_delete_target(root,root));
        assert!(!is_safe_delete_target(root,Path::new(r"C:\foo")));
        assert!(!is_safe_delete_target(root,Path::new(r"C:\foo\..\bar")));
        assert!(!is_safe_delete_target(root,Path::new(r"D:\foo\bar")));
        assert!(is_safe_delete_target(root,Path::new(r"C:\foo\bar.txt")));
        assert!(is_safe_delete_target(root,Path::new(r"C:\foo\baz")));
    }

    #[test]
    fn ancestor_guards_prevent_replacement_and_partial_failure_keeps_locked_files() {
        let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("dw-del-guard-{unique}"));
        let project = root.join("project");
        let target = project.join("node_modules");
        fs::create_dir_all(&target).unwrap();
        let guards = guard_ancestors(&to_verbatim_path(&target)).unwrap();
        assert!(fs::rename(&project,root.join("moved")).is_err());
        drop(guards);
        let locked = target.join("locked.js");
        let good = target.join("good.js");
        fs::write(&locked,b"keep").unwrap();
        fs::write(&good,b"remove").unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&locked).unwrap();
        assert!(delete_path(&root,&Target{path:target.clone(),kind:Kind::Dir}).is_err());
        assert!(locked.exists());
        assert!(!good.exists());
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }
}
