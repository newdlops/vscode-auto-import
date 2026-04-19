use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use rayon::prelude::*;
use walkdir::WalkDir;

use crate::parsers::{ParserBundle, ParserLanguage};

use super::indexer::WorkspaceIndexer;

pub fn scan_workspace<F>(
    indexer: &WorkspaceIndexer,
    workspace_root: &str,
    exclude_globs: &[String],
    languages: &[ParserLanguage],
    mut on_progress: F,
) -> usize
where
    F: FnMut(usize, usize) + Send,
{
    let exclude = build_globset(exclude_globs);
    let files = collect_files(workspace_root, &exclude, languages);
    let total = files.len();
    let done = Arc::new(AtomicUsize::new(0));
    let last_reported = Arc::new(AtomicUsize::new(0));

    let (tx, rx) = crossbeam_channel::bounded::<usize>(256);
    let done_clone = Arc::clone(&done);
    let last_clone = Arc::clone(&last_reported);

    rayon::scope(|s| {
        s.spawn(|_| {
            files.par_iter().for_each_init(ParserBundle::new, |bundle, path| {
                let path_owned = path.clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    indexer.index_file_disk(bundle, &path_owned, None);
                }));
                let new_done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                let _ = tx.send(new_done);
            });
            drop(tx);
        });

        while let Ok(_current) = rx.recv() {
            let now = done_clone.load(Ordering::Relaxed);
            let last = last_clone.load(Ordering::Relaxed);
            let tick = (total / 10).max(200);
            if now - last >= tick || now == total {
                last_clone.store(now, Ordering::Relaxed);
                on_progress(now, total);
            }
        }
    });

    indexer.reflatten_all_barrels();
    total
}

pub fn collect_files(
    workspace_root: &str,
    exclude: &GlobSet,
    languages: &[ParserLanguage],
) -> Vec<String> {
    let mut out = Vec::new();
    for entry in WalkDir::new(workspace_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_excluded_dir(e.path(), workspace_root, exclude))
    {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let Some(path_str) = p.to_str() else {
            continue;
        };
        let Some(lang) = ParserLanguage::from_path(path_str) else {
            continue;
        };
        if !languages.contains(&lang) {
            continue;
        }
        let rel = match p.strip_prefix(workspace_root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if exclude.is_match(rel) {
            continue;
        }
        out.push(path_str.to_string());
    }
    out
}

fn is_excluded_dir(path: &std::path::Path, workspace_root: &str, exclude: &GlobSet) -> bool {
    if let Ok(rel) = path.strip_prefix(workspace_root) {
        if exclude.is_match(rel) {
            return true;
        }
    }
    false
}

pub fn build_globset(patterns: &[String]) -> GlobSet {
    let mut builder = GlobSetBuilder::new();
    for p in patterns {
        if let Ok(glob) = GlobBuilder::new(p).literal_separator(true).build() {
            builder.add(glob);
        }
    }
    builder.build().unwrap_or_else(|_| GlobSet::empty())
}
