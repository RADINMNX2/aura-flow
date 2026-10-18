//! Real-media integration: ffprobe on the checked-in fixture, and an opt-in full RIFE render.
//! The heavy render is `#[ignore]` so the normal suite stays fast; run it with:
//!   cargo test -p flow-core --test real_media -- --ignored --nocapture

use std::path::{Path, PathBuf};
use std::time::Instant;

use flow_core::engines;
use flow_core::plan::{Job, SourceRef};
use flow_core::probe::{probe_file, Toolchain};
use flow_core::{Core, JobControl, Progress, Sink};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../dev/GG-src.mp4")
}

#[test]
fn ffprobe_reads_the_checked_in_fixture() {
    let path = fixture();
    if !path.is_file() {
        eprintln!("skipping: fixture missing at {}", path.display());
        return;
    }
    let Ok(tools) = Toolchain::discover() else {
        eprintln!("skipping: ffprobe is not installed");
        return;
    };
    let probe = probe_file(&tools.ffprobe, &path).expect("ffprobe the fixture");
    assert_eq!((probe.width, probe.height), (544, 306));
    assert_eq!(probe.fps, Some(15.0));
    assert_eq!(probe.frames, Some(81));
    assert!((probe.duration.unwrap_or(0.0) - 5.4).abs() < 0.05);
    assert!(!probe.has_subs);
    assert!(probe.size.unwrap_or(0) > 300_000);
}

#[test]
fn engine_discovery_finds_a_real_install_when_present() {
    let roots = engines::default_roots();
    let found = engines::discover(&roots);
    if found.is_empty() {
        eprintln!("skipping: no engine install found");
        return;
    }
    let reg = engines::registry(&found);
    assert!(!reg.engines.is_empty());
    for engine in &reg.engines {
        assert!(!engine.models.is_empty(), "{} has no models", engine.id);
        assert!(engine.models.iter().any(|m| m.default), "{} has no default model", engine.id);
    }
}

struct PrintSink {
    stages: Vec<String>,
    ticks: usize,
}

impl Sink for PrintSink {
    fn stage(&mut self, id: &str, index: usize, of: usize, done: bool) {
        self.stages.push(format!("{id}:{done}"));
        println!("stage {index}/{of} {id} done={done}");
    }
    fn progress(&mut self, p: &Progress) {
        self.ticks += 1;
        if self.ticks % 40 == 0 {
            println!("{} {:.0}% overall {:.0}% {:.1} fps eta {:?}", p.stage, p.stage_p * 100.0, p.overall * 100.0, p.rate, p.eta);
        }
    }
    fn log(&mut self, level: &str, text: &str) {
        println!("[{level}] {text}");
    }
}

