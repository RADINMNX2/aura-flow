#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use flow_core::engines::{self, EngineRuntime};
use flow_core::gpu::GpuSample;
use flow_core::pipeline::Progress;
use flow_core::probe::{probe_file, MediaProbe, Toolchain};
use flow_core::{Core, Job, JobControl, Sink};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    core: Option<Arc<Core>>,
    engines: Vec<EngineRuntime>,
    tool_error: Option<String>,
    current: Arc<Mutex<Option<JobControl>>>,
}

impl AppState {
    fn core(&self) -> Result<Arc<Core>, String> {
        self.core.clone().ok_or_else(|| {
            self.tool_error
                .clone()
                .unwrap_or_else(|| "ffmpeg and ffprobe are required for this action".into())
        })
    }
}

struct TauriSink {
    app: AppHandle,
}

impl Sink for TauriSink {
    fn stage(&mut self, id: &str, index: usize, of: usize, done: bool) {
        let _ = self.app.emit(
            "flow://stage",
            json!({ "id": id, "index": index, "of": of, "done": done }),
        );
    }

    fn progress(&mut self, progress: &Progress) {
        let _ = self.app.emit("flow://progress", progress.clone());
    }

    fn log(&mut self, level: &str, text: &str) {
        let _ = self.app.emit("flow://log", json!({ "level": level, "text": text }));
    }
}

#[tauri::command]
fn scan_engines(state: State<'_, AppState>) -> Value {
    let registry = engines::registry(&state.engines);
    serde_json::to_value(registry).unwrap_or_else(|_| json!({ "engines": [] }))
}

#[tauri::command]
async fn probe(state: State<'_, AppState>, path: String) -> Result<MediaProbe, String> {
    let core = state.core()?;
    let p = PathBuf::from(&path);
    tauri::async_runtime::spawn_blocking(move || probe_file(&core.tools.ffprobe, &p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn plan(state: State<'_, AppState>, job: Job) -> Result<Value, String> {
    let core = state.core()?;
    let plan = tauri::async_runtime::spawn_blocking(move || core.plan(&job))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    serde_json::to_value(plan).map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_job(
    app: AppHandle,
    state: State<'_, AppState>,
    job: Job,
) -> Result<Value, String> {
    let core = state.core()?;
    let current = state.current.clone();
    let control = {
        let mut guard = current.lock().map_err(|_| "job state is poisoned".to_string())?;
        if guard.is_some() {
            return Err("a render is already running".into());
        }
        let c = JobControl::new();
        *guard = Some(c.clone());
        c
    };
    let app_for_job = app.clone();
    let control_for_job = control.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut sink = TauriSink { app: app_for_job };
        core.run(&job, &mut sink, &control_for_job)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = current.lock() {
        *guard = None;
    }
    match result {
        Ok(outcome) => {
            let _ = app.emit("flow://done", outcome.clone());
            Ok(json!({ "ok": true, "out": outcome }))
        }
        Err(err) if err.cancelled() => Ok(json!({ "ok": false, "cancelled": true })),
        Err(err) => {
            let text = err.to_string();
            let _ = app.emit("flow://log", json!({ "level": "error", "text": text }));
            Err(text)
        }
    }
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>) -> Value {
    if let Ok(guard) = state.current.lock() {
        if let Some(control) = guard.as_ref() {
            control.cancel();
        }
    }
    json!({ "ok": true })
}

#[tauri::command]
fn open_url(url: String) -> Value {
    if !(url.starts_with("https://") || url.starts_with("http://")) || url.len() > 2048 {
        return json!({ "ok": false, "why": "only http(s) links are opened" });
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("rundll32.exe");
        cmd.args(["url.dll,FileProtocolHandler", &url]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
        match cmd.spawn() {
            Ok(_) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "why": e.to_string() }),
        }
    }
    #[cfg(not(windows))]
    {
        match std::process::Command::new("xdg-open").arg(&url).spawn() {
            Ok(_) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "why": e.to_string() }),
        }
    }
}

#[tauri::command]
async fn pick_video() -> Result<Option<Value>, String> {
    let file = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Video", &["mp4", "mkv", "mov", "webm", "avi", "m4v"])
            .set_title("Pick a clip")
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(file.map(|p| file_json(&p)))
}

#[tauri::command]
async fn pick_dir() -> Result<Option<String>, String> {
    let dir = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new().set_title("Pick a folder").pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(dir.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn reveal_path(path: String) -> Value {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return json!({ "ok": false, "why": "that path does not exist" });
    }
    #[cfg(windows)]
    {
        let mut cmd = if p.is_dir() {
            let mut c = std::process::Command::new("explorer.exe");
            c.arg(p.as_os_str());
            c
        } else {
            let mut c = std::process::Command::new("explorer.exe");
            c.arg(format!("/select,{}", p.display()));
            c
        };
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
        match cmd.spawn() {
            Ok(_) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "why": e.to_string() }),
        }
    }
    #[cfg(not(windows))]
    {
        let target = if p.is_dir() { p.clone() } else { p.parent().unwrap_or(Path::new(".")).to_path_buf() };
        match std::process::Command::new("xdg-open").arg(target).spawn() {
            Ok(_) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "why": e.to_string() }),
        }
    }
}

#[tauri::command]
async fn list_gpus() -> Result<Vec<flow_core::gpu::GpuInfo>, String> {
    tauri::async_runtime::spawn_blocking(flow_core::gpu::list)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn gpu_sample(gpu: Option<u32>) -> Result<GpuSample, String> {
    tauri::async_runtime::spawn_blocking(move || flow_core::gpu::sample_for(gpu))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn file_json(path: &Path) -> Value {
    json!({
        "path": path.to_string_lossy(),
        "name": path.file_name().and_then(|s| s.to_str()).unwrap_or("clip"),
        "size": std::fs::metadata(path).ok().map(|m| m.len()),
    })
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let toolchain = Toolchain::discover();
            let engine_list = engines::discover(&engines::default_roots());
            let (core, tool_error) = match toolchain {
                Ok(tools) => (Some(Arc::new(Core::new(tools, engine_list.clone()))), None),
                Err(e) => (None, Some(e.to_string())),
            };
            app.manage(AppState {
                core,
                engines: engine_list,
                tool_error,
                current: Arc::new(Mutex::new(None)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_engines,
            probe,
            plan,
            start_job,
            cancel_job,
            open_url,
            pick_video,
            pick_dir,
            reveal_path,
            list_gpus,
            gpu_sample
        ])
        .run(tauri::generate_context!())
        .expect("flow could not start");
}
