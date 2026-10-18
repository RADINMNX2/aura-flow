//! Child-process control. One streaming runner for ffmpeg and the ncnn engines:
//! concurrent stdout/stderr readers (no pipe deadlocks), a tick hook for file-count
//! progress, and a cancel flag checked every ~120 ms.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::{FlowError, Result};

#[derive(Clone, Default, Debug)]
pub struct JobControl {
    cancelled: Arc<AtomicBool>,
}

impl JobControl {
    pub fn new() -> Self {
        Self { cancelled: Arc::new(AtomicBool::new(false)) }
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

pub fn run_streaming<F, T>(
    program: &Path,
    args: &[String],
    control: &JobControl,
    mut on_line: F,
    mut on_tick: T,
) -> Result<()>
where
    F: FnMut(&str),
    T: FnMut(),
{
    if control.is_cancelled() {
        return Err(FlowError::Cancelled);
    }
    let program = resolve_program(program)
        .ok_or_else(|| FlowError::MissingTool(program.to_string_lossy().to_string()))?;

    let mut cmd = Command::new(&program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        FlowError::MissingTool(format!("{} could not start: {e}", program.file_name().unwrap_or_default().to_string_lossy()))
    })?;

    let (tx, rx) = mpsc::channel::<(bool, String)>();
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(std::result::Result::ok) {
                let _ = tx.send((true, line));
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(std::result::Result::ok) {
                let _ = tx.send((false, line));
            }
        });
    }
    drop(tx);

    let started = Instant::now();
    let mut last_tick = Instant::now();
    let mut tail: Vec<String> = Vec::new();
    let mut waited: Option<std::process::ExitStatus> = None;

    loop {
        if control.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(FlowError::Cancelled);
        }

        match rx.recv_timeout(Duration::from_millis(120)) {
            Ok((is_stdout, line)) => {
                if !is_stdout {
                    tail.push(line.clone());
                    if tail.len() > 40 {
                        tail.remove(0);
                    }
                }
                on_line(&line);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if waited.is_none() {
                    waited = child.try_wait().ok().flatten();
                }
                if waited.is_some() {
                    break;
                }
            }
        }

        if let Ok(Some(status)) = child.try_wait() {
            waited = Some(status);
            // drain what is already buffered before closing
            while let Ok((is_stdout, line)) = rx.try_recv() {
                if !is_stdout {
                    tail.push(line.clone());
                }
                on_line(&line);
            }
            break;
        }

        if last_tick.elapsed() >= Duration::from_millis(140) {
            on_tick();
            last_tick = Instant::now();
        }
        if started.elapsed() > Duration::from_secs(60 * 60 * 4) {
            let _ = child.kill();
            return Err(FlowError::Process("the job exceeded the four-hour safety limit".into()));
        }
    }

    let status = waited.or_else(|| child.wait().ok()).ok_or_else(|| FlowError::Process("the process vanished".into()))?;
    if !status.success() {
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        let detail = tail.iter().rev().find(|l| !l.trim().is_empty()).cloned().unwrap_or_default();
        return Err(FlowError::Process(format!(
            "{} exited with {code}: {detail}",
            program.file_name().unwrap_or_default().to_string_lossy()
        )));
    }
    Ok(())
}

fn resolve_program(program: &Path) -> Option<std::path::PathBuf> {
    if program.is_file() {
        return Some(program.to_path_buf());
    }
    // A bare command name is resolved through PATH, like a shell would.
    if program.components().count() != 1 {
        return None;
    }
    let name = program.file_name()?.to_string_lossy().to_string();
    let candidates = if Path::new(&name).extension().is_some() {
        vec![name]
    } else {
        vec![format!("{name}.exe"), name]
    };
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        for cand in &candidates {
            let p = dir.join(cand);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cancelled_control_refuses_to_start() {
        let ctl = JobControl::new();
        ctl.cancel();
        let err = run_streaming(Path::new("cmd.exe"), &[], &ctl, |_| {}, || {}).unwrap_err();
        assert!(err.cancelled());
    }

    #[cfg(windows)]
    #[test]
    fn stdout_is_streamed_line_by_line() {
        let ctl = JobControl::new();
        let args = vec!["/C".to_string(), "echo hello-flow".to_string()];
        let mut seen = Vec::new();
        run_streaming(Path::new("cmd.exe"), &args, &ctl, |l| seen.push(l.to_string()), || {}).unwrap();
        assert!(seen.iter().any(|l| l.contains("hello-flow")));
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_kills_a_running_child() {
        let ctl = JobControl::new();
        let c2 = ctl.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            c2.cancel();
        });
        let args = vec!["/C".to_string(), "ping -n 6 127.0.0.1 >nul".to_string()];
        let started = Instant::now();
        let err = run_streaming(Path::new("cmd.exe"), &args, &ctl, |_| {}, || {}).unwrap_err();
        assert!(err.cancelled());
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
