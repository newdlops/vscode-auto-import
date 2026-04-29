import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../../config';
import { SymbolFlag } from '../../index/types';
import { resolveTsModuleSpecifier } from './tsModuleResolver';
import {
  parseTsImports,
  type ImportStatement,
  type NamedClause,
} from './tsImportParser';

export function buildTsImportEdits(
  doc: vscode.TextDocument,
  name: string,
  targetPath: string,
  moduleSpecifier: string | undefined,
  flags: number,
  config: Config,
): vscode.TextEdit[] {
  const modulePath = pickModuleSpecifier(doc, moduleSpecifier, targetPath);
  if (!modulePath) return [];

  const isDefault = (flags & SymbolFlag.DefaultExport) !== 0;
  const policy = config.typescript.preferTypeImports;
  const wantTypeOnly =
    policy === 'always' || (policy === 'auto' && (flags & SymbolFlag.TypeOnly) !== 0);

  const source = doc.getText();
  const imports = parseTsImports(source);

  if (isDefault) {
    const merged = tryAddDefault(doc, source, imports, modulePath, name);
    if (merged) return [merged];
  } else {
    const merged = tryMergeNamed(doc, source, imports, modulePath, name, wantTypeOnly);
    if (merged) return merged;
  }

  const line = buildImportLine(name, modulePath, isDefault, wantTypeOnly);
  const insertOffset = findTsInsertOffset(source, imports);
  return [vscode.TextEdit.insert(doc.positionAt(insertOffset), line + '\n')];
}

function pickModuleSpecifier(
  doc: vscode.TextDocument,
  moduleSpecifier: string | undefined,
  targetPath: string,
): string | undefined {
  if (moduleSpecifier && moduleSpecifier.length > 0) return moduleSpecifier;
  return resolveTsModuleSpecifier(doc.uri.fsPath, targetPath);
}

function buildImportLine(
  name: string,
  modulePath: string,
  isDefault: boolean,
  typeOnly: boolean,
): string {
  const kw = typeOnly ? 'import type' : 'import';
  if (isDefault) return `${kw} ${name} from '${modulePath}';`;
  return `${kw} { ${name} } from '${modulePath}';`;
}

function tryMergeNamed(
  doc: vscode.TextDocument,
  source: string,
  imports: ImportStatement[],
  modulePath: string,
  name: string,
  wantTypeOnly: boolean,
): vscode.TextEdit[] | undefined {
  const candidates = imports.filter((s) => s.moduleSpecifier === modulePath);
  if (candidates.length === 0) return undefined;

  for (const stmt of candidates) {
    if (stmt.clause.named) {
      const dup = stmt.clause.named.items.find((it) => it.local === name);
      if (dup) return [];
    }
    if (stmt.clause.defaultName === name) return [];
    if (stmt.clause.namespaceName === name) return [];
  }

  const exact = candidates.find((s) => s.clause.typeOnly === wantTypeOnly && s.clause.named);
  if (exact) {
    return mergeIntoNamedClause(doc, source, exact, name);
  }

  const sameTypeWithDefaultOnly = candidates.find(
    (s) => s.clause.typeOnly === wantTypeOnly && !s.clause.named && s.clause.defaultName,
  );
  if (sameTypeWithDefaultOnly) {
    return addNamedClauseToExisting(doc, source, sameTypeWithDefaultOnly, name);
  }

  return undefined;
}

function tryAddDefault(
  doc: vscode.TextDocument,
  source: string,
  imports: ImportStatement[],
  modulePath: string,
  name: string,
): vscode.TextEdit | undefined {
  const candidates = imports.filter(
    (s) => s.moduleSpecifier === modulePath && !s.clause.typeOnly,
  );
  for (const stmt of candidates) {
    if (stmt.clause.defaultName === name) return undefined;
    if (!stmt.clause.defaultName) {
      return insertDefaultIntoStatement(doc, source, stmt, name);
    }
  }
  return undefined;
}

