//! The real render pipeline: probe -> extract -> interpolate -> encode -> mux.
//! Every stage reports measured progress; cancellation is checked inside child waits.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::engines::{self, EngineRuntime};
use crate::error::{FlowError, Result};
use crate::gpu::{self, GpuSample};
use crate::plan::{self, Job, Plan};
use crate::probe::{probe_file, MediaProbe, Toolchain};
use crate::process::{run_streaming, JobControl};
use crate::scene;

pub const STAGES: [&str; 5] = ["probe", "extract", "interp", "encode", "mux"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub stage_p: f64,
    pub overall: f64,
    pub done: u64,
    pub total: u64,
    pub rate: f64,
    pub eta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<GpuSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub path: String,
    pub name: String,
    pub out_fps: f64,
    pub source_fps: f64,
    pub frames: u64,
    pub seconds: f64,
    pub ms: u64,
    pub bytes: u64,
    pub codec: String,
    pub crf: i32,
    pub a: String,
    pub b: String,
    pub warnings: Vec<String>,
}

pub trait Sink {
    fn stage(&mut self, id: &str, index: usize, of: usize, done: bool);
    fn progress(&mut self, progress: &Progress);
    fn log(&mut self, level: &str, text: &str);
}

pub struct Core {
    pub tools: Toolchain,
    pub engines: Vec<EngineRuntime>,
}

impl Core {
    pub fn new(tools: Toolchain, engines: Vec<EngineRuntime>) -> Self {
        Self { tools, engines }
    }

    pub fn discover() -> Result<Self> {
        let tools = Toolchain::discover()?;
        let engines = engines::discover(&engines::default_roots());
        Ok(Self { tools, engines })
    }

    pub fn registry(&self) -> engines::EngineRegistry {
        engines::registry(&self.engines)
    }

    pub fn plan(&self, job: &Job) -> Result<Plan> {
        let probe = match job.source.probe.clone() {
            Some(p) => p,
            None => probe_file(&self.tools.ffprobe, Path::new(&job.source.path))?,
        };
        plan::plan(job, &probe)
    }

    pub fn run(&self, job: &Job, sink: &mut dyn Sink, control: &JobControl) -> Result<Outcome> {
        let started = Instant::now();
        let result = self.run_inner(job, sink, control, started);
        if let Err(err) = &result {
            if !err.cancelled() {
                sink.log("error", &err.to_string());
            }
        }
        result
    }

