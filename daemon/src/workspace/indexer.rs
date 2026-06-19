use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use blake3::Hasher;
use serde::Serialize;

use crate::index::{ExportedSymbol, SymbolFlag, SymbolIndex};
use crate::parsers::extractor::{ExtractionResult, ReExportEntry, ReExportNames};
use crate::parsers::python_fallback::extract_python_regex;
use crate::parsers::{java, python, typescript, ParserBundle, ParserLanguage};

use super::re_export_resolver;

const MAX_FILE_SIZE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Default, Serialize, Clone)]
pub struct IndexerStats {
    pub parsed: usize,
    pub skipped_large: usize,
    pub parse_failures: usize,
    pub python_regex_fallbacks: usize,
}

pub struct Settings {
    pub workspace_root: String,
    pub python_respect_all: bool,
    pub java_include_inner: bool,
}

pub struct IndexerHandle {
    index: Arc<Mutex<SymbolIndex>>,
    re_exports_by_barrel: Arc<Mutex<HashMap<String, Vec<ReExportEntry>>>>,
    resolved_targets_by_barrel: Arc<Mutex<HashMap<String, Vec<String>>>>,
    barrels_by_target: Arc<Mutex<HashMap<String, Vec<String>>>>,
    atomic_parsed: Arc<AtomicUsize>,
    atomic_fallback: Arc<AtomicUsize>,
    atomic_failed: Arc<AtomicUsize>,
    atomic_large: Arc<AtomicUsize>,
    atomic_dirty: Arc<AtomicBool>,
    settings: Arc<Settings>,
}

impl IndexerHandle {
    pub fn re_exports(&self) -> Arc<Mutex<HashMap<String, Vec<ReExportEntry>>>> {
        Arc::clone(&self.re_exports_by_barrel)
    }

    pub fn mark_dirty(&self) {
        self.atomic_dirty.store(true, Ordering::Relaxed);
    }

    pub fn take_dirty(&self) -> bool {
        self.atomic_dirty.swap(false, Ordering::AcqRel)
    }

    pub fn load_snapshot(
        &self,
        snapshot: crate::index::symbol_index::IndexSnapshot,
        re_exports: Vec<(String, Vec<ReExportEntry>)>,
    ) -> Result<(), String> {
        {
            let mut guard = self.index.lock().unwrap();
            guard.restore(snapshot)?;
        }
        {
            let mut map = self.re_exports_by_barrel.lock().unwrap();
            map.clear();
            for (k, v) in re_exports {
                map.insert(k, v);
            }
        }
        Ok(())
    }
}

impl IndexerHandle {
    pub fn new(settings: Settings) -> Self {
        Self {
            index: Arc::new(Mutex::new(SymbolIndex::new())),
            re_exports_by_barrel: Arc::new(Mutex::new(HashMap::new())),
            resolved_targets_by_barrel: Arc::new(Mutex::new(HashMap::new())),
            barrels_by_target: Arc::new(Mutex::new(HashMap::new())),
            atomic_parsed: Arc::new(AtomicUsize::new(0)),
            atomic_fallback: Arc::new(AtomicUsize::new(0)),
            atomic_failed: Arc::new(AtomicUsize::new(0)),
            atomic_large: Arc::new(AtomicUsize::new(0)),
            atomic_dirty: Arc::new(AtomicBool::new(false)),
            settings: Arc::new(settings),
        }
    }

    pub fn index(&self) -> Arc<Mutex<SymbolIndex>> {
        Arc::clone(&self.index)
    }

    pub fn snapshot_stats(&self) -> IndexerStats {
        IndexerStats {
            parsed: self.atomic_parsed.load(Ordering::Relaxed),
            skipped_large: self.atomic_large.load(Ordering::Relaxed),
            parse_failures: self.atomic_failed.load(Ordering::Relaxed),
            python_regex_fallbacks: self.atomic_fallback.load(Ordering::Relaxed),
        }
    }
}

pub struct WorkspaceIndexer {
    handle: IndexerHandle,
}

impl WorkspaceIndexer {
    pub fn from_handle(handle: IndexerHandle) -> Self {
        Self { handle }
    }

    pub fn handle(&self) -> &IndexerHandle {
        &self.handle
    }

    pub fn index_file_disk(
        &self,
        parser_bundle: &mut ParserBundle,
        path: &str,
        override_qualifier: Option<&str>,
    ) -> bool {
        self.index_file_disk_with_export_flags(parser_bundle, path, override_qualifier, 0)
    }

