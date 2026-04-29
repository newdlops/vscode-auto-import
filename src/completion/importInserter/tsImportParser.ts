// Robust character-based parser for TypeScript / JavaScript ECMAScript import
// statements. Used by both the import inserter (to merge new specifiers into
// an existing import block) and the existing-imports detector (to know which
// names are already imported).
//
// The parser scans the top of the file as long as it sees imports, comments,
// blank lines, and directive prologues. It stops at the first non-import
// top-level construct. This matches the structure of well-formed ES modules
// (where `import` declarations must appear at module scope, not inside
// functions).

export interface NamedSpecifier {
  imported: string;
  local: string;
  inlineType: boolean;
  start: number;
  end: number;
}

export interface NamedClause {
  open: number;
  close: number;
  items: NamedSpecifier[];
  multiline: boolean;
  innerIndent: string;
  closeIndent: string;
}

export interface ImportClause {
  typeOnly: boolean;
  defaultName?: string;
  namespaceName?: string;
  named?: NamedClause;
}

export interface ImportStatement {
  start: number;
  end: number;
  indent: string;
  clause: ImportClause;
  moduleSpecifier: string;
  moduleStart: number;
  moduleEnd: number;
  quote: '"' | "'";
  hasSemicolon: boolean;
}

export function parseTsImports(source: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  let i = 0;

  if (source.charCodeAt(0) === 0xfeff) i = 1;
  if (source.startsWith('#!', i)) {
    const nl = source.indexOf('\n', i);
    i = nl === -1 ? source.length : nl + 1;
  }

  while (i < source.length) {
    const after = skipTrivia(source, i);
    if (after >= source.length) break;

    if (source[after] === '"' || source[after] === "'") {
      const str = readString(source, after);
      if (str) {
        let end = skipInlineSpace(source, str.end);
        if (source[end] === ';') end++;
        i = end;
        continue;
      }
    }

    const ident = readIdent(source, after);
    if (!ident || ident.value !== 'import') break;

    const stmt = parseImportAt(source, after);
    if (!stmt) break;
    out.push(stmt);
    i = stmt.end;
  }

  return out;
}

export function collectImportedNames(stmts: ImportStatement[]): Set<string> {
  const names = new Set<string>();
  for (const s of stmts) {
    if (s.clause.defaultName) names.add(s.clause.defaultName);
    if (s.clause.namespaceName) names.add(s.clause.namespaceName);
    if (s.clause.named) {
      for (const item of s.clause.named.items) names.add(item.local);
    }
  }
  return names;
}

function parseImportAt(source: string, importStart: number): ImportStatement | undefined {
  const lineStart = findLineStart(source, importStart);
  const indent = source.slice(lineStart, importStart);
  let i = importStart + 'import'.length;
  i = skipTrivia(source, i);

  let typeOnly = false;
  const typeIdent = readIdent(source, i);
  if (typeIdent && typeIdent.value === 'type') {
    const nextStart = skipTrivia(source, typeIdent.end);
    const next = readIdent(source, nextStart);
    if (next?.value !== 'from') {
      typeOnly = true;
      i = typeIdent.end;
      i = skipTrivia(source, i);
    }
  }

  if (source[i] === '"' || source[i] === "'") {
    const str = readString(source, i);
    if (!str) return undefined;
    let end = skipInlineSpace(source, str.end);
    const semi = source[end] === ';';
    if (semi) end++;
    return {
      start: importStart,
      end,
      indent,
      clause: { typeOnly },
      moduleSpecifier: str.value,
      moduleStart: i,
      moduleEnd: str.end,
      quote: str.quote as '"' | "'",
      hasSemicolon: semi,
    };
  }

  const clause: ImportClause = { typeOnly };

  const defaultIdent = readIdent(source, i);
  if (defaultIdent && defaultIdent.value !== 'from' && defaultIdent.value !== 'type') {
    clause.defaultName = defaultIdent.value;
    i = defaultIdent.end;
    i = skipTrivia(source, i);
    if (source[i] === ',') {
      i++;
      i = skipTrivia(source, i);
    }
  }

  if (source[i] === '*') {
    i++;
    i = skipTrivia(source, i);
    const asKw = readIdent(source, i);
    if (asKw?.value === 'as') {
      i = asKw.end;
      i = skipTrivia(source, i);
      const name = readIdent(source, i);
      if (name) {
        clause.namespaceName = name.value;
        i = name.end;
      }
    }
    i = skipTrivia(source, i);
  } else if (source[i] === '{') {
    const named = parseNamedClause(source, i);
    if (!named) return undefined;
    clause.named = named;
    i = named.close + 1;
    i = skipTrivia(source, i);
  }

  const fromKw = readIdent(source, i);
  if (fromKw?.value !== 'from') return undefined;
  i = fromKw.end;
  i = skipTrivia(source, i);

  const str = readString(source, i);
  if (!str) return undefined;

  let end = skipInlineSpace(source, str.end);
  const hasSemicolon = source[end] === ';';
  if (hasSemicolon) end++;

  return {
    start: importStart,
    end,
    indent,
    clause,
    moduleSpecifier: str.value,
    moduleStart: i,
    moduleEnd: str.end,
    quote: str.quote as '"' | "'",
    hasSemicolon,
  };
}

