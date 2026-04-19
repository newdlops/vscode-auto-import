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
    const names = parseNameList(existing.namesText);
    if (names.includes(name)) return [];
    const newNames = [...names, name];
    const newLine = `from ${modulePath} import ${newNames.join(', ')}`;
    return [
      vscode.TextEdit.replace(
        new vscode.Range(doc.positionAt(existing.start), doc.positionAt(existing.end)),
        newLine,
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
  const regex = /^([\t ]*)from\s+(\S+)\s+import\s+([^\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    if (m[2] === modulePath) {
      return { start: m.index, end: m.index + m[0].length, namesText: m[3]! };
    }
  }
  return undefined;
}

function parseNameList(namesText: string): string[] {
  const cleaned = namesText.trim().replace(/[()]/g, '').replace(/\\\s*$/, '');
  return cleaned
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '*');
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