#[test]
#[ignore]
fn real_four_x_render() {
    let path = fixture();
    if !path.is_file() {
        eprintln!("skipping: fixture missing");
        return;
    }
    let core = Core::discover().expect("tools + engines");
    assert!(!core.engines.is_empty(), "no interpolation engine installed");
    let tools = Toolchain::discover().unwrap();
    let probe = probe_file(&tools.ffprobe, &path).expect("probe fixture");
    let out_dir = tempfile::tempdir().unwrap();
    let job = Job {
        source: SourceRef { name: Some("GG.mp4".into()), path: path.to_string_lossy().to_string(), probe: Some(probe) },
        engine: "rife-ncnn".into(),
        model: "rife-v4.26".into(),
        factor: 4.0,
        codec: "h264".into(),
        quality: 78.0,
        crf: Some(17),
        preset: Some("ultrafast".into()),
        keep_audio: false,
        keep_subs: false,
        scene_detect: false,
        tta: false,
        gpu: 0,
        out_dir: Some(out_dir.path().to_string_lossy().to_string()),
        temp_on: None,
    };
    let expected = (81.0f64 * 4.0).round() as u64;
    let mut sink = PrintSink { stages: Vec::new(), ticks: 0 };
    let started = Instant::now();
    let outcome = core.run(&job, &mut sink, &JobControl::new()).expect("real render");
    println!("render took {:.1}s -> {} ({} frames, {:.2} fps, {} bytes)", started.elapsed().as_secs_f64(), outcome.name, outcome.frames, outcome.out_fps, outcome.bytes);
    assert!(Path::new(&outcome.path).is_file());
    assert_eq!(outcome.frames, expected);
    assert_eq!(outcome.out_fps, 60.0);
    assert!(outcome.bytes > 10_000);
    assert!(sink.stages.iter().any(|s| s == "mux:true"));

    let out_probe = probe_file(&tools.ffprobe, Path::new(&outcome.path)).expect("probe output");
    println!("output probe: {:?} fps, {:?} frames, {:?}s", out_probe.fps, out_probe.frames, out_probe.duration);
    assert_eq!((out_probe.width, out_probe.height), (544, 306));
    assert_eq!(out_probe.frames, Some(expected));
    assert!((out_probe.fps.unwrap_or(0.0) - 60.0).abs() < 0.6, "fps drifted: {:?}", out_probe.fps);
    assert!((out_probe.duration.unwrap_or(0.0) - 5.4).abs() < 0.2);
}

#[test]
#[ignore]
fn real_mux_keeps_audio_and_subtitles() {
    let Ok(tools) = Toolchain::discover() else { eprintln!("skipping: ffmpeg/ffprobe missing"); return };
    let core = Core::discover().expect("tools + engines");
    if core.engines.is_empty() {
        eprintln!("skipping: no engine installed");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src.mp4");
    let srt = dir.path().join("subs.srt");
    let subs_src = dir.path().join("srcs.mp4");
    std::fs::write(&srt, "1\n00:00:00,000 --> 00:00:00,800\nflow test\n").unwrap();
    let status = std::process::Command::new(&tools.ffmpeg)
        .args([
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=1",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            src.to_string_lossy().as_ref(),
        ])
        .status()
        .unwrap();
    assert!(status.success(), "could not generate the source clip");
    let status = std::process::Command::new(&tools.ffmpeg)
        .args([
            "-y", "-hide_banner", "-loglevel", "error",
            "-i", src.to_string_lossy().as_ref(),
            "-i", srt.to_string_lossy().as_ref(),
            "-map", "0", "-map", "1", "-c", "copy", "-c:s", "mov_text",
            subs_src.to_string_lossy().as_ref(),
        ])
        .status()
        .unwrap();
    assert!(status.success(), "could not mux the test subtitles");
    let probe = probe_file(&tools.ffprobe, &subs_src).unwrap();
    assert!(probe.has_audio && probe.has_subs);

    let job = Job {
        source: SourceRef { name: Some("srcs.mp4".into()), path: subs_src.to_string_lossy().to_string(), probe: Some(probe) },
        engine: "rife-ncnn".into(),
        model: "rife-v4.26".into(),
        factor: 2.0,
        codec: "h264".into(),
        quality: 78.0,
        crf: Some(20),
        preset: Some("ultrafast".into()),
        keep_audio: true,
        keep_subs: true,
        scene_detect: false,
        tta: false,
        gpu: 0,
        out_dir: Some(dir.path().join("out").to_string_lossy().to_string()),
        temp_on: None,
    };
    let mut sink = PrintSink { stages: Vec::new(), ticks: 0 };
    let out = core.run(&job, &mut sink, &JobControl::new()).expect("render with av+subs");
    let out_probe = probe_file(&tools.ffprobe, Path::new(&out.path)).unwrap();
    println!("mux output: {:?} audio={} subs={} frames={:?}", out.name, out_probe.has_audio, out_probe.has_subs, out_probe.frames);
    assert!(out_probe.has_audio, "audio was dropped");
    assert!(out_probe.has_subs, "subtitles were dropped");
    assert_eq!(out_probe.frames, Some(20));
}
