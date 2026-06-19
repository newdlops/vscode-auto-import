import * as vscode from 'vscode';
import { SymbolFlag } from '../../index/types';
import { parsePyImports, type PyImportStatement } from './pyImportParser';

export function buildPythonImportEdits(
  doc: vscode.TextDocument,
  name: string,
  modulePath: string,
  flags = 0,
): vscode.TextEdit[] {
  if (!modulePath) return [];
  const source = doc.getText();
  const stmts = parsePyImports(source);

  if ((flags & SymbolFlag.ModuleImport) !== 0) {
    if (stmts.some((s) => s.kind === 'plain' && s.items.some((it) => it.local === name))) {
      return [];
    }
    const insertOffset = findPyInsertOffset(source, stmts);
    return [vscode.TextEdit.insert(doc.positionAt(insertOffset), `import ${modulePath}\n`)];
  }

  const existing = stmts.find((s) => s.kind === 'from' && s.fromModule === modulePath);
  if (existing) {
    if (existing.items.some((it) => it.local === name)) return [];
    return [buildMergeEdit(doc, source, existing, name)];
  }

  const insertOffset = findPyInsertOffset(source, stmts);
  const line = `from ${modulePath} import ${name}`;
  return [vscode.TextEdit.insert(doc.positionAt(insertOffset), line + '\n')];
}

function buildMergeEdit(
  doc: vscode.TextDocument,
  source: string,
  stmt: PyImportStatement,
  name: string,
): vscode.TextEdit {
  const head = `from ${stmt.fromModule!} import `;
  let replacement: string;
  if (stmt.parenOpen !== undefined && stmt.parenClose !== undefined) {
    const inner = source.slice(stmt.parenOpen + 1, stmt.parenClose);
    replacement = `${head}(${mergeParenForm(inner, name)})`;
  } else {
    const inner = source.slice(stmt.namesStart!, stmt.namesEnd!);
    replacement = `${head}${mergeFlatForm(inner, name)}`;
  }

  let endOff = stmt.end;
  if (source[endOff - 1] === ';') endOff -= 1;

  return vscode.TextEdit.replace(
    new vscode.Range(doc.positionAt(stmt.start), doc.positionAt(endOff)),
    replacement,
  );
}

function mergeFlatForm(inner: string, name: string): string {
  const trimmedRight = inner.replace(/[\s\\]+$/, '');
  const trimmed = trimmedRight.replace(/,\s*$/, '');
  if (trimmed.length === 0) return name;
  return `${trimmed}, ${name}`;
}

function mergeParenForm(inner: string, name: string): string {
  if (!inner.includes('\n')) {
    const trimmed = inner.trim().replace(/,\s*$/, '');
    if (trimmed.length === 0) return name;
    return `${trimmed}, ${name}`;
  }

  const lines = inner.split('\n');
  let lastContentIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = stripPyComment(lines[i]!).trim();
    if (t.length === 0) continue;
    lastContentIdx = i;
    break;
  }

  const indent = detectInnerIndent(lines) ?? '    ';

  if (lastContentIdx < 0) {
    const closingIndent = detectClosingIndent(lines);
    return `\n${indent}${name},\n${closingIndent}`;
  }

  const lastLine = lines[lastContentIdx]!;
  const stripped = stripPyComment(lastLine);
  const trailingComma = /,\s*$/.test(stripped);
  const mutated = lines.slice();

  if (trailingComma) {
    mutated.splice(lastContentIdx + 1, 0, `${indent}${name},`);
  } else {
    const trimmedEnd = lastLine.replace(/\s+$/, '');
    mutated[lastContentIdx] = `${trimmedEnd},`;
    mutated.splice(lastContentIdx + 1, 0, `${indent}${name}`);
  }

  return mutated.join('\n');
}

function stripPyComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (!inDouble && c === "'") inSingle = !inSingle;
    else if (!inSingle && c === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && c === '#') return line.slice(0, i);
  }
  return line;
}

function detectInnerIndent(lines: string[]): string | undefined {
  for (const line of lines) {
    const m = line.match(/^([ \t]+)\S/);
    if (m) return m[1];
  }
  return undefined;
}

function detectClosingIndent(lines: string[]): string {
  const last = lines[lines.length - 1] ?? '';
  const m = last.match(/^([ \t]*)$/);
  return m ? m[1]! : '';
}

function findPyInsertOffset(source: string, stmts: PyImportStatement[]): number {
  if (stmts.length > 0) {
    const last = stmts[stmts.length - 1]!;
    let off = last.end;
    while (off < source.length && (source[off] === ' ' || source[off] === '\t')) off++;
    if (source[off] === '\r') off++;
    if (source[off] === '\n') off++;
    return off;
  }

  const lines = source.split('\n');
  let inDocstring = false;
  let quoteChar = '';
  let cursor = 0;
  for (const raw of lines) {
    const lineLength = raw.length + 1;
    const t = raw.trim();
    if (inDocstring) {
      if (t.includes(quoteChar)) inDocstring = false;
      cursor += lineLength;
      continue;
    }
    if (!t || t.startsWith('#')) {
      cursor += lineLength;
      continue;
    }
    if (t.startsWith('"""') || t.startsWith("'''")) {
      quoteChar = t.startsWith('"""') ? '"""' : "'''";
      if (t.length >= 6 && t.endsWith(quoteChar)) {
        cursor += lineLength;
        continue;
      }
      inDocstring = true;
      cursor += lineLength;
      continue;
    }
    return cursor;
  }
  return source.length;
}
