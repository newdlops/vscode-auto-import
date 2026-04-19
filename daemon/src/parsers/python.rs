use tree_sitter::{Node, Tree};

use crate::index::{ExportedSymbol, SymbolFlag, SymbolKind};

use super::extractor::{unquote, ExtractionResult, ReExportEntry, ReExportName, ReExportNames};

pub fn extract_python(tree: &Tree, source: &str, respect_all: bool) -> ExtractionResult {
    let mut result = ExtractionResult::default();
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut has_all = false;
    let mut all_list: Vec<String> = Vec::new();
    let mut candidates: Vec<ExportedSymbol> = Vec::new();

    let mut cursor = root.walk();
    for c in root.named_children(&mut cursor) {
        let kind = c.kind();
        if kind == "expression_statement" {
            if let Some(inner) = c.named_child(0) {
                if inner.kind() == "assignment" {
                    let left = inner.child_by_field_name("left");
                    if let Some(left) = left {
                        if left.kind() == "identifier" {
                            let text = left.utf8_text(bytes).unwrap_or("");
                            if text == "__all__" {
                                has_all = true;
                                if let Some(right) = inner.child_by_field_name("right") {
                                    collect_all_items(right, bytes, &mut all_list);
                                }
                                continue;
                            }
                            candidates.push(mk_sym(text, SymbolKind::Variable, &c));
                        }
                    }
                }
            }
            continue;
        }

        let target = if kind == "decorated_definition" {
            c.child_by_field_name("definition").unwrap_or(c)
        } else {
            c
        };

        match target.kind() {
            "function_definition" => {
                if let Some(name_node) = target.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(bytes) {
                        candidates.push(mk_sym(name, SymbolKind::Function, &target));
                    }
                }
            }
            "class_definition" => {
                if let Some(name_node) = target.child_by_field_name("name") {
                    if let Ok(name) = name_node.utf8_text(bytes) {
                        candidates.push(mk_sym(name, SymbolKind::Class, &target));
                    }
                }
            }
            _ => {}
        }

        if kind == "import_from_statement" {
            handle_import_from(c, bytes, &mut result.re_exports);
        }
    }

    if respect_all && has_all {
        let allow: std::collections::HashSet<&String> = all_list.iter().collect();
        result.exports = candidates
            .into_iter()
            .filter(|s| allow.contains(&s.name))
            .collect();
    } else {
        result.exports = candidates
            .into_iter()
            .filter(|s| !s.name.starts_with('_'))
            .collect();
    }
    result
}

fn handle_import_from(node: Node, bytes: &[u8], re_exports: &mut Vec<ReExportEntry>) {
    let Some(module_node) = node.child_by_field_name("module_name") else {
        return;
    };
    let Ok(from_path) = module_node.utf8_text(bytes) else {
        return;
    };

    let mut saw_wildcard = false;
    let mut names: Vec<ReExportName> = Vec::new();

    let mut cursor = node.walk();
    for c in node.children(&mut cursor) {
        if c == module_node {
            continue;
        }
        match c.kind() {
            "wildcard_import" => {
                saw_wildcard = true;
            }
            "*" => {
                saw_wildcard = true;
            }
            "dotted_name" => {
                if let Ok(text) = c.utf8_text(bytes) {
                    names.push(ReExportName {
                        exported_name: text.to_string(),
                        source_name: None,
                    });
                }
            }
            "aliased_import" => {
                let name = c.child_by_field_name("name");
                let alias = c.child_by_field_name("alias");
                if let Some(name) = name {
                    let name_text = name.utf8_text(bytes).unwrap_or("");
                    if let Some(alias) = alias {
                        let alias_text = alias.utf8_text(bytes).unwrap_or("");
                        names.push(ReExportName {
                            exported_name: alias_text.to_string(),
                            source_name: Some(name_text.to_string()),
                        });
                    } else {
                        names.push(ReExportName {
                            exported_name: name_text.to_string(),
                            source_name: None,
                        });
                    }
                }
            }
            _ => {}
        }
    }

    if saw_wildcard {
        re_exports.push(ReExportEntry {
            from_path: from_path.to_string(),
            names: ReExportNames::All,
            is_type_only: false,
        });
    } else if !names.is_empty() {
        re_exports.push(ReExportEntry {
            from_path: from_path.to_string(),
            names: ReExportNames::Named(names),
            is_type_only: false,
        });
    }
}

fn collect_all_items(node: Node, bytes: &[u8], out: &mut Vec<String>) {
    if node.kind() != "list" && node.kind() != "tuple" {
        return;
    }
    let mut cursor = node.walk();
    for item in node.named_children(&mut cursor) {
        if item.kind() == "string" {
            out.push(string_literal_value(item, bytes));
        }
    }
}

fn string_literal_value(node: Node, bytes: &[u8]) -> String {
    let mut cursor = node.walk();
    for c in node.named_children(&mut cursor) {
        if c.kind() == "string_content" {
            if let Ok(t) = c.utf8_text(bytes) {
                return t.to_string();
            }
        }
    }
    unquote(node.utf8_text(bytes).unwrap_or("")).to_string()
}

fn mk_sym(name: &str, kind: SymbolKind, node: &Node) -> ExportedSymbol {
    ExportedSymbol {
        name: name.to_string(),
        kind,
        flags: SymbolFlag::NONE,
        parent_qualifier: None,
        source_path: None,
        line: node.start_position().row as u32,
        col: node.start_position().column as u32,
    }
}
