use std::io::Write;
use std::path::{Component, Path};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::mpsc;
use tokio::time::{interval, MissedTickBehavior};

use super::protocol::{
    ErrorObject, IndexFileParams, InitParams, Notification, QueryParams, RemoveFileParams, Request,
    Response, Suggestion,
};
use crate::index::prefix_index::initials_match;
use crate::index::{SymbolFlag, SymbolKind};
use crate::parsers::ParserLanguage;
use crate::persistence;
use crate::workspace::indexer::{IndexerHandle, Settings};
use crate::workspace::library::scan_libraries;
use crate::workspace::scanner::{build_globset, scan_workspace};
use crate::workspace::standard_library::index_standard_libraries;
use crate::workspace::WorkspaceIndexer;

type SharedIndexer = Arc<AsyncMutex<Option<Arc<WorkspaceIndexer>>>>;

pub async fn run() -> Result<()> {
    let stdout = tokio::io::stdout();
    let writer: Arc<tokio::sync::Mutex<tokio::io::Stdout>> = Arc::new(tokio::sync::Mutex::new(stdout));
    let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<Notification>();
    let writer_clone = Arc::clone(&writer);
    tokio::spawn(async move {
        while let Some(n) = notify_rx.recv().await {
            let payload = match serde_json::to_string(&n) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let mut w = writer_clone.lock().await;
            let _ = w.write_all(payload.as_bytes()).await;
            let _ = w.write_all(b"\n").await;
            let _ = w.flush().await;
        }
    });

    send_notification(
        &notify_tx,
        "ready",
        json!({ "protocol": 1, "name": "autoimport-daemon", "version": env!("CARGO_PKG_VERSION") }),
    );

    let stdin = tokio::io::stdin();
    let reader = BufReader::new(stdin);
    let mut lines = reader.lines();

    let shared: SharedIndexer = Arc::new(AsyncMutex::new(None));
    let mut config = ServerConfig::default();

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                send_notification(
                    &notify_tx,
                    "log",
                    json!({ "level": "error", "message": format!("bad request: {}", e) }),
                );
                continue;
            }
        };
        let id = req.id;
        let method = req.method.clone();
        let params = req.params.clone();
        let writer = Arc::clone(&writer);
        let notify = notify_tx.clone();
        let shared_handle = Arc::clone(&shared);

        match method.as_str() {
            "init" => {
                match serde_json::from_value::<InitParams>(params) {
                    Ok(init) => {
                        let (indexer_arc, server_cfg) = install_indexer(init);
                        {
                            let mut slot = shared_handle.lock().await;
                            *slot = Some(Arc::clone(&indexer_arc));
                        }
                        config = server_cfg;

                        if let Some(dir) = config.cache_dir.clone() {
                            spawn_periodic_save(
                                Arc::clone(&indexer_arc),
                                dir,
                                notify_tx.clone(),
                            );
                        }

                        let mut loaded = false;
                        let mut cached_files = 0usize;
                        if let Some(dir) = &config.cache_dir {
                            let dir_path = std::path::Path::new(dir);
                            if dir_path.join("index.bin").exists() {
                                match persistence::load(dir_path) {
                                    Ok(cache) => {
                                        let handle = indexer_arc.handle();
                                        match handle
                                            .load_snapshot(cache.snapshot, cache.re_exports_by_barrel)
                                        {
                                            Ok(()) => {
                                                indexer_arc.reflatten_all_barrels();
                                                cached_files = handle
                                                    .index()
                                                    .lock()
                                                    .unwrap()
                                                    .file_count();
                                                loaded = true;
                                                send_notification(
                                                    &notify_tx,
                                                    "log",
                                                    json!({
                                                        "level": "info",
                                                        "message": format!("cache loaded: {} files from {}", cached_files, dir_path.display())
                                                    }),
                                                );
                                            }
                                            Err(e) => {
                                                send_notification(
                                                    &notify_tx,
                                                    "log",
                                                    json!({
                                                        "level": "warn",
                                                        "message": format!("cache restore failed: {}", e)
                                                    }),
                                                );
                                            }
                                        }
                                    }
                                    Err(e) => {
                                        send_notification(
                                            &notify_tx,
                                            "log",
                                            json!({
                                                "level": "warn",
                                                "message": format!("cache load failed: {}", e)
                                            }),
                                        );
                                    }
                                }
                            }
                        }

                        let languages = parse_languages(&config.languages);
                        let stdlib = index_standard_libraries(indexer_arc.as_ref(), &languages);
                        send_notification(
                            &notify_tx,
                            "log",
                            json!({
                                "level": "info",
                                "message": format!(
                                    "standard libraries indexed: ts/js={} python={} java={}",
                                    stdlib.typescript, stdlib.python, stdlib.java
                                )
                            }),
                        );

                        respond(
                            &writer,
                            id,
                            Ok(json!({ "ok": true, "cacheLoaded": loaded, "cachedFiles": cached_files })),
                        )
                        .await;
                    }
                    Err(e) => {
                        respond(
                            &writer,
                            id,
                            Err(ErrorObject {
                                code: -32602,
                                message: format!("invalid init params: {}", e),
                            }),
                        )
                        .await;
                    }
                }
            }
            "scan" => {
                let Some(indexer) = shared_handle.lock().await.as_ref().cloned() else {
                    respond(&writer, id, Err(not_initialized())).await;
                    continue;
                };
                let writer = Arc::clone(&writer);
                let notify = notify.clone();
                let cfg = config.clone();
                tokio::task::spawn_blocking(move || {
                    let languages = parse_languages(&cfg.languages);
                    let start = std::time::Instant::now();
                    let total = scan_workspace(
                        indexer.as_ref(),
                        &cfg.workspace_root,
                        &cfg.exclude_globs,
                        &languages,
                        |done, total| {
                            send_notification(
                                &notify,
                                "scanProgress",
                                json!({ "done": done, "total": total }),
                            );
                        },
                    );
                    let elapsed = start.elapsed().as_millis() as u64;
                    let stats = indexer.handle().snapshot_stats();
                    let index_stats = indexer.handle().index().lock().unwrap().stats();
                    send_notification(
                        &notify,
                        "scanComplete",
                        json!({
                            "total": total,
                            "elapsedMs": elapsed,
                            "indexer": stats,
                            "index": index_stats,
                        }),
                    );

                    if cfg.libraries_enabled {
                        let lib_start = std::time::Instant::now();
                        let lib = scan_libraries(
                            indexer.as_ref(),
                            &cfg.workspace_root,
                            cfg.libraries_ts,
                            cfg.libraries_py,
                            cfg.py_max_depth,
                            &cfg.py_extra_paths,
                        );
                        let lib_elapsed = lib_start.elapsed().as_millis() as u64;
                        let stats2 = indexer.handle().snapshot_stats();
                        let index_stats2 = indexer.handle().index().lock().unwrap().stats();
                        send_notification(
                            &notify,
                            "librariesScanComplete",
                            json!({
                                "ts": lib.ts,
                                "python": lib.python,
                                "elapsedMs": lib_elapsed,
                                "indexer": stats2,
                                "index": index_stats2,
                            }),
                        );
                    }

                    if let Some(dir) = &cfg.cache_dir {
                        let handle = indexer.handle();
                        let index_arc = handle.index();
                        let re_exports_arc = handle.re_exports();
                        let save_start = std::time::Instant::now();
                        match crate::persistence::save(
                            std::path::Path::new(dir),
                            &index_arc,
                            &re_exports_arc,
                        ) {
                            Ok(()) => send_notification(
                                &notify,
                                "log",
                                json!({
                                    "level": "info",
                                    "message": format!("cache saved ({}ms)", save_start.elapsed().as_millis())
                                }),
                            ),
                            Err(e) => send_notification(
                                &notify,
                                "log",
                                json!({
                                    "level": "warn",
                                    "message": format!("cache save failed: {}", e)
                                }),
                            ),
                        }
                    }

                    let writer_c = Arc::clone(&writer);
                    tokio::runtime::Handle::current().spawn(async move {
                        respond(&writer_c, id, Ok(json!({ "total": total }))).await;
                    });
                });
            }
            "indexFile" => {
                let Some(indexer) = shared_handle.lock().await.as_ref().cloned() else {
                    respond(&writer, id, Err(not_initialized())).await;
                    continue;
                };
                match serde_json::from_value::<IndexFileParams>(params) {
                    Ok(p) => {
                        let writer = Arc::clone(&writer);
                        tokio::task::spawn_blocking(move || {
                            let mut bundle = crate::parsers::ParserBundle::new();
                            let result = if let Some(src) = p.source.as_deref() {
                                let lang = ParserLanguage::from_path(&p.path);
                                if let Some(lang) = lang {
                                    let mtime = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .map(|d| d.as_millis() as u64)
                                        .unwrap_or(0);
                                    indexer.index_file_source(
                                        &mut bundle,
                                        &p.path,
                                        src,
                                        mtime,
                                        lang,
                                        p.override_qualifier.as_deref(),
                                    )
                                } else {
                                    false
                                }
                            } else {
                                indexer.index_file_disk(
                                    &mut bundle,
                                    &p.path,
                                    p.override_qualifier.as_deref(),
                                )
                            };
                            let writer_c = Arc::clone(&writer);
                            tokio::runtime::Handle::current().spawn(async move {
                                respond(&writer_c, id, Ok(json!({ "ok": result }))).await;
                            });
                        });
                    }
                    Err(e) => {
                        respond(
                            &writer,
                            id,
                            Err(ErrorObject {
                                code: -32602,
                                message: e.to_string(),
                            }),
                        )
                        .await;
                    }
                }
            }
            "removeFile" => {
                let Some(indexer) = shared_handle.lock().await.as_ref().cloned() else {
                    respond(&writer, id, Err(not_initialized())).await;
                    continue;
                };
                match serde_json::from_value::<RemoveFileParams>(params) {
                    Ok(p) => {
                        indexer.remove_file(&p.path);
                        respond(&writer, id, Ok(json!({ "ok": true }))).await;
                    }
                    Err(e) => {
                        respond(
                            &writer,
                            id,
                            Err(ErrorObject {
                                code: -32602,
                                message: e.to_string(),
                            }),
                        )
                        .await;
                    }
                }
            }
            "query" => {
                let Some(indexer) = shared_handle.lock().await.as_ref().cloned() else {
                    respond(&writer, id, Err(not_initialized())).await;
                    continue;
                };
                match serde_json::from_value::<QueryParams>(params) {
                    Ok(p) => {
                        let result = run_query(&indexer, &p);
                        respond(&writer, id, Ok(json!({ "suggestions": result }))).await;
                    }
                    Err(e) => {
                        respond(
                            &writer,
                            id,
                            Err(ErrorObject {
                                code: -32602,
                                message: e.to_string(),
                            }),
                        )
                        .await;
                    }
                }
            }
            "stats" => {
                if let Some(indexer) = shared_handle.lock().await.as_ref().cloned() {
                    let index_stats = indexer.handle().index().lock().unwrap().stats();
                    let ist = indexer.handle().snapshot_stats();
                    respond(
                        &writer,
                        id,
                        Ok(json!({ "index": index_stats, "indexer": ist })),
                    )
                    .await;
                } else {
                    respond(&writer, id, Err(not_initialized())).await;
                }
            }
            "shutdown" => {
                if let Some(dir) = config.cache_dir.clone() {
                    if let Some(indexer) = shared_handle.lock().await.as_ref().cloned() {
                        if indexer.handle().take_dirty() {
                            let handle = indexer.handle();
                            let index_arc = handle.index();
                            let re_exports_arc = handle.re_exports();
                            let dir_path = std::path::PathBuf::from(dir);
                            let notify = notify_tx.clone();
                            let _ = tokio::task::spawn_blocking(move || {
                                match crate::persistence::save(
                                    &dir_path,
                                    &index_arc,
                                    &re_exports_arc,
                                ) {
                                    Ok(()) => send_notification(
                                        &notify,
                                        "log",
                                        json!({ "level": "info", "message": "cache flushed on shutdown" }),
                                    ),
                                    Err(e) => send_notification(
                                        &notify,
                                        "log",
                                        json!({ "level": "warn", "message": format!("shutdown save failed: {}", e) }),
                                    ),
                                }
                            })
                            .await;
                        }
                    }
                }
                respond(&writer, id, Ok(json!({ "ok": true }))).await;
                break;
            }
            other => {
                respond(
                    &writer,
                    id,
                    Err(ErrorObject {
                        code: -32601,
                        message: format!("unknown method: {}", other),
                    }),
                )
                .await;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Default)]
