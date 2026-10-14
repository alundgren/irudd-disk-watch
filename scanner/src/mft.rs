//! Builds the tree from the NTFS master file table (MFT) instead of listing folders.
//! Reads the raw volume, so it needs administrator rights.
//!
//! Every file and folder has a record in the MFT that holds its names, its parent
//! folder, and the size of its unnamed data stream. Reading the table front to back
//! is a few large sequential reads instead of one request per folder.

use crate::tree::{Counters, Dir};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::windows::fs::{FileExt, OpenOptionsExt};
use std::path::{Component, Path, Prefix};
use std::sync::atomic::Ordering;

const ROOT_RECORD: usize = 5;
const FIXUP_STRIDE: usize = 512;
const CHUNK_BYTES: usize = 16 << 20;
const IN_USE: u8 = 1;
const IS_DIR: u8 = 2;
const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_DATA: u32 = 0x80;
const ATTR_END: u32 = 0xFFFF_FFFF;
const NAMESPACE_DOS: u8 = 2;
const REFERENCE_MASK: u64 = 0xFFFF_FFFF_FFFF;

fn u16le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn u64le(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

struct Boot {
    cluster_size: u64,
    mft_offset: u64,
    record_size: usize,
}

fn parse_boot(b: &[u8]) -> Result<Boot, String> {
    if &b[3..11] != b"NTFS    " {
        return Err("not an NTFS volume".into());
    }
    let bytes_per_sector = u16le(b, 0x0B) as u64;
    let raw = b[0x0D];
    let sectors_per_cluster = if raw > 0x80 { 1u64 << (256 - raw as u32) } else { raw as u64 };
    let cluster_size = bytes_per_sector * sectors_per_cluster;
    let raw = b[0x40] as i8;
    let record_size = if raw < 0 { 1usize << (-(raw as i32)) } else { raw as usize * cluster_size as usize };
    if cluster_size == 0 || record_size < FIXUP_STRIDE || record_size % FIXUP_STRIDE != 0 {
        return Err("unexpected NTFS boot sector".into());
    }
    Ok(Boot { cluster_size, mft_offset: u64le(b, 0x30) * cluster_size, record_size })
}

/// Restores the last two bytes of each 512-byte stride, which NTFS swaps out to
/// detect torn writes. Returns false for a torn or corrupt record.
fn apply_fixup(rec: &mut [u8]) -> bool {
    let offset = u16le(rec, 4) as usize;
    let count = u16le(rec, 6) as usize;
    if count == 0 || offset + count * 2 > rec.len() || (count - 1) * FIXUP_STRIDE > rec.len() {
        return false;
    }
    let check = [rec[offset], rec[offset + 1]];
    for i in 1..count {
        let end = i * FIXUP_STRIDE;
        if rec[end - 2..end] != check {
            return false;
        }
        rec[end - 2] = rec[offset + 2 * i];
        rec[end - 1] = rec[offset + 2 * i + 1];
    }
    true
}

/// Decodes a non-resident attribute's run list into (cluster, length) pairs.
/// A `None` cluster is a sparse run.
fn decode_runs(mut p: &[u8]) -> Option<Vec<(Option<u64>, u64)>> {
    let mut runs = Vec::new();
    let mut lcn: i64 = 0;
    while let Some(&header) = p.first() {
        if header == 0 {
            return Some(runs);
        }
        let len_size = (header & 0xF) as usize;
        let off_size = (header >> 4) as usize;
        if len_size == 0 || len_size > 8 || off_size > 8 || p.len() < 1 + len_size + off_size {
            return None;
        }
        let mut len = 0u64;
        for (i, byte) in p[1..1 + len_size].iter().enumerate() {
            len |= (*byte as u64) << (8 * i);
        }
        if off_size == 0 {
            runs.push((None, len));
        } else {
            let bytes = &p[1 + len_size..1 + len_size + off_size];
            let mut delta = 0i64;
            for (i, byte) in bytes.iter().enumerate() {
                delta |= (*byte as i64) << (8 * i);
            }
            let unused = 64 - 8 * off_size as u32;
            delta = (delta << unused) >> unused;
            lcn += delta;
            runs.push((Some(lcn as u64), len));
        }
        p = &p[1 + len_size + off_size..];
    }
    None
}

/// Calls `visit(type, attribute bytes)` for each attribute of a fixed-up record.
fn for_each_attribute(rec: &[u8], mut visit: impl FnMut(u32, &[u8])) {
    let used = (u32le(rec, 0x18) as usize).min(rec.len());
    let mut off = u16le(rec, 0x14) as usize;
    while off + 0x18 <= used {
        let kind = u32le(rec, off);
        if kind == ATTR_END {
            break;
        }
        let len = u32le(rec, off + 4) as usize;
        if len < 0x18 || off + len > used {
            break;
        }
        visit(kind, &rec[off..off + len]);
        off += len;
    }
}

fn resident_value(attr: &[u8]) -> Option<&[u8]> {
    if attr[8] != 0 {
        return None;
    }
    let len = u32le(attr, 0x10) as usize;
    let off = u16le(attr, 0x14) as usize;
    attr.get(off..off + len)
}

/// Columns of what the scan keeps per MFT record, indexed by record number.
struct Table {
    flags: Vec<u8>,
    seq: Vec<u16>,
    parent: Vec<u32>,
    parent_seq: Vec<u16>,
    size: Vec<u64>,
    name: Vec<Option<Box<str>>>,
}

impl Table {
    fn new(count: usize) -> Table {
        Table {
            flags: vec![0; count],
            seq: vec![0; count],
            parent: vec![0; count],
            parent_seq: vec![0; count],
            size: vec![0; count],
            name: vec![None; count],
        }
    }

    fn is_dir(&self, i: usize) -> bool {
        self.flags[i] & (IN_USE | IS_DIR) == IN_USE | IS_DIR
    }

    /// Records the attributes of one raw record. Extension records carry attributes
    /// that did not fit in their base record, so those land on the base record.
    fn add_record(&mut self, index: usize, rec: &mut [u8], counters: &Counters) {
        if &rec[0..4] != b"FILE" || !apply_fixup(rec) {
            return;
        }
        let flags = u16le(rec, 0x16);
        if flags & 1 == 0 {
            return;
        }
        let base = (u64le(rec, 0x20) & REFERENCE_MASK) as usize;
        let target = if base == 0 { index } else { base };
        if target >= self.flags.len() {
            return;
        }
        if base == 0 {
            let dir = flags & 2 != 0;
            self.flags[target] |= IN_USE | if dir { IS_DIR } else { 0 };
            self.seq[target] = u16le(rec, 0x10);
            let counter = if dir { &counters.dirs } else { &counters.files };
            counter.fetch_add(1, Ordering::Relaxed);
        }
        for_each_attribute(rec, |kind, attr| match kind {
            ATTR_FILE_NAME => self.add_name(target, attr),
            ATTR_DATA => self.add_data(target, attr, counters),
            _ => {}
        });
    }

    /// Keeps the first non-DOS name, so a file with several hard links counts once.
    fn add_name(&mut self, target: usize, attr: &[u8]) {
        let Some(value) = resident_value(attr) else { return };
        if value.len() < 0x42 || value[0x41] == NAMESPACE_DOS || self.name[target].is_some() {
            return;
        }
        let chars = value[0x40] as usize;
        let Some(raw) = value.get(0x42..0x42 + chars * 2) else { return };
        let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let reference = u64le(value, 0);
        self.name[target] = Some(String::from_utf16_lossy(&units).into());
        self.parent[target] = (reference & REFERENCE_MASK) as u32;
        self.parent_seq[target] = (reference >> 48) as u16;
    }

    /// Takes the logical size of the unnamed stream, which is what Explorer shows.
    fn add_data(&mut self, target: usize, attr: &[u8], counters: &Counters) {
        if attr[9] != 0 {
            return;
        }
        let size = if attr[8] == 0 {
            u32le(attr, 0x10) as u64
        } else if attr.len() >= 0x38 && u64le(attr, 0x10) == 0 {
            u64le(attr, 0x30)
        } else {
            return;
        };
        self.size[target] = size;
        counters.bytes.fetch_add(size, Ordering::Relaxed);
    }
}

/// Byte ranges of the MFT on the volume, and its length, read from record 0 ($MFT itself).
fn mft_extents(rec: &mut [u8], cluster_size: u64) -> Result<(Vec<(u64, u64)>, u64), String> {
    if &rec[0..4] != b"FILE" || !apply_fixup(rec) {
        return Err("MFT record 0 is unreadable".into());
    }
    let mut found = None;
    for_each_attribute(rec, |kind, attr| {
        if kind == ATTR_DATA && attr[8] != 0 && attr[9] == 0 && attr.len() >= 0x40 && u64le(attr, 0x10) == 0 {
            let runs = decode_runs(&attr[u16le(attr, 0x20) as usize..]);
            found = Some((runs, u64le(attr, 0x30)));
        }
    });
    let (runs, size) = found.ok_or("MFT data attribute not found")?;
    let runs = runs.ok_or("MFT data runs are corrupt")?;
    let mut extents = Vec::new();
    for (lcn, len) in runs {
        let Some(lcn) = lcn else { return Err("MFT has a sparse run".into()) };
        extents.push((lcn * cluster_size, len * cluster_size));
    }
    if extents.iter().map(|(_, len)| len).sum::<u64>() < size {
        return Err("MFT is too fragmented to read from record 0".into());
    }
    Ok((extents, size))
}

fn read_exact_at(file: &File, buf: &mut [u8], mut offset: u64) -> io::Result<()> {
    let mut done = 0;
    while done < buf.len() {
        let n = file.seek_read(&mut buf[done..], offset)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        done += n;
        offset += n as u64;
    }
    Ok(())
}

fn read_table(drive: &str, counters: &Counters) -> Result<Table, String> {
    const FILE_SHARE_READ_WRITE: u32 = 3;
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ_WRITE)
        .open(format!(r"\\.\{drive}"))
        .map_err(|err| match err.raw_os_error() {
            Some(5) => "reading the MFT needs administrator rights".to_string(),
            _ => format!("cannot open volume {drive}: {err}"),
        })?;
    let io_err = |err: io::Error| format!("reading volume {drive}: {err}");
    let mut sector = vec![0u8; 512];
    read_exact_at(&file, &mut sector, 0).map_err(io_err)?;
    let boot = parse_boot(&sector)?;
    let mut rec0 = vec![0u8; boot.record_size];
    read_exact_at(&file, &mut rec0, boot.mft_offset).map_err(io_err)?;
    let (extents, mft_size) = mft_extents(&mut rec0, boot.cluster_size)?;

    let count = (mft_size / boot.record_size as u64) as usize;
    if count > u32::MAX as usize {
        return Err("MFT has too many records".into());
    }
    let mut table = Table::new(count);
    let mut buf = vec![0u8; CHUNK_BYTES];
    let mut index = 0;
    for (start, len) in extents {
        let mut done = 0;
        while done < len && index < count {
            let n = (len - done).min(CHUNK_BYTES as u64) as usize;
            read_exact_at(&file, &mut buf[..n], start + done).map_err(io_err)?;
            for rec in buf[..n].chunks_exact_mut(boot.record_size) {
                if index == count {
                    break;
                }
                table.add_record(index, rec, counters);
                index += 1;
            }
            done += n as u64;
        }
    }
    Ok(table)
}

