//! Pure recipe math. No process, no clock, no filesystem: every number here is testable.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{FlowError, Result};
use crate::probe::MediaProbe;

pub const FACTOR_MIN: f64 = 1.0;
pub const FACTOR_MAX: f64 = 16.0;
pub const QUALITY_MIN: f64 = 0.0;
pub const QUALITY_MAX: f64 = 100.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub probe: Option<MediaProbe>,
}

impl SourceRef {
    pub fn display_name(&self) -> String {
        self.name
            .clone()
            .or_else(|| Path::new(&self.path).file_name().and_then(|s| s.to_str()).map(str::to_string))
            .unwrap_or_else(|| "clip".into())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub source: SourceRef,
    #[serde(default = "default_engine")]
    pub engine: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_factor")]
    pub factor: f64,
    #[serde(default = "default_codec")]
    pub codec: String,
    #[serde(default = "default_quality")]
    pub quality: f64,
    #[serde(default)]
    pub crf: Option<i32>,
    #[serde(default)]
    pub preset: Option<String>,
    #[serde(default)]
    pub keep_audio: bool,
    #[serde(default)]
    pub keep_subs: bool,
    #[serde(default)]
    pub scene_detect: bool,
    #[serde(default)]
    pub tta: bool,
    #[serde(default)]
    pub gpu: i32,
    #[serde(default)]
    pub out_dir: Option<String>,
    #[serde(default)]
    pub temp_on: Option<String>,
}

fn default_engine() -> String { "rife-ncnn".into() }
fn default_model() -> String { "rife-v4.26".into() }
fn default_factor() -> f64 { 4.0 }
fn default_codec() -> String { "h264".into() }
fn default_quality() -> f64 { 78.0 }

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub in_fps: f64,
    pub out_fps: f64,
    pub in_frames: u64,
    pub out_frames: u64,
    pub est_seconds: f64,
    pub rate: f64,
    pub temp_gb: f64,
}

impl Job {
    pub fn factor(&self) -> Result<f64> {
        if !self.factor.is_finite() || self.factor < FACTOR_MIN || self.factor > FACTOR_MAX {
            return Err(FlowError::Plan(format!(
                "factor must be between {FACTOR_MIN} and {FACTOR_MAX}, got {}",
                self.factor
            )));
        }
        Ok(self.factor)
    }

    pub fn quality(&self) -> Result<f64> {
        if !self.quality.is_finite() || !(QUALITY_MIN..=QUALITY_MAX).contains(&self.quality) {
            return Err(FlowError::Plan("quality must be 0-100".into()));
        }
        Ok(self.quality)
    }

    pub fn crf(&self) -> Result<i32> {
        if let Some(crf) = self.crf {
            if (0..=51).contains(&crf) {
                return Ok(crf);
            }
            return Err(FlowError::Plan("crf must be 0-51".into()));
        }
        Ok(crf_from_quality(self.quality()?))
    }

    pub fn encoder(&self) -> Result<&'static str> {
        encoder_for(&self.codec)
    }

    pub fn preset(&self) -> String {
        let p = self.preset.clone().unwrap_or_else(|| "slow".into());
        if PRESETS.contains(&p.as_str()) { p } else { "slow".into() }
    }

    pub fn probe(&self) -> Result<&MediaProbe> {
        self.source.probe.as_ref().ok_or_else(|| FlowError::Plan("source probe is missing".into()))
    }
}

pub fn crf_from_quality(q: f64) -> i32 {
    // 0 => CRF 36 (small), 100 => CRF 12 (clean). Same mapping as the UI.
    (36.0 - (q / 100.0) * 24.0).round().clamp(0.0, 51.0) as i32
}

pub const PRESETS: [&str; 8] = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower"];

pub fn encoder_for(codec: &str) -> Result<&'static str> {
    match codec {
        "h264" => Ok("libx264"),
        "h265" => Ok("libx265"),
        "av1" => Ok("libaom-av1"),
        other => Err(FlowError::Plan(format!("unsupported codec {other}"))),
    }
}

