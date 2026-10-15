#[cfg(windows)]
mod delete;
#[cfg(windows)]
mod legacy;
#[cfg(windows)]
mod locks;
#[cfg(windows)]
mod mft;
mod tree;
#[cfg(unix)]
mod unix;
mod volumes;
#[cfg(windows)]
mod walk;
#[cfg(windows)]
mod windows_worker;
mod worker;
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--worker") {
        std::process::exit(worker::run());
    }
    #[cfg(windows)]
    legacy::main();
    #[cfg(not(windows))]
    {
        eprintln!("Use dw-scan --worker on Unix.");
        std::process::exit(2);
    }
}
