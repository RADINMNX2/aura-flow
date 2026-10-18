#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! flow. setup — the installer shell.
//!
//! The app itself is installed through the embedded Tauri NSIS installer so the user gets a
//! real uninstaller, Add/Remove Programs entry and upgrade path. This shell owns the modern
//! wizard, the prerequisite checks, RIFE brokering and the ffmpeg download.
//!
//! The app, engine and installer are embedded in this executable; the result is one file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use winreg::enums::*;
use winreg::RegKey;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const APP_ID: &str = "studio.aura.flow";
const APP_EXE: &str = "flow-studio.exe";
const NSIS_FILE: &str = env!("FLOW_PAYLOAD_NSIS");
const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const FFMPEG_BYTES: u64 = 114_768_076;

static NSIS_SETUP: &[u8] = include_bytes!(concat!("../payload/", env!("FLOW_PAYLOAD_NSIS")));
static RIFE_EXE: &[u8] = include_bytes!("../payload/rife-ncnn-vulkan.exe");
static RIFE_BIN: &[u8] = include_bytes!("../payload/rife-v4.26/flownet.bin");
static RIFE_PARAM: &[u8] = include_bytes!("../payload/rife-v4.26/flownet.param");
static RIFE_LICENSE: &[u8] = include_bytes!("../payload/rife-ncnn-vulkan.LICENSE.txt");

const STAGES: [&str; 5] = ["prepare", "app", "engine", "tools", "finish"];
const UNINST_STAGES: [&str; 4] = ["stop", "app", "data", "finish"];

#[derive(Default)]
struct InstallerState {
    running: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    cancellable: Arc<AtomicBool>,
}

