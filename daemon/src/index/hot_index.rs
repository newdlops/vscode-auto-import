use std::collections::HashMap;

use super::string_table::StringId;
use super::symbol::SymbolKind;

pub type FileId = StringId;
pub type NameId = StringId;

#[derive(Debug, Clone)]
pub struct HotEntry {
    pub file_id: FileId,
    pub kind: SymbolKind,
    pub flags: u32,
    pub parent_name_id: Option<NameId>,
}

#[derive(Default)]
pub struct HotIndex {
    by_name: HashMap<NameId, Vec<HotEntry>>,
    by_file: HashMap<FileId, Vec<NameId>>,
}

impl HotIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, name_id: NameId, entry: HotEntry) {
        self.by_file.entry(entry.file_id).or_default().push(name_id);
        self.by_name.entry(name_id).or_default().push(entry);
    }

    pub fn remove_file(&mut self, file_id: FileId) {
        let Some(names) = self.by_file.remove(&file_id) else {
            return;
        };
        for name_id in names {
            let Some(entries) = self.by_name.get_mut(&name_id) else {
                continue;
            };
            entries.retain(|e| e.file_id != file_id);
            if entries.is_empty() {
                self.by_name.remove(&name_id);
            }
        }
    }

    pub fn lookup(&self, name_id: NameId) -> Option<&[HotEntry]> {
        self.by_name.get(&name_id).map(|v| v.as_slice())
    }

    pub fn total_entries(&self) -> usize {
        self.by_name.values().map(|v| v.len()).sum()
    }
}