    pub fn index_file_disk_with_export_flags(
        &self,
        parser_bundle: &mut ParserBundle,
        path: &str,
        override_qualifier: Option<&str>,
        extra_export_flags: u32,
    ) -> bool {
        let Some(lang) = ParserLanguage::from_path(path) else {
            return false;
        };

        let metadata = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => return false,
        };
        if metadata.len() > MAX_FILE_SIZE_BYTES {
            self.handle.atomic_large.fetch_add(1, Ordering::Relaxed);
            return false;
        }
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|st| st.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        {
            let guard = self.handle.index.lock().unwrap();
            if let Some(existing) = guard.get_file(path) {
                if extra_export_flags == 0 && existing.mtime == mtime_ms {
                    return true;
                }
            }
        }

        let source = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(_) => return false,
        };

        self.index_file_source_with_export_flags(
            parser_bundle,
            path,
            &source,
            mtime_ms,
            lang,
            override_qualifier,
            extra_export_flags,
        )
    }

    pub fn index_file_source(
        &self,
        parser_bundle: &mut ParserBundle,
        path: &str,
        source: &str,
        mtime_ms: u64,
        lang: ParserLanguage,
        override_qualifier: Option<&str>,
    ) -> bool {
        self.index_file_source_with_export_flags(
            parser_bundle,
            path,
            source,
            mtime_ms,
            lang,
            override_qualifier,
            0,
        )
    }

    fn index_file_source_with_export_flags(
        &self,
        parser_bundle: &mut ParserBundle,
        path: &str,
        source: &str,
        mtime_ms: u64,
        lang: ParserLanguage,
        override_qualifier: Option<&str>,
        extra_export_flags: u32,
    ) -> bool {
        if source.len() as u64 > MAX_FILE_SIZE_BYTES {
            self.handle.atomic_large.fetch_add(1, Ordering::Relaxed);
            return false;
        }

        let mut hasher = Hasher::new();
        hasher.update(source.as_bytes());
        let hash_bytes = hasher.finalize();
        let mut hash = [0u8; 16];
        hash.copy_from_slice(&hash_bytes.as_bytes()[..16]);

        {
            let guard = self.handle.index.lock().unwrap();
            if let Some(existing) = guard.get_file(path) {
                if extra_export_flags == 0 && existing.content_hash == hash {
                    return true;
                }
            }
        }

        let parser = parser_bundle.get(lang);
        let tree_opt = parser.parse(source, None);
        let mut result: Option<ExtractionResult> = None;

        if let Some(tree) = tree_opt {
            let extracted = match lang {
                ParserLanguage::TypeScript | ParserLanguage::JavaScript => {
                    typescript::extract_typescript(&tree, source)
                }
                ParserLanguage::Python => {
                    python::extract_python(&tree, source, self.handle.settings.python_respect_all)
                }
                ParserLanguage::Java => {
                    java::extract_java(&tree, source, self.handle.settings.java_include_inner)
                }
            };
            self.handle.atomic_parsed.fetch_add(1, Ordering::Relaxed);
            result = Some(extracted);
        } else {
            self.handle.atomic_failed.fetch_add(1, Ordering::Relaxed);
            if lang == ParserLanguage::Python {
                let fallback = extract_python_regex(source, self.handle.settings.python_respect_all);
                self.handle.atomic_fallback.fetch_add(1, Ordering::Relaxed);
                result = Some(fallback);
            }
        }

        let Some(extraction) = result else {
            return false;
        };

        let file_qualifier = override_qualifier
            .map(|s| s.to_string())
            .or(extraction.file_qualifier.clone())
            .or_else(|| {
                if lang == ParserLanguage::Python {
                    compute_python_module(path, &self.handle.settings.workspace_root)
                } else {
                    None
                }
            });

        self.clear_barrel_deps(path);
        {
            let mut map = self.handle.re_exports_by_barrel.lock().unwrap();
            map.insert(path.to_string(), extraction.re_exports.clone());
        }

        let flattened = self.flatten_barrel(path, lang, &extraction.re_exports);
        let mut all_exports = merge_exports(extraction.exports, flattened);
        if extra_export_flags != 0 {
            for export in &mut all_exports {
                export.flags |= extra_export_flags;
            }
        }

        {
            let mut guard = self.handle.index.lock().unwrap();
            guard.upsert_file(path, hash, mtime_ms, file_qualifier, all_exports);
        }
        self.handle.mark_dirty();

        self.cascade_to_barrels(path);
        true
    }

    pub fn remove_file(&self, path: &str) {
        self.clear_barrel_deps(path);
        {
            let mut map = self.handle.re_exports_by_barrel.lock().unwrap();
            map.remove(path);
        }
        {
            let mut guard = self.handle.index.lock().unwrap();
            guard.remove_file(path);
        }
        self.handle.mark_dirty();
        self.cascade_to_barrels(path);
    }

    pub fn index_synthetic_file(
        &self,
        path: &str,
        file_qualifier: Option<&str>,
        exports: Vec<ExportedSymbol>,
    ) {
        self.clear_barrel_deps(path);
        {
            let mut map = self.handle.re_exports_by_barrel.lock().unwrap();
            map.remove(path);
        }
        {
            let mut guard = self.handle.index.lock().unwrap();
            guard.upsert_file(
                path,
                [0; 16],
                0,
                file_qualifier.map(|s| s.to_string()),
                exports,
            );
        }
        self.handle.mark_dirty();
    }

    pub fn reflatten_all_barrels(&self) {
        let barrel_paths: Vec<String> = {
            let map = self.handle.re_exports_by_barrel.lock().unwrap();
            map.keys().cloned().collect()
        };
        for barrel in barrel_paths {
            let re_exports = {
                let map = self.handle.re_exports_by_barrel.lock().unwrap();
                map.get(&barrel).cloned().unwrap_or_default()
            };
            if re_exports.is_empty() {
                continue;
            }
            self.reflatten_barrel(&barrel, &re_exports);
        }
    }

    fn reflatten_barrel(&self, barrel: &str, re_exports: &[ReExportEntry]) {
        let Some(lang) = ParserLanguage::from_path(barrel) else {
            return;
        };
        let (content_hash, mtime, file_qualifier, own_exports) = {
            let guard = self.handle.index.lock().unwrap();
            let Some(file) = guard.get_file(barrel) else {
                return;
            };
            let own: Vec<ExportedSymbol> = file
                .exports
                .iter()
                .filter(|e| (e.flags & SymbolFlag::RE_EXPORT) == 0)
                .cloned()
                .collect();
            (
                file.content_hash,
                file.mtime,
                file.file_qualifier.clone(),
                own,
            )
        };
        self.clear_barrel_deps(barrel);
        let flattened = self.flatten_barrel(barrel, lang, re_exports);
        let merged = merge_exports(own_exports, flattened);
        {
            let mut guard = self.handle.index.lock().unwrap();
            guard.upsert_file(barrel, content_hash, mtime, file_qualifier, merged);
        }
    }

    fn flatten_barrel(
        &self,
        barrel: &str,
        lang: ParserLanguage,
        re_exports: &[ReExportEntry],
    ) -> Vec<ExportedSymbol> {
        let mut out: Vec<ExportedSymbol> = Vec::new();
        let mut resolved_targets: Vec<String> = Vec::new();
        for re in re_exports {
            let Some(target_path) = re_export_resolver::resolve(&re.from_path, barrel, lang) else {
                continue;
            };
            let target_str = target_path.to_string_lossy().to_string();
            if target_str == barrel {
                continue;
            }
            resolved_targets.push(target_str.clone());

            let target_exports = {
                let guard = self.handle.index.lock().unwrap();
                guard.get_file(&target_str).map(|f| f.exports.clone())
            };
            let Some(target_exports) = target_exports else {
                continue;
            };

            match &re.names {
                ReExportNames::All => {
                    for exp in target_exports {
                        if (exp.flags & SymbolFlag::DEFAULT_EXPORT) != 0 {
                            continue;
                        }
                        out.push(ExportedSymbol {
                            name: exp.name,
                            kind: exp.kind,
                            flags: (exp.flags | SymbolFlag::RE_EXPORT) & !SymbolFlag::DEFAULT_EXPORT,
                            parent_qualifier: exp.parent_qualifier,
                            source_path: exp.source_path.or(Some(target_str.clone())),
                            line: exp.line,
                            col: exp.col,
                        });
                    }
                }
                ReExportNames::Named(names) => {
                    let mut by_name: HashMap<String, &ExportedSymbol> = HashMap::new();
                    for e in &target_exports {
                        by_name.insert(e.name.clone(), e);
                    }
                    for n in names {
                        let source_name = n.source_name.as_deref().unwrap_or(&n.exported_name);
                        let Some(source_exp) = by_name.get(source_name) else {
                            continue;
                        };
                        out.push(ExportedSymbol {
                            name: n.exported_name.clone(),
                            kind: source_exp.kind,
                            flags: source_exp.flags | SymbolFlag::RE_EXPORT,
                            parent_qualifier: source_exp.parent_qualifier.clone(),
                            source_path: Some(target_str.clone()),
                            line: 0,
                            col: 0,
                        });
                    }
                }
            }
        }

        {
            let mut rt = self.handle.resolved_targets_by_barrel.lock().unwrap();
            rt.insert(barrel.to_string(), resolved_targets.clone());
        }
        {
            let mut bt = self.handle.barrels_by_target.lock().unwrap();
            for target in resolved_targets {
                bt.entry(target).or_default().push(barrel.to_string());
            }
        }
        out
    }

    fn clear_barrel_deps(&self, barrel: &str) {
        let targets = {
            let mut rt = self.handle.resolved_targets_by_barrel.lock().unwrap();
            rt.remove(barrel).unwrap_or_default()
        };
        let mut bt = self.handle.barrels_by_target.lock().unwrap();
        for target in targets {
            if let Some(list) = bt.get_mut(&target) {
                list.retain(|b| b != barrel);
                if list.is_empty() {
                    bt.remove(&target);
                }
            }
        }
    }

    fn cascade_to_barrels(&self, changed_file: &str) {
        let dependents = {
            let bt = self.handle.barrels_by_target.lock().unwrap();
            bt.get(changed_file).cloned().unwrap_or_default()
        };
        for barrel in dependents {
            let re_exports = {
                let map = self.handle.re_exports_by_barrel.lock().unwrap();
                map.get(&barrel).cloned().unwrap_or_default()
            };
            self.reflatten_barrel(&barrel, &re_exports);
        }
    }
}