/* ─────────────────────────────── preflight ─────────────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OsInfo {
    name: String,
    version: String,
    build: String,
    arch: String,
    locale: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WebviewInfo {
    ok: bool,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GpuInfo {
    ok: bool,
    name: String,
    memory_mb: f64,
    driver: Option<String>,
    vulkan: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    ok: bool,
    name: String,
    size_mb: f64,
    bundled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolInfo {
    path: String,
    version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsInfo {
    ok: bool,
    source: String,
    ffmpeg: Option<ToolInfo>,
    ffprobe: Option<ToolInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskInfo {
    free_gb: f64,
    root: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledInfo {
    ok: bool,
    version: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sizes {
    app_mb: f64,
    engine_mb: f64,
    download_mb: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preflight {
    setup_version: String,
    os: OsInfo,
    webview2: WebviewInfo,
    gpu: GpuInfo,
    engine: EngineInfo,
    tools: ToolsInfo,
    disk: DiskInfo,
    install_dir: String,
    installed: Option<InstalledInfo>,
    data_mb: f64,
    sizes: Sizes,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolsCheck {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    ffmpeg: Option<ToolInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ffprobe: Option<ToolInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallOptions {
    dir: String,
    #[serde(default)]
    desktop: bool,
    #[serde(default)]
    start_menu: bool,
    #[serde(default)]
    launch: bool,
    tools_mode: String,
    #[serde(default)]
    ffmpeg: Option<String>,
    #[serde(default)]
    ffprobe: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    ok: bool,
    path: String,
    exe: String,
    version: String,
    engine: String,
    tools: String,
    update: bool,
}

enum InstallErr {
    Cancelled,
    Msg(String),
}

impl From<String> for InstallErr {
    fn from(s: String) -> Self { Self::Msg(s) }
}
impl From<&str> for InstallErr {
    fn from(s: &str) -> Self { Self::Msg(s.to_string()) }
}
impl From<std::io::Error> for InstallErr {
    fn from(e: std::io::Error) -> Self { Self::Msg(e.to_string()) }
}
impl From<serde_json::Error> for InstallErr {
    fn from(e: serde_json::Error) -> Self { Self::Msg(e.to_string()) }
}
impl std::fmt::Display for InstallErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { Self::Cancelled => f.write_str("cancelled"), Self::Msg(s) => f.write_str(s) }
    }
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

fn hidden(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(Stdio::null());
    cmd
}

fn app_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_ID)
}

fn read_hklm(path: &str, name: &str) -> Option<String> {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    key.get_value::<String, _>(name).ok()
}

fn read_hkcu(path: &str, name: &str) -> Option<String> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(path, KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    key.get_value::<String, _>(name).ok()
}

fn webview2_version() -> Option<String> {
    let id = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    read_hklm(&format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{id}"), "pv")
        .or_else(|| read_hkcu(&format!(r"Software\Microsoft\EdgeUpdate\Clients\{id}"), "pv"))
        .or_else(|| read_hklm(&format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{id}"), "pv"))
}

fn installed_info() -> Option<InstalledInfo> {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\flow", KEY_READ | KEY_WOW64_64KEY)
        .ok()?;
    let version = key.get_value::<String, _>("DisplayVersion").unwrap_or_default();
    let location = key.get_value::<String, _>("InstallLocation").unwrap_or_default();
    let path = location.trim().trim_matches('"').to_string();
    if path.is_empty() { return None; }
    Some(InstalledInfo { ok: Path::new(&path).join(APP_EXE).is_file(), version, path })
}

fn os_info() -> OsInfo {
    let base = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let mut name = read_hklm(base, "ProductName").unwrap_or_else(|| "Windows".into());
    let build = read_hklm(base, "CurrentBuildNumber").unwrap_or_default();
    let ubr = read_hklm(base, "UBR").unwrap_or_default();
    if build.parse::<u32>().unwrap_or(0) >= 22000 && name.contains("Windows 10") {
        name = name.replace("Windows 10", "Windows 11");
    }
    let build = if ubr.is_empty() || ubr == "0" { build.clone() } else { format!("{build}.{ubr}") };
    let version = read_hklm(base, "DisplayVersion")
        .or_else(|| read_hklm(base, "ReleaseId"))
        .unwrap_or_else(|| "—".into());
    let locale = read_hkcu(r"Control Panel\International", "LocaleName").unwrap_or_else(|| "en-US".into());
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }.to_string();
    OsInfo { name, version, build, arch, locale }
}

fn vulkan_present() -> bool {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:/Windows"))
        .join("System32").join("vulkan-1.dll").is_file()
}

fn gpu_info() -> GpuInfo {
    let vulkan = vulkan_present();
    let driver = hidden("nvidia-smi")
        .args(["--query-gpu=driver_version", "--format=csv,noheader"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty());
    match flow_core::gpu::list() {
        Ok(list) if !list.is_empty() => {
            let g = &list[0];
            GpuInfo { ok: true, name: g.name.clone(), memory_mb: g.memory_mb, driver, vulkan }
        }
        _ => GpuInfo { ok: false, name: "Not detected".into(), memory_mb: 0.0, driver, vulkan },
    }
}

fn tool_version(path: &Path) -> Result<String, String> {
    if !path.is_file() {
        return Err(format!("{} does not exist", path.display()));
    }
    let out = hidden(path)
        .arg("-version")
        .output()
        .map_err(|e| format!("{} could not start: {e}", path.display()))?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.trim().is_empty() { text = String::from_utf8_lossy(&out.stderr).to_string(); }
    if !out.status.success() {
        return Err(format!("{} -version exited with {:?}", path.display(), out.status.code()));
    }
    let first = text.lines().next().unwrap_or("").trim();
    let version = first
        .strip_prefix("ffmpeg version ").or_else(|| first.strip_prefix("ffprobe version "))
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or(first)
        .to_string();
    Ok(version.chars().take(40).collect())
}

fn validate_pair(ffmpeg: &Path, ffprobe: &Path) -> ToolsCheck {
    let ff = tool_version(ffmpeg);
    let fp = tool_version(ffprobe);
    match (ff, fp) {
        (Ok(fv), Ok(pv)) => ToolsCheck {
            ok: true,
            ffmpeg: Some(ToolInfo { path: ffmpeg.to_string_lossy().to_string(), version: Some(fv) }),
            ffprobe: Some(ToolInfo { path: ffprobe.to_string_lossy().to_string(), version: Some(pv) }),
            error: None,
        },
        (a, b) => {
            let fv = a.as_ref().ok().cloned();
            let pv = b.as_ref().ok().cloned();
            let error = a.as_ref().err().cloned().or_else(|| b.as_ref().err().cloned())
                .unwrap_or_else(|| "the two tools did not answer".into());
            ToolsCheck {
                ok: false,
                ffmpeg: Some(ToolInfo { path: ffmpeg.to_string_lossy().to_string(), version: fv }),
                ffprobe: Some(ToolInfo { path: ffprobe.to_string_lossy().to_string(), version: pv }),
                error: Some(error),
            }
        }
    }
}

fn discover_tools() -> ToolsInfo {
    match flow_core::probe::Toolchain::discover() {
        Ok(t) => {
            let check = validate_pair(&t.ffmpeg, &t.ffprobe);
            ToolsInfo {
                ok: check.ok,
                source: if app_data_dir().join("toolchain.json").is_file() { "configured".into() } else { "detected".into() },
                ffmpeg: check.ffmpeg,
                ffprobe: check.ffprobe,
            }
        }
        Err(_) => ToolsInfo { ok: false, source: "none".into(), ffmpeg: None, ffprobe: None },
    }
}

fn engine_size_mb() -> f64 {
    let bytes = RIFE_EXE.len() + RIFE_BIN.len() + RIFE_PARAM.len() + RIFE_LICENSE.len();
    (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

fn disk_info(path: &Path) -> DiskInfo {
    let start = if path.exists() { path } else { path.parent().unwrap_or(Path::new(".")) };
    let root = start.ancestors().find(|p| p.parent().is_none()).unwrap_or(Path::new("C:\\"));
    let free = fs2::available_space(root).unwrap_or(0);
    DiskInfo { free_gb: (free as f64 / 1_073_741_824.0 * 10.0).round() / 10.0, root: root.to_string_lossy().to_string() }
}

fn default_install_dir(installed: &Option<InstalledInfo>) -> PathBuf {
    if let Some(i) = installed {
        if i.ok && !i.path.is_empty() { return PathBuf::from(&i.path); }
    }
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Programs")
        .join("flow")
}

fn collect_preflight() -> Preflight {
    let wv = webview2_version();
    let installed = installed_info();
    let install_dir = default_install_dir(&installed);
    let data_mb = ((dir_kb(&app_data_dir()) as f64 / 1024.0) * 10.0).round() / 10.0;
    Preflight {
        setup_version: VERSION.into(),
        os: os_info(),
        webview2: WebviewInfo { ok: wv.is_some(), version: wv },
        gpu: gpu_info(),
        engine: EngineInfo { ok: true, name: "RIFE 4.26".into(), size_mb: engine_size_mb(), bundled: true },
        tools: discover_tools(),
        disk: disk_info(&install_dir),
        install_dir: install_dir.to_string_lossy().to_string(),
        installed,
        data_mb,
        sizes: Sizes { app_mb: 5.5, engine_mb: engine_size_mb(), download_mb: (FFMPEG_BYTES as f64 / 1_048_576.0).round() as u64 },
    }
}

/* ─────────────────────────────── commands ─────────────────────────────── */