pub fn av1_cpu_used(preset: &str) -> u8 {
    match preset {
        "ultrafast" => 8,
        "superfast" => 7,
        "veryfast" => 6,
        "faster" => 6,
        "fast" => 5,
        "medium" => 4,
        "slow" => 3,
        "slower" => 2,
        _ => 4,
    }
}

/// Throughput estimate for the planning UI. The real rate measured during a run is
/// reported separately; this only answers "roughly how long will it take".
pub fn estimate_rate(probe: &MediaProbe, engine: &str, tta: bool) -> f64 {
    let reference = 544.0 * 306.0;
    let pixels = probe.pixels().max(1.0);
    let engine_scale = if engine.starts_with("dain") { 0.42 } else { 1.0 };
    let tta_scale = if tta { 0.5 } else { 1.0 };
    (37.7 * (reference / pixels) * engine_scale * tta_scale).max(0.05)
}

pub fn plan(job: &Job, probe: &MediaProbe) -> Result<Plan> {
    let factor = job.factor()?;
    job.quality()?;
    job.encoder()?;

    let in_fps = probe
        .fps
        .filter(|f| f.is_finite() && *f > 0.0 && *f < 1000.0)
        .ok_or_else(|| FlowError::Plan("the source frame rate is unknown".into()))?;
    let in_frames = probe.frames.or_else(|| probe.duration.map(|d| (d * in_fps).round() as u64)).unwrap_or(0);
    if in_frames == 0 {
        return Err(FlowError::Plan("the source has no frames".into()));
    }

    let out_frames = ((in_frames as f64) * factor).round().max(1.0) as u64;
    let rate = estimate_rate(probe, &job.engine, job.tta);
    let est_seconds = (out_frames as f64 / rate + 1.2).max(0.5);
    let bytes_per_frame = probe.pixels().max(1.0) * 1.6;
    let temp_gb = ((in_frames as f64 + out_frames as f64) * bytes_per_frame) / 1e9;

    Ok(Plan {
        in_fps,
        out_fps: in_fps * factor,
        in_frames,
        out_frames,
        est_seconds,
        rate,
        temp_gb: (temp_gb * 100.0).round() / 100.0,
    })
}

pub fn sanitize_stem(name: &str) -> String {
    // String-level extension stripping: Windows Path would treat a colon in "a:b?.mkv"
    // as a drive prefix and silently eat the first component.
    let stem = match name.rsplit_once('.') {
        Some((base, ext)) if !base.is_empty() && !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) => base,
        _ => name,
    };
    let mut out = String::with_capacity(stem.len());
    for ch in stem.chars() {
        if ch.is_control() || r#"<>:"/\|?*"#.contains(ch) {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let out = out.trim().trim_matches('.').to_string();
    if out.is_empty() { "clip".into() } else { out }
}

