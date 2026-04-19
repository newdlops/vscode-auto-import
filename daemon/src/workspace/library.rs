use std::path::{Path, PathBuf};

use rayon::prelude::*;

use crate::parsers::ParserBundle;

use super::indexer::WorkspaceIndexer;

pub struct LibraryScanResult {
    pub ts: usize,
    pub python: usize,
}

pub fn scan_libraries(
    indexer: &WorkspaceIndexer,
    workspace_root: &str,
    ts_enabled: bool,
    py_enabled: bool,
    py_max_depth: usize,
    py_extra_paths: &[String],
) -> LibraryScanResult {
    let mut result = LibraryScanResult { ts: 0, python: 0 };

    if ts_enabled {
        result.ts = scan_ts_libraries(indexer, workspace_root);
    }
    if py_enabled {
        result.python = scan_python_libraries(indexer, workspace_root, py_max_depth, py_extra_paths);
    }
    result
}

fn scan_ts_libraries(indexer: &WorkspaceIndexer, workspace_root: &str) -> usize {
    let pkg_json_path = Path::new(workspace_root).join("package.json");
    let Ok(raw) = std::fs::read_to_string(&pkg_json_path) else {
        return 0;
    };
    let Ok(pkg_json): Result<serde_json::Value, _> = serde_json::from_str(&raw) else {
        return 0;
    };

    let mut deps: Vec<String> = Vec::new();
    for field in &["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] {
        if let Some(obj) = pkg_json.get(field).and_then(|v| v.as_object()) {
            for key in obj.keys() {
                deps.push(key.clone());
            }
        }
    }
    deps.sort();
    deps.dedup();

    let entries: Vec<(String, PathBuf)> = deps
        .par_iter()
        .flat_map(|dep| resolve_ts_library_entries(workspace_root, dep))
        .collect();

    let count: usize = entries
        .par_iter()
        .map_init(ParserBundle::new, |bundle, (module_spec, entry_path)| {
            let Some(path_str) = entry_path.to_str() else {
                return 0;
            };
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                indexer.index_file_disk(bundle, path_str, Some(module_spec))
            }));
            match result {
                Ok(true) => 1,
                _ => 0,
            }
        })
        .sum();

    indexer.reflatten_all_barrels();
    count
}

fn resolve_ts_library_entries(workspace_root: &str, dep: &str) -> Vec<(String, PathBuf)> {
    let mut entries = Vec::new();
    if let Some(primary) = resolve_one_ts_entry(workspace_root, dep) {
        entries.push((dep.to_string(), primary.clone()));
        if !dep.starts_with("@types/") {
            let types_dep = if dep.starts_with('@') {
                format!("@types/{}", dep[1..].replace('/', "__"))
            } else {
                format!("@types/{}", dep)
            };
            if let Some(types_path) = resolve_one_ts_entry(workspace_root, &types_dep) {
                if types_path != primary {
                    entries.push((dep.to_string(), types_path));
                }
            }
        }
    }
    entries
}

fn resolve_one_ts_entry(workspace_root: &str, dep: &str) -> Option<PathBuf> {
    let pkg_dir = Path::new(workspace_root).join("node_modules").join(dep);
    let pkg_json_path = pkg_dir.join("package.json");
    let raw = std::fs::read_to_string(&pkg_json_path).ok()?;
    let pkg_json: serde_json::Value = serde_json::from_str(&raw).ok()?;

    let mut candidates: Vec<String> = Vec::new();
    for k in ["types", "typings"] {
        if let Some(s) = pkg_json.get(k).and_then(|v| v.as_str()) {
            candidates.push(s.to_string());
        }
    }
    if let Some(exports) = pkg_json.get("exports") {
        if let Some(root) = exports.get(".") {
            collect_export_candidates(root, &mut candidates);
        }
    }
    if let Some(main) = pkg_json.get("main").and_then(|v| v.as_str()) {
        candidates.push(main.to_string());
    }
    candidates.push("index.d.ts".to_string());
    candidates.push("index.ts".to_string());

    for rel in candidates {
        let abs = pkg_dir.join(&rel);
        if let Some(resolved) = try_resolve_ts_file(&abs) {
            return Some(resolved);
        }
    }
    None
}

fn collect_export_candidates(v: &serde_json::Value, out: &mut Vec<String>) {
    if let Some(s) = v.as_str() {
        out.push(s.to_string());
        return;
    }
    if let Some(obj) = v.as_object() {
        for key in ["types", "typescript", "default", "import", "require"] {
            if let Some(inner) = obj.get(key) {
                collect_export_candidates(inner, out);
            }
        }
    }
}