#[tauri::command]
async fn preflight() -> Result<Preflight, String> {
    tauri::async_runtime::spawn_blocking(collect_preflight)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder(current: Option<String>) -> Result<Option<String>, String> {
    let dir = tauri::async_runtime::spawn_blocking(move || {
        let mut d = rfd::FileDialog::new().set_title("Where should flow live?");
        if let Some(c) = current.filter(|c| Path::new(c).is_dir()) {
            d = d.set_directory(c);
        }
        d.pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(dir.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_tools() -> Result<Option<Value>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        let ffmpeg = rfd::FileDialog::new().set_title("Pick ffmpeg.exe").add_filter("ffmpeg", &["exe"]).pick_file()?;
        let ffprobe = rfd::FileDialog::new().set_title("Pick ffprobe.exe").add_filter("ffprobe", &["exe"]).pick_file()?;
        Some((ffmpeg, ffprobe))
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked.map(|(ffmpeg, ffprobe)| json!({
        "ffmpeg": { "path": ffmpeg.to_string_lossy(), "version": null },
        "ffprobe": { "path": ffprobe.to_string_lossy(), "version": null },
    })))
}

#[tauri::command]
async fn validate_tools(ffmpeg: Option<String>, ffprobe: Option<String>) -> Result<ToolsCheck, String> {
    tauri::async_runtime::spawn_blocking(move || match (ffmpeg, ffprobe) {
        (Some(a), Some(b)) => validate_pair(Path::new(&a), Path::new(&b)),
        _ => ToolsCheck { ok: false, ffmpeg: None, ffprobe: None, error: Some("pick both ffmpeg.exe and ffprobe.exe".into()) },
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_install(app: AppHandle, state: State<'_, InstallerState>, options: InstallOptions) -> Result<Value, String> {
    let running = state.running.clone();
    if running.swap(true, Ordering::SeqCst) {
        return Err("an install is already running".into());
    }
    let cancel = state.cancel.clone();
    let cancellable = state.cancellable.clone();
    cancel.store(false, Ordering::SeqCst);
    cancellable.store(true, Ordering::SeqCst);
    let app_for_job = app.clone();
    let options_for_job = options;
    let cancel_for_job = cancel.clone();
    let cancellable_for_job = cancellable.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        install(&app_for_job, &options_for_job, &cancel_for_job, &cancellable_for_job)
    })
    .await
    .map_err(|e| e.to_string())?;
    running.store(false, Ordering::SeqCst);
    cancellable.store(false, Ordering::SeqCst);
    match result {
        Ok(outcome) => Ok(json!({ "ok": true, "out": outcome, "path": outcome.path, "exe": outcome.exe, "version": outcome.version, "engine": outcome.engine, "tools": outcome.tools, "update": outcome.update })),
        Err(InstallErr::Cancelled) => Ok(json!({ "ok": false, "cancelled": true })),
        Err(InstallErr::Msg(msg)) => Err(msg),
    }
}

#[tauri::command]
fn cancel_install(state: State<'_, InstallerState>) -> Value {
    if !state.running.load(Ordering::SeqCst) {
        return json!({ "ok": false, "why": "nothing is running" });
    }
    if !state.cancellable.load(Ordering::SeqCst) {
        return json!({ "ok": false, "why": "too late to cancel, app files are already being written" });
    }
    state.cancel.store(true, Ordering::SeqCst);
    json!({ "ok": true })
}

/* ────────────────────────────── uninstall ────────────────────────────── */

fn u_stage(app: &AppHandle, index: usize, done: bool) {
    let _ = app.emit("setup://stage", json!({
        "id": UNINST_STAGES[index], "index": index, "of": UNINST_STAGES.len(), "done": done
    }));
}

fn u_progress(app: &AppHandle, index: usize, stage_p: f64) {
    let p = stage_p.clamp(0.0, 1.0);
    let _ = app.emit("setup://progress", json!({
        "stage": UNINST_STAGES[index], "stageP": p, "overall": (index as f64 + p) / UNINST_STAGES.len() as f64
    }));
}

fn u_begin(app: &AppHandle, index: usize) {
    u_stage(app, index, false);
    u_progress(app, index, 0.0);
    log(app, "info", format!("{} started", UNINST_STAGES[index]));
}

fn u_end(app: &AppHandle, index: usize) {
    u_progress(app, index, 1.0);
    u_stage(app, index, true);
    log(app, "ok", format!("{} done", UNINST_STAGES[index]));
}

fn remove_dir_retry(dir: &Path) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..8 {
        if !dir.exists() { return Ok(()); }
        match fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = e.to_string();
                if attempt < 7 { std::thread::sleep(Duration::from_millis(300)); }
            }
        }
    }
    Err(last)
}

/// Ask only the installed flow window to close, politely first, then by exact PID.
fn close_installed_app(exe: &Path) -> Result<(), String> {
    let exe_s = exe.to_string_lossy().replace('\'', "''");
    let script = r#"
$target = '__EXE__';
$p = @(Get-Process -Name 'flow-studio' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target });
if ($p.Count -gt 0) {
  foreach ($x in $p) { try { $x.CloseMainWindow() | Out-Null } catch {} }
  $deadline = (Get-Date).AddSeconds(6);
  while ((Get-Date) -lt $deadline) {
    $left = @(Get-Process -Name 'flow-studio' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target });
    if ($left.Count -eq 0) { break };
    Start-Sleep -Milliseconds 300;
  }
  $left = @(Get-Process -Name 'flow-studio' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target });
  if ($left.Count -gt 0) { $left | Stop-Process -Force; Start-Sleep -Milliseconds 800 }
}
$left = @(Get-Process -Name 'flow-studio' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target });
if ($left.Count -gt 0) { exit 3 }
exit 0
"#.replace("__EXE__", &exe_s);
    let out = hidden("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script.as_str()])
        .output()
        .map_err(|e| format!("could not ask Windows to close flow: {e}"))?;
    if !out.status.success() {
        return Err("flow is still running. Close it, then try again.".into());
    }
    Ok(())
}

