//! Engine discovery. The app never guesses a model path: it scans real folders and only
//! advertises engines whose executable and weights are both present.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{FlowError, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModel {
    pub dir: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    pub size_mb: f64,
    #[serde(default)]
    pub default: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Engine {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub icon: String,
    pub blurb: String,
    pub factors: Vec<u32>,
    pub any_factor: bool,
    pub needs_python: bool,
    pub vram_mb: u32,
    pub models: Vec<EngineModel>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EngineRegistry {
    pub engines: Vec<Engine>,
}

#[derive(Debug, Clone)]
pub struct EngineRuntime {
    pub id: String,
    pub name: String,
    pub exe: PathBuf,
    pub root: PathBuf,
    pub models: Vec<ModelRuntime>,
}

#[derive(Debug, Clone)]
pub struct ModelRuntime {
    pub dir: String,
    pub path: PathBuf,
    pub size_mb: f64,
}

impl EngineRegistry {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_else(|_| serde_json::json!({ "engines": [] }))
    }
}

pub fn default_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(v) = std::env::var("FLOW_ENGINE_ROOT") {
        if !v.trim().is_empty() {
            roots.push(PathBuf::from(v));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("engines"));
        roots.push(cwd.join("vendor").join("engines"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("engines"));
            roots.push(dir.join("resources").join("engines"));
        }
    }
    if let Some(data) = crate::probe::app_data_dir() {
        roots.push(data.join("engines"));
    }
    if let Some(pkgs) = crate::probe::flowframes_pkgs_root() {
        roots.push(pkgs);
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        let p = PathBuf::from(pf).join("Flowframes").join("FlowframesData").join("pkgs");
        if p.is_dir() {
            roots.push(p);
        }
    }
    roots
}

fn candidates(root: &Path, folder: &str) -> Vec<PathBuf> {
    let mut out = vec![root.join(folder), root.join("pkgs").join(folder), root.to_path_buf()];
    // a root may be the engine folder itself; the exe check below decides
    out.dedup();
    out
}

fn find_engine(root: &Path, folder: &str, exe_name: &str) -> Option<PathBuf> {
    for dir in candidates(root, folder) {
        let exe = dir.join(exe_name);
        if exe.is_file() {
            return Some(exe);
        }
    }
    None
}

fn dir_size_bytes(path: &Path) -> u64 {
    fn walk(p: &Path, total: &mut u64) {
        let Ok(entries) = std::fs::read_dir(p) else { return };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                walk(&entry.path(), total);
            } else {
                *total = total.saturating_add(meta.len());
            }
        }
    }
    let mut total = 0;
    walk(path, &mut total);
    total
}

fn looks_like_model(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        let p = e.path();
        p.is_file()
            && matches!(p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(), Some("bin" | "param"))
    })
}

fn model_display(dir: &str) -> String {
    let cleaned = dir.trim_start_matches("rife-").trim_start_matches("RIFE");
    if cleaned.is_empty() {
        return dir.to_string();
    }
    if let Some(v) = cleaned.strip_prefix('v') {
        return format!("RIFE {v}");
    }
    format!("RIFE {cleaned}")
}

fn version_key(dir: &str) -> Vec<u32> {
    dir.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<u32>().ok())
        .collect()
}

fn scan_rife(root: &Path) -> Option<EngineRuntime> {
    let exe = find_engine(root, "rife-ncnn", "rife-ncnn-vulkan.exe")?;
    let root = exe.parent()?.to_path_buf();
    let mut models: Vec<ModelRuntime> = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| looks_like_model(&e.path()))
        .map(|e| {
            let dir = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            ModelRuntime { dir, path, size_mb: (dir_size_bytes(&e.path()) as f64 / 1_048_576.0 * 10.0).round() / 10.0 }
        })
        .collect();
    models.sort_by(|a, b| version_key(&b.dir).cmp(&version_key(&a.dir)).then_with(|| a.dir.cmp(&b.dir)));
    if models.is_empty() {
        return None;
    }
    Some(EngineRuntime { id: "rife-ncnn".into(), name: "RIFE".into(), exe, root, models })
}

fn scan_dain(root: &Path) -> Option<EngineRuntime> {
    let exe = find_engine(root, "dain-ncnn", "dain-ncnn-vulkan.exe")?;
    let root = exe.parent()?.to_path_buf();
    let mut models: Vec<ModelRuntime> = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| looks_like_model(&e.path()))
        .map(|e| {
            let dir = e.file_name().to_string_lossy().to_string();
            let path = e.path();
            ModelRuntime { dir, path, size_mb: (dir_size_bytes(&e.path()) as f64 / 1_048_576.0 * 10.0).round() / 10.0 }
        })
        .collect();
    models.sort_by(|a, b| a.dir.cmp(&b.dir));
    if models.is_empty() {
        return None;
    }
    Some(EngineRuntime { id: "dain-ncnn".into(), name: "DAIN".into(), exe, root, models })
}

pub fn discover(roots: &[PathBuf]) -> Vec<EngineRuntime> {
    let mut out: Vec<EngineRuntime> = Vec::new();
    for root in roots {
        if let Some(r) = scan_rife(root) {
            if !out.iter().any(|e| e.id == r.id) {
                out.push(r);
            }
        }
        if let Some(d) = scan_dain(root) {
            if !out.iter().any(|e| e.id == d.id) {
                out.push(d);
            }
        }
    }
    out
}

