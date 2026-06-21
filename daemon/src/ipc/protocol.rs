use serde::{Deserialize, Serialize};

use crate::index::SymbolKind;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: Option<u64>,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorObject>,
}

#[derive(Debug, Serialize)]
pub struct Notification {
    pub method: String,
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct ErrorObject {
    pub code: i32,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitParams {
    pub workspace_root: String,
    #[serde(default = "default_exclude_globs")]
    pub exclude_globs: Vec<String>,
    #[serde(default = "default_languages")]
    pub languages: Vec<String>,
    #[serde(default)]
    pub python_respect_all: Option<bool>,
    #[serde(default)]
    pub java_include_inner: Option<bool>,
    #[serde(default)]
    pub libraries_enabled: Option<bool>,
    #[serde(default)]
    pub libraries_ts_node_modules: Option<bool>,
    #[serde(default)]
    pub libraries_python_site_packages: Option<bool>,
    #[serde(default)]
    pub libraries_python_max_depth: Option<usize>,
    #[serde(default)]
    pub libraries_python_extra_paths: Vec<String>,
    #[serde(default)]
    pub cache_dir: Option<String>,
}

fn default_languages() -> Vec<String> {
    vec![
        "typescript".into(),
        "javascript".into(),
        "python".into(),
        "java".into(),
    ]
}

fn default_exclude_globs() -> Vec<String> {
    vec![
        "**/node_modules/**".into(),
        "**/.venv/**".into(),
        "**/venv/**".into(),
        "**/__pycache__/**".into(),
        "**/target/**".into(),
        "**/build/**".into(),
        "**/dist/**".into(),
        "**/out/**".into(),
        "**/.git/**".into(),
    ]
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFileParams {
    pub path: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub override_qualifier: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveFileParams {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryParams {
    pub prefix: String,
    pub current_path: String,
    #[serde(default)]
    pub already_imported: Vec<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    pub language: String,
    #[serde(default)]
    pub context: QueryContext,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryContext {
    pub line_prefix: String,
    pub line_suffix: String,
}

fn default_limit() -> usize {
    20
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub name: String,
    pub kind: u8,
    pub flags: u32,
    pub target_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_qualifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_qualifier: Option<String>,
    pub score: i32,
}

impl Suggestion {
    pub fn from_kind(
        name: String,
        kind: SymbolKind,
        flags: u32,
        target_path: String,
        file_qualifier: Option<String>,
        parent_qualifier: Option<String>,
        score: i32,
    ) -> Self {
        Self {
            name,
            kind: kind as u8,
            flags,
            target_path,
            file_qualifier,
            parent_qualifier,
            score,
        }
    }
}
