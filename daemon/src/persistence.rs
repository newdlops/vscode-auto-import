use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::index::SymbolIndex;
use crate::index::symbol_index::IndexSnapshot;
use crate::parsers::extractor::ReExportEntry;

#[derive(Serialize, Deserialize)]
pub struct CacheFile {
    pub snapshot: IndexSnapshot,
    pub re_exports_by_barrel: Vec<(String, Vec<ReExportEntry>)>,
}

pub fn save(
    base_dir: &Path,
    index: &Arc<Mutex<SymbolIndex>>,
    re_exports: &Arc<Mutex<std::collections::HashMap<String, Vec<ReExportEntry>>>>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(base_dir)?;
    let snapshot = index.lock().unwrap().snapshot();
    let reexp = re_exports
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<Vec<_>>();
    let cache = CacheFile {
        snapshot,
        re_exports_by_barrel: reexp,
    };
    let tmp = base_dir.join("index.bin.tmp");
    let final_path = base_dir.join("index.bin");
    let data = bincode::serialize(&cache)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &final_path)?;
    Ok(())
}

pub fn load(base_dir: &Path) -> std::io::Result<CacheFile> {
    let path = base_dir.join("index.bin");
    let data = std::fs::read(path)?;
    bincode::deserialize(&data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
}
