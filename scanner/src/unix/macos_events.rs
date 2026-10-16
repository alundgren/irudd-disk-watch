//! Owned FSEvents stream. All paths stay as native bytes relative to the physical volume.
use super::{Control, File, Result, ioerr};
use std::collections::BTreeSet;
use std::ffi::{CStr, c_char, c_void};
use std::os::fd::AsRawFd;
use std::sync::Mutex;
use std::time::{Duration, Instant};

type Ref = *const c_void;
#[repr(C)]
struct Context {
    version: isize,
    info: *mut c_void,
    retain: Ref,
    release: Ref,
    describe: Ref,
}
#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn FSEventStreamCreateRelativeToDevice(
        a: Ref,
        cb: unsafe extern "C" fn(Ref, *mut c_void, usize, *mut c_void, *const u32, *const u64),
        context: *mut Context,
        device: i32,
        paths: Ref,
        since: u64,
        latency: f64,
        flags: u32,
    ) -> Ref;
    fn FSEventStreamSetDispatchQueue(stream: Ref, queue: Ref);
    fn FSEventStreamStart(stream: Ref) -> u8;
    fn FSEventStreamFlushSync(stream: Ref);
    fn FSEventStreamStop(stream: Ref);
    fn FSEventStreamInvalidate(stream: Ref);
    fn FSEventStreamRelease(stream: Ref);
    fn FSEventsCopyUUIDForDevice(device: i32) -> Ref;
    fn FSEventsGetCurrentEventId() -> u64;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFTypeArrayCallBacks: [usize; 5];
    fn CFStringCreateWithFileSystemRepresentation(a: Ref, text: *const c_char) -> Ref;
    fn CFArrayCreate(a: Ref, values: *const Ref, count: isize, callbacks: Ref) -> Ref;
    fn CFUUIDCreateString(a: Ref, uuid: Ref) -> Ref;
    fn CFStringGetCString(text: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFRelease(value: Ref);
}
unsafe extern "C" {
    fn dispatch_queue_create(label: *const c_char, attr: Ref) -> Ref;
    fn dispatch_sync_f(queue: Ref, context: *mut c_void, work: unsafe extern "C" fn(*mut c_void));
    fn dispatch_release(queue: Ref);
}

#[derive(Default, Clone)]
pub(super) struct Dirty {
    exact: BTreeSet<Vec<Vec<u8>>>,
    recursive: BTreeSet<Vec<Vec<u8>>>,
}
impl Dirty {
    pub fn all() -> Self {
        let mut d = Self::default();
        d.recursive.insert(vec![]);
        d
    }
    pub fn affects(&self, parts: &[Vec<u8>]) -> bool {
        use std::ops::Bound::{Included, Unbounded};
        let descendant = |set: &BTreeSet<Vec<Vec<u8>>>| {
            set.range::<[Vec<u8>], _>((Included(parts), Unbounded))
                .next()
                .is_some_and(|path| path.starts_with(parts))
        };
        descendant(&self.exact)
            || descendant(&self.recursive)
            || (0..=parts.len()).any(|length| self.recursive.contains(&parts[..length]))
    }
    pub fn is_empty(&self) -> bool {
        self.exact.is_empty() && self.recursive.is_empty()
    }
}
#[derive(Default)]
struct Events {
    root: Vec<Vec<u8>>,
    dirty: Dirty,
    history: bool,
    unsafe_reason: Option<String>,
    count: usize,
    last_id: u64,
}
fn parts(raw: &[u8]) -> Option<Vec<Vec<u8>>> {
    let parts: Vec<_> = raw
        .split(|b| *b == b'/')
        .filter(|p| !p.is_empty())
        .map(<[u8]>::to_vec)
        .collect();
    (!parts.iter().any(|p| p == b"." || p == b"..")).then_some(parts)
}
impl Events {
    fn accept(&mut self, path: &[u8], flags: u32) {
        if flags & (0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80) != 0 || flags & !0x7fffff != 0 {
            self.unsafe_reason = Some("Change history requires a full scan".into());
            self.dirty = Dirty::all();
        }
        if flags & 0x10 != 0 {
            self.history = true;
            return;
        }
        if self.unsafe_reason.is_some() {
            return;
        }
        self.count += 1;
        // Lost history and mount changes cannot be scoped safely to one folder.
        if self.count > 100_000 {
            self.unsafe_reason = Some("Change history requires a full scan".into());
            self.dirty = Dirty::all();
            return;
        }
        let Some(path) = parts(path) else {
            self.unsafe_reason = Some("Unrecognized event path".into());
            return;
        };
        if self.root.starts_with(&path) && path.len() < self.root.len() {
            // Changes to an ancestor's other children do not change this root. Coalesced
            // subtree events, renames, removals and access-policy changes need a full read.
            if flags & (1 | 0x100 | 0x200 | 0x800 | 0x4000 | 0x8000) != 0 {
                self.dirty = Dirty::all();
            }
            return;
        }
        if !path.starts_with(&self.root) {
            return;
        }
        let relative = path[self.root.len()..].to_vec();
        if flags & 1 != 0 || flags & (0x10000 | 0x20000 | 0x40000) == 0 || flags & 0x20000 != 0 {
            self.dirty.recursive.insert(relative.clone());
        }
        let parent = if relative.is_empty() {
            vec![]
        } else {
            relative[..relative.len() - 1].to_vec()
        };
        self.dirty.exact.insert(parent);
    }
}
unsafe extern "C" fn callback(
    _: Ref,
    info: *mut c_void,
    count: usize,
    paths: *mut c_void,
    flags: *const u32,
    ids: *const u64,
) {
    // Context and callback pointers are owned by the stream and remain live until stop and queue drain.
    let state = unsafe { &*(info as *const Mutex<Events>) };
    let Ok(mut state) = state.lock() else {
        return;
    };
    for i in 0..count {
        let flag = unsafe { *flags.add(i) };
        if flag & 0x10 != 0 {
            state.accept(b"", flag);
            continue;
        }
        let path = unsafe { *((paths as *const *const c_char).add(i)) };
        if path.is_null() {
            state.unsafe_reason = Some("Missing event path".into());
            continue;
        }
        state.accept(unsafe { CStr::from_ptr(path).to_bytes() }, flag);
        state.last_id = state.last_id.max(unsafe { *ids.add(i) });
    }
}
unsafe extern "C" fn barrier(_: *mut c_void) {}