fn try_resolve_ts_file(abs: &Path) -> Option<PathBuf> {
    if abs.is_file() && is_ts_file(abs) {
        return Some(abs.to_path_buf());
    }
    let stem_str = abs.to_string_lossy().to_string();
    let no_ext = stem_str
        .trim_end_matches(".js")
        .trim_end_matches(".mjs")
        .trim_end_matches(".cjs")
        .to_string();
    for suffix in [".d.ts", ".d.mts", ".d.cts", ".ts", ".tsx"] {
        let candidate = PathBuf::from(format!("{}{}", no_ext, suffix));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn is_ts_file(p: &Path) -> bool {
    if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
        name.ends_with(".d.ts")
            || name.ends_with(".d.mts")
            || name.ends_with(".d.cts")
            || name.ends_with(".ts")
            || name.ends_with(".tsx")
    } else {
        false
    }
}

fn scan_python_libraries(
    indexer: &WorkspaceIndexer,
    workspace_root: &str,
    max_depth: usize,
    extra_paths: &[String],
) -> usize {
    let dirs = discover_site_packages(workspace_root, extra_paths);
    if dirs.is_empty() {
        return 0;
    }
    let mut total = 0usize;
    for sp in dirs {
        total += scan_site_packages_dir(indexer, &sp, max_depth);
    }
    total
}

fn scan_site_packages_dir(indexer: &WorkspaceIndexer, site_dir: &Path, max_depth: usize) -> usize {
    let Ok(read_dir) = std::fs::read_dir(site_dir) else {
        return 0;
    };

    let mut jobs: Vec<(PathBuf, String, bool)> = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('_')
            || name.starts_with('.')
            || name.ends_with(".dist-info")
            || name.ends_with(".egg-info")
            || name.ends_with(".egg-link")
        {
            continue;
        }
        let abs = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_file() && (name.ends_with(".py") || name.ends_with(".pyi")) {
            let module = name
                .trim_end_matches(".pyi")
                .trim_end_matches(".py")
                .to_string();
            if module.starts_with('_') {
                continue;
            }
            jobs.push((abs, module, true));
        } else if file_type.is_dir() {
            jobs.push((abs, name, false));
        }
    }

    jobs.par_iter()
        .map_init(ParserBundle::new, |bundle, (abs, name, is_file)| {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if *is_file {
                    let path_str = abs.to_string_lossy().to_string();
                    if indexer.index_file_disk(bundle, &path_str, Some(name)) {
                        1
                    } else {
                        0
                    }
                } else {
                    scan_python_package(bundle, indexer, abs, name, max_depth)
                }
            }));
            result.unwrap_or(0)
        })
        .sum()
}

fn scan_python_package(
    bundle: &mut ParserBundle,
    indexer: &WorkspaceIndexer,
    pkg_dir: &Path,
    base_name: &str,
    max_depth: usize,
) -> usize {
    let mut count = 0usize;
    fn walk(
        bundle: &mut ParserBundle,
        indexer: &WorkspaceIndexer,
        dir: &Path,
        parts: &[String],
        depth: usize,
        max_depth: usize,
        count: &mut usize,
    ) {
        if depth > max_depth {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.')
                || name == "__pycache__"
                || name == "tests"
                || name == "test"
                || name == "_vendor"
            {
                continue;
            }
            let abs = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_file() {
                if name == "__init__.py" || name == "__init__.pyi" {
                    let module = parts.join(".");
                    let path_str = abs.to_string_lossy().to_string();
                    if indexer.index_file_disk(bundle, &path_str, Some(&module)) {
                        *count += 1;
                    }
                } else if name.ends_with(".py") || name.ends_with(".pyi") {
                    let mod_part = name.trim_end_matches(".pyi").trim_end_matches(".py");
                    if mod_part.starts_with('_') {
                        continue;
                    }
                    let mut new_parts: Vec<String> = parts.to_vec();
                    new_parts.push(mod_part.to_string());
                    let module = new_parts.join(".");
                    let path_str = abs.to_string_lossy().to_string();
                    if indexer.index_file_disk(bundle, &path_str, Some(&module)) {
                        *count += 1;
                    }
                }
            } else if file_type.is_dir() {
                let mut new_parts: Vec<String> = parts.to_vec();
                new_parts.push(name.clone());
                walk(bundle, indexer, &abs, &new_parts, depth + 1, max_depth, count);
            }
        }
    }
    walk(
        bundle,
        indexer,
        pkg_dir,
        &[base_name.to_string()],
        1,
        max_depth,
        &mut count,
    );
    count
}

fn discover_site_packages(workspace_root: &str, extra_paths: &[String]) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = extra_paths.iter().map(PathBuf::from).collect();
    for venv_name in [".venv", "venv", "env", ".env"] {
        let venv_lib = Path::new(workspace_root).join(venv_name).join("lib");
        if let Ok(entries) = std::fs::read_dir(&venv_lib) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("python") {
                    candidates.push(venv_lib.join(name).join("site-packages"));
                }
            }
        }
        candidates.push(
            Path::new(workspace_root)
                .join(venv_name)
                .join("Lib")
                .join("site-packages"),
        );
    }

    let mut seen = std::collections::HashSet::new();
    let mut valid = Vec::new();
    for c in candidates {
        let Ok(resolved) = c.canonicalize() else {
            continue;
        };
        if seen.insert(resolved.clone()) && resolved.is_dir() {
            valid.push(resolved);
        }
    }
    valid
}