fn run_uninstaller(app: &AppHandle, installed: &Path) -> Result<(), String> {
    let un = installed.join("uninstall.exe");
    if !un.is_file() {
        return Err(format!("the uninstaller is missing at {}", un.display()));
    }
    let nsu_before = std::env::temp_dir().join("~nsu.tmp").exists();
    let mut child = hidden(&un)
        .current_dir(installed)
        .arg("/S")
        .spawn()
        .map_err(|e| format!("the uninstaller could not start: {e}"))?;
    match child.wait() {
        Ok(status) if !status.success() => log(app, "warn", format!("uninstaller returned {:?}", status.code())),
        Err(e) => log(app, "warn", format!("waiting for the uninstaller: {e}")),
        _ => {}
    }
    let exe = installed.join(APP_EXE);
    let nsu_tmp = std::env::temp_dir().join("~nsu.tmp");
    let started = Instant::now();
    let timeout = Duration::from_secs(120);
    // Silent NSIS hands off to a temp uninstaller and its launcher returns immediately.
    // Wait for the app exe, the uninstaller and the NSIS staging folder to disappear,
    // otherwise a quick "Install again" can be deleted by the still-running cleaner.
    loop {
        let exe_gone = !exe.is_file();
        let un_gone = !un.is_file();
        let tmp_gone = nsu_before || !nsu_tmp.exists();
        if exe_gone && un_gone && tmp_gone { break; }
        if started.elapsed() > timeout {
            return Err("the uninstaller did not finish. Close flow and try again.".into());
        }
        let p = (started.elapsed().as_secs_f64() / 22.0).clamp(0.05, 0.9);
        u_progress(app, 1, p);
        std::thread::sleep(Duration::from_millis(250));
    }
    // Give the temp process a final moment for shortcuts/registry, then re-check.
    std::thread::sleep(Duration::from_millis(2200));
    if exe.is_file() {
        return Err(format!("{} is still on disk", exe.display()));
    }
    log(app, "ok", "uninstaller settled");
    Ok(())
}