pub(super) fn current_id() -> u64 {
    unsafe { FSEventsGetCurrentEventId() }
}
pub(super) fn volume(file: &File) -> Result<(String, Vec<Vec<u8>>)> {
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    if unsafe { libc::fstatfs(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
        return Err(ioerr());
    }
    let stat = unsafe { stat.assume_init() };
    if stat.f_flags & libc::MNT_LOCAL as u32 == 0 {
        return Err("Quick scan requires a local volume".into());
    }
    let mut path = [0 as c_char; libc::PATH_MAX as usize];
    if unsafe {
        libc::fcntl(
            file.as_raw_fd(),
            libc::F_GETPATH_NOFIRMLINK,
            path.as_mut_ptr(),
        )
    } != 0
    {
        return Err(ioerr());
    }
    let path = parts(unsafe { CStr::from_ptr(path.as_ptr()).to_bytes() })
        .ok_or("Invalid physical root")?;
    let mount = parts(unsafe { CStr::from_ptr(stat.f_mntonname.as_ptr()).to_bytes() })
        .ok_or("Invalid volume path")?;
    if !path.starts_with(&mount) {
        return Err("Physical root is outside its volume".into());
    }
    let uuid = unsafe { FSEventsCopyUUIDForDevice(file.metadata()?.dev() as i32) };
    if uuid.is_null() {
        return Err("Volume change history is unavailable".into());
    }
    let text = unsafe { CFUUIDCreateString(std::ptr::null(), uuid) };
    unsafe {
        CFRelease(uuid);
    }
    if text.is_null() {
        return Err("Volume UUID is unavailable".into());
    }
    let mut buffer = [0 as c_char; 64];
    let ok = unsafe { CFStringGetCString(text, buffer.as_mut_ptr(), 64, 0x08000100) };
    unsafe {
        CFRelease(text);
    }
    if ok == 0 {
        return Err("Volume UUID conversion failed".into());
    }
    Ok((
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned(),
        path[mount.len()..].to_vec(),
    ))
}
use std::os::unix::fs::MetadataExt;

pub(super) struct Monitor {
    stream: Ref,
    queue: Ref,
    events: Box<Mutex<Events>>,
    started: bool,
    checkpoint: std::cell::Cell<u64>,
}
impl Monitor {
    pub fn start(file: &File, root: Vec<Vec<u8>>, since: u64, control: &Control) -> Result<Self> {
        let mut events = Box::new(Mutex::new(Events {
            root,
            last_id: since,
            ..Events::default()
        }));
        let mut context = Context {
            version: 0,
            info: (&mut *events as *mut Mutex<Events>).cast(),
            retain: std::ptr::null(),
            release: std::ptr::null(),
            describe: std::ptr::null(),
        };
        let empty =
            unsafe { CFStringCreateWithFileSystemRepresentation(std::ptr::null(), c"".as_ptr()) };
        if empty.is_null() {
            return Err("Unable to create event path".into());
        }
        let paths = unsafe {
            CFArrayCreate(
                std::ptr::null(),
                &empty,
                1,
                (&raw const kCFTypeArrayCallBacks).cast(),
            )
        };
        if paths.is_null() {
            unsafe {
                CFRelease(empty);
            }
            return Err("Unable to create event paths".into());
        }
        // The checkpoint precedes observation, and the cache commits atomically. Unfinished scans never advance it.
        let stream = unsafe {
            FSEventStreamCreateRelativeToDevice(
                std::ptr::null(),
                callback,
                &mut context,
                file.metadata()?.dev() as i32,
                paths,
                since,
                0.05,
                0x02 | 0x04 | 0x10,
            )
        };
        unsafe {
            CFRelease(paths);
            CFRelease(empty);
        }
        if stream.is_null() {
            return Err("FSEvents could not create a stream".into());
        }
        let queue = unsafe {
            dispatch_queue_create(c"com.irudd.diskwatch.events".as_ptr(), std::ptr::null())
        };
        if queue.is_null() {
            unsafe {
                FSEventStreamRelease(stream);
            }
            return Err("Unable to create event queue".into());
        }
        let mut monitor = Self {
            stream,
            queue,
            events,
            started: false,
            checkpoint: std::cell::Cell::new(since),
        };
        unsafe {
            FSEventStreamSetDispatchQueue(stream, queue);
        }
        if unsafe { FSEventStreamStart(stream) } == 0 {
            return Err("FSEvents could not start".into());
        }
        monitor.started = true;
        let started = Instant::now();
        while !monitor
            .events
            .lock()
            .map_err(|_| "Event callback failed")?
            .history
        {
            control.check()?;
            if started.elapsed() > Duration::from_secs(5) {
                return Err("Change history replay timed out".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Starting and replaying a stream is faster than the kernel-to-daemon event handoff.
        // Keep observing before the first flush instead of treating HistoryDone as a live-event barrier.
        while started.elapsed() < Duration::from_millis(300) {
            control.check()?;
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(monitor)
    }
    pub fn drain(&self, control: &Control) -> Result<Dirty> {
        control.check()?;
        unsafe {
            FSEventStreamFlushSync(self.stream);
        }
        control.check()?;
        let mut events = self.events.lock().map_err(|_| "Event callback failed")?;
        if let Some(reason) = &events.unsafe_reason {
            return Err(reason.clone().into());
        }
        self.checkpoint.set(events.last_id);
        Ok(std::mem::take(&mut events.dirty))
    }
    pub fn checkpoint(&self) -> u64 {
        self.checkpoint.get()
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        unsafe {
            if self.started {
                FSEventStreamStop(self.stream);
            }
            FSEventStreamInvalidate(self.stream);
            dispatch_sync_f(self.queue, std::ptr::null_mut(), barrier);
            FSEventStreamRelease(self.stream);
            dispatch_release(self.queue);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_changes_read_parent_but_reuse_siblings_and_children() {
        let mut events = Events {
            root: vec![b"root".to_vec()],
            ..Events::default()
        };
        events.accept(b"root/a/file", 0x10000 | 0x1000);
        assert!(events.dirty.affects(&[]));
        assert!(events.dirty.affects(&[b"a".to_vec()]));
        assert!(!events.dirty.affects(&[b"b".to_vec()]));
        assert!(!events.dirty.affects(&[b"a".to_vec(), b"child".to_vec()]));
        events.accept(b"root/a", 0x20000 | 0x800);
        assert!(events.dirty.affects(&[b"a".to_vec(), b"child".to_vec()]));
    }
    #[test]
    fn ambiguity_requires_full_scan() {
        for flags in [2, 4, 8, 0x20, 0x40, 0x80, 0x800000, 0x12] {
            let mut events = Events::default();
            events.accept(b"outside", flags);
            assert!(events.unsafe_reason.is_some());
        }
    }
    #[test]
    fn unrelated_temporary_siblings_do_not_invalidate_a_tracked_root() {
        let mut events = Events {
            root: vec![b"tmp".to_vec(), b"owned".to_vec()],
            ..Events::default()
        };
        events.accept(b"tmp", 0x20000 | 0x400);
        events.accept(b"tmp/other/file", 0x10000 | 0x1000);
        assert!(events.dirty.is_empty());
        events.accept(b"tmp", 0x20000 | 1);
        assert!(events.dirty.affects(&[]));
    }
    #[test]
    fn path_components_do_not_match_similarly_named_siblings() {
        let mut events = Events::default();
        events.accept(b"alpha/file", 0x10000 | 0x1000);
        assert!(events.dirty.affects(&[b"alpha".to_vec()]));
        assert!(!events.dirty.affects(&[b"alphabet".to_vec()]));
        assert!(
            !events
                .dirty
                .affects(&[b"alpha".to_vec(), b"child".to_vec()])
        );
        events.accept(b"alpha", 0x20000 | 1);
        assert!(
            events
                .dirty
                .affects(&[b"alpha".to_vec(), b"child".to_vec()])
        );
    }
}
