use serde::{Deserialize, Serialize};

use crate::index::ExportedSymbol;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReExportName {
    pub exported_name: String,
    pub source_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ReExportNames {
    All,
    Named(Vec<ReExportName>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReExportEntry {
    pub from_path: String,
    pub names: ReExportNames,
    pub is_type_only: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ExtractionResult {
    pub exports: Vec<ExportedSymbol>,
    pub re_exports: Vec<ReExportEntry>,
    pub file_qualifier: Option<String>,
}

pub fn unquote(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() < 2 {
        return s;
    }
    let first = bytes[0];
    let last = *bytes.last().unwrap();
    if (first == b'"' || first == b'\'' || first == b'`') && first == last {
        &s[1..s.len() - 1]
    } else {
        s
    }
}
