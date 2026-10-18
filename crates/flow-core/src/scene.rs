//! Cut guard. A hard cut must never be cross-faded by an interpolator, so we detect
//! scene changes up front and run the engine segment by segment instead of across them.

use std::path::Path;

use crate::error::{FlowError, Result};

pub const DEFAULT_THRESHOLD: f64 = 0.32;

/// A 1-based inclusive frame range. `(1, 18)` means frames 1..=18.
pub type Segment = (u64, u64);

pub fn detect_cuts(ffmpeg: &Path, source: &Path, fps: f64, total_frames: u64, threshold: f64) -> Result<Vec<u64>> {
    if total_frames < 3 || fps <= 0.0 {
        return Ok(Vec::new());
    }
    let filter = format!("select=gt(scene\\,{threshold:.2}),showinfo");
    let output = crate::quiet_command(ffmpeg)
        .args([
            "-hide_banner",
            "-nostats",
            "-loglevel",
            "info",
            "-i",
            source.to_string_lossy().as_ref(),
            "-an",
            "-vf",
            &filter,
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| FlowError::MissingTool(format!("ffmpeg could not start: {e}")))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(FlowError::Process(format!(
            "scene scan failed: {}",
            err.lines().last().unwrap_or("unknown ffmpeg error")
        )));
    }
    let log = String::from_utf8_lossy(&output.stderr);
    let mut cuts: Vec<u64> = parse_scene_times(&log, fps)
        .into_iter()
        .filter(|frame| *frame >= 2 && *frame <= total_frames)
        .collect();
    cuts.sort_unstable();
    cuts.dedup();
    Ok(cuts)
}

/// Pull `pts_time:` values out of showinfo lines and convert them to 1-based frame numbers.
pub fn parse_scene_times(log: &str, fps: f64) -> Vec<u64> {
    let mut out = Vec::new();
    for line in log.lines() {
        let Some(idx) = line.find("pts_time:") else { continue };
        let rest = &line[idx + "pts_time:".len()..];
        let token = rest.split_whitespace().next().unwrap_or("");
        if let Ok(t) = token.parse::<f64>() {
            if t.is_finite() && t >= 0.0 {
                let frame = (t * fps).round() as u64 + 1;
                if frame >= 2 {
                    out.push(frame);
                }
            }
        }
    }
    out
}

pub fn segments(total_frames: u64, cuts: &[u64]) -> Vec<Segment> {
    if total_frames == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 1u64;
    for &cut in cuts {
        if cut <= start || cut > total_frames {
            continue;
        }
        out.push((start, cut - 1));
        start = cut;
    }
    out.push((start, total_frames));
    out.retain(|(a, b)| a <= b);
    out
}

pub fn planned_output_frames(segments: &[Segment], factor: f64) -> u64 {
    segments
        .iter()
        .map(|(a, b)| (((*b - *a + 1) as f64) * factor).round().max(1.0) as u64)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn showinfo_lines_become_frame_numbers() {
        let log = r#"
[Parsed_showinfo_1 @ 000001] n:   0 pts:      0 pts_time:0       pos:       48 fmt:yuv420p type:I
[Parsed_showinfo_1 @ 000001] n:  19 pts: 132300 pts_time:1.2     pos:  2097152 fmt:yuv420p type:I
[Parsed_showinfo_1 @ 000002] n:  55 pts: 367500 pts_time:3.66667 pos:  4194304 fmt:yuv420p type:I
"#;
        let times = parse_scene_times(log, 15.0);
        assert_eq!(times, vec![19, 56]);
    }

    #[test]
    fn segments_never_cross_a_cut() {
        let s = segments(81, &[19, 55]);
        assert_eq!(s, vec![(1, 18), (19, 54), (55, 81)]);
        assert_eq!(planned_output_frames(&s, 4.0), 18 * 4 + 36 * 4 + 27 * 4);
    }

    #[test]
    fn invalid_or_duplicate_cuts_are_ignored() {
        assert_eq!(segments(10, &[1, 1, 10, 11, 0]), vec![(1, 9), (10, 10)]);
        assert_eq!(segments(0, &[3]), Vec::new());
    }

    #[test]
    fn a_single_cut_still_covers_every_frame() {
        let s = segments(5, &[3]);
        assert_eq!(s, vec![(1, 2), (3, 5)]);
    }
}