/// The table as a tree: each folder's children, sorted by parent for range lookup.
struct Tree<'a> {
    table: &'a Table,
    edges: Vec<(u32, u32)>,
    excluded: HashSet<usize>,
    min_file_size: u64,
}

impl Tree<'_> {
    fn children(&self, dir: usize) -> impl Iterator<Item = usize> + '_ {
        let start = self.edges.partition_point(|&(p, _)| (p as usize) < dir);
        self.edges[start..].iter().take_while(move |&&(p, _)| p as usize == dir).map(|&(_, c)| c as usize)
    }

    fn child_dir(&self, dir: usize, name: &str) -> Option<usize> {
        let name = name.to_lowercase();
        self.children(dir).find(|&c| {
            self.table.is_dir(c) && self.table.name[c].as_deref().is_some_and(|n| n.to_lowercase() == name)
        })
    }

    /// Follows the folder names below the volume root. Returns None if a folder is missing.
    fn resolve(&self, path: &Path) -> Option<usize> {
        let mut at = ROOT_RECORD;
        for component in path.components() {
            if let Component::Normal(name) = component {
                at = self.child_dir(at, &name.to_string_lossy())?;
            }
        }
        Some(at)
    }

    fn build(&self, dir: usize, name: String) -> Dir {
        let mut out = Dir::new(name);
        for child in self.children(dir) {
            let name = self.table.name[child].as_deref().unwrap_or_default().to_string();
            if self.table.is_dir(child) {
                if !self.excluded.contains(&child) {
                    out.add_subdir(self.build(child, name));
                }
            } else {
                out.add_file(name, self.table.size[child], self.min_file_size);
            }
        }
        out
    }
}