struct ServerConfig {
    workspace_root: String,
    exclude_globs: Vec<String>,
    languages: Vec<String>,
    libraries_enabled: bool,
    libraries_ts: bool,
    libraries_py: bool,
    py_max_depth: usize,
    py_extra_paths: Vec<String>,
    cache_dir: Option<String>,
}

fn spawn_periodic_save(
    indexer: Arc<WorkspaceIndexer>,
    cache_dir: String,
    notify: mpsc::UnboundedSender<Notification>,
) {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(10));
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ticker.tick().await; // skip immediate tick
        loop {
            ticker.tick().await;
            if !indexer.handle().take_dirty() {
                continue;
            }
            let handle = indexer.handle();
            let index_arc = handle.index();
            let re_exports_arc = handle.re_exports();
            let dir_path = std::path::PathBuf::from(&cache_dir);
            let notify_c = notify.clone();
            let res = tokio::task::spawn_blocking(move || {
                crate::persistence::save(&dir_path, &index_arc, &re_exports_arc)
            })
            .await;
            match res {
                Ok(Ok(())) => send_notification(
                    &notify_c,
                    "log",
                    json!({ "level": "debug", "message": "periodic cache save" }),
                ),
                Ok(Err(e)) => send_notification(
                    &notify_c,
                    "log",
                    json!({ "level": "warn", "message": format!("periodic cache save failed: {}", e) }),
                ),
                Err(e) => send_notification(
                    &notify_c,
                    "log",
                    json!({ "level": "warn", "message": format!("periodic save task panicked: {}", e) }),
                ),
            }
        }
    });
}