fn merge_exports(
    own: Vec<ExportedSymbol>,
    flattened: Vec<ExportedSymbol>,
) -> Vec<ExportedSymbol> {
    if flattened.is_empty() {
        return own;
    }
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for e in &own {
        seen.insert(format!(
            "{}::{}",
            e.parent_qualifier.as_deref().unwrap_or(""),
            e.name
        ));
    }
    let mut out = own;
    for e in flattened {
        let key = format!("{}::{}", e.parent_qualifier.as_deref().unwrap_or(""), e.name);
        if !seen.contains(&key) {
            seen.insert(key);
            out.push(e);
        }
    }
    out
}

fn compute_python_module(file_path: &str, workspace_root: &str) -> Option<String> {
    let path = Path::new(file_path);

    // If the file is inside a `site-packages` directory anywhere in the path,
    // use the segment after `site-packages` as the dotted module path. This
    // avoids garbage like `.venv.lib.python3.11.site-packages.requests.api`.
    if let Some(after) = strip_after_segment(path, "site-packages") {
        return module_from_relative(&after);
    }

    let rel = match path.strip_prefix(workspace_root) {
        Ok(r) => r.to_path_buf(),
        Err(_) => return None,
    };

    // Walk up from the file directory to the highest ancestor that still has
    // an `__init__.py`. The dotted path starts at the directory just below
    // that ancestor (handles src layouts, where `src/` is not part of the
    // module path).
    let abs_dir = match path.parent() {
        Some(p) => p.to_path_buf(),
        None => return module_from_relative(&rel),
    };
    let workspace_path = Path::new(workspace_root);
    let pkg_root = find_package_root(&abs_dir, workspace_path);
    if let Some(root_parent) = pkg_root {
        if let Ok(below) = path.strip_prefix(&root_parent) {
            return module_from_relative(below);
        }
    }
    module_from_relative(&rel)
}

