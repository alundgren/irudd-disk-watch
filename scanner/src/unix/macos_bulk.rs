use super::{Control, File, Result, ScanEntry, ioerr, open_at};
use std::cell::RefCell;
use std::os::fd::AsRawFd;

const ATTR_CMN_ERROR: u32 = 0x20000000;
const REQUIRED: u32 = libc::ATTR_CMN_NAME | libc::ATTR_CMN_RETURNED_ATTRS;
const IDENTITY: u32 = libc::ATTR_CMN_FSID | libc::ATTR_CMN_OBJTYPE | libc::ATTR_CMN_FILEID;
const REQUESTED: u32 =
    libc::ATTR_CMN_NAME | libc::ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ERROR | IDENTITY;

#[derive(Clone, Copy, Debug)]
pub(super) struct Metadata {
    pub mount: u64,
    pub kind: u32,
    pub inode: u64,
}

impl Metadata {
    pub fn matches_regular(&self, stat: &libc::stat) -> bool {
        // getattrlistbulk uses vnode types, where VREG is 1, rather than stat mode bits.
        // The caller checks stat's mounted device and the bulk physical volume ID separately.
        // APFS snapshot bulk device numbers are not comparable to stat's device numbers.
        self.kind == 1 && self.inode == stat.st_ino && stat.st_mode & libc::S_IFMT == libc::S_IFREG
    }
}

struct Record<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Record<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        let value = self
            .bytes
            .get(self.at..self.at + N)
            .ok_or("Truncated bulk metadata")?;
        self.at += N;
        Ok(value.try_into().unwrap())
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_ne_bytes(self.take()?))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_ne_bytes(self.take()?))
    }
}

fn decode(bytes: &[u8]) -> Result<ScanEntry> {
    let mut record = Record { bytes, at: 4 };
    let common = record.u32()?;
    let other = [record.u32()?, record.u32()?, record.u32()?, record.u32()?];
    if common & !REQUESTED != 0 || other != [0; 4] || common & REQUIRED != REQUIRED {
        return Err("Unexpected bulk metadata attributes".into());
    }
    let error = if common & ATTR_CMN_ERROR != 0 {
        record.u32()?
    } else {
        0
    };
    let reference = record.at;
    let offset = i32::from_ne_bytes(record.take()?);
    let length = record.u32()? as usize;
    let start = usize::try_from(reference as i64 + offset as i64)
        .map_err(|_| "Invalid bulk name offset")?;
    let end = start
        .checked_add(length)
        .ok_or("Invalid bulk name length")?;
    let name = bytes
        .get(start..end)
        .ok_or("Bulk name exceeds its record")?;
    if name.len() < 2
        || name.last() != Some(&0)
        || name[..name.len() - 1].contains(&0)
        || name.contains(&b'/')
    {
        return Err("Invalid bulk directory name".into());
    }
    let mount = if common & libc::ATTR_CMN_FSID != 0 {
        record.u64()?
    } else {
        0
    };
    let kind = if common & libc::ATTR_CMN_OBJTYPE != 0 {
        record.u32()?
    } else {
        0
    };
    let inode = if common & libc::ATTR_CMN_FILEID != 0 {
        record.u64()?
    } else {
        0
    };
    if start < record.at {
        return Err("Bulk name overlaps fixed metadata".into());
    }
    Ok(ScanEntry {
        name: name[..name.len() - 1].to_vec(),
        metadata: (error == 0 && common & IDENTITY == IDENTITY).then_some(Metadata {
            mount,
            kind,
            inode,
        }),
    })
}

fn native_read(file: &File, attrs: &mut libc::attrlist, buffer: &mut [u8]) -> i32 {
    unsafe {
        libc::getattrlistbulk(
            file.as_raw_fd(),
            (attrs as *mut libc::attrlist).cast(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            libc::FSOPT_RETURN_REALDEV as _,
        )
    }
}

thread_local! {
    // Decoded batches own their names. Recursion can reuse the scratch buffer after fill returns.
    static BUFFER: RefCell<Vec<u8>> = RefCell::new(vec![0; 64 * 1024]);
}

pub(super) struct Entries<'a> {
    file: File,
    control: &'a Control,
    batch: std::vec::IntoIter<ScanEntry>,
    done: bool,
}

impl<'a> Entries<'a> {
    pub fn open(dir: &File, control: &'a Control) -> Result<Option<Self>> {
        Self::open_with(dir, control, native_read)
    }

