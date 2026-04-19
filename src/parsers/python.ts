import type Parser from 'web-tree-sitter';
import { SymbolFlag, SymbolKind, type ExportedSymbol } from '../index/types';
import { unquote, type ExtractionResult, type ReExportEntry, type ReExportName } from './base';

type SN = Parser.SyntaxNode;

export function extractPython(tree: Parser.Tree, respectAll: boolean): ExtractionResult {
  const root = tree.rootNode;
  let hasAll = false;
  const allList: string[] = [];
  const candidates: ExportedSymbol[] = [];
  const reExports: ReExportEntry[] = [];

  for (const c of root.namedChildren) {
    if (c.type === 'expression_statement') {
      const inner = c.namedChild(0);
      if (inner?.type === 'assignment') {
        const left = inner.childForFieldName('left');
        if (left && left.type === 'identifier' && left.text === '__all__') {
          hasAll = true;
          collectAllItems(inner.childForFieldName('right'), allList);
          continue;
        }
        if (left && left.type === 'identifier') {
          candidates.push(mkSym(left.text, SymbolKind.Variable, c));
        }
      }
      continue;
    }

    let target = c;
    if (c.type === 'decorated_definition') {
      const def = c.childForFieldName('definition');
      if (def) target = def;
    }

    if (target.type === 'function_definition') {
      const name = target.childForFieldName('name')?.text;
      if (name) candidates.push(mkSym(name, SymbolKind.Function, target));
    } else if (target.type === 'class_definition') {
      const name = target.childForFieldName('name')?.text;
      if (name) candidates.push(mkSym(name, SymbolKind.Class, target));
    } else if (c.type === 'import_from_statement') {
      handleImportFrom(c, reExports);
    }
  }

  let exports: ExportedSymbol[];
  if (respectAll && hasAll) {
    const allow = new Set(allList);
    exports = candidates.filter((s) => allow.has(s.name));
  } else {
    exports = candidates.filter((s) => !s.name.startsWith('_'));
  }
  return { exports, reExports };
}

function handleImportFrom(node: SN, reOut: ReExportEntry[]): void {
  const moduleNode = node.childForFieldName('module_name');
  if (!moduleNode) return;
  const fromPath = moduleNode.text;

  const names: ReExportName[] = [];
  let sawWildcard = false;

  for (const c of node.children) {
    if (c === moduleNode) continue;
    if (c.type === 'wildcard_import' || c.text === '*') {
      sawWildcard = true;
    } else if (c.type === 'dotted_name' && c !== moduleNode) {
      names.push({ exportedName: c.text });
    } else if (c.type === 'aliased_import') {
      const nm = c.childForFieldName('name');
      const al = c.childForFieldName('alias');
      if (nm) {
        names.push({
          exportedName: al?.text ?? nm.text,
          sourceName: al ? nm.text : undefined,
        });
      }
    }
  }

  if (sawWildcard) {
    reOut.push({ fromPath, names: 'all', isTypeOnly: false });
  } else if (names.length > 0) {
    reOut.push({ fromPath, names, isTypeOnly: false });
  }
}

function collectAllItems(node: SN | null, out: string[]): void {
  if (!node) return;
  if (node.type === 'list' || node.type === 'tuple') {
    for (const item of node.namedChildren) {
      if (item.type === 'string') {
        out.push(stringLiteralValue(item));
      }
    }
  }
}

function stringLiteralValue(node: SN): string {
  for (const c of node.namedChildren) {
    if (c.type === 'string_content') return c.text;
  }
  return unquote(node.text);
}

function mkSym(name: string, kind: SymbolKind, node: SN): ExportedSymbol {
  return {
    name,
    kind,
    flags: SymbolFlag.None,
    line: node.startPosition.row,
    col: node.startPosition.column,
  };
}