pub fn format_factor(factor: f64) -> String {
    if (factor.fract()).abs() < 1e-9 {
        format!("{}", factor.round() as i64)
    } else {
        let s = format!("{factor:.2}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

pub fn sanitize_component(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_control() || r#"<>:"/\|?*"#.contains(ch) {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let out = out.trim().trim_matches('.').to_string();
    if out.is_empty() { "model".into() } else { out }
}

pub fn output_name(source_name: &str, factor: f64, model: &str, out_fps: f64) -> String {
    let stem = sanitize_stem(source_name);
    let model = sanitize_component(model);
    format!("{stem}-{}x-{model}-{}fps.mp4", format_factor(factor), out_fps.round() as i64)
}

pub fn output_dir(job: &Job) -> Result<PathBuf> {
    if let Some(dir) = job.out_dir.as_ref().filter(|d| !d.trim().is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    let src = Path::new(&job.source.path);
    Ok(src.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(".")))
}

pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let mut candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    let ext = Path::new(name).extension().and_then(|s| s.to_str()).unwrap_or("mp4");
    for n in 2..10_000 {
        candidate = dir.join(format!("{stem}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe() -> MediaProbe {
        MediaProbe {
            name: "GG.mp4".into(),
            path: "C:/clips/GG.mp4".into(),
            width: 544,
            height: 306,
            fps: Some(15.0),
            frames: Some(81),
            duration: Some(5.4),
            size: Some(378_697),
            has_audio: true,
            has_subs: false,
            codec: Some("h264".into()),
            pixel_format: Some("yuv420p".into()),
            source: None,
        }
    }

    fn job() -> Job {
        Job {
            source: SourceRef { name: Some("GG.mp4".into()), path: "C:/clips/GG.mp4".into(), probe: Some(probe()) },
            engine: "rife-ncnn".into(),
            model: "rife-v4.26".into(),
            factor: 4.0,
            codec: "h264".into(),
            quality: 78.0,
            crf: None,
            preset: Some("slow".into()),
            keep_audio: true,
            keep_subs: false,
            scene_detect: true,
            tta: false,
            gpu: 0,
            out_dir: None,
            temp_on: None,
        }
    }

    #[test]
    fn plan_math_is_exact_at_four_x() {
        let p = plan(&job(), &probe()).unwrap();
        assert_eq!(p.in_fps, 15.0);
        assert_eq!(p.out_fps, 60.0);
        assert_eq!(p.in_frames, 81);
        assert_eq!(p.out_frames, 324);
        assert!(p.est_seconds > 0.0);
        assert!(p.temp_gb > 0.0);
    }

    #[test]
    fn fractional_factors_round_to_real_frames() {
        let mut j = job();
        j.factor = 2.5;
        let p = plan(&j, &probe()).unwrap();
        assert_eq!(p.out_frames, 203); // 202.5 rounds away from zero
        assert_eq!(p.out_fps, 37.5);
    }

    #[test]
    fn invalid_recipes_are_rejected_with_a_reason() {
        let mut j = job();
        j.factor = 0.5;
        assert!(plan(&j, &probe()).is_err());
        j.factor = 4.0;
        j.codec = "prores".into();
        assert!(plan(&j, &probe()).is_err());
        j.codec = "h264".into();
        j.quality = 120.0;
        assert!(plan(&j, &probe()).is_err());
        j.quality = 78.0;
        j.crf = Some(99);
        assert!(j.crf().is_err());
    }

    #[test]
    fn crf_curve_matches_the_ui() {
        assert_eq!(crf_from_quality(100.0), 12);
        assert_eq!(crf_from_quality(78.0), 17);
        assert_eq!(crf_from_quality(0.0), 36);
    }

    #[test]
    fn output_names_are_safe_and_readable() {
        assert_eq!(output_name("GG.mp4", 4.0, "rife-v4.26", 60.0), "GG-4x-rife-v4.26-60fps.mp4");
        assert_eq!(output_name("a:b?.mkv", 1.5, "rife-v4.26", 22.5), "a_b_-1.5x-rife-v4.26-23fps.mp4");
        assert_eq!(format_factor(3.0), "3");
        assert_eq!(format_factor(1.25), "1.25");
    }

    #[test]
    fn unique_paths_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let first = unique_path(dir.path(), "clip.mp4");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(dir.path(), "clip.mp4");
        assert_ne!(first, second);
        assert!(second.to_string_lossy().contains("clip-2.mp4"));
    }

    #[test]
    fn tta_and_dain_are_slower_estimates() {
        let plain = estimate_rate(&probe(), "rife-ncnn", false);
        let tta = estimate_rate(&probe(), "rife-ncnn", true);
        let dain = estimate_rate(&probe(), "dain-ncnn", false);
        assert!(tta < plain);
        assert!(dain < plain);
    }

    #[test]
    fn job_deserializes_the_frontend_shape() {
        let raw = r#"{
          "source":{"name":"GG.mp4","path":"dev/GG-src.mp4","probe":{"name":"GG.mp4","path":"dev/GG-src.mp4","width":544,"height":306,"fps":15,"frames":81,"duration":5.4,"size":378697,"hasAudio":true,"hasSubs":false,"codec":"h264"}},
          "engine":"rife-ncnn","model":"rife-v4.26","factor":4,"codec":"h264","quality":78,
          "crf":17,"preset":"slow","keepAudio":true,"keepSubs":true,"sceneDetect":true,"tta":false,"gpu":0
        }"#;
        let j: Job = serde_json::from_str(raw).unwrap();
        assert_eq!(j.factor, 4.0);
        assert!(j.keep_audio && j.keep_subs);
        assert!(j.scene_detect);
        assert_eq!(j.probe().unwrap().width, 544);
    }
}