    fn run_inner(&self, job: &Job, sink: &mut dyn Sink, control: &JobControl, started: Instant) -> Result<Outcome> {
        stage_start(sink, 0, 0, "Probe");
        let source = Path::new(&job.source.path);
        let probe = probe_file(&self.tools.ffprobe, source)?;
        let mut plan = plan::plan(job, &probe)?;
        let (exe, model_path, _engine_root) = engines::resolve(&self.engines, &job.engine, &job.model)?;
        let encoder = job.encoder()?;
        let crf = job.crf()?;
        let preset = job.preset();
        sink.log("ok", &format!(
            "{} - {}x{} {}fps {} frames, {:.1} MB",
            probe.name, probe.width, probe.height, round(probe.fps.unwrap_or(0.0), 3), plan.in_frames,
            probe.size.unwrap_or(0) as f64 / 1_048_576.0
        ));
        sink.progress(&Progress { stage: "probe".into(), stage_p: 1.0, overall: 0.2, done: plan.in_frames, total: plan.in_frames, rate: 0.0, eta: None, gpu: gpu::sample().ok() });
        stage_done(sink, 0, 0);
        check(control)?;

        let temp = create_temp(job, &probe)?;
        let frames_dir = temp.join("frames");
        let interp_dir = temp.join("interp");
        fs::create_dir_all(&frames_dir)?;
        fs::create_dir_all(&interp_dir)?;
        sink.log("info", &format!("temp: {}", temp.display()));

        // ---- extract ----
        stage_start(sink, 1, 1, "Extract");
        let frames_pat = frames_dir.join("%08d.png");
        let mut extract_args = vec![
            "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1",
            "-i", &job.source.path,
            "-map", "0:v:0", "-vsync", "0", "-start_number", "1",
            frames_pat.to_string_lossy().as_ref(),
        ].into_iter().map(str::to_string).collect::<Vec<_>>();
        extract_args.insert(0, "-nostdin".into());
        sink.log("info", &format!("extract: ffmpeg -> {}", frames_dir.display()));
        let mut gpu_state = GpuTick::new(job.gpu);
        let extracted = AtomicU64::new(0);
        let extract_started = Instant::now();
        run_streaming(&self.tools.ffmpeg, &extract_args, control, |line| {
            if let Some(v) = kv_u64(line, "frame") {
                extracted.store(v, Ordering::Relaxed);
            }
        }, || {
            let done = extracted.load(Ordering::Relaxed);
            let p = if plan.in_frames > 0 { (done as f64 / plan.in_frames as f64).clamp(0.0, 1.0) } else { 0.0 };
            let elapsed = extract_started.elapsed().as_secs_f64().max(0.001);
            let rate = done as f64 / elapsed;
            let eta = if rate > 0.0 && plan.in_frames > done { Some((plan.in_frames - done) as f64 / rate) } else { None };
            let g = gpu_state.maybe();
            sink.progress(&Progress { stage: "extract".into(), stage_p: p, overall: (1.0 + p) / 5.0, done, total: plan.in_frames, rate, eta, gpu: g });
        })?;
        let extracted_count = count_images(&frames_dir);
        if extracted_count == 0 {
            return Err(FlowError::Process("ffmpeg extracted no frames".into()));
        }
        if extracted_count != plan.in_frames {
            sink.log("warn", &format!("probe said {} frames, extraction produced {}; using the real count", plan.in_frames, extracted_count));
        }
        plan.in_frames = extracted_count;
        plan.out_frames = ((extracted_count as f64) * job.factor()?).round().max(1.0) as u64;
        sink.progress(&Progress { stage: "extract".into(), stage_p: 1.0, overall: 0.4, done: extracted_count, total: extracted_count, rate: 0.0, eta: None, gpu: gpu_state.last.clone() });
        stage_done(sink, 1, 1);
        check(control)?;

        // ---- interpolate ----
        stage_start(sink, 2, 2, "Interpolate");
        let out_fps = probe.fps.unwrap_or(plan.in_fps) * job.factor()?;
        let expected = plan.out_frames;
        let segments = if job.scene_detect {
            sink.log("info", "scene scan: looking for hard cuts");
            sink.progress(&Progress { stage: "interp".into(), stage_p: 0.03, overall: (2.0 + 0.03) / 5.0, done: 0, total: expected, rate: 0.0, eta: None, gpu: gpu_state.current() });
            match scene::detect_cuts(&self.tools.ffmpeg, source, probe.fps.unwrap_or(plan.in_fps), extracted_count, scene::DEFAULT_THRESHOLD) {
                Ok(cuts) if !cuts.is_empty() => {
                    sink.log("info", &format!("scene guard: {} cuts at frames {:?}", cuts.len(), cuts.iter().take(12).collect::<Vec<_>>()));
                    scene::segments(extracted_count, &cuts)
                }
                Ok(_) => {
                    sink.log("info", "scene guard: no cuts found, one continuous pass");
                    vec![(1, extracted_count)]
                }
                Err(e) => {
                    sink.log("warn", &format!("scene scan failed ({e}); interpolating the whole clip"));
                    vec![(1, extracted_count)]
                }
            }
        } else {
            vec![(1, extracted_count)]
        };
        sink.log("info", &format!("engine: {} model {}", exe.display(), model_path.display()));
        if job.tta && job.engine.starts_with("dain") {
            sink.log("warn", "DAIN has no TTA switch; running without it");
        }
        let mut produced_total: u64 = 0;
        let interp_started = Instant::now();
        let seg_count = segments.len();
        for (i, (a, b)) in segments.iter().enumerate() {
            check(control)?;
            let len = b - a + 1;
            let target = ((len as f64) * job.factor()?).round().max(1.0) as u64;
            let seg_in = temp.join(format!("seg-{i:02}-in"));
            let seg_out = temp.join(format!("seg-{i:02}-out"));
            fs::create_dir_all(&seg_in)?;
            fs::create_dir_all(&seg_out)?;
            for (n, frame) in (*a..=*b).enumerate() {
                let src = frames_dir.join(format!("{frame:08}.png"));
                let dst = seg_in.join(format!("{:08}.png", n + 1));
                link_or_copy(&src, &dst)?;
            }
            sink.log("info", &format!("interpolate segment {}/{}: frames {}..{} -> {} frames", i + 1, seg_count, a, b, target));
            if len == 1 {
                for n in 1..=target {
                    let dst = seg_out.join(format!("{n:08}.png"));
                    link_or_copy(&seg_in.join("00000001.png"), &dst)?;
                }
            } else {
                let mut args = vec![
                    "-i".to_string(), seg_in.to_string_lossy().to_string(),
                    "-o".to_string(), seg_out.to_string_lossy().to_string(),
                    "-m".to_string(), model_path.to_string_lossy().to_string(),
                    "-n".to_string(), target.to_string(),
                    "-g".to_string(), job.gpu.to_string(),
                    "-f".to_string(), "%08d.png".to_string(),
                ];
                if job.tta && job.engine.starts_with("rife") {
                    args.push("-x".into());
                }
                let mut last = 0u64;
                run_streaming(&exe, &args, control, |_line| {}, || {
                    let c = count_images(&seg_out);
                    if c != last {
                        last = c;
                        let p = if target > 0 { (c as f64 / target as f64).clamp(0.0, 1.0) } else { 0.0 };
                        let elapsed = interp_started.elapsed().as_secs_f64().max(0.001);
                        let done = produced_total + c;
                        let rate = done as f64 / elapsed;
                        let eta = if rate > 0.0 && expected > done { Some((expected - done) as f64 / rate) } else { None };
                        let g = gpu_state.maybe();
                        sink.progress(&Progress { stage: "interp".into(), stage_p: ((i as f64 + p) / seg_count as f64) * 0.97 + 0.03, overall: (2.0 + ((i as f64 + p) / seg_count as f64) * 0.97 + 0.03) / 5.0, done, total: expected, rate, eta, gpu: g });
                    }
                })?;
            }
            let files = list_images(&seg_out);
            if files.is_empty() {
                return Err(FlowError::Process(format!("engine produced no frames for segment {i}")));
            }
            if files.len() as u64 != target {
                sink.log("warn", &format!("engine produced {} frames for a target of {}", files.len(), target));
            }
            for file in files {
                produced_total += 1;
                let dst = interp_dir.join(format!("{produced_total:08}.png"));
                link_or_copy(&file, &dst)?;
            }
        }
        if produced_total == 0 {
            return Err(FlowError::Process("interpolation produced no frames".into()));
        }
        plan.out_frames = produced_total;
        sink.progress(&Progress { stage: "interp".into(), stage_p: 1.0, overall: 0.6, done: produced_total, total: produced_total, rate: produced_total as f64 / interp_started.elapsed().as_secs_f64().max(0.001), eta: None, gpu: gpu_state.current() });
        stage_done(sink, 2, 2);
        check(control)?;

        // ---- encode ----
        stage_start(sink, 3, 3, "Encode");
        let video_tmp = temp.join("video.mkv");
        let interp_pat = interp_dir.join("%08d.png");
        let mut encode_args: Vec<String> = vec![
            "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-nostdin",
            "-framerate", &format!("{out_fps:.6}"), "-start_number", "1",
            "-i", interp_pat.to_string_lossy().as_ref(),
            "-c:v", encoder,
        ].into_iter().map(str::to_string).collect();
        match job.codec.as_str() {
            "av1" => {
                encode_args.extend([
                    "-crf".into(), crf.to_string(),
                    "-b:v".into(), "0".into(),
                    "-cpu-used".into(), plan::av1_cpu_used(&preset).to_string(),
                    "-row-mt".into(), "1".into(),
                ]);
            }
            _ => {
                encode_args.extend([
                    "-crf".into(), crf.to_string(),
                    "-preset".into(), preset.clone(),
                ]);
                if job.codec == "h264" {
                    encode_args.extend(["-x264-params".into(), "aq-mode=3".into()]);
                }
            }
        }
        encode_args.extend([
            "-pix_fmt".into(), "yuv420p".into(),
            "-an".into(),
            video_tmp.to_string_lossy().to_string(),
        ]);
        sink.log("info", &format!("encode: {} crf {} preset {}", encoder, crf, preset));
        let encode_started = Instant::now();
        let encoded = AtomicU64::new(0);
        run_streaming(&self.tools.ffmpeg, &encode_args, control, |line| {
            if let Some(v) = kv_u64(line, "frame") {
                encoded.store(v, Ordering::Relaxed);
            }
        }, || {
            let done = encoded.load(Ordering::Relaxed);
            let elapsed = encode_started.elapsed().as_secs_f64().max(0.001);
            let rate = done as f64 / elapsed;
            let p = if produced_total > 0 { (done as f64 / produced_total as f64).clamp(0.0, 1.0) } else { 0.0 };
            let eta = if rate > 0.0 && produced_total > done { Some((produced_total - done) as f64 / rate) } else { None };
            let g = gpu_state.maybe();
            sink.progress(&Progress { stage: "encode".into(), stage_p: p, overall: (3.0 + p) / 5.0, done, total: produced_total, rate, eta, gpu: g });
        })?;
        sink.progress(&Progress { stage: "encode".into(), stage_p: 1.0, overall: 0.8, done: produced_total, total: produced_total, rate: 0.0, eta: None, gpu: gpu_state.current() });
        stage_done(sink, 3, 3);
        check(control)?;

        // ---- mux ----
        stage_start(sink, 4, 4, "Mux");
        let out_dir = plan::output_dir(job)?;
        fs::create_dir_all(&out_dir)?;
        let name = plan::output_name(&job.source.display_name(), job.factor()?, &job.model, out_fps);
        let out_path = plan::unique_path(&out_dir, &name);
        let mut mux_args: Vec<String> = vec![
            "-y", "-hide_banner", "-nostats", "-loglevel", "error", "-progress", "pipe:1", "-nostdin",
            "-i", video_tmp.to_string_lossy().as_ref(),
        ].into_iter().map(str::to_string).collect();
        let wants_any = (job.keep_audio && probe.has_audio) || (job.keep_subs && probe.has_subs);
        if wants_any {
            mux_args.extend(["-i".into(), job.source.path.clone()]);
            mux_args.extend(["-map".into(), "0:v:0".into()]);
            if job.keep_audio && probe.has_audio {
                mux_args.extend(["-map".into(), "1:a:0?".into(), "-c:a".into(), "copy".into()]);
            }
            if job.keep_subs && probe.has_subs {
                mux_args.extend(["-map".into(), "1:s?".into(), "-c:s".into(), "mov_text".into()]);
            }
            mux_args.extend(["-map_metadata".into(), "1".into()]);
        }
        mux_args.extend([
            "-c:v".into(), "copy".into(),
            "-movflags".into(), "+faststart".into(),
            out_path.to_string_lossy().to_string(),
        ]);
        sink.log("info", &format!("mux: audio {}, subs {} -> {}", if job.keep_audio && probe.has_audio { "yes" } else { "no" }, if job.keep_subs && probe.has_subs { "yes" } else { "no" }, out_path.display()));
        run_streaming(&self.tools.ffmpeg, &mux_args, control, |_| {}, || {})?;
        if !out_path.is_file() {
            return Err(FlowError::Process("the muxer did not write an output file".into()));
        }
        sink.progress(&Progress { stage: "mux".into(), stage_p: 1.0, overall: 1.0, done: produced_total, total: produced_total, rate: 0.0, eta: None, gpu: gpu_state.current() });
        stage_done(sink, 4, 4);

        let bytes = fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
        let seconds = produced_total as f64 / out_fps.max(0.001);
        let outcome = Outcome {
            path: out_path.to_string_lossy().to_string(),
            name: out_path.file_name().and_then(|s| s.to_str()).unwrap_or("output.mp4").to_string(),
            out_fps,
            source_fps: probe.fps.unwrap_or(plan.in_fps),
            frames: produced_total,
            seconds,
            ms: started.elapsed().as_millis() as u64,
            bytes,
            codec: job.codec.clone(),
            crf,
            a: job.source.path.clone(),
            b: out_path.to_string_lossy().to_string(),
            warnings: Vec::new(),
        };
        sink.log("ok", &format!("done in {:.1}s -> {} ({:.1} MB)", outcome.ms as f64 / 1000.0, outcome.name, bytes as f64 / 1_048_576.0));

        if std::env::var("FLOW_KEEP_TEMP").map(|v| v != "1").unwrap_or(true) {
            let _ = fs::remove_dir_all(&temp);
        } else {
            sink.log("warn", &format!("FLOW_KEEP_TEMP=1, leaving {}", temp.display()));
        }
        Ok(outcome)
    }
}