    fn open_with(
        dir: &File,
        control: &'a Control,
        call: impl FnMut(&File, &mut libc::attrlist, &mut [u8]) -> i32,
    ) -> Result<Option<Self>> {
        // A separate open description permits a clean readdir fallback without mixed offsets.
        let mut entries = Self {
            file: open_at(dir, b".", true)?,
            control,
            batch: Vec::new().into_iter(),
            done: false,
        };
        match entries.fill_with(call) {
            Ok(()) => Ok(Some(entries)),
            Err(error)
                if matches!(
                    error.code,
                    Some(libc::ENOTSUP | libc::EINVAL | libc::ENOSYS)
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn fill_with(
        &mut self,
        mut call: impl FnMut(&File, &mut libc::attrlist, &mut [u8]) -> i32,
    ) -> Result<()> {
        self.control.check()?;
        BUFFER.with(|scratch| {
            let mut buffer = scratch.borrow_mut();
            let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
            attrs.bitmapcount = 5;
            attrs.commonattr = REQUESTED;
            let count = call(&self.file, &mut attrs, &mut buffer);
            if count < 0 {
                return Err(ioerr());
            }
            if count == 0 {
                self.done = true;
                self.batch = Vec::new().into_iter();
                return Ok(());
            }
            if count as usize > buffer.len() / 32 {
                return Err("Invalid bulk entry count".into());
            }
            let mut entries = Vec::with_capacity(count as usize);
            let mut at = 0usize;
            for _ in 0..count {
                self.control.check()?;
                let length = buffer.get(at..at + 4).ok_or("Missing bulk record length")?;
                let length = u32::from_ne_bytes(length.try_into().unwrap()) as usize;
                if length < 32 || length % 8 != 0 {
                    return Err("Invalid bulk record length".into());
                }
                let end = at
                    .checked_add(length)
                    .ok_or("Bulk record length overflow")?;
                let entry = decode(buffer.get(at..end).ok_or("Bulk record exceeds buffer")?)?;
                if entry.name != b"." && entry.name != b".." {
                    entries.push(entry);
                }
                at = end;
            }
            self.batch = entries.into_iter();
            Ok(())
        })
    }
}

impl Iterator for Entries<'_> {
    type Item = Result<ScanEntry>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.done && self.batch.len() == 0 {
                return None;
            }
            if let Err(error) = self.control.check() {
                self.done = true;
                self.batch = Vec::new().into_iter();
                return Some(Err(error.into()));
            }
            if let Some(entry) = self.batch.next() {
                return Some(Ok(entry));
            }
            if self.done {
                return None;
            }
            if let Err(error) = self.fill_with(native_read) {
                // Restarting after yielding records would duplicate captured files.
                self.done = true;
                return Some(Err(error));
            }
        }
    }
}

#[cfg(test)]
pub(super) fn read(dir: &File, control: &Control) -> Result<Option<Vec<ScanEntry>>> {
    Entries::open(dir, control)?
        .map(|entries| entries.collect())
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(common: u32, error: u32) -> Vec<u8> {
        let mut bytes = vec![0; 4];
        for bits in [common, 0, 0, 0, 0] {
            bytes.extend(bits.to_ne_bytes());
        }
        if common & ATTR_CMN_ERROR != 0 {
            bytes.extend(error.to_ne_bytes());
        }
        let reference = bytes.len();
        bytes.extend([0u8; 8]);
        if common & libc::ATTR_CMN_FSID != 0 {
            bytes.extend(11u64.to_ne_bytes());
        }
        if common & libc::ATTR_CMN_OBJTYPE != 0 {
            bytes.extend(1u32.to_ne_bytes());
        }
        if common & libc::ATTR_CMN_FILEID != 0 {
            bytes.extend(13u64.to_ne_bytes());
        }
        let offset = (bytes.len() - reference) as i32;
        bytes[reference..reference + 4].copy_from_slice(&offset.to_ne_bytes());
        bytes[reference + 4..reference + 8].copy_from_slice(&5u32.to_ne_bytes());
        bytes.extend(b"file\0");
        bytes.resize(bytes.len().next_multiple_of(8), 0);
        let length = bytes.len() as u32;
        bytes[..4].copy_from_slice(&length.to_ne_bytes());
        bytes
    }

    #[test]
    fn valid_metadata_and_missing_or_failed_attributes() {
        let entry = decode(&record(REQUESTED, 0)).unwrap();
        assert_eq!(entry.name, b"file");
        let meta = entry.metadata.unwrap();
        assert_eq!((meta.mount, meta.kind, meta.inode), (11, 1, 13));
        assert!(
            decode(&record(REQUESTED & !libc::ATTR_CMN_FSID, 0))
                .unwrap()
                .metadata
                .is_none()
        );
        assert!(
            decode(&record(REQUESTED, libc::EACCES as u32))
                .unwrap()
                .metadata
                .is_none()
        );
    }

    #[test]
    fn corrupt_or_escaping_name_references_are_rejected() {
        let mut bytes = record(REQUESTED, 0);
        let reference = 28;
        for offset in [i32::MIN, -4, i32::MAX] {
            bytes[reference..reference + 4].copy_from_slice(&offset.to_ne_bytes());
            assert!(decode(&bytes).is_err());
        }
        for length in 0..32 {
            assert!(decode(&bytes[..length]).is_err());
        }
    }

    #[test]
    fn unavailable_api_returns_fallback_without_consuming_the_callers_directory() {
        let dir = File::open(std::env::temp_dir()).unwrap();
        let control = Control::testing();
        for code in [libc::ENOTSUP, libc::EINVAL, libc::ENOSYS] {
            let result = Entries::open_with(&dir, &control, |_, _, _| {
                unsafe {
                    *libc::__error() = code;
                }
                -1
            })
            .unwrap();
            assert!(result.is_none());
        }
        for code in [libc::EACCES, libc::EIO] {
            let result = Entries::open_with(&dir, &control, |_, _, _| {
                unsafe {
                    *libc::__error() = code;
                }
                -1
            });
            assert!(matches!(result, Err(error) if error.code == Some(code)));
        }
    }

    #[test]
    fn invalid_batch_lengths_and_counts_are_not_accepted_as_empty_directories() {
        let dir = File::open(std::env::temp_dir()).unwrap();
        let control = Control::testing();
        for length in [0u32, 31, 33, u32::MAX] {
            let result = Entries::open_with(&dir, &control, |_, _, buffer| {
                buffer[..4].copy_from_slice(&length.to_ne_bytes());
                1
            });
            assert!(result.is_err());
        }
        assert!(Entries::open_with(&dir, &control, |_, _, _| 3000).is_err());
    }
}
