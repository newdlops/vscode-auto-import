use tree_sitter::{Node, Tree};

use crate::index::{ExportedSymbol, SymbolFlag, SymbolKind};

use super::extractor::ExtractionResult;

const TYPE_DECLS: &[&str] = &[
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
];

pub fn extract_java(tree: &Tree, source: &str, include_inner: bool) -> ExtractionResult {
    let mut result = ExtractionResult::default();
    let root = tree.root_node();
    let bytes = source.as_bytes();

    let mut cursor = root.walk();
    for c in root.named_children(&mut cursor) {
        if c.kind() == "package_declaration" {
            let mut inner_cursor = c.walk();
            for child in c.named_children(&mut inner_cursor) {
                if child.kind() == "identifier" || child.kind() == "scoped_identifier" {
                    if let Ok(text) = child.utf8_text(bytes) {
                        result.file_qualifier = Some(text.to_string());
                        break;
                    }
                }
            }
        } else if TYPE_DECLS.contains(&c.kind()) {
            extract_type_decl(c, bytes, None, include_inner, &mut result.exports);
        }
    }
    result
}

fn extract_type_decl(
    node: Node,
    bytes: &[u8],
    parent_qualifier: Option<&str>,
    include_inner: bool,
    out: &mut Vec<ExportedSymbol>,
) {
    let modifiers = find_modifiers(node);
    let is_public = has_modifier(modifiers, "public");
    let is_static = has_modifier(modifiers, "static");

    if !is_public {
        return;
    }
    if parent_qualifier.is_some() && !is_static {
        return;
    }

    let Some(name_node) = node.child_by_field_name("name") else {
        return;
    };
    let Ok(name) = name_node.utf8_text(bytes) else {
        return;
    };

    let flags = if parent_qualifier.is_some() {
        SymbolFlag::INNER_CLASS
    } else {
        SymbolFlag::NONE
    };

    let kind = match node.kind() {
        "interface_declaration" | "annotation_type_declaration" => SymbolKind::Interface,
        "enum_declaration" => SymbolKind::Enum,
        _ => SymbolKind::Class,
    };

    out.push(ExportedSymbol {
        name: name.to_string(),
        kind,
        flags,
        parent_qualifier: parent_qualifier.map(|s| s.to_string()),
        source_path: None,
        line: node.start_position().row as u32,
        col: node.start_position().column as u32,
    });

    if !include_inner {
        return;
    }

    let Some(body) = node.child_by_field_name("body") else {
        return;
    };

    let new_qualifier = match parent_qualifier {
        Some(p) => format!("{}.{}", p, name),
        None => name.to_string(),
    };

    let mut cursor = body.walk();
    for member in body.named_children(&mut cursor) {
        if TYPE_DECLS.contains(&member.kind()) {
            extract_type_decl(member, bytes, Some(&new_qualifier), include_inner, out);
        }
    }
}

fn find_modifiers(node: Node) -> Option<Node> {
    let mut cursor = node.walk();
    for c in node.children(&mut cursor) {
        if c.kind() == "modifiers" {
            return Some(c);
        }
    }
    None
}

fn has_modifier(modifiers: Option<Node>, modifier: &str) -> bool {
    let Some(m) = modifiers else {
        return false;
    };
    let mut cursor = m.walk();
    for child in m.children(&mut cursor) {
        if child.kind() == modifier {
            return true;
        }
    }
    false
}
