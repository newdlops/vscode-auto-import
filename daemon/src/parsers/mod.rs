pub mod extractor;
pub mod java;
pub mod python;
pub mod python_fallback;
pub mod typescript;

use tree_sitter::{Language, Parser};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParserLanguage {
    TypeScript,
    JavaScript,
    Python,
    Java,
}

impl ParserLanguage {
    pub fn from_path(path: &str) -> Option<Self> {
        let ext = extension_lower(path);
        match ext.as_str() {
            "ts" | "tsx" | "mts" | "cts" => Some(Self::TypeScript),
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            "java" => Some(Self::Java),
            _ => None,
        }
    }

    fn language(self) -> Language {
        match self {
            Self::TypeScript => tree_sitter_typescript::language_tsx(),
            Self::JavaScript => tree_sitter_typescript::language_tsx(),
            Self::Python => tree_sitter_python::language(),
            Self::Java => tree_sitter_java::language(),
        }
    }
}

fn extension_lower(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default()
}

pub struct ParserBundle {
    ts: Parser,
    py: Parser,
    java: Parser,
}

impl ParserBundle {
    pub fn new() -> Self {
        let mut ts = Parser::new();
        let _ = ts.set_language(&ParserLanguage::TypeScript.language());
        let mut py = Parser::new();
        let _ = py.set_language(&ParserLanguage::Python.language());
        let mut java = Parser::new();
        let _ = java.set_language(&ParserLanguage::Java.language());
        Self { ts, py, java }
    }

    pub fn get(&mut self, lang: ParserLanguage) -> &mut Parser {
        match lang {
            ParserLanguage::TypeScript | ParserLanguage::JavaScript => &mut self.ts,
            ParserLanguage::Python => &mut self.py,
            ParserLanguage::Java => &mut self.java,
        }
    }
}

impl Default for ParserBundle {
    fn default() -> Self {
        Self::new()
    }
}
