use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::index::{ExportedSymbol, SymbolFlag, SymbolKind};

use super::extractor::ExtractionResult;

fn class_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^class\s+([A-Za-z_]\w*)").unwrap())
}
fn def_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:async\s+)?def\s+([A-Za-z_]\w*)").unwrap())
}
fn assign_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^([A-Za-z_]\w*)\s*(?::[^=]*)?=").unwrap())
}
fn all_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^__all__\s*=\s*[\[\(]([^\]\)]*)[\]\)]").unwrap())
}
fn string_item_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"['"]([^'"]+)['"]"#).unwrap())
}

pub fn extract_python_regex(source: &str, respect_all: bool) -> ExtractionResult {
    let keywords: HashSet<&str> = [
        "from", "import", "if", "elif", "else", "while", "for", "with", "try", "except",
        "finally", "return", "raise", "yield", "pass", "break", "continue", "global", "nonlocal",
        "assert", "del", "lambda", "not", "and", "or", "in", "is", "True", "False", "None",
        "class", "def", "async", "await",
    ]
    .into_iter()
    .collect();

    let mut exports: Vec<ExportedSymbol> = Vec::new();
    let mut has_all = false;
    let mut allow_list: Option<HashSet<String>> = None;

    let mut in_multiline_string = false;
    let mut multiline_quote = "";

    for (idx, raw) in source.split('\n').enumerate() {
        if in_multiline_string {
            if raw.contains(multiline_quote) {
                in_multiline_string = false;
            }
            continue;
        }

        let bytes = raw.as_bytes();
        if bytes.is_empty() || bytes[0] == b' ' || bytes[0] == b'\t' {
            continue;
        }
        if raw.starts_with('#') {
            continue;
        }

        let line = strip_inline_comment(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with("\"\"\"") || trimmed.starts_with("'''") {
            multiline_quote = if trimmed.starts_with("\"\"\"") {
                "\"\"\""
            } else {
                "'''"
            };
            if trimmed.len() >= 6 && trimmed.ends_with(multiline_quote) {
                continue;
            }
            in_multiline_string = true;
            continue;
        }

        if let Some(cap) = all_re().captures(trimmed) {
            has_all = true;
            let inner = cap.get(1).map_or("", |m| m.as_str());
            let mut list = HashSet::new();
            for m in string_item_re().captures_iter(inner) {
                if let Some(s) = m.get(1) {
                    list.insert(s.as_str().to_string());
                }
            }
            allow_list = Some(list);
            continue;
        }

        if let Some(cap) = class_re().captures(trimmed) {
            if let Some(name) = cap.get(1) {
                exports.push(mk(name.as_str(), SymbolKind::Class, idx as u32));
                continue;
            }
        }

        if let Some(cap) = def_re().captures(trimmed) {
            if let Some(name) = cap.get(1) {
                exports.push(mk(name.as_str(), SymbolKind::Function, idx as u32));
                continue;
            }
        }

        if trimmed.starts_with('@') {
            continue;
        }

        if let Some(cap) = assign_re().captures(trimmed) {
            if let Some(name) = cap.get(1) {
                let n = name.as_str();
                if !keywords.contains(n) && n != "__all__" {
                    exports.push(mk(n, SymbolKind::Variable, idx as u32));
                }
            }
        }
    }

    let filtered: Vec<ExportedSymbol> = if respect_all && has_all {
        let allow = allow_list.unwrap_or_default();
        exports.into_iter().filter(|e| allow.contains(&e.name)).collect()
    } else {
        exports
            .into_iter()
            .filter(|e| !e.name.starts_with('_'))
            .collect()
    };

    ExtractionResult {
        exports: filtered,
        re_exports: Vec::new(),
        file_qualifier: None,
    }
}

fn mk(name: &str, kind: SymbolKind, line: u32) -> ExportedSymbol {
    ExportedSymbol {
        name: name.to_string(),
        kind,
        flags: SymbolFlag::NONE,
        parent_qualifier: None,
        source_path: None,
        line,
        col: 0,
    }
}

fn strip_inline_comment(line: &str) -> &str {
    let mut in_single = false;
    let mut in_double = false;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == b'\\' {
            i += 2;
            continue;
        }
        if !in_double && c == b'\'' {
            in_single = !in_single;
        } else if !in_single && c == b'"' {
            in_double = !in_double;
        } else if !in_single && !in_double && c == b'#' {
            return &line[..i];
        }
        i += 1;
    }
    line
}
