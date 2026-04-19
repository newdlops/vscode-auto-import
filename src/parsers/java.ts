import type Parser from 'web-tree-sitter';
import { SymbolFlag, SymbolKind, type ExportedSymbol } from '../index/types';
import type { ExtractionResult } from './base';

type SN = Parser.SyntaxNode;

const TYPE_DECLS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

export function extractJava(tree: Parser.Tree, includeInnerClasses: boolean): ExtractionResult {
  const exports: ExportedSymbol[] = [];
  let fileQualifier: string | undefined;
  for (const c of tree.rootNode.namedChildren) {
    if (c.type === 'package_declaration') {
      for (const child of c.namedChildren) {
        if (child.type === 'identifier' || child.type === 'scoped_identifier') {
          fileQualifier = child.text;
          break;
        }
      }
    } else if (TYPE_DECLS.has(c.type)) {
      extractTypeDecl(c, exports, undefined, includeInnerClasses);
    }
  }
  return { exports, reExports: [], fileQualifier };
}

function extractTypeDecl(
  node: SN,
  out: ExportedSymbol[],
  parentQualifier: string | undefined,
  includeInner: boolean,
): void {
  const modifiers = findModifiers(node);
  const isPublic = hasModifier(modifiers, 'public');
  const isStatic = hasModifier(modifiers, 'static');

  if (!isPublic) return;
  if (parentQualifier !== undefined && !isStatic) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;

  out.push({
    name,
    kind: kindFor(node.type),
    flags: parentQualifier !== undefined ? SymbolFlag.InnerClass : SymbolFlag.None,
    parentQualifier,
    line: node.startPosition.row,
    col: node.startPosition.column,
  });

  if (!includeInner) return;

  const body = node.childForFieldName('body');
  if (!body) return;

  const newQualifier = parentQualifier !== undefined ? `${parentQualifier}.${name}` : name;
  for (const member of body.namedChildren) {
    if (TYPE_DECLS.has(member.type)) {
      extractTypeDecl(member, out, newQualifier, includeInner);
    }
  }
}

function findModifiers(node: SN): SN | undefined {
  for (const c of node.children) {
    if (c.type === 'modifiers') return c;
  }
  return undefined;
}

function hasModifier(modifiers: SN | undefined, modifier: string): boolean {
  if (!modifiers) return false;
  for (const m of modifiers.children) {
    if (m.type === modifier) return true;
  }
  return false;
}

function kindFor(nodeType: string): SymbolKind {
  switch (nodeType) {
    case 'interface_declaration':
    case 'annotation_type_declaration':
      return SymbolKind.Interface;
    case 'enum_declaration':
      return SymbolKind.Enum;
    default:
      return SymbolKind.Class;
  }
}
