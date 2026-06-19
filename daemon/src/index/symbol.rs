use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum SymbolKind {
    Variable = 0,
    Function = 1,
    Class = 2,
    Interface = 3,
    TypeAlias = 4,
    Enum = 5,
    Namespace = 6,
    Module = 7,
    Method = 8,
    Property = 9,
}

#[allow(non_snake_case)]
pub mod SymbolFlag {
    pub const NONE: u32 = 0;
    pub const DEFAULT_EXPORT: u32 = 1 << 0;
    pub const TYPE_ONLY: u32 = 1 << 1;
    pub const RE_EXPORT: u32 = 1 << 2;
    pub const INNER_CLASS: u32 = 1 << 4;
    pub const MODULE_IMPORT: u32 = 1 << 5;
    pub const STANDARD_LIBRARY: u32 = 1 << 6;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportedSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub flags: u32,
    pub parent_qualifier: Option<String>,
    pub source_path: Option<String>,
    pub line: u32,
    pub col: u32,
}
