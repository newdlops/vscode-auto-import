import type Parser from 'web-tree-sitter';
import { SymbolFlag, SymbolKind, type ExportedSymbol } from '../index/types';
import { unquote, type ExtractionResult, type ReExportEntry, type ReExportName } from './base';

type SN = Parser.SyntaxNode;

const DECLARATION_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'lexical_declaration',
  'variable_declaration',
  'type_alias_declaration',
  'interface_declaration',
  'enum_declaration',
  'internal_module',
  'module',
]);

export function extractTypeScript(tree: Parser.Tree): ExtractionResult {
  const exports: ExportedSymbol[] = [];
  const reExports: ReExportEntry[] = [];
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === 'export_statement') {
      handleExport(child, exports, reExports);
    }
  }
  return { exports, reExports };
}

function handleExport(node: SN, out: ExportedSymbol[], reOut: ReExportEntry[]): void {
  let isDefault = false;
  let isTypeOnly = false;
  let hasStar = false;
  let starAs: string | undefined;
  let fromPath: string | undefined;
  let exportClause: SN | undefined;
  let declaration: SN | undefined;
  let defaultValue: SN | undefined;

  for (const c of node.children) {
    switch (c.type) {
      case 'default':
        isDefault = true;
        break;
      case 'type':
        isTypeOnly = true;
        break;
      case '*':
        hasStar = true;
        break;
      case 'string':
        fromPath = unquote(c.text);
        break;
      case 'export_clause':
        exportClause = c;
        break;
      case 'namespace_export': {
        const id = c.namedChildren[0];
        if (id) starAs = id.text;
        break;
      }
      default:
        if (!c.isNamed) break;
        if (DECLARATION_TYPES.has(c.type)) declaration = c;
        else if (isDefault && !defaultValue) defaultValue = c;
    }
  }

  if (declaration) {
    for (const sym of extractDeclaration(declaration)) {
      if (isDefault) sym.flags |= SymbolFlag.DefaultExport;
      if (isTypeOnly) sym.flags |= SymbolFlag.TypeOnly;
      out.push(sym);
    }
    return;
  }

  if (isDefault && defaultValue) {
    const name = extractDefaultName(defaultValue);
    if (name) {
      out.push({
        name,
        kind: SymbolKind.Variable,
        flags: SymbolFlag.DefaultExport,
        line: node.startPosition.row,
        col: node.startPosition.column,
      });
    }
    return;
  }

  if (exportClause) {
    const names = extractClauseNames(exportClause);
    if (fromPath) {
      reOut.push({ fromPath, names, isTypeOnly });
    } else {
      for (const n of names) {
        out.push({
          name: n.exportedName,
          kind: SymbolKind.Variable,
          flags: isTypeOnly ? SymbolFlag.TypeOnly : SymbolFlag.None,
          line: node.startPosition.row,
          col: node.startPosition.column,
        });
      }
    }
    return;
  }

  if ((hasStar || starAs !== undefined) && fromPath) {
    if (starAs !== undefined) {
      reOut.push({
        fromPath,
        names: [{ exportedName: starAs }],
        isTypeOnly,
      });
    } else {
      reOut.push({ fromPath, names: 'all', isTypeOnly });
    }
  }
}

function extractDeclaration(node: SN): ExportedSymbol[] {
  const loc = { line: node.startPosition.row, col: node.startPosition.column };
  switch (node.type) {
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = node.childForFieldName('name')?.text;
      return name ? [{ name, kind: SymbolKind.Class, flags: 0, ...loc }] : [];
    }
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_signature': {
      const name = node.childForFieldName('name')?.text;
      return name ? [{ name, kind: SymbolKind.Function, flags: 0, ...loc }] : [];
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      const out: ExportedSymbol[] = [];
      for (const declarator of node.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        if (nameNode && nameNode.type === 'identifier') {
          out.push({
            name: nameNode.text,
            kind: SymbolKind.Variable,
            flags: 0,
            line: declarator.startPosition.row,
            col: declarator.startPosition.column,
          });
        }
      }
      return out;
    }
    case 'type_alias_declaration': {
      const name = node.childForFieldName('name')?.text;
      return name
        ? [{ name, kind: SymbolKind.TypeAlias, flags: SymbolFlag.TypeOnly, ...loc }]
        : [];
    }
    case 'interface_declaration': {
      const name = node.childForFieldName('name')?.text;
      return name
        ? [{ name, kind: SymbolKind.Interface, flags: SymbolFlag.TypeOnly, ...loc }]
        : [];
    }
    case 'enum_declaration': {
      const name = node.childForFieldName('name')?.text;
      return name ? [{ name, kind: SymbolKind.Enum, flags: 0, ...loc }] : [];
    }
    case 'internal_module':
    case 'module': {
      const name = node.childForFieldName('name')?.text;
      return name ? [{ name, kind: SymbolKind.Namespace, flags: 0, ...loc }] : [];
    }
  }
  return [];
}

function extractClauseNames(exportClause: SN): ReExportName[] {
  const names: ReExportName[] = [];
  for (const spec of exportClause.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    const nameNode = spec.childForFieldName('name');
    const aliasNode = spec.childForFieldName('alias');
    if (!nameNode) continue;
    if (aliasNode) {
      names.push({ exportedName: aliasNode.text, sourceName: nameNode.text });
    } else {
      names.push({ exportedName: nameNode.text });
    }
  }
  return names;
}

function extractDefaultName(node: SN): string | undefined {
  if (node.type === 'identifier') return node.text;
  const named = node.childForFieldName('name');
  if (named) return named.text;
  return undefined;
}