function mergeIntoNamedClause(
  doc: vscode.TextDocument,
  source: string,
  stmt: ImportStatement,
  name: string,
): vscode.TextEdit[] | undefined {
  const named = stmt.clause.named;
  if (!named) return undefined;
  if (named.items.some((it) => it.local === name)) return [];

  const newClause = buildNamedClauseReplacement(source, named, name);
  const before = source.slice(stmt.start, named.open);
  const after = source.slice(named.close + 1, stmt.end);
  const replacement = `${before}${newClause}${after}`;
  return [
    vscode.TextEdit.replace(
      new vscode.Range(doc.positionAt(stmt.start), doc.positionAt(stmt.end)),
      replacement,
    ),
  ];
}

function buildNamedClauseReplacement(
  source: string,
  named: NamedClause,
  name: string,
): string {
  const newSpec = name;

  if (named.items.length === 0) {
    if (named.multiline) {
      const indent = named.innerIndent;
      const closeIndent = named.closeIndent;
      return `{\n${indent}${newSpec},\n${closeIndent}}`;
    }
    return `{ ${newSpec} }`;
  }

  if (!named.multiline) {
    const lastItem = named.items[named.items.length - 1]!;
    const inner = source.slice(named.open + 1, named.close);
    const trailing = source.slice(lastItem.end, named.close);
    const hasTrailingComma = /,\s*$/.test(trailing);
    const trimmedInner = inner.replace(/\s+$/, '');
    if (hasTrailingComma) {
      return `{${trimmedInner} ${newSpec} }`;
    }
    return `{${trimmedInner}, ${newSpec} }`;
  }

  const lastItem = named.items[named.items.length - 1]!;
  const beforeLast = source.slice(named.open + 1, lastItem.end);
  const afterLast = source.slice(lastItem.end, named.close);
  const indent = named.innerIndent;
  const closeIndent = named.closeIndent;
  const hasTrailingComma = /,/.test(afterLast.split('\n')[0] ?? '');

  const head = beforeLast + ',';
  const newLine = hasTrailingComma ? `\n${indent}${newSpec},` : `\n${indent}${newSpec}`;
  const tail = `\n${closeIndent}`;
  return `{${head}${newLine}${tail}}`;
}

function addNamedClauseToExisting(
  doc: vscode.TextDocument,
  source: string,
  stmt: ImportStatement,
  name: string,
): vscode.TextEdit[] | undefined {
  if (!stmt.clause.defaultName) return undefined;
  const insertAt = findOffsetAfterDefault(source, stmt);
  if (insertAt === undefined) return undefined;
  return [vscode.TextEdit.insert(doc.positionAt(insertAt), `, { ${name} }`)];
}

function findOffsetAfterDefault(source: string, stmt: ImportStatement): number | undefined {
  if (!stmt.clause.defaultName) return undefined;
  const slice = source.slice(stmt.start, stmt.moduleStart);
  const re = new RegExp(`\\b${escape(stmt.clause.defaultName)}\\b`);
  const m = re.exec(slice);
  if (!m) return undefined;
  return stmt.start + m.index + m[0].length;
}

function insertDefaultIntoStatement(
  doc: vscode.TextDocument,
  source: string,
  stmt: ImportStatement,
  name: string,
): vscode.TextEdit | undefined {
  if (stmt.clause.namespaceName) return undefined;
  const named = stmt.clause.named;
  if (named) {
    const importKwEnd = stmt.start + 'import'.length;
    return vscode.TextEdit.insert(doc.positionAt(importKwEnd), ` ${name},`);
  }
  return undefined;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findTsInsertOffset(source: string, imports: ImportStatement[]): number {
  if (imports.length === 0) {
    return findTopOfFileOffset(source);
  }
  const last = imports[imports.length - 1]!;
  let off = last.end;
  while (off < source.length && (source[off] === ' ' || source[off] === '\t')) off++;
  if (source[off] === '\n') off++;
  return off;
}

function findTopOfFileOffset(source: string): number {
  let i = 0;
  if (source.charCodeAt(0) === 0xfeff) i = 1;
  if (source.startsWith('#!', i)) {
    const nl = source.indexOf('\n', i);
    i = nl === -1 ? source.length : nl + 1;
  }
  while (i < source.length) {
    const lineEnd = source.indexOf('\n', i);
    const line = source.slice(i, lineEnd === -1 ? source.length : lineEnd);
    const trimmed = line.trim();
    if (
      trimmed === '' ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*') ||
      trimmed.startsWith("'use ") ||
      trimmed.startsWith('"use ')
    ) {
      i = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    break;
  }
  return i;
}