/// Drive letter of a local path, such as `C:`, or None for UNC and other paths.
fn drive_of(path: &Path) -> Option<String> {
    match path.components().next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => Some(format!("{}:", letter as char)),
            _ => None,
        },
        _ => None,
    }
}

pub fn scan(root: &Path, excludes: &[String], min_file_size: u64, counters: &Counters) -> Result<Dir, String> {
    let drive = drive_of(root).ok_or("the MFT can only be read for a local drive")?;
    let table = read_table(&drive, counters)?;

    let mut edges: Vec<(u32, u32)> = (0..table.flags.len())
        .filter(|&i| i != ROOT_RECORD && table.flags[i] & IN_USE != 0 && table.name[i].is_some())
        .filter(|&i| {
            let p = table.parent[i] as usize;
            p < table.flags.len() && table.is_dir(p) && table.seq[p] == table.parent_seq[i]
        })
        .map(|i| (table.parent[i], i as u32))
        .collect();
    edges.sort_unstable();
    let mut tree = Tree { table: &table, edges, excluded: HashSet::new(), min_file_size };

    for exclude in excludes {
        let path = Path::new(exclude);
        if drive_of(path).is_some_and(|d| d.eq_ignore_ascii_case(&drive)) {
            if let Some(record) = tree.resolve(path) {
                tree.excluded.insert(record);
            }
        }
    }
    let start = tree.resolve(root).ok_or_else(|| format!("{} was not found in the MFT", root.display()))?;
    Ok(tree.build(start, root.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_runs_with_negative_and_sparse_offsets() {
        // 0x21: 1-byte length, 2-byte offset. Second run jumps back 0x10 clusters.
        let runs = [0x21, 0x18, 0x00, 0x10, 0x21, 0x08, 0xF0, 0xFF, 0x01, 0x04, 0x00];
        assert_eq!(decode_runs(&runs), Some(vec![(Some(0x1000), 0x18), (Some(0x0FF0), 0x08), (None, 0x04)]));
        assert_eq!(decode_runs(&[0x21, 0x18]), None);
    }

    /// A 1024-byte record with the given attributes, its fixups applied the way NTFS writes them.
    fn record(flags: u16, base: u64, attributes: &[Vec<u8>]) -> Vec<u8> {
        let mut rec = vec![0u8; 1024];
        rec[0..4].copy_from_slice(b"FILE");
        rec[4..6].copy_from_slice(&0x30u16.to_le_bytes());
        rec[6..8].copy_from_slice(&3u16.to_le_bytes());
        rec[0x10..0x12].copy_from_slice(&7u16.to_le_bytes());
        rec[0x14..0x16].copy_from_slice(&0x38u16.to_le_bytes());
        rec[0x16..0x18].copy_from_slice(&flags.to_le_bytes());
        rec[0x20..0x28].copy_from_slice(&base.to_le_bytes());
        let mut off = 0x38;
        for attr in attributes {
            rec[off..off + attr.len()].copy_from_slice(attr);
            off += attr.len();
        }
        rec[off..off + 4].copy_from_slice(&ATTR_END.to_le_bytes());
        rec[0x18..0x1C].copy_from_slice(&(off as u32 + 8).to_le_bytes());
        rec[0x30..0x32].copy_from_slice(&[0xAB, 0xCD]);
        for i in 1..3 {
            let end = i * 512;
            rec[0x30 + 2 * i] = rec[end - 2];
            rec[0x30 + 2 * i + 1] = rec[end - 1];
            rec[end - 2..end].copy_from_slice(&[0xAB, 0xCD]);
        }
        rec
    }

    fn file_name(parent: u64, parent_seq: u16, namespace: u8, name: &str) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let mut value = vec![0u8; 0x42 + units.len() * 2];
        value[0..8].copy_from_slice(&(parent | (parent_seq as u64) << 48).to_le_bytes());
        value[0x40] = units.len() as u8;
        value[0x41] = namespace;
        for (i, u) in units.iter().enumerate() {
            value[0x42 + 2 * i..0x44 + 2 * i].copy_from_slice(&u.to_le_bytes());
        }
        resident(ATTR_FILE_NAME, &value)
    }

    fn resident(kind: u32, value: &[u8]) -> Vec<u8> {
        let len = (0x18 + value.len()).next_multiple_of(8);
        let mut attr = vec![0u8; len];
        attr[0..4].copy_from_slice(&kind.to_le_bytes());
        attr[4..8].copy_from_slice(&(len as u32).to_le_bytes());
        attr[0x10..0x14].copy_from_slice(&(value.len() as u32).to_le_bytes());
        attr[0x14..0x16].copy_from_slice(&0x18u16.to_le_bytes());
        attr[0x18..0x18 + value.len()].copy_from_slice(value);
        attr
    }

    fn non_resident_data(size: u64) -> Vec<u8> {
        let mut attr = vec![0u8; 0x48];
        attr[0..4].copy_from_slice(&ATTR_DATA.to_le_bytes());
        attr[4..8].copy_from_slice(&0x48u32.to_le_bytes());
        attr[8] = 1;
        attr[0x20..0x22].copy_from_slice(&0x40u16.to_le_bytes());
        attr[0x30..0x38].copy_from_slice(&size.to_le_bytes());
        attr[0x40..0x44].copy_from_slice(&[0x11, 0x01, 0x10, 0x00]);
        attr
    }

    #[test]
    fn reads_names_sizes_and_extension_records() {
        let counters = Counters::default();
        let mut table = Table::new(10);
        let dos = file_name(5, 5, NAMESPACE_DOS, "VIDEO~1.MOV");
        let long = file_name(5, 5, 1, "video final.mov");
        table.add_record(6, &mut record(1, 0, &[dos, long, non_resident_data(5_000_000_000)]), &counters);
        table.add_record(7, &mut record(1 | 2, 0, &[file_name(5, 5, 3, "Footage")]), &counters);
        table.add_record(8, &mut record(1, 0, &[file_name(7, 7, 3, "big.bin")]), &counters);
        table.add_record(9, &mut record(1, 8, &[non_resident_data(42)]), &counters);

        assert_eq!(table.name[6].as_deref(), Some("video final.mov"));
        assert_eq!((table.parent[6], table.size[6]), (5, 5_000_000_000));
        assert!(table.is_dir(7));
        assert_eq!((table.name[8].as_deref(), table.size[8]), (Some("big.bin"), 42));
        assert_eq!(table.flags[9], 0);
    }

    #[test]
    fn rejects_torn_records() {
        let mut rec = record(1, 0, &[file_name(5, 5, 1, "a")]);
        rec[1022] ^= 0xFF;
        let mut table = Table::new(1);
        table.add_record(0, &mut rec, &Counters::default());
        assert_eq!(table.flags[0], 0);
    }
}
