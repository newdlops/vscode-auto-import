use tree_sitter::{Node, Tree};

use crate::index::{ExportedSymbol, SymbolFlag, SymbolKind};

use super::extractor::{unquote, ExtractionResult, ReExportEntry, ReExportName, ReExportNames};

const DECLARATION_TYPES: &[&str] = &[
    "class_declaration",
    "abstract_class_declaration",
    "function_declaration",
    "generator_function_declaration",
    "function_signature",
    "lexical_declaration",
    "variable_declaration",
    "type_alias_declaration",
    "interface_declaration",
    "enum_declaration",
    "internal_module",
    "module",
    "ambient_declaration",
];

pub fn extract_typescript(tree: &Tree, source: &str) -> ExtractionResult {
    let mut result = ExtractionResult::default();
    let root = tree.root_node();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        if child.kind() == "export_statement" {
            handle_export(child, source, &mut result);
        }
    }
    result
}

fn handle_export(node: Node, source: &str, out: &mut ExtractionResult) {
    let mut is_default = false;
    let mut is_type_only = false;
    let mut has_star = false;
    let mut star_as: Option<String> = None;
    let mut from_path: Option<String> = None;
    let mut export_clause: Option<Node> = None;
    let mut declaration: Option<Node> = None;
    let mut default_value: Option<Node> = None;

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "default" => is_default = true,
            "type" => is_type_only = true,
            "*" => has_star = true,
            "string" => {
                if let Ok(text) = child.utf8_text(source.as_bytes()) {
                    from_path = Some(unquote(text).to_string());
                }
            }
            "export_clause" => export_clause = Some(child),
            "namespace_export" => {
                if let Some(id) = child.named_child(0) {
                    if let Ok(t) = id.utf8_text(source.as_bytes()) {
                        star_as = Some(t.to_string());
                    }
                }
            }
            kind if child.is_named() && DECLARATION_TYPES.contains(&kind) => {
                declaration = Some(child);
            }
            _ if child.is_named() && is_default && default_value.is_none() => {
                default_value = Some(child);
            }
            _ => {}
        }
    }

    if let Some(decl) = declaration {
        for mut sym in extract_declaration(decl, source) {
            if is_default {
                sym.flags |= SymbolFlag::DEFAULT_EXPORT;
            }
            if is_type_only {
                sym.flags |= SymbolFlag::TYPE_ONLY;
            }
            out.exports.push(sym);
        }
        return;
    }

    if is_default {
        if let Some(val) = default_value {
            if let Some(name) = extract_default_name(val, source) {
                out.exports.push(ExportedSymbol {
                    name,
                    kind: SymbolKind::Variable,
                    flags: SymbolFlag::DEFAULT_EXPORT,
                    parent_qualifier: None,
                    source_path: None,
                    line: node.start_position().row as u32,
                    col: node.start_position().column as u32,
                });
            }
        }
        return;
    }

    if let Some(clause) = export_clause {
        let names = extract_clause_names(clause, source);
        if let Some(from) = &from_path {
            out.re_exports.push(ReExportEntry {
                from_path: from.clone(),
                names: ReExportNames::Named(names),
                is_type_only,
            });
        } else {
            for n in names {
                out.exports.push(ExportedSymbol {
                    name: n.exported_name.clone(),
                    kind: SymbolKind::Variable,
                    flags: if is_type_only {
                        SymbolFlag::TYPE_ONLY
                    } else {
                        SymbolFlag::NONE
                    },
                    parent_qualifier: None,
                    source_path: None,
                    line: node.start_position().row as u32,
                    col: node.start_position().column as u32,
                });
            }
        }
        return;
    }

    if (has_star || star_as.is_some()) && from_path.is_some() {
        let from = from_path.unwrap();
        let names = if let Some(as_name) = star_as {
            ReExportNames::Named(vec![ReExportName {
                exported_name: as_name,
                source_name: None,
            }])
        } else {
            ReExportNames::All
        };
        out.re_exports.push(ReExportEntry {
            from_path: from,
            names,
            is_type_only,
        });
    }
}

