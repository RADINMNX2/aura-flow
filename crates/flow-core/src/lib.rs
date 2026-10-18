//! flow-core — the local frame-interpolation engine behind flow.
//!
//! Boundaries are deliberately small: `probe` reads media, `plan` is pure math, `engines`
//! scans real installs, `scene` guards cuts, `process` owns child lifetimes and cancellation,
//! and `pipeline` composes the five stages. The Tauri layer only translates these into IPC.

pub mod engines;
pub mod error;
pub mod gpu;
pub mod pipeline;
pub mod plan;
pub mod probe;
pub mod process;
pub mod scene;

pub use error::{FlowError, Result};
pub use pipeline::{Core, Outcome, Progress, Sink};
pub use plan::{Job, Plan, SourceRef};
pub use probe::{MediaProbe, Toolchain};
pub use process::JobControl;

/// Version reported by the core; kept in lockstep with the app.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Spawn a console tool without flashing a console window on Windows.
/// Every child in this workspace goes through this (or sets the same flag itself).
pub(crate) fn quiet_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}
