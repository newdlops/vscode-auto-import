use std::path::{Path, PathBuf};

use crate::parsers::ParserLanguage;

const TS_EXTS: &[&str] = &[".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const TS_INDEX: &[&str] = &[
    "index.ts",
    "index.tsx",
    "index.d.ts",
    "index.js",
    "index.jsx",
    "index.mjs",
    "index.cjs",
];

pub fn resolve(from_path: &str, barrel_path: &str, lang: ParserLanguage) -> Option<PathBuf> {
    match lang {
        ParserLanguage::TypeScript | ParserLanguage::JavaScript => resolve_ts(from_path, barrel_path),
        ParserLanguage::Python => resolve_python(from_path, barrel_path),
        _ => None,
    }
}

fn resolve_ts(from_path: &str, barrel_path: &str) -> Option<PathBuf> {
    if !from_path.starts_with('.') && !from_path.starts_with('/') {
        return None;
    }
    let barrel_dir = Path::new(barrel_path).parent()?;
    let abs_base = normalize(barrel_dir.join(from_path));

    for ext in TS_EXTS {
        let mut candidate = abs_base.clone();
        let name = candidate.file_name()?.to_os_string();
        let mut name_str = name.to_string_lossy().into_owned();
        name_str.push_str(ext);
        candidate.set_file_name(&name_str);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    for idx in TS_INDEX {
        let candidate = abs_base.join(idx);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_python(from_path: &str, barrel_path: &str) -> Option<PathBuf> {
    if !from_path.starts_with('.') {
        return None;
    }
    let leading_dots = from_path.bytes().take_while(|&b| b == b'.').count();
    let barrel_dir = Path::new(barrel_path).parent()?;
    let mut dir: PathBuf = barrel_dir.to_path_buf();
    for _ in 1..leading_dots {
        dir = dir.parent()?.to_path_buf();
    }
    let after_dots = &from_path[leading_dots..];
    let target_base = if after_dots.is_empty() {
        dir
    } else {
        let mut p = dir;
        for part in after_dots.split('.') {
            p.push(part);
        }
        p
    };

    let mut py = target_base.clone();
    py.set_extension("py");
    if py.is_file() {
        return Some(py);
    }
    let init = target_base.join("__init__.py");
    if init.is_file() {
        return Some(init);
    }
    None
}

fn normalize(p: PathBuf) -> PathBuf {
    // Resolve .. and . segments; std doesn't have a canonicalize without I/O
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    for comp in p.components() {
        use std::path::Component;
        match comp {
            Component::ParentDir => {
                if out.last().map_or(false, |s| s != "..") {
                    out.pop();
                } else {
                    out.push(std::ffi::OsString::from(".."));
                }
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {
                out.clear();
                out.push(comp.as_os_str().to_os_string());
            }
            Component::Normal(s) => out.push(s.to_os_string()),
        }
    }
    let mut result = PathBuf::new();
    for s in out {
        result.push(s);
    }
    result
}
