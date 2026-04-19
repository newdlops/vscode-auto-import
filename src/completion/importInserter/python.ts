import * as vscode from 'vscode';

export function buildPythonImportEdits(
  doc: vscode.TextDocument,
  name: string,
  modulePath: string,
): vscode.TextEdit[] {
  if (!modulePath) return [];
  const source = doc.getText();

  const existing = findExistingFromImport(source, modulePath);
  if (existing) {
    const rawNames = isParenForm(existing.namesText)
      ? stripParens(existing.namesText)
      : existing.namesText;
    if (parseNameList(rawNames).includes(name)) return [];

    const replacement = rebuildFromImport(modulePath, existing.namesText, name);
    return [
      vscode.TextEdit.replace(
        new vscode.Range(doc.positionAt(existing.start), doc.positionAt(existing.end)),
        replacement,
      ),
    ];
  }

  const line = `from ${modulePath} import ${name}`;
  const insertLine = findPyInsertLine(source);
  return [vscode.TextEdit.insert(new vscode.Position(insertLine, 0), line + '\n')];
}

interface ExistingImport {
  start: number;
  end: number;
  namesText: string;
}

function findExistingFromImport(source: string, modulePath: string): ExistingImport | undefined {
  const regex = /^([\t ]*)from\s+(\S+)\s+import\s+(\([\s\S]*?\)|[^\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (m[2] === modulePath) {
      return { start: m.index, end: m.index + m[0].length, namesText: m[3]! };
    }
  }
  return undefined;
}

function isParenForm(namesText: string): boolean {
  return namesText.trimStart().startsWith('(');
}

function stripParens(namesText: string): string {
  const trimmed = namesText.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return trimmed.slice(1, -1);
  }
  return namesText;
}

function parseNameList(namesText: string): string[] {
  return namesText
    .replace(/\\\s*$/gm, '')
    .split(',')
    .map((s) => s.trim())
    .map((s) => s.split(/\s+as\s+/)[0]!.trim())
    .filter((s) => s.length > 0 && s !== '*');
}

function rebuildFromImport(modulePath: string, namesText: string, name: string): string {
  const paren = isParenForm(namesText);
  const multiLine = namesText.includes('\n');

  if (paren && multiLine) {
    return `from ${modulePath} import ${insertParenMultiLine(namesText, name)}`;
  }
  if (paren) {
    const inner = stripParens(namesText).trim().replace(/,\s*$/, '');
    const merged = inner.length > 0 ? `${inner}, ${name}` : name;
    return `from ${modulePath} import (${merged})`;
  }
  const inner = namesText.trim().replace(/,\s*$/, '');
  const merged = inner.length > 0 ? `${inner}, ${name}` : name;
  return `from ${modulePath} import ${merged}`;
}

function insertParenMultiLine(parensText: string, name: string): string {
  const lines = parensText.split('\n');
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed === '' || trimmed === '(' || trimmed === ')') continue;
    lastIdx = i;
    break;
  }
  if (lastIdx < 0) {
    const indent = detectParenIndent(lines) ?? '    ';
    return `(\n${indent}${name},\n)`;
  }

  const lastLine = lines[lastIdx]!;
  const leadingMatch = lastLine.match(/^(\s*)/);
  const nameIndent = leadingMatch ? leadingMatch[1]! : '    ';
  const hasTrailingComma = lastLine.trimEnd().endsWith(',');

  const mutated = [...lines];
  if (hasTrailingComma) {
    mutated.splice(lastIdx + 1, 0, `${nameIndent}${name},`);
  } else {
    mutated[lastIdx] = `${lastLine},`;
    mutated.splice(lastIdx + 1, 0, `${nameIndent}${name}`);
  }
  return mutated.join('\n');
}

function detectParenIndent(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = line.match(/^(\s+)\S/);
    if (match) return match[1];
  }
  return undefined;
}

function findPyInsertLine(source: string): number {
  const lines = source.split('\n');
  const scan = Math.min(lines.length, 300);
  let lastImport = -1;
  let inDocstring = false;
  let quoteChar = '';
  for (let i = 0; i < scan; i++) {
    const t = lines[i]!.trim();

    if (inDocstring) {
      if (t.includes(quoteChar)) inDocstring = false;
      continue;
    }

    if (!t || t.startsWith('#')) continue;

    if (t.startsWith('"""') || t.startsWith("'''")) {
      quoteChar = t.startsWith('"""') ? '"""' : "'''";
      if (t.length >= 6 && t.endsWith(quoteChar)) continue;
      inDocstring = true;
      continue;
    }

    if (/^(?:import\s|from\s)/.test(t)) {
      lastImport = i;
      continue;
    }
    break;
  }
  return lastImport + 1;
}
