use std::io::{self, IsTerminal};

#[cfg(windows)]
use winapi_util::{HandleRef, console};

/// Checks stdout for automatic ANSI support, enabling Windows virtual terminal processing.
#[must_use]
pub fn stdout_supports_ansi() -> bool {
    let terminal = io::stdout().is_terminal();
    #[cfg(windows)]
    let terminal = terminal && enable_windows_ansi(&HandleRef::stdout());
    terminal && std::env::var("TERM").as_deref() != Ok("dumb")
}

/// Checks stderr for automatic ANSI support, enabling Windows virtual terminal processing.
#[must_use]
pub fn stderr_supports_ansi() -> bool {
    let terminal = io::stderr().is_terminal();
    #[cfg(windows)]
    let terminal = terminal && enable_windows_ansi(&HandleRef::stderr());
    terminal && std::env::var("TERM").as_deref() != Ok("dumb")
}

#[cfg(windows)]
fn enable_windows_ansi(handle: &HandleRef) -> bool {
    const ENABLE_VIRTUAL_TERMINAL_PROCESSING: u32 = 0x0004;
    let Ok(mode) = console::mode(handle) else {
        // IsTerminal also recognizes ANSI-capable MSYS/Cygwin PTYs.
        return true;
    };
    console::set_mode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING).is_ok()
}