fn module_from_relative(rel: &Path) -> Option<String> {
    let no_ext = rel.with_extension("");
    let mut parts: Vec<String> = no_ext
        .components()
        .filter_map(|c| c.as_os_str().to_str().map(|s| s.to_string()))
        .collect();
    if parts.last().map(|p| p == "__init__").unwrap_or(false) {
        parts.pop();
    }
    if parts.is_empty() {
        return None;
    }
    Some(parts.join("."))
}

fn strip_after_segment(path: &Path, marker: &str) -> Option<std::path::PathBuf> {
    let mut found = false;
    let mut out = std::path::PathBuf::new();
    for c in path.components() {
        if found {
            out.push(c);
            continue;
        }
        if let Some(s) = c.as_os_str().to_str() {
            if s == marker {
                found = true;
            }
        }
    }
    if found && !out.as_os_str().is_empty() {
        Some(out)
    } else {
        None
    }
}

fn find_package_root(dir: &Path, workspace_root: &Path) -> Option<std::path::PathBuf> {
    let mut current = dir.to_path_buf();
    let mut highest_with_init: Option<std::path::PathBuf> = None;
    while current.starts_with(workspace_root) {
        let init_py = current.join("__init__.py");
        let init_pyi = current.join("__init__.pyi");
        if init_py.exists() || init_pyi.exists() {
            highest_with_init = Some(current.clone());
        } else if highest_with_init.is_some() {
            break;
        }
        match current.parent() {
            Some(p) if p != current => current = p.to_path_buf(),
            _ => break,
        }
    }
    highest_with_init.and_then(|p| p.parent().map(|q| q.to_path_buf()))
}