pub fn registry(runtimes: &[EngineRuntime]) -> EngineRegistry {
    let engines = runtimes
        .iter()
        .map(|rt| {
            if rt.id == "rife-ncnn" {
                let default_dir = rt
                    .models
                    .iter()
                    .find(|m| m.dir == "rife-v4.26")
                    .or_else(|| rt.models.first())
                    .map(|m| m.dir.clone());
                Engine {
                    id: rt.id.clone(),
                    name: "RIFE".into(),
                    backend: "ncnn-vulkan".into(),
                    icon: "ph-lightning".into(),
                    blurb: "Vulkan, no Python. The fast path on a Pascal card.".into(),
                    factors: vec![2, 3, 4, 5, 6, 8],
                    any_factor: true,
                    needs_python: false,
                    vram_mb: 1400,
                    models: rt
                        .models
                        .iter()
                        .map(|m| EngineModel {
                            dir: m.dir.clone(),
                            name: model_display(&m.dir),
                            desc: Some("ncnn weights".into()),
                            size_mb: m.size_mb,
                            default: Some(&m.dir) == default_dir.as_ref(),
                            fixed: None,
                        })
                        .collect(),
                }
            } else {
                Engine {
                    id: rt.id.clone(),
                    name: "DAIN".into(),
                    backend: "ncnn-vulkan".into(),
                    icon: "ph-depth".into(),
                    blurb: "Depth-aware, slower on a 1070, good on live footage.".into(),
                    factors: vec![2, 3, 4, 5, 6, 7, 8],
                    any_factor: true,
                    needs_python: false,
                    vram_mb: 3200,
                    models: rt
                        .models
                        .iter()
                        .map(|m| EngineModel {
                            dir: m.dir.clone(),
                            name: m.dir.clone(),
                            desc: Some("ncnn weights".into()),
                            size_mb: m.size_mb,
                            default: true,
                            fixed: None,
                        })
                        .collect(),
                }
            }
        })
        .collect();
    EngineRegistry { engines }
}

pub fn resolve(runtimes: &[EngineRuntime], id: &str, model_dir: &str) -> Result<(PathBuf, PathBuf, PathBuf)> {
    let rt = runtimes
        .iter()
        .find(|r| r.id == id)
        .ok_or_else(|| FlowError::Engine(format!("engine {id} is not installed")))?;
    let model = rt
        .models
        .iter()
        .find(|m| m.dir == model_dir)
        .or_else(|| rt.models.first())
        .ok_or_else(|| FlowError::Engine(format!("engine {id} has no models")))?;
    Ok((rt.exe.clone(), model.path.clone(), rt.root.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_engine(root: &Path) {
        let rife = root.join("rife-ncnn");
        std::fs::create_dir_all(rife.join("rife-v4.26")).unwrap();
        std::fs::create_dir_all(rife.join("rife-v4.25")).unwrap();
        std::fs::write(rife.join("rife-ncnn-vulkan.exe"), b"exe").unwrap();
        std::fs::write(rife.join("rife-v4.26").join("flownet.bin"), vec![0u8; 64 * 1024]).unwrap();
        std::fs::write(rife.join("rife-v4.26").join("flownet.param"), b"param").unwrap();
        std::fs::write(rife.join("rife-v4.25").join("flownet.bin"), vec![0u8; 1024]).unwrap();

        let dain = root.join("dain-ncnn");
        std::fs::create_dir_all(dain.join("best")).unwrap();
        std::fs::write(dain.join("dain-ncnn-vulkan.exe"), b"exe").unwrap();
        std::fs::write(dain.join("best").join("flownet.bin"), vec![0u8; 4096]).unwrap();
    }

    #[test]
    fn discovery_requires_exe_and_weights() {
        let tmp = tempfile::tempdir().unwrap();
        fake_engine(tmp.path());
        let rt = discover(&[tmp.path().to_path_buf()]);
        assert_eq!(rt.len(), 2);
        assert_eq!(rt[0].id, "rife-ncnn");
        assert_eq!(rt[0].models.len(), 2);
        assert_eq!(rt[0].models[0].dir, "rife-v4.26");
        assert!(rt[0].models[0].size_mb > 0.0);
        assert_eq!(rt[1].id, "dain-ncnn");
    }

    #[test]
    fn missing_exe_is_not_advertised() {
        let tmp = tempfile::tempdir().unwrap();
        let rife = tmp.path().join("rife-ncnn");
        std::fs::create_dir_all(rife.join("rife-v4.26")).unwrap();
        std::fs::write(rife.join("rife-v4.26").join("flownet.bin"), b"w").unwrap();
        assert!(discover(&[tmp.path().to_path_buf()]).is_empty());
    }

    #[test]
    fn registry_serializes_the_frontend_contract() {
        let tmp = tempfile::tempdir().unwrap();
        fake_engine(tmp.path());
        let rt = discover(&[tmp.path().to_path_buf()]);
        let reg = registry(&rt);
        let json = serde_json::to_value(&reg).unwrap();
        let models = json["engines"][0]["models"].as_array().unwrap();
        assert_eq!(json["engines"][0]["id"], "rife-ncnn");
        assert_eq!(json["engines"][0]["anyFactor"], true);
        assert_eq!(models[0]["dir"], "rife-v4.26");
        assert_eq!(models[0]["default"], true);
    }

    #[test]
    fn resolve_falls_back_to_first_model_and_errors_on_unknown_engine() {
        let tmp = tempfile::tempdir().unwrap();
        fake_engine(tmp.path());
        let rt = discover(&[tmp.path().to_path_buf()]);
        let (exe, model, _) = resolve(&rt, "rife-ncnn", "does-not-exist").unwrap();
        assert!(exe.exists());
        assert!(model.exists());
        assert!(resolve(&rt, "unknown", "x").is_err());
    }
}