fn install_indexer(init: InitParams) -> (Arc<WorkspaceIndexer>, ServerConfig) {
    let settings = Settings {
        workspace_root: init.workspace_root.clone(),
        python_respect_all: init.python_respect_all.unwrap_or(true),
        java_include_inner: init.java_include_inner.unwrap_or(true),
    };
    let handle = IndexerHandle::new(settings);
    let indexer = Arc::new(WorkspaceIndexer::from_handle(handle));
    let cfg = ServerConfig {
        workspace_root: init.workspace_root,
        exclude_globs: init.exclude_globs,
        languages: init.languages,
        libraries_enabled: init.libraries_enabled.unwrap_or(true),
        libraries_ts: init.libraries_ts_node_modules.unwrap_or(true),
        libraries_py: init.libraries_python_site_packages.unwrap_or(true),
        py_max_depth: init.libraries_python_max_depth.unwrap_or(3),
        py_extra_paths: init.libraries_python_extra_paths,
        cache_dir: init.cache_dir,
    };
    let _ = build_globset(&cfg.exclude_globs);
    (indexer, cfg)
}

fn parse_languages(names: &[String]) -> Vec<ParserLanguage> {
    names
        .iter()
        .filter_map(|s| match s.as_str() {
            "typescript" => Some(ParserLanguage::TypeScript),
            "javascript" => Some(ParserLanguage::JavaScript),
            "python" => Some(ParserLanguage::Python),
            "java" => Some(ParserLanguage::Java),
            _ => None,
        })
        .collect()
}

