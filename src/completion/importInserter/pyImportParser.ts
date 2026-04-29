// Robust character-based parser for Python `import` and `from ... import ...`
// statements. Used by both the Python import inserter (to merge new names
// into an existing `from MODULE import ...` block) and the existing-imports
// detector (to know which names are already imported).
//
// The parser handles:
//   - Plain `import a` and `import a, b as c`
//   - `from MODULE import a, b as c`
//   - Parenthesized multi-line lists, including comments and trailing commas
//   - Backslash line continuations
//   - Relative imports (`from .pkg import x`)
//   - Module-level docstrings (skipped)

export interface PyImportItem {
  imported: string;
  local: string;
  start: number;
  end: number;
}

export interface PyImportStatement {
  start: number;
  end: number;
  kind: 'from' | 'plain';
  fromModule?: string;
  fromModuleStart?: number;
  fromModuleEnd?: number;
  namesStart?: number;
  namesEnd?: number;
  parenOpen?: number;
  parenClose?: number;
  items: PyImportItem[];
}

export function parsePyImports(source: string): PyImportStatement[] {
  const out: PyImportStatement[] = [];
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < source.length) {
    const next = skipTopLevelNonImport(source, i);
    if (next === undefined) break;
    i = next;
    if (i >= source.length) break;
    if (!isAtLineStart(source, i)) break;

    const ident = readPyIdent(source, i);
    if (!ident) break;
    if (ident.value === 'from') {
      const stmt = parseFromStatement(source, i);
      if (!stmt) break;
      out.push(stmt);
      i = stmt.end;
      continue;
    }
    if (ident.value === 'import') {
      const stmt = parsePlainImport(source, i);
      if (!stmt) break;
      out.push(stmt);
      i = stmt.end;
      continue;
    }
    break;
  }

  return out;
}

export function parsePyImportNames(source: string): Set<string> {
  const out = new Set<string>();
  for (const stmt of parsePyImports(source)) {
    for (const item of stmt.items) out.add(item.local);
  }
  return out;
}

function skipTopLevelNonImport(s: string, start: number): number | undefined {
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      // Skip module-level string literal (typical docstring)
      const stringEnd = skipPyStringLiteral(s, i);
      if (stringEnd === undefined) return undefined;
      i = stringEnd;
      continue;
    }
    return i;
  }
  return i;
}

function skipPyStringLiteral(s: string, i: number): number | undefined {
  const quote = s[i];
  if (quote !== '"' && quote !== "'") return undefined;
  // Triple-quoted?
  if (s[i + 1] === quote && s[i + 2] === quote) {
    let j = i + 3;
    while (j < s.length) {
      if (s[j] === quote && s[j + 1] === quote && s[j + 2] === quote) {
        return j + 3;
      }
      if (s[j] === '\\' && j + 1 < s.length) {
        j += 2;
        continue;
      }
      j++;
    }
    return undefined;
  }
  // Single-line string
  let j = i + 1;
  while (j < s.length && s[j] !== quote && s[j] !== '\n') {
    if (s[j] === '\\' && j + 1 < s.length) {
      j += 2;
      continue;
    }
    j++;
  }
  if (s[j] === quote) return j + 1;
  return undefined;
}