fn stage_start(sink: &mut dyn Sink, index: usize, _of: usize, label: &str) {
    sink.stage(STAGES[index], index, STAGES.len(), false);
    sink.log("info", &format!("{label} started"));
    sink.progress(&Progress { stage: STAGES[index].into(), stage_p: 0.0, overall: index as f64 / STAGES.len() as f64, done: 0, total: 0, rate: 0.0, eta: None, gpu: None });
}

fn stage_done(sink: &mut dyn Sink, index: usize, _of: usize) {
    sink.stage(STAGES[index], index, STAGES.len(), true);
}

fn check(control: &JobControl) -> Result<()> {
    if control.is_cancelled() { Err(FlowError::Cancelled) } else { Ok(()) }
}

fn kv_u64(line: &str, key: &str) -> Option<u64> {
    let (k, v) = line.split_once('=')?;
    if k.trim() == key { v.trim().parse().ok() } else { None }
}

fn round(v: f64, d: i32) -> f64 {
    let m = 10f64.powi(d);
    (v * m).round() / m
}

fn create_temp(job: &Job, probe: &MediaProbe) -> Result<PathBuf> {
    let base = match job.temp_on.as_deref() {
        Some("input") => Path::new(&job.source.path).parent().map(Path::to_path_buf).unwrap_or_else(std::env::temp_dir),
        Some("app") => std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("flow").join("temp"),
        _ => std::env::temp_dir().join("flow"),
    };
    fs::create_dir_all(&base)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let stem = plan::sanitize_stem(&probe.name);
    let dir = base.join(format!("flow-{stem}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn list_images(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && matches!(
                            p.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
                            Some("png" | "jpg" | "jpeg" | "webp")
                        )
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn count_images(dir: &Path) -> u64 {
    list_images(dir).len() as u64
}

fn link_or_copy(src: &Path, dst: &Path) -> Result<()> {
    if dst.exists() {
        let _ = fs::remove_file(dst);
    }
    if fs::hard_link(src, dst).is_ok() {
        return Ok(());
    }
    fs::copy(src, dst)?;
    Ok(())
}

struct GpuTick {
    last_at: Instant,
    last: Option<GpuSample>,
    index: i32,
}

impl GpuTick {
    fn new(index: i32) -> Self {
        Self { last_at: Instant::now() - std::time::Duration::from_secs(5), last: None, index }
    }
    fn maybe(&mut self) -> Option<GpuSample> {
        if self.last_at.elapsed() >= std::time::Duration::from_millis(2000) {
            self.last = gpu::sample_for(if self.index >= 0 { Some(self.index as u32) } else { None }).ok();
            self.last_at = Instant::now();
        }
        self.last.clone()
    }
    fn current(&mut self) -> Option<GpuSample> {
        self.last.clone()
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines_are_parsed_but_noise_is_ignored() {
        assert_eq!(kv_u64("frame=42", "frame"), Some(42));
        assert_eq!(kv_u64("frame=42\r", "frame"), Some(42));
        assert_eq!(kv_u64("out_time_ms=1200", "frame"), None);
        assert_eq!(kv_u64("nonsense", "frame"), None);
    }

    #[test]
    fn output_naming_matches_the_ui_contract() {
        assert_eq!(plan::output_name("GG.mp4", 4.0, "rife-v4.26", 60.0), "GG-4x-rife-v4.26-60fps.mp4");
    }

    #[test]
    fn stage_ids_are_stable() {
        assert_eq!(STAGES, ["probe", "extract", "interp", "encode", "mux"]);
    }
}
