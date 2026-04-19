import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../../config';
import { SymbolFlag } from '../../index/types';

export function buildTsImportEdits(
  doc: vscode.TextDocument,
  name: string,
  targetPath: string,
  flags: number,
  config: Config,
): vscode.TextEdit[] {
  const modulePath = toRelativeModule(doc.uri.fsPath, targetPath);
  if (!modulePath) return [];

  const isDefault = (flags & SymbolFlag.DefaultExport) !== 0;
  const policy = config.typescript.preferTypeImports;
  const wantTypeOnly =
    policy === 'always' || (policy === 'auto' && (flags & SymbolFlag.TypeOnly) !== 0);

  const source = doc.getText();

  if (!isDefault) {
    const merge = tryMergeIntoExistingNamed(doc, source, modulePath, name, wantTypeOnly);
    if (merge) return [merge];
  }

  const line = buildImportLine(name, modulePath, isDefault, wantTypeOnly);
  const insertLine = findTsInsertLine(source);
  return [vscode.TextEdit.insert(new vscode.Position(insertLine, 0), line + '\n')];
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

function tryMergeIntoExistingNamed(
  doc: vscode.TextDocument,
  source: string,
  modulePath: string,
  name: string,
  typeOnly: boolean,
): vscode.TextEdit | undefined {
  const esc = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyword = typeOnly ? 'import\\s+type' : 'import(?!\\s+type)';
  const regex = new RegExp(
    `(^[\\t ]*)(${keyword})\\s+\\{([^}]*)\\}(\\s+from\\s+['"])${esc}(['"])\\s*;?`,
    'm',
  );
  const m = regex.exec(source);
  if (!m) return undefined;
  const fullStart = m.index;
  const fullEnd = fullStart + m[0].length;
  const indent = m[1]!;
  const kw = m[2]!;
  const inner = m[3]!.trim();
  const fromQuote = m[4]!;
  const closeQuote = m[5]!;

  const existing = inner
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
    .filter(Boolean);
  if (existing.includes(name)) return undefined;

  const newInner = inner.length > 0 ? `${inner}, ${name}` : name;
  const newLine = `${indent}${kw} { ${newInner} }${fromQuote}${modulePath}${closeQuote};`;
  return vscode.TextEdit.replace(
    new vscode.Range(doc.positionAt(fullStart), doc.positionAt(fullEnd)),
    newLine,
  );
}

function findTsInsertLine(source: string): number {
  const lines = source.split('\n');
  const scan = Math.min(lines.length, 300);
  let lastImport = -1;
  for (let i = 0; i < scan; i++) {
    const t = lines[i]!.trim();
    if (/^(?:import\s|export\s+.*\sfrom\s)/.test(t)) {
      lastImport = i;
      continue;
    }
    if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    if (t.startsWith("'use ") || t.startsWith('"use ')) continue;
    break;
  }
  return lastImport + 1;
}

function toRelativeModule(currentFile: string, targetFile: string): string | undefined {
  if (!targetFile) return undefined;
  let rel = path.relative(path.dirname(currentFile), targetFile);
  if (!rel) return undefined;
  rel = rel.replace(/\\/g, '/');
  rel = rel.replace(/\.d\.ts$/, '').replace(/\.(ts|tsx|mts|cts|jsx|mjs|cjs|js)$/, '');
  rel = rel.replace(/\/index$/, '');
  if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
  return rel;
}