fn run_query(indexer: &WorkspaceIndexer, q: &QueryParams) -> Vec<Suggestion> {
    let query_lang = match q.language.as_str() {
        "typescript" => ParserLanguage::TypeScript,
        "javascript" => ParserLanguage::JavaScript,
        "python" => ParserLanguage::Python,
        "java" => ParserLanguage::Java,
        _ => return Vec::new(),
    };
    let handle = indexer.handle();
    let index_arc = handle.index();
    let mut guard = index_arc.lock().unwrap();

    let already: std::collections::HashSet<&str> =
        q.already_imported.iter().map(|s| s.as_str()).collect();
    let budget = (q.limit * 10).max(200);

    let candidate_ids = guard.lookup_prefix(&q.prefix, budget);
    let hints = context_hints(query_lang, &q.context.line_prefix, &q.context.line_suffix);

    let mut scored: Vec<(Suggestion, i32)> = Vec::new();
    for name_id in candidate_ids {
        let Some(name) = guard.name_str(name_id).map(|s| s.to_string()) else {
            continue;
        };
        if already.contains(name.as_str()) {
            continue;
        }
        let entries_snapshot = {
            let Some(entries) = guard.hot.lookup(name_id) else {
                continue;
            };
            entries.to_vec()
        };
        for entry in entries_snapshot {
            let Some(target_path) = guard.path_str(entry.file_id).map(|s| s.to_string()) else {
                continue;
            };
            if target_path == q.current_path {
                continue;
            }
            let target_lang = ParserLanguage::from_path(&target_path);
            if target_lang.map_or(true, |l| !same_lang_group(l, query_lang)) {
                continue;
            }
            let file = guard.get_file(&target_path);
            let file_qualifier = file.and_then(|f| f.file_qualifier.clone());
            let parent_qualifier = entry
                .parent_name_id
                .and_then(|id| guard.name_str(id).map(|s| s.to_string()));
            let depth = target_path.chars().filter(|&c| c == '/').count() as i32;
            let proximity = path_proximity_score(&q.current_path, &target_path);
            let score = compute_score(
                &q.prefix,
                &name,
                entry.kind,
                entry.flags,
                depth,
                proximity,
                &hints,
            );
            let suggestion = Suggestion::from_kind(
                name.clone(),
                entry.kind,
                entry.flags,
                target_path,
                file_qualifier,
                parent_qualifier,
                score,
            );
            scored.push((suggestion, score));
        }
    }

    scored.sort_by(|a, b| b.1.cmp(&a.1));
    let mut seen = std::collections::HashSet::new();
    scored.retain(|(s, _)| {
        let source_key = s
            .file_qualifier
            .clone()
            .unwrap_or_else(|| s.target_path.clone());
        seen.insert((
            s.name.clone(),
            source_key,
            s.parent_qualifier.clone(),
            (s.flags & SymbolFlag::MODULE_IMPORT) != 0,
        ))
    });
    scored.truncate(q.limit);
    scored.into_iter().map(|(s, _)| s).collect()
}