function parseNamedClause(source: string, openIdx: number): NamedClause | undefined {
  if (source[openIdx] !== '{') return undefined;
  let i = openIdx + 1;
  const items: NamedSpecifier[] = [];

  while (i < source.length) {
    i = skipTrivia(source, i);
    if (source[i] === '}') break;
    if (source[i] === ',') {
      i++;
      continue;
    }
    if (i >= source.length) return undefined;

    const itemStart = i;
    let inlineType = false;
    const maybeType = readIdent(source, i);
    if (maybeType && maybeType.value === 'type') {
      const peekStart = skipTrivia(source, maybeType.end);
      const peekChar = source[peekStart];
      const peekIdent = readIdent(source, peekStart);
      const isTypeKeyword =
        peekIdent !== undefined &&
        peekIdent.value !== 'as' &&
        peekChar !== ',' &&
        peekChar !== '}';
      if (isTypeKeyword) {
        inlineType = true;
        i = maybeType.end;
        i = skipTrivia(source, i);
      }
    }

    const name = readIdent(source, i);
    if (!name) return undefined;
    const imported = name.value;
    let local = name.value;
    let itemEnd = name.end;
    i = name.end;
    i = skipTrivia(source, i);

    const asKw = readIdent(source, i);
    if (asKw?.value === 'as') {
      i = asKw.end;
      i = skipTrivia(source, i);
      const aliasNode = readIdent(source, i);
      if (!aliasNode) return undefined;
      local = aliasNode.value;
      i = aliasNode.end;
      itemEnd = aliasNode.end;
    }

    items.push({ imported, local, inlineType, start: itemStart, end: itemEnd });
  }

  if (source[i] !== '}') return undefined;
  const close = i;
  const inner = source.slice(openIdx + 1, close);
  const multiline = inner.includes('\n');
  let innerIndent = '  ';
  let closeIndent = '';

  if (multiline) {
    if (items.length > 0) {
      const firstItem = items[0]!;
      const lineStartOfItem = findLineStart(source, firstItem.start);
      innerIndent = source.slice(lineStartOfItem, firstItem.start);
    } else {
      const firstNl = source.indexOf('\n', openIdx);
      if (firstNl >= 0 && firstNl < close) {
        const probeLineEnd = source.indexOf('\n', firstNl + 1);
        const probeStart = firstNl + 1;
        const probeEnd = probeLineEnd === -1 ? close : Math.min(probeLineEnd, close);
        const probeLine = source.slice(probeStart, probeEnd);
        const wsMatch = probeLine.match(/^(\s+)/);
        if (wsMatch) innerIndent = wsMatch[1]!;
      }
    }
    const closeLineStart = findLineStart(source, close);
    closeIndent = source.slice(closeLineStart, close);
    if (!/^\s*$/.test(closeIndent)) closeIndent = '';
  }

  return { open: openIdx, close, items, multiline, innerIndent, closeIndent };
}

function skipTrivia(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      if (i + 1 < s.length) i += 2;
      else i = s.length;
      continue;
    }
    return i;
  }
  return i;
}

function skipInlineSpace(s: string, i: number): number {
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end === -1) return s.length;
      i = end + 2;
      continue;
    }
    return i;
  }
  return i;
}

function readString(
  s: string,
  i: number,
): { value: string; quote: string; end: number } | undefined {
  const quote = s[i];
  if (quote !== '"' && quote !== "'") return undefined;
  let j = i + 1;
  let value = '';
  while (j < s.length && s[j] !== quote) {
    if (s[j] === '\n') return undefined;
    if (s[j] === '\\') {
      const next = s[j + 1];
      if (next === undefined) return undefined;
      value += next;
      j += 2;
      continue;
    }
    value += s[j];
    j++;
  }
  if (s[j] !== quote) return undefined;
  return { value, quote, end: j + 1 };
}

function readIdent(s: string, i: number): { value: string; end: number } | undefined {
  const c = s[i];
  if (c === undefined) return undefined;
  if (!isIdentStart(c)) return undefined;
  let j = i + 1;
  while (j < s.length && isIdentPart(s[j]!)) j++;
  return { value: s.slice(i, j), end: j };
}

function isIdentStart(c: string): boolean {
  return (
    (c >= 'A' && c <= 'Z') ||
    (c >= 'a' && c <= 'z') ||
    c === '_' ||
    c === '$'
  );
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

function findLineStart(s: string, idx: number): number {
  let j = idx;
  while (j > 0 && s[j - 1] !== '\n') j--;
  return j;
}
