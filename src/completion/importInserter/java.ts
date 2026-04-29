import * as vscode from 'vscode';

export function buildJavaImportEdits(
  doc: vscode.TextDocument,
  name: string,
  packageName: string,
  parentQualifier: string | undefined,
): vscode.TextEdit[] {
  if (!packageName && !parentQualifier) return [];

  const fqcn = packageName
    ? parentQualifier
      ? `${packageName}.${parentQualifier}.${name}`
      : `${packageName}.${name}`
    : parentQualifier
      ? `${parentQualifier}.${name}`
      : name;

  const source = doc.getText();
  if (
    new RegExp(`^[\\t ]*import\\s+(?:static\\s+)?${escapeRegex(fqcn)};`, 'm').test(source)
  ) {
    return [];
  }
  if (
    packageName &&
    new RegExp(`^[\\t ]*import\\s+${escapeRegex(packageName)}\\.\\*;`, 'm').test(source)
  ) {
    return [];
  }

  const { line, prefixBlank } = findJavaInsertLine(source);
  const text = prefixBlank ? `\nimport ${fqcn};\n` : `import ${fqcn};\n`;
  return [vscode.TextEdit.insert(new vscode.Position(line, 0), text)];
}

function findJavaInsertLine(source: string): { line: number; prefixBlank: boolean } {
  const lines = source.split('\n');
  const scan = Math.min(lines.length, 300);
  let lastImport = -1;
  let packageLine = -1;
  for (let i = 0; i < scan; i++) {
    const t = lines[i]!.trim();
    if (t.startsWith('package ')) {
      packageLine = i;
      continue;
    }
    if (t.startsWith('import ')) {
      lastImport = i;
      continue;
    }
    if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    break;
  }
  if (lastImport >= 0) return { line: lastImport + 1, prefixBlank: false };
  if (packageLine >= 0) {
    const next = lines[packageLine + 1]?.trim() ?? '';
    return { line: packageLine + 1, prefixBlank: next !== '' };
  }
  return { line: 0, prefixBlank: false };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