fn remove_shortcut(path: PathBuf) {
    if path.is_file() { let _ = fs::remove_file(path); }
}

fn uninstall(app: &AppHandle, remove_data: bool) -> Result<Value, String> {
    let started = Instant::now();
    let ins = installed_info().ok_or_else(|| "flow is not installed for this user.".to_string())?;
    if !ins.ok || ins.path.trim().is_empty() {
        return Err("flow is not installed for this user.".into());
    }
    let target = PathBuf::from(&ins.path);
    let exe = target.join(APP_EXE);
    log(app, "info", format!("removing flow from {}", target.display()));

    u_begin(app, 0);
    close_installed_app(&exe)?;
    u_end(app, 0);

    u_begin(app, 1);
    run_uninstaller(app, &target)?;
    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(r"Software\RADINMNX\flow");
    let _ = RegKey::predef(HKEY_CURRENT_USER)
        .delete_subkey_all(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\flow");
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        remove_shortcut(PathBuf::from(profile).join("Desktop").join("flow.lnk"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        remove_shortcut(PathBuf::from(appdata).join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("flow.lnk"));
    }
    u_end(app, 1);

    u_begin(app, 2);
    let data_dir = app_data_dir();
    let data_kb = dir_kb(&data_dir);
    if remove_data {
        log(app, "info", format!("removing local data ({:.1} MB)", data_kb as f64 / 1024.0));
        match remove_dir_retry(&data_dir) {
            Ok(()) => log(app, "ok", "engine, tools and WebView data removed"),
            Err(e) => log(app, "warn", format!("local data is still locked: {e}")),
        }
    } else {
        log(app, "info", "engine and tools kept for a faster reinstall");
        let _ = fs::remove_file(data_dir.join("setup-manifest.json"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let temp = PathBuf::from(local).join("flow").join("temp");
        let _ = fs::remove_dir_all(temp);
    }
    u_end(app, 2);

    u_begin(app, 3);
    if exe.is_file() {
        return Err(format!("{} is still on disk", exe.display()));
    }
    let data_kept = data_dir.is_dir();
    let data_deleted = !data_kept;
    let data_mb = (data_kb as f64 / 1024.0 * 10.0).round() / 10.0;
    u_end(app, 3);
    log(app, "ok", format!("flow removed in {:.1}s", started.elapsed().as_secs_f64()));
    Ok(json!({
        "ok": true,
        "path": target.to_string_lossy(),
        "dataDeleted": data_deleted,
        "dataKept": data_kept,
        "dataMb": data_mb,
        "mode": "uninstall"
    }))
}

#[tauri::command]
async fn start_uninstall(
    app: AppHandle,
    state: State<'_, InstallerState>,
    remove_data: bool,
) -> Result<Value, String> {
    let running = state.running.clone();
    if running.swap(true, Ordering::SeqCst) {
        return Err("another setup action is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    state.cancellable.store(false, Ordering::SeqCst);
    let app_for_job = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || uninstall(&app_for_job, remove_data)).await;
    running.store(false, Ordering::SeqCst);
    match result {
        Ok(r) => r,
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn open_app(path: String) -> Value {
    let p = PathBuf::from(&path);
    let exe = if p.is_dir() { p.join(APP_EXE) } else { p };
    if !exe.is_file() {
        return json!({ "ok": false, "why": "flow-studio.exe was not found there" });
    }
    match Command::new(&exe).current_dir(exe.parent().unwrap_or(Path::new("."))).spawn() {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "why": e.to_string() }),
    }
}

#[tauri::command]
fn reveal_path(path: String) -> Value {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return json!({ "ok": false, "why": "that path does not exist" });
    }
    let mut cmd = hidden("explorer.exe");
    if p.is_dir() { cmd.arg(p.as_os_str()); } else { cmd.arg(format!("/select,{}", p.display())); }
    match cmd.spawn() {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "why": e.to_string() }),
    }
}

/* ─────────────────────────────── install ─────────────────────────────── */

fn stage(app: &AppHandle, index: usize, done: bool) {
    let _ = app.emit("setup://stage", json!({
        "id": STAGES[index], "index": index, "of": STAGES.len(), "done": done
    }));
}

fn progress(app: &AppHandle, index: usize, stage_p: f64) {
    let p = stage_p.clamp(0.0, 1.0);
    let _ = app.emit("setup://progress", json!({
        "stage": STAGES[index], "stageP": p, "overall": (index as f64 + p) / STAGES.len() as f64
    }));
}

fn log(app: &AppHandle, level: &str, text: impl AsRef<str>) {
    let _ = app.emit("setup://log", json!({ "level": level, "text": text.as_ref() }));
}

fn begin_stage(app: &AppHandle, index: usize) {
    stage(app, index, false);
    progress(app, index, 0.0);
    log(app, "info", format!("{} started", STAGES[index]));
}

fn end_stage(app: &AppHandle, index: usize) {
    progress(app, index, 1.0);
    stage(app, index, true);
    log(app, "ok", format!("{} done", STAGES[index]));
}

fn ensure_not_running() -> Result<(), String> {
    let out = hidden("tasklist")
        .args(["/FI", "IMAGENAME eq flow-studio.exe", "/NH"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    if text.contains("flow-studio.exe") {
        Err("flow is still running. Close it, then run the setup again.".into())
    } else {
        Ok(())
    }
}

fn write_install_location(target: &Path) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(r"Software\RADINMNX\flow").map_err(|e| e.to_string())?;
    key.set_value("", &target.to_string_lossy().to_string()).map_err(|e| e.to_string())
}

fn installed_location_fallback(target: &Path) -> PathBuf {
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\flow", KEY_READ | KEY_WOW64_64KEY)
        .ok();
    if let Some(k) = key {
        if let Ok(v) = k.get_value::<String, _>("InstallLocation") {
            let p = PathBuf::from(v.trim().trim_matches('"'));
            if p.join(APP_EXE).is_file() { return p; }
        }
    }
    target.to_path_buf()
}

fn run_nsis(app: &AppHandle, stage_index: usize, nsis: &Path) -> Result<(), String> {
    let mut child = hidden(nsis)
        .args(["/S", "/NS"])
        .spawn()
        .map_err(|e| format!("the app installer could not start: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!("the app installer exited with {:?}", status.code()));
                }
                return Ok(());
            }
            Ok(None) => {
                let p = (started.elapsed().as_secs_f64() / 3.2).clamp(0.06, 0.9);
                progress(app, stage_index, p);
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err(format!("waiting for the app installer: {e}")),
        }
    }
}

struct WriteProgress<'a> {
    app: &'a AppHandle,
    stage_index: usize,
    base: f64,
    span: f64,
    total: u64,
    written: u64,
    cancel: &'a Arc<AtomicBool>,
    last_emit: Instant,
}

impl<'a> WriteProgress<'a> {
    fn new(app: &'a AppHandle, stage_index: usize, base: f64, span: f64, total: u64, cancel: &'a Arc<AtomicBool>) -> Self {
        Self { app, stage_index, base, span, total, written: 0, cancel, last_emit: Instant::now() }
    }
    fn write(&mut self, dest: &Path, data: &[u8]) -> Result<(), InstallErr> {
        if let Some(parent) = dest.parent() { fs::create_dir_all(parent)?; }
        let mut file = fs::File::create(dest)?;
        for chunk in data.chunks(256 * 1024) {
            if self.cancel.load(Ordering::SeqCst) { return Err(InstallErr::Cancelled); }
            file.write_all(chunk)?;
            self.written += chunk.len() as u64;
            let local = if self.total > 0 { (self.written as f64 / self.total as f64).clamp(0.0, 1.0) } else { 0.0 };
            if local >= 1.0 || self.last_emit.elapsed() >= Duration::from_millis(60) {
                progress(self.app, self.stage_index, self.base + local * self.span);
                self.last_emit = Instant::now();
            }
        }
        Ok(())
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(p) = path.parent() { fs::create_dir_all(p).map_err(|e| e.to_string())?; }
    fs::write(path, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn shortcut_powershell(exe: &Path, desktop: bool, start_menu: bool) -> Result<(), String> {
    if !desktop && !start_menu { return Ok(()); }
    let mut script = String::from("$ws = New-Object -ComObject WScript.Shell\r\n");
    let def = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let exe_s = def(exe);
    let dir_s = def(exe.parent().unwrap_or(Path::new(".")));
    if desktop {
        let desk = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default().join("Desktop").join("flow.lnk");
        script.push_str(&format!(
            "$s = $ws.CreateShortcut('{lnk}'); $s.TargetPath = '{exe}'; $s.WorkingDirectory = '{dir}'; $s.IconLocation = '{exe},0'; $s.Save()\r\n",
            lnk = def(&desk), exe = exe_s, dir = dir_s
        ));
    }
    if start_menu {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let dir = PathBuf::from(appdata).join("Microsoft").join("Windows").join("Start Menu").join("Programs");
            let lnk = dir.join("flow.lnk");
            script.push_str(&format!(
                "$s = $ws.CreateShortcut('{lnk}'); $s.TargetPath = '{exe}'; $s.WorkingDirectory = '{dir}'; $s.IconLocation = '{exe},0'; $s.Save()\r\n",
                lnk = def(&lnk), exe = exe_s, dir = dir_s
            ));
        }
    }
    script.push_str("$ws = $null\r\n");
    let out = hidden("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script.as_str()])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect());
    }
    Ok(())
}

fn dir_kb(path: &Path) -> u64 {
    fn walk(p: &Path, total: &mut u64) {
        let Ok(rd) = fs::read_dir(p) else { return };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() { walk(&e.path(), total); } else { *total = total.saturating_add(meta.len()); }
        }
    }
    let mut total = 0;
    walk(path, &mut total);
    total / 1024
}

fn update_estimated_size(paths: &[&Path]) {
    let total: u64 = paths.iter().map(|p| dir_kb(p)).sum::<u64>().min(u32::MAX as u64);
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\flow", KEY_WRITE | KEY_WOW64_64KEY)
    {
        let _ = key.set_value("EstimatedSize", &(total as u32));
    }
}

fn find_below(root: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() { stack.push(p); }
            else if p.file_name().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case(name)).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

fn install(app: &AppHandle, opts: &InstallOptions, cancel: &Arc<AtomicBool>, cancellable: &Arc<AtomicBool>) -> Result<Outcome, InstallErr> {
    let started = Instant::now();
    let target = PathBuf::from(&opts.dir);
    if !target.is_absolute() || opts.dir.trim().is_empty() {
        return Err(InstallErr::Msg("Pick an absolute install folder.".into()));
    }
    ensure_not_running().map_err(InstallErr::Msg)?;
    let update = installed_info().map(|i| i.ok).unwrap_or(false);
    let temp = std::env::temp_dir().join(format!("flow-setup-{}-{}", std::process::id(), started.elapsed().as_nanos()));
    fs::create_dir_all(&temp)?;

    begin_stage(app, 0);
    log(app, "info", format!("target {}", target.display()));
    fs::create_dir_all(&target)?;
    let probe_file = target.join(".flow-setup-probe");
    fs::write(&probe_file, b"ok")?;
    let _ = fs::remove_file(&probe_file);
    progress(app, 0, 0.25);
    if cancel.load(Ordering::SeqCst) { return Err(InstallErr::Cancelled); }
    write_install_location(&target).map_err(|e| InstallErr::Msg(format!("could not pin the install location: {e}")))?;
    let nsis_path = temp.join(NSIS_FILE);
    let mut w = WriteProgress::new(app, 0, 0.25, 0.65, NSIS_SETUP.len() as u64, cancel);
    w.write(&nsis_path, NSIS_SETUP)?;
    fs::create_dir_all(app_data_dir()).map_err(|e| InstallErr::Msg(e.to_string()))?;
    log(app, "info", "app installer unpacked");
    end_stage(app, 0);

    begin_stage(app, 1);
    cancellable.store(false, Ordering::SeqCst);
    log(app, "info", format!("installing flow into {}", target.display()));
    run_nsis(app, 1, &nsis_path).map_err(InstallErr::Msg)?;
    let installed = installed_location_fallback(&target);
    let exe = installed.join(APP_EXE);
    if !exe.is_file() {
        return Err(InstallErr::Msg(format!("the app did not land at {}", exe.display())));
    }
    if installed != target {
        log(app, "warn", format!("the installer chose {} instead of the picked folder", installed.display()));
    }
    end_stage(app, 1);

    begin_stage(app, 2);
    let engine_dir = app_data_dir().join("engines").join("rife-ncnn");
    let model_dir = engine_dir.join("rife-v4.26");
    fs::create_dir_all(&model_dir).map_err(|e| InstallErr::Msg(e.to_string()))?;
    let total_engine = (RIFE_EXE.len() + RIFE_BIN.len() + RIFE_PARAM.len() + RIFE_LICENSE.len()) as u64;
    let mut w = WriteProgress::new(app, 2, 0.0, 0.85, total_engine, cancel);
    w.write(&engine_dir.join("rife-ncnn-vulkan.exe"), RIFE_EXE)?;
    w.write(&model_dir.join("flownet.bin"), RIFE_BIN)?;
    w.write(&model_dir.join("flownet.param"), RIFE_PARAM)?;
    w.write(&engine_dir.join("LICENSE-rife-ncnn-vulkan.txt"), RIFE_LICENSE)?;
    progress(app, 2, 0.9);
    log(app, "info", format!("RIFE 4.26 -> {}", engine_dir.display()));
    end_stage(app, 2);

    begin_stage(app, 3);
    let tools_dir = app_data_dir().join("tools");
    fs::create_dir_all(&tools_dir).map_err(|e| InstallErr::Msg(e.to_string()))?;
    let mut tool_note = "existing".to_string();
    let pair: (PathBuf, PathBuf) = match opts.tools_mode.as_str() {
        "download" => {
            log(app, "info", "downloading ffmpeg essentials (about 115 MB)");
            let zip = temp.join("ffmpeg.zip");
            download_ffmpeg(app, &zip)?;
            progress(app, 3, 0.55);
            let extract = temp.join("ffmpeg");
            fs::create_dir_all(&extract)?;
            log(app, "info", "unpacking ffmpeg");
            let ok = hidden("tar.exe").args(["-xf", &zip.to_string_lossy(), "-C", &extract.to_string_lossy()]).status().map(|s| s.success()).unwrap_or(false);
            if !ok {
                let script = format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    zip.to_string_lossy().replace('\'', "''"), extract.to_string_lossy().replace('\'', "''")
                );
                let _ = hidden("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script.as_str()]).status();
            }
            let ff = find_below(&extract, "ffmpeg.exe").ok_or_else(|| InstallErr::Msg("ffmpeg.exe was not in the downloaded archive".into()))?;
            let fp = find_below(&extract, "ffprobe.exe").ok_or_else(|| InstallErr::Msg("ffprobe.exe was not in the downloaded archive".into()))?;
            progress(app, 3, 0.68);
            let ff_out = tools_dir.join("ffmpeg.exe");
            let fp_out = tools_dir.join("ffprobe.exe");
            fs::copy(&ff, &ff_out)?;
            progress(app, 3, 0.78);
            fs::copy(&fp, &fp_out)?;
            progress(app, 3, 0.9);
            tool_note = "downloaded".into();
            (ff_out, fp_out)
        }
        _ => {
            let ff = opts.ffmpeg.clone().or_else(|| discover_tools().ffmpeg.map(|t| t.path)).unwrap_or_default();
            let fp = opts.ffprobe.clone().or_else(|| discover_tools().ffprobe.map(|t| t.path)).unwrap_or_default();
            let check = validate_pair(Path::new(&ff), Path::new(&fp));
            if !check.ok {
                return Err(InstallErr::Msg(check.error.unwrap_or_else(|| "ffmpeg and ffprobe were not usable".into())));
            }
            progress(app, 3, 0.55);
            (PathBuf::from(ff), PathBuf::from(fp))
        }
    };
    let config = json!({ "ffmpeg": pair.0.to_string_lossy(), "ffprobe": pair.1.to_string_lossy(), "source": tool_note });
    write_json(&app_data_dir().join("toolchain.json"), &config).map_err(InstallErr::Msg)?;
    log(app, "info", format!("video tools -> {}", pair.0.display()));
    end_stage(app, 3);

    begin_stage(app, 4);
    match shortcut_powershell(&exe, opts.desktop, opts.start_menu) {
        Ok(()) => log(app, "ok", "shortcuts written"),
        Err(e) => log(app, "warn", format!("shortcuts failed: {e}")),
    }
    update_estimated_size(&[installed.as_path(), app_data_dir().as_path()]);
    let manifest = json!({
        "version": VERSION,
        "installedAt": started.elapsed().as_secs(),
        "app": installed.to_string_lossy(),
        "engine": "RIFE 4.26",
        "tools": tool_note,
    });
    let _ = write_json(&app_data_dir().join("setup-manifest.json"), &manifest);
    if opts.launch {
        if let Err(e) = Command::new(&exe).current_dir(installed.as_path()).spawn() {
            log(app, "warn", format!("could not open flow: {e}"));
        }
    }
    end_stage(app, 4);
    let _ = fs::remove_dir_all(&temp);
    log(app, "ok", format!("flow installed in {:.1}s", started.elapsed().as_secs_f64()));
    Ok(Outcome {
        ok: true,
        path: installed.to_string_lossy().to_string(),
        exe: exe.to_string_lossy().to_string(),
        version: VERSION.into(),
        engine: "RIFE 4.26".into(),
        tools: tool_note,
        update,
    })
}

fn download_ffmpeg(app: &AppHandle, dest: &Path) -> Result<(), InstallErr> {
    let mut child = hidden("curl.exe")
        .args(["-L", "--fail", "--retry", "2", "--silent", "--show-error", "-o", &dest.to_string_lossy(), FFMPEG_URL])
        .spawn()
        .map_err(|e| InstallErr::Msg(format!("curl could not start: {e}")))?;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            if !status.success() {
                return Err(InstallErr::Msg(format!("ffmpeg download failed (exit {:?})", status.code())));
            }
            break;
        }
        let size = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        let p = (size as f64 / FFMPEG_BYTES as f64).clamp(0.0, 0.9);
        progress(app, 3, p);
        std::thread::sleep(Duration::from_millis(250));
    }
    let size = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    log(app, "ok", format!("downloaded {:.1} MB", size as f64 / 1_048_576.0));
    Ok(())
}

fn build_setup() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .manage(InstallerState::default())
        .invoke_handler(tauri::generate_handler![
            preflight,
            pick_folder,
            pick_tools,
            validate_tools,
            start_install,
            cancel_install,
            start_uninstall,
            open_app,
            reveal_path
        ])
}

fn main() {
    build_setup()
        .run(tauri::generate_context!())
        .expect("flow setup could not start");
}
