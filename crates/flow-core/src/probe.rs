//! ffprobe wrapper. Everything the UI shows about a clip comes from this module.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{FlowError, Result};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
    pub name: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub frames: Option<u64>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub has_subs: bool,
    #[serde(default)]
    pub codec: Option<String>,
    #[serde(default)]
    pub pixel_format: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

impl MediaProbe {
    pub fn pixels(&self) -> f64 {
        (self.width.max(1) as f64) * (self.height.max(1) as f64)
    }
}

#[derive(Debug, Clone)]
pub struct Toolchain {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

impl Toolchain {
    /// Look for tools in an explicit order: the setup's toolchain.json, env, the
    /// app's private tools folder, PATH, then the Flowframes pack.
    pub fn discover() -> Result<Self> {
        if let Some(pair) = toolchain_config() {
            return Ok(pair);
        }
        let ffmpeg = find_tool("ffmpeg", &["FLOW_FFMPEG"])?
            .ok_or_else(|| FlowError::MissingTool("ffmpeg.exe (set FLOW_FFMPEG)".into()))?;
        let ffprobe = find_tool("ffprobe", &["FLOW_FFPROBE"])?
            .ok_or_else(|| FlowError::MissingTool("ffprobe.exe (set FLOW_FFPROBE)".into()))?;
        Ok(Self { ffmpeg, ffprobe })
    }

    pub fn from_paths(ffmpeg: impl Into<PathBuf>, ffprobe: impl Into<PathBuf>) -> Self {
        Self { ffmpeg: ffmpeg.into(), ffprobe: ffprobe.into() }
    }
}

fn find_tool(stem: &str, env_keys: &[&str]) -> Result<Option<PathBuf>> {
    for key in env_keys {
        if let Ok(v) = std::env::var(key) {
            let p = PathBuf::from(v);
            if p.is_file() {
                return Ok(Some(p));
            }
        }
    }
    for dir in app_data_dirs() {
        let p = dir.join(format!("{stem}.exe"));
        if p.is_file() {
            return Ok(Some(p));
        }
    }
    let exe = format!("{stem}.exe");
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let p = dir.join(&exe);
        if p.is_file() {
            return Ok(Some(p));
        }
    }
    for dir in flowframes_av_dirs() {
        let p = dir.join(&exe);
        if p.is_file() {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

pub fn app_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("studio.aura.flow"))
}

fn app_data_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(base) = app_data_dir() {
        out.push(base.join("tools"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("tools"));
        }
    }
    out
}