fn same_lang_group(a: ParserLanguage, b: ParserLanguage) -> bool {
    match (a, b) {
        (ParserLanguage::TypeScript, ParserLanguage::TypeScript)
        | (ParserLanguage::TypeScript, ParserLanguage::JavaScript)
        | (ParserLanguage::JavaScript, ParserLanguage::TypeScript)
        | (ParserLanguage::JavaScript, ParserLanguage::JavaScript) => true,
        (x, y) => x == y,
    }
}

#[derive(Debug, Default)]
struct QueryHints {
    type_context: bool,
    construct_context: bool,
    call_context: bool,
    module_context: bool,
    annotation_context: bool,
}

fn compute_score(
    prefix: &str,
    name: &str,
    kind: SymbolKind,
    flags: u32,
    depth: i32,
    proximity: i32,
    hints: &QueryHints,
) -> i32 {
    let mut score: i32 = 0;
    let lower_name = name.to_ascii_lowercase();
    let lower_prefix = prefix.to_ascii_lowercase();
    if name == prefix {
        score += 1000;
    } else if name.starts_with(prefix) {
        score += 500;
    } else if lower_name.starts_with(&lower_prefix) {
        score += 300;
    } else if initials_match(name, &lower_prefix) {
        score += 240;
    }
    let extra = (name.len() as i32 - (prefix.len() as i32) * 2).max(0);
    score -= extra;
    score += context_score(kind, flags, hints);
    score += proximity;
    if (flags & SymbolFlag::RE_EXPORT) != 0 {
        score -= 10;
    }
    if (flags & SymbolFlag::DEFAULT_EXPORT) != 0 {
        score += 5;
    }
    if (flags & SymbolFlag::STANDARD_LIBRARY) != 0 {
        score -= 25;
    }
    if (flags & SymbolFlag::MODULE_IMPORT) != 0 {
        score -= 3;
    }
    score -= depth * 2;
    score
}

fn context_score(kind: SymbolKind, flags: u32, hints: &QueryHints) -> i32 {
    let mut score = 0;
    if hints.construct_context {
        score += match kind {
            SymbolKind::Class => 160,
            SymbolKind::Interface | SymbolKind::TypeAlias => -90,
            SymbolKind::Function => -40,
            _ => 0,
        };
    }
    if hints.type_context {
        score += match kind {
            SymbolKind::Class
            | SymbolKind::Interface
            | SymbolKind::TypeAlias
            | SymbolKind::Enum
            | SymbolKind::Namespace => 120,
            SymbolKind::Function => -70,
            SymbolKind::Variable => -50,
            _ => 0,
        };
        if (flags & SymbolFlag::TYPE_ONLY) != 0 {
            score += 45;
        }
    }
    if hints.call_context {
        score += match kind {
            SymbolKind::Function | SymbolKind::Method => 90,
            SymbolKind::Class => 35,
            SymbolKind::Interface | SymbolKind::TypeAlias => -80,
            _ => 0,
        };
    }
    if hints.module_context {
        score += match kind {
            SymbolKind::Module | SymbolKind::Namespace => 120,
            _ => -25,
        };
        if (flags & SymbolFlag::MODULE_IMPORT) != 0 {
            score += 80;
        }
    }
    if hints.annotation_context {
        score += match kind {
            SymbolKind::Function => 70,
            SymbolKind::Class | SymbolKind::Interface => 60,
            SymbolKind::Variable => -20,
            _ => 0,
        };
    }
    if (flags & SymbolFlag::TYPE_ONLY) != 0
        && !hints.type_context
        && (hints.call_context || hints.construct_context)
    {
        score -= 100;
    }
    score
}

