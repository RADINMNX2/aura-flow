//! GPU telemetry through the driver's own nvidia-smi. No polling daemon, no fake numbers.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::{FlowError, Result};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub index: u32,
    pub name: String,
    pub memory_mb: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub util: f64,
    pub vram_mb: f64,
    pub vram_total_mb: f64,
    pub temp_c: f64,
}

pub fn nvidia_smi() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("NVIDIA_SMI") {
        let p = PathBuf::from(v);
        if p.is_file() {
            return Some(p);
        }
    }
    let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:/Windows"));
    let p = system.join("System32").join("nvidia-smi.exe");
    if p.is_file() {
        return Some(p);
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let p = dir.join("nvidia-smi.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn list() -> Result<Vec<GpuInfo>> {
    let smi = nvidia_smi().ok_or_else(|| FlowError::MissingTool("nvidia-smi.exe".into()))?;
    let output = crate::quiet_command(&smi)
        .args(["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"])
        .output()
        .map_err(|e| FlowError::Process(format!("nvidia-smi failed: {e}")))?;
    if !output.status.success() {
        return Err(FlowError::Process("nvidia-smi returned a non-zero status".into()));
    }
    Ok(parse_gpu_list(&String::from_utf8_lossy(&output.stdout)))
}

pub fn parse_gpu_list(text: &str) -> Vec<GpuInfo> {
    let mut out = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let parts: Vec<&str> = line.splitn(3, ',').map(str::trim).collect();
        if parts.len() < 3 {
            continue;
        }
        let Ok(index) = parts[0].parse::<u32>() else { continue };
        let memory_mb = parts[2].parse::<f64>().unwrap_or(0.0);
        out.push(GpuInfo { index, name: parts[1].to_string(), memory_mb });
    }
    out
}

pub fn sample() -> Result<GpuSample> {
    sample_for(None)
}

pub fn sample_for(gpu: Option<u32>) -> Result<GpuSample> {
    let smi = nvidia_smi().ok_or_else(|| FlowError::MissingTool("nvidia-smi.exe".into()))?;
    let mut cmd = crate::quiet_command(&smi);
    if let Some(index) = gpu {
        cmd.arg(format!("-i={index}"));
    }
    let output = cmd
        .args([
            "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .map_err(|e| FlowError::Process(format!("nvidia-smi failed: {e}")))?;
    if !output.status.success() {
        return Err(FlowError::Process("nvidia-smi returned a non-zero status".into()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_sample(&text)
}

pub fn parse_sample(text: &str) -> Result<GpuSample> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .ok_or_else(|| FlowError::Process("nvidia-smi printed no GPU row".into()))?;
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 4 {
        return Err(FlowError::Process(format!("unexpected nvidia-smi row: {line}")));
    }
    let val = |i: usize| -> Result<f64> {
        let raw = parts[i];
        if raw.contains("N/A") || raw.contains("Not Supported") {
            return Ok(0.0);
        }
        raw.trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '%' || c == ' ' || c == ']')
            .trim_start_matches('[')
            .parse::<f64>()
            .map_err(|_| FlowError::Process(format!("unexpected nvidia-smi value: {raw}")))
    };
    Ok(GpuSample {
        util: val(0)?.clamp(0.0, 100.0),
        vram_mb: val(1)?.max(0.0),
        vram_total_mb: val(2)?.max(1.0),
        temp_c: val(3)?.max(0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_rows_parse_with_and_without_units() {
        let s = parse_sample("14, 686, 8192, 40\n").unwrap();
        assert_eq!(s, GpuSample { util: 14.0, vram_mb: 686.0, vram_total_mb: 8192.0, temp_c: 40.0 });
        let t = parse_sample("[N/A], 686 MiB, 8192 MiB, 40\n").unwrap();
        assert_eq!(t.util, 0.0);
        assert_eq!(t.vram_mb, 686.0);
    }

    #[test]
    fn a_gpu_list_keeps_names_and_memory() {
        let list = parse_gpu_list("0, NVIDIA GeForce GTX 1070, 8192
1, NVIDIA GeForce RTX 4090, 24564
");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].name, "NVIDIA GeForce GTX 1070");
        assert_eq!(list[1].memory_mb, 24564.0);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse_sample("").is_err());
        assert!(parse_sample("12, 34").is_err());
    }
}
