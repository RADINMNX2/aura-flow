//! One error type for every boundary: IO, tools, probe, plan and the pipeline.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum FlowError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("ffprobe could not read the source: {0}")]
    Probe(String),
    #[error("the recipe is invalid: {0}")]
    Plan(String),
    #[error("engine problem: {0}")]
    Engine(String),
    #[error("process failed: {0}")]
    Process(String),
    #[error("a required tool is missing: {0}")]
    MissingTool(String),
    #[error("path is not usable: {}", .0.display())]
    InvalidPath(PathBuf),
    #[error("cancelled")]
    Cancelled,
}

pub type Result<T> = std::result::Result<T, FlowError>;

impl FlowError {
    pub fn cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }
}