fn context_hints(lang: ParserLanguage, line_prefix: &str, line_suffix: &str) -> QueryHints {
    let before = line_prefix.trim_end();
    let after = line_suffix.trim_start();
    let mut hints = QueryHints::default();

    if after.starts_with('(') {
        hints.call_context = true;
    }
    if after.starts_with('.') {
        hints.module_context = true;
    }
    if before.ends_with('@') {
        hints.annotation_context = true;
    }

    match lang {
        ParserLanguage::TypeScript | ParserLanguage::JavaScript => {
            if ends_with_word(before, "new") || ends_with_word(before, "instanceof") {
                hints.construct_context = true;
            }
            if is_likely_ts_type_annotation(before)
                || before.ends_with('<')
                || before.ends_with('|')
                || before.ends_with('&')
                || ends_with_word(before, "as")
                || ends_with_word(before, "satisfies")
                || ends_with_word(before, "extends")
                || ends_with_word(before, "implements")
                || ends_with_word(before, "type")
                || ends_with_word(before, "interface")
            {
                hints.type_context = true;
            }
            if ends_with_word(before, "import") || ends_with_word(before, "from") {
                hints.module_context = true;
            }
        }
        ParserLanguage::Python => {
            if is_likely_python_type_annotation(before)
                || before.ends_with("->")
                || before.ends_with('[')
                || before.ends_with('|')
                || ends_with_word(before, "class")
                || ends_with_word(before, "except")
            {
                hints.type_context = true;
            }
        }
        ParserLanguage::Java => {
            if ends_with_word(before, "new") {
                hints.construct_context = true;
            }
            if before.ends_with('@') {
                hints.annotation_context = true;
            }
            if before.ends_with('<')
                || before.ends_with(',')
                || ends_with_word(before, "extends")
                || ends_with_word(before, "implements")
                || ends_with_word(before, "throws")
                || ends_with_word(before, "catch")
                || ends_with_word(before, "instanceof")
            {
                hints.type_context = true;
            }
        }
    }

    hints
}