/// The setup writes this when the user chooses to use ffmpeg already on the PC.
/// Both paths are validated before the file is written; we still verify they exist here.
fn toolchain_config() -> Option<Toolchain> {
    let base = app_data_dir()?;
    let raw = std::fs::read_to_string(base.join("toolchain.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let ffmpeg = v.get("ffmpeg").and_then(Value::as_str).map(PathBuf::from)?;
    let ffprobe = v.get("ffprobe").and_then(Value::as_str).map(PathBuf::from)?;
    if ffmpeg.is_file() && ffprobe.is_file() {
        Some(Toolchain { ffmpeg, ffprobe })
    } else {
        None
    }
}

pub fn flowframes_pkgs_root() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    let p = PathBuf::from(local).join("Flowframes").join("FlowframesData").join("pkgs");
    p.is_dir().then_some(p)
}

fn flowframes_av_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(pkgs) = flowframes_pkgs_root() {
        out.push(pkgs.join("av"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        out.push(PathBuf::from(pf).join("Flowframes").join("FlowframesData").join("pkgs").join("av"));
    }
    out
}

pub fn probe_file(ffprobe: &Path, path: &Path) -> Result<MediaProbe> {
    if !path.exists() {
        return Err(FlowError::InvalidPath(path.to_path_buf()));
    }
    if path.is_dir() {
        return Err(FlowError::Probe(
            "folders of numbered frames are not wired into the core yet; give it the source video".into(),
        ));
    }
    let output = crate::quiet_command(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|e| FlowError::MissingTool(format!("ffprobe could not start: {e}")))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(FlowError::Probe(err.lines().last().unwrap_or("unknown ffprobe failure").to_string()));
    }
    let json: Value = serde_json::from_slice(&output.stdout)?;
    MediaProbe::from_ffprobe(path, &json)
}

impl MediaProbe {
    pub fn from_ffprobe(path: &Path, json: &Value) -> Result<Self> {
        let streams = json.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
        let video = streams
            .iter()
            .find(|s| {
                s.get("codec_type").and_then(Value::as_str) == Some("video")
                    && s.get("disposition").and_then(|d| d.get("attached_pic")).and_then(Value::as_i64) != Some(1)
            })
            .ok_or_else(|| FlowError::Probe("no video stream in that file".into()))?;

        let width = num_u64(video.get("width")).unwrap_or(0) as u32;
        let height = num_u64(video.get("height")).unwrap_or(0) as u32;
        if width == 0 || height == 0 {
            return Err(FlowError::Probe("the video stream has no usable dimensions".into()));
        }

        let fps = video
            .get("avg_frame_rate")
            .and_then(Value::as_str)
            .and_then(parse_rational)
            .or_else(|| video.get("r_frame_rate").and_then(Value::as_str).and_then(parse_rational))
            .filter(|f| *f > 0.0 && *f < 1000.0);

        let duration = json
            .get("format")
            .and_then(|f| f.get("duration"))
            .and_then(parse_f64)
            .or_else(|| video.get("duration").and_then(parse_f64));

        let nb_frames = num_u64(video.get("nb_frames")).map(|n| n).or_else(|| {
            duration.and_then(|d| fps.map(|f| (d * f).round().max(1.0) as u64))
        });

        let format = json.get("format");
        let size = format.and_then(|f| num_u64(f.get("size"))).or_else(|| std::fs::metadata(path).ok().map(|m| m.len()));

        Ok(Self {
            name: path.file_name().and_then(|s| s.to_str()).unwrap_or("clip").to_string(),
            path: path.to_string_lossy().to_string(),
            width,
            height,
            fps,
            frames: nb_frames,
            duration,
            size,
            has_audio: streams.iter().any(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio")),
            has_subs: streams.iter().any(|s| s.get("codec_type").and_then(Value::as_str) == Some("subtitle")),
            codec: video.get("codec_name").and_then(Value::as_str).map(str::to_string),
            pixel_format: video.get("pix_fmt").and_then(Value::as_str).map(str::to_string),
            source: Some("ffprobe".into()),
        })
    }
}

pub fn parse_rational(v: &str) -> Option<f64> {
    let (a, b) = v.split_once('/')?;
    let a: f64 = a.trim().parse().ok()?;
    let b: f64 = b.trim().parse().ok()?;
    if b == 0.0 || !a.is_finite() || !b.is_finite() {
        return None;
    }
    Some(a / b)
}

fn parse_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

pub(crate) fn num_u64(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rational_parsing_handles_ntsc_and_garbage() {
        assert_eq!(parse_rational("15/1"), Some(15.0));
        assert!((parse_rational("30000/1001").unwrap() - 29.97002997).abs() < 1e-6);
        assert_eq!(parse_rational("0/0"), None);
        assert_eq!(parse_rational("n/a"), None);
        assert_eq!(parse_rational("24"), None);
    }

    #[test]
    fn probe_json_is_read_exactly() {
        let json: Value = serde_json::from_str(FIXTURE).unwrap();
        let p = MediaProbe::from_ffprobe(Path::new("C:/clips/GG.mp4"), &json).unwrap();
        assert_eq!(p.width, 544);
        assert_eq!(p.height, 306);
        assert_eq!(p.fps, Some(15.0));
        assert_eq!(p.frames, Some(81));
        assert_eq!(p.duration, Some(5.4));
        assert_eq!(p.size, Some(378697));
        assert!(p.has_audio);
        assert!(!p.has_subs);
        assert_eq!(p.codec.as_deref(), Some("h264"));
    }

    #[test]
    fn a_missing_video_stream_is_an_error_not_a_guess() {
        let json: Value = serde_json::from_str(r#"{"streams":[{"codec_type":"audio"}]}"#).unwrap();
        assert!(MediaProbe::from_ffprobe(Path::new("x.wav"), &json).is_err());
    }

    #[test]
    fn frames_fall_back_to_duration_times_fps() {
        let json: Value = serde_json::from_str(
            r#"{"streams":[{"codec_type":"video","width":1280,"height":720,"avg_frame_rate":"24/1","duration":"2.5"}],"format":{"duration":"2.5"}}"#,
        )
        .unwrap();
        let p = MediaProbe::from_ffprobe(Path::new("x.mp4"), &json).unwrap();
        assert_eq!(p.frames, Some(60));
        assert_eq!(p.size, std::fs::metadata("x.mp4").ok().map(|m| m.len()));
    }

    const FIXTURE: &str = r#"{
      "streams": [
        {"codec_type":"video","codec_name":"h264","width":544,"height":306,
         "avg_frame_rate":"15/1","r_frame_rate":"15/1","nb_frames":"81","duration":"5.400000","pix_fmt":"yuv420p"},
        {"codec_type":"audio","codec_name":"aac"}
      ],
      "format": {"duration":"5.400000","size":"378697","format_name":"mov,mp4"}
    }"#;
}
