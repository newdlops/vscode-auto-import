use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::hot_index::{FileId, HotEntry, HotIndex};
use super::prefix_index::PrefixIndex;
use super::string_table::{StringId, StringTable};
use super::symbol::ExportedSymbol;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFile {
    pub path_id: FileId,
    pub content_hash: [u8; 16],
    pub mtime: u64,
    pub file_qualifier: Option<String>,
    pub exports: Vec<ExportedSymbol>,
}

#[derive(Serialize, Debug, Default, Clone)]
pub struct IndexStats {
    pub files: usize,
    pub names: usize,
    pub paths: usize,
    pub hot_entries: usize,
}

pub struct SymbolIndex {
    pub names: StringTable,
    pub paths: StringTable,
    pub hot: HotIndex,
    pub prefix: PrefixIndex,
    files: HashMap<FileId, IndexedFile>,
}

impl Default for SymbolIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl SymbolIndex {
    pub fn new() -> Self {
        Self {
            names: StringTable::new(),
            paths: StringTable::new(),
            hot: HotIndex::new(),
            prefix: PrefixIndex::new(),
            files: HashMap::new(),
        }
    }

    pub fn upsert_file(
        &mut self,
        path: &str,
        content_hash: [u8; 16],
        mtime: u64,
        file_qualifier: Option<String>,
        exports: Vec<ExportedSymbol>,
    ) {
        let path_id = self.paths.intern(path);
        if self.files.contains_key(&path_id) {
            self.hot.remove_file(path_id);
        }
        if let Some(q) = &file_qualifier {
            self.names.intern(q);
        }
        for sym in &exports {
            let name_id = self.names.intern(&sym.name);
            let parent_name_id = sym.parent_qualifier.as_deref().map(|p| self.names.intern(p));
            self.hot.add(
                name_id,
                HotEntry {
                    file_id: path_id,
                    kind: sym.kind,
                    flags: sym.flags,
                    parent_name_id,
                },
            );
        }
        self.files.insert(
            path_id,
            IndexedFile {
                path_id,
                content_hash,
                mtime,
                file_qualifier,
                exports,
            },
        );
    }

    pub fn remove_file(&mut self, path: &str) -> bool {
        let Some(path_id) = self.paths.lookup(path) else {
            return false;
        };
        if self.files.remove(&path_id).is_none() {
            return false;
        }
        self.hot.remove_file(path_id);
        true
    }

    pub fn get_file(&self, path: &str) -> Option<&IndexedFile> {
        let id = self.paths.lookup(path)?;
        self.files.get(&id)
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn stats(&self) -> IndexStats {
        IndexStats {
            files: self.files.len(),
            names: self.names.len(),
            paths: self.paths.len(),
            hot_entries: self.hot.total_entries(),
        }
    }

    pub fn path_str(&self, id: StringId) -> Option<&str> {
        self.paths.get(id)
    }

    pub fn name_str(&self, id: StringId) -> Option<&str> {
        self.names.get(id)
    }

    pub fn lookup_prefix(&mut self, prefix: &str, limit: usize) -> Vec<StringId> {
        self.prefix.lookup_prefix(&self.names, prefix, limit)
    }

    pub fn snapshot(&self) -> IndexSnapshot {
        IndexSnapshot {
            version: SNAPSHOT_VERSION,
            names: self.names.all().to_vec(),
            paths: self.paths.all().to_vec(),
            files: self
                .files
                .iter()
                .map(|(id, f)| (*id, f.clone()))
                .collect(),
        }
    }

    pub fn restore(&mut self, snap: IndexSnapshot) -> Result<(), String> {
        if snap.version != SNAPSHOT_VERSION {
            return Err(format!(
                "cache version mismatch: got {}, expected {}",
                snap.version, SNAPSHOT_VERSION
            ));
        }
        self.names = StringTable::from_strings(snap.names);
        self.paths = StringTable::from_strings(snap.paths);
        self.hot = HotIndex::new();
        self.prefix = PrefixIndex::new();
        self.files.clear();

        let files = snap.files;
        for (_path_id, file) in files {
            if let Some(path) = self.paths.get(file.path_id).map(|s| s.to_string()) {
                self.upsert_file(
                    &path,
                    file.content_hash,
                    file.mtime,
                    file.file_qualifier,
                    file.exports,
                );
            }
        }
        Ok(())
    }
}

pub const SNAPSHOT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct IndexSnapshot {
    pub version: u32,
    pub names: Vec<String>,
    pub paths: Vec<String>,
    pub files: Vec<(FileId, IndexedFile)>,
}