fn path_proximity_score(current_path: &str, target_path: &str) -> i32 {
    let mut score = 0;
    if is_external_path(target_path) {
        score -= 25;
    }

    let current_parent = parent_components(current_path);
    let target_parent = parent_components(target_path);
    if current_parent.is_empty() || target_parent.is_empty() {
        return score;
    }

    let common = current_parent
        .iter()
        .zip(target_parent.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let distance = (current_parent.len() - common) + (target_parent.len() - common);
    score
        + match distance {
            0 => 80,
            1 => 55,
            2 => 35,
            3 => 20,
            4 | 5 => 8,
            _ => 0,
        }
}

fn is_likely_ts_type_annotation(before: &str) -> bool {
    if !before.ends_with(':') {
        return false;
    }
    let head = before[..before.len() - 1].trim_end();
    let lower = head.to_ascii_lowercase();
    let last_brace = head.rfind('{');
    let last_equals = head.rfind('=');
    if last_brace > last_equals && !lower.contains("type ") && !lower.contains("interface ") {
        return false;
    }
    if head.ends_with(')') {
        return true;
    }
    if lower.contains("const ") || lower.contains("let ") || lower.contains("var ") {
        return true;
    }
    if lower.contains("function ") || lower.contains("interface ") || lower.contains("type ") {
        return true;
    }
    let last_paren = head.rfind('(');
    last_paren > last_brace
}

fn is_likely_python_type_annotation(before: &str) -> bool {
    if !before.ends_with(':') {
        return false;
    }
    let head = before[..before.len() - 1].trim_end();
    let last_brace = head.rfind('{');
    let last_bracket = head.rfind('[');
    let last_equals = head.rfind('=');
    if (last_brace > last_equals) || (last_bracket > last_equals) {
        return false;
    }
    true
}

fn parent_components(path: &str) -> Vec<String> {
    Path::new(path)
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    Component::Normal(s) => s.to_str().map(|s| s.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_external_path(path: &str) -> bool {
    path.contains("/node_modules/")
        || path.contains("\\node_modules\\")
        || path.contains("/site-packages/")
        || path.contains("\\site-packages\\")
}

fn ends_with_word(s: &str, word: &str) -> bool {
    if !s.ends_with(word) {
        return false;
    }
    let before = &s[..s.len() - word.len()];
    before
        .bytes()
        .next_back()
        .map_or(true, |b| !is_ident_byte(b))
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoring_uses_construct_context_to_prefer_classes() {
        let hints = QueryHints {
            construct_context: true,
            ..QueryHints::default()
        };

        let class_score = compute_score("Us", "UserService", SymbolKind::Class, 0, 3, 0, &hints);
        let interface_score = compute_score(
            "Us",
            "UserService",
            SymbolKind::Interface,
            SymbolFlag::TYPE_ONLY,
            3,
            0,
            &hints,
        );

        assert!(class_score > interface_score);
    }

    #[test]
    fn scoring_uses_type_context_to_prefer_type_symbols() {
        let hints = QueryHints {
            type_context: true,
            ..QueryHints::default()
        };

        let type_score = compute_score(
            "Us",
            "UserShape",
            SymbolKind::TypeAlias,
            SymbolFlag::TYPE_ONLY,
            3,
            0,
            &hints,
        );
        let function_score =
            compute_score("Us", "UserShape", SymbolKind::Function, 0, 3, 0, &hints);

        assert!(type_score > function_score);
    }

    #[test]
    fn scoring_uses_call_context_to_prefer_functions() {
        let hints = QueryHints {
            call_context: true,
            ..QueryHints::default()
        };

        let function_score = compute_score("lo", "loadUser", SymbolKind::Function, 0, 3, 0, &hints);
        let type_score = compute_score(
            "lo",
            "loadUser",
            SymbolKind::TypeAlias,
            SymbolFlag::TYPE_ONLY,
            3,
            0,
            &hints,
        );

        assert!(function_score > type_score);
    }

    #[test]
    fn scoring_uses_initials_when_prefix_is_not_contiguous() {
        let hints = QueryHints::default();

        let score = compute_score("UIC", "UserInfoCard", SymbolKind::Class, 0, 3, 0, &hints);

        assert!(score > 0);
    }

    #[test]
    fn context_hints_detect_typescript_type_positions() {
        let hints = context_hints(ParserLanguage::TypeScript, "const user: ", "");

        assert!(hints.type_context);
    }

    #[test]
    fn path_proximity_prefers_nearby_workspace_files() {
        let nearby = path_proximity_score("/repo/src/views/user.ts", "/repo/src/views/model.ts");
        let external =
            path_proximity_score("/repo/src/views/user.ts", "/repo/node_modules/pkg/model.ts");

        assert!(nearby > external);
    }
}

async fn respond(
    writer: &Arc<tokio::sync::Mutex<tokio::io::Stdout>>,
    id: Option<u64>,
    result: std::result::Result<serde_json::Value, ErrorObject>,
) {
    let Some(id) = id else {
        return;
    };
    let resp = match result {
        Ok(v) => Response {
            id,
            result: Some(v),
            error: None,
        },
        Err(e) => Response {
            id,
            result: None,
            error: Some(e),
        },
    };
    let Ok(payload) = serde_json::to_string(&resp) else {
        return;
    };
    let mut w = writer.lock().await;
    let _ = w.write_all(payload.as_bytes()).await;
    let _ = w.write_all(b"\n").await;
    let _ = w.flush().await;
}

fn send_notification<T: Serialize>(
    tx: &mpsc::UnboundedSender<Notification>,
    method: &str,
    params: T,
) {
    let params = serde_json::to_value(params).unwrap_or(json!({}));
    let _ = tx.send(Notification {
        method: method.to_string(),
        params,
    });
}

fn not_initialized() -> ErrorObject {
    ErrorObject {
        code: -32002,
        message: "daemon not initialized; call 'init' first".into(),
    }
}

#[allow(dead_code)]
fn write_stderr(msg: &str) {
    let _ = std::io::stderr().write_all(msg.as_bytes());
    let _ = std::io::stderr().write_all(b"\n");
}