function parseFromStatement(s: string, fromOffset: number): PyImportStatement | undefined {
  let i = fromOffset + 'from'.length;
  i = skipInlineWs(s, i, false);

  const modStart = i;
  while (s[i] === '.') i++;
  while (i < s.length) {
    const id = readPyIdent(s, i);
    if (!id) break;
    i = id.end;
    if (s[i] === '.') {
      i++;
      continue;
    }
    break;
  }
  const modEnd = i;
  if (modEnd === modStart) return undefined;
  const fromModule = s.slice(modStart, modEnd);

  i = skipInlineWs(s, i, false);
  const importKw = readPyIdent(s, i);
  if (importKw?.value !== 'import') return undefined;
  i = importKw.end;
  i = skipInlineWs(s, i, false);

  const isParens = s[i] === '(';
  let parenOpen: number | undefined;
  let parenClose: number | undefined;
  if (isParens) {
    parenOpen = i;
    i++;
  }

  const namesStart = i;
  const items: PyImportItem[] = [];

  while (i < s.length) {
    i = skipImportTrivia(s, i, isParens);
    if (i >= s.length) break;
    const c = s[i];
    if (isParens && c === ')') {
      parenClose = i;
      i++;
      break;
    }
    if (!isParens && (c === '\n' || c === '\r' || c === ';')) break;
    if (c === ',') {
      i++;
      continue;
    }
    if (c === '*') {
      i++;
      i = skipImportTrivia(s, i, isParens);
      continue;
    }

    const itemStart = i;
    const id = readPyIdent(s, i);
    if (!id) {
      i++;
      continue;
    }
    let imported = id.value;
    let local = imported;
    i = id.end;
    i = skipImportTrivia(s, i, isParens);

    const asKw = readPyIdent(s, i);
    if (asKw?.value === 'as') {
      i = asKw.end;
      i = skipImportTrivia(s, i, isParens);
      const alias = readPyIdent(s, i);
      if (alias) {
        local = alias.value;
        i = alias.end;
      }
    }

    items.push({ imported, local, start: itemStart, end: i });
  }

  const namesEnd = isParens ? parenClose ?? i : i;

  let end = i;
  end = skipInlineWs(s, end, false);
  if (s[end] === ';') end++;

  return {
    start: fromOffset,
    end,
    kind: 'from',
    fromModule,
    fromModuleStart: modStart,
    fromModuleEnd: modEnd,
    namesStart,
    namesEnd,
    parenOpen,
    parenClose,
    items,
  };
}

function parsePlainImport(s: string, importOffset: number): PyImportStatement | undefined {
  let i = importOffset + 'import'.length;
  i = skipInlineWs(s, i, false);

  const items: PyImportItem[] = [];
  while (i < s.length) {
    i = skipImportTrivia(s, i, false);
    const c = s[i];
    if (c === '\n' || c === '\r' || c === ';' || c === undefined) break;
    if (c === ',') {
      i++;
      continue;
    }

    const itemStart = i;
    const dotted = readPyDottedName(s, i);
    if (!dotted) {
      i++;
      continue;
    }
    const importedFull = dotted.value;
    let local = importedFull.split('.')[0]!;
    i = dotted.end;
    i = skipImportTrivia(s, i, false);

    const asKw = readPyIdent(s, i);
    if (asKw?.value === 'as') {
      i = asKw.end;
      i = skipImportTrivia(s, i, false);
      const alias = readPyIdent(s, i);
      if (alias) {
        local = alias.value;
        i = alias.end;
      }
    }

    items.push({ imported: importedFull, local, start: itemStart, end: i });
  }

  let end = i;
  end = skipInlineWs(s, end, false);
  if (s[end] === ';') end++;

  return {
    start: importOffset,
    end,
    kind: 'plain',
    items,
  };
}

function readPyDottedName(s: string, i: number): { value: string; end: number } | undefined {
  const first = readPyIdent(s, i);
  if (!first) return undefined;
  let j = first.end;
  let value = first.value;
  while (s[j] === '.') {
    const next = readPyIdent(s, j + 1);
    if (!next) break;
    value += '.' + next.value;
    j = next.end;
  }
  return { value, end: j };
}

function readPyIdent(s: string, i: number): { value: string; end: number } | undefined {
  const c = s[i];
  if (c === undefined) return undefined;
  if (!isIdentStart(c)) return undefined;
  let j = i + 1;
  while (j < s.length && isIdentPart(s[j]!)) j++;
  return { value: s.slice(i, j), end: j };
}

function skipInlineWs(s: string, i: number, allowNewline: boolean): number {
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && (s[i + 1] === '\n' || s[i + 1] === '\r')) {
      i += 2;
      if (s[i - 1] === '\r' && s[i] === '\n') i++;
      continue;
    }
    if (allowNewline && (c === '\n' || c === '\r')) {
      i++;
      continue;
    }
    return i;
  }
  return i;
}

function skipImportTrivia(s: string, i: number, inParens: boolean): number {
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && (s[i + 1] === '\n' || s[i + 1] === '\r')) {
      i += 2;
      if (s[i - 1] === '\r' && s[i] === '\n') i++;
      continue;
    }
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      if (!inParens) return i;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (inParens) {
        i++;
        continue;
      }
      return i;
    }
    return i;
  }
  return i;
}

function isAtLineStart(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0) {
    const c = s[j];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t') return false;
    j--;
  }
  return true;
}

function isIdentStart(c: string): boolean {
  return (
    (c >= 'A' && c <= 'Z') ||
    (c >= 'a' && c <= 'z') ||
    c === '_'
  );
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}