fn extract_declaration(node: Node, source: &str) -> Vec<ExportedSymbol> {
    if node.kind() == "ambient_declaration" {
        let mut cursor = node.walk();
        for c in node.named_children(&mut cursor) {
            let syms = extract_declaration(c, source);
            if !syms.is_empty() {
                return syms;
            }
        }
        return Vec::new();
    }

    let row = node.start_position().row as u32;
    let col = node.start_position().column as u32;
    let bytes = source.as_bytes();
    match node.kind() {
        "class_declaration" | "abstract_class_declaration" => named_symbol(
            node.child_by_field_name("name"),
            bytes,
            SymbolKind::Class,
            0,
            row,
            col,
        ),
        "function_declaration" | "generator_function_declaration" | "function_signature" => {
            named_symbol(
                node.child_by_field_name("name"),
                bytes,
                SymbolKind::Function,
                0,
                row,
                col,
            )
        }
        "lexical_declaration" | "variable_declaration" => {
            let mut out = Vec::new();
            let mut cursor = node.walk();
            for decl in node.named_children(&mut cursor) {
                if decl.kind() != "variable_declarator" {
                    continue;
                }
                if let Some(name_node) = decl.child_by_field_name("name") {
                    if name_node.kind() == "identifier" {
                        if let Ok(name) = name_node.utf8_text(bytes) {
                            out.push(ExportedSymbol {
                                name: name.to_string(),
                                kind: SymbolKind::Variable,
                                flags: 0,
                                parent_qualifier: None,
                                source_path: None,
                                line: decl.start_position().row as u32,
                                col: decl.start_position().column as u32,
                            });
                        }
                    }
                }
            }
            out
        }
        "type_alias_declaration" => named_symbol(
            node.child_by_field_name("name"),
            bytes,
            SymbolKind::TypeAlias,
            SymbolFlag::TYPE_ONLY,
            row,
            col,
        ),
        "interface_declaration" => named_symbol(
            node.child_by_field_name("name"),
            bytes,
            SymbolKind::Interface,
            SymbolFlag::TYPE_ONLY,
            row,
            col,
        ),
        "enum_declaration" => named_symbol(
            node.child_by_field_name("name"),
            bytes,
            SymbolKind::Enum,
            0,
            row,
            col,
        ),
        "internal_module" | "module" => named_symbol(
            node.child_by_field_name("name"),
            bytes,
            SymbolKind::Namespace,
            0,
            row,
            col,
        ),
        _ => Vec::new(),
    }
}

fn named_symbol(
    name_node: Option<Node>,
    bytes: &[u8],
    kind: SymbolKind,
    flags: u32,
    line: u32,
    col: u32,
) -> Vec<ExportedSymbol> {
    let Some(n) = name_node else {
        return Vec::new();
    };
    let Ok(name) = n.utf8_text(bytes) else {
        return Vec::new();
    };
    vec![ExportedSymbol {
        name: name.to_string(),
        kind,
        flags,
        parent_qualifier: None,
        source_path: None,
        line,
        col,
    }]
}

fn extract_clause_names(clause: Node, source: &str) -> Vec<ReExportName> {
    let mut names = Vec::new();
    let bytes = source.as_bytes();
    let mut cursor = clause.walk();
    for spec in clause.named_children(&mut cursor) {
        if spec.kind() != "export_specifier" {
            continue;
        }
        let name_node = spec.child_by_field_name("name");
        let alias_node = spec.child_by_field_name("alias");
        let Some(name_node) = name_node else {
            continue;
        };
        let Ok(name) = name_node.utf8_text(bytes) else {
            continue;
        };
        if let Some(alias) = alias_node {
            if let Ok(alias_text) = alias.utf8_text(bytes) {
                names.push(ReExportName {
                    exported_name: alias_text.to_string(),
                    source_name: Some(name.to_string()),
                });
                continue;
            }
        }
        names.push(ReExportName {
            exported_name: name.to_string(),
            source_name: None,
        });
    }
    names
}

fn extract_default_name(node: Node, source: &str) -> Option<String> {
    let bytes = source.as_bytes();
    if node.kind() == "identifier" {
        return node.utf8_text(bytes).ok().map(|s| s.to_string());
    }
    if let Some(n) = node.child_by_field_name("name") {
        if let Ok(s) = n.utf8_text(bytes) {
            return Some(s.to_string());
        }
    }
    None
}
