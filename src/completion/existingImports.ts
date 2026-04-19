import type { ParserLanguage } from '../parsers/base';

export function getAlreadyImportedSymbols(source: string, lang: ParserLanguage): Set<string> {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return parseTsImports(source);
    case 'python':
      return parsePyImports(source);
    case 'java':
      return parseJavaImports(source);
  }
}

function parseTsImports(source: string): Set<string> {
  const names = new Set<string>();
  const regex = /^[\t ]*(?:import|export)\s+(?:type\s+)?(.+?)\s+from\s+['"][^'"]+['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    collectTsSpecifierNames(m[1]!, names);
  }
  return names;
}

function collectTsSpecifierNames(spec: string, out: Set<string>): void {
  const trimmed = spec.trim();
  const braceMatch = /\{([^}]*)\}/.exec(trimmed);
  if (braceMatch) {
    for (const part of braceMatch[1]!.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const mm = /^(\w+)(?:\s+as\s+(\w+))?/.exec(t);
      if (mm) out.add(mm[2] ?? mm[1]!);
    }
  }
  const noBrace = trimmed.replace(/\{[^}]*\}/, '').trim();
  if (!noBrace) return;
  for (const part of noBrace.split(',')) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith('*')) {
      const mm = /\*\s*as\s+(\w+)/.exec(t);
      if (mm) out.add(mm[1]!);
    } else {
      const mm = /^(\w+)/.exec(t);
      if (mm) out.add(mm[1]!);
    }
  }
}

function parsePyImports(source: string): Set<string> {
  const names = new Set<string>();
  const lines = source.split('\n');
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;

    const fromMatch = /^from\s+\S+\s+import\s+(.+)$/.exec(t);
    if (fromMatch) {
      const rest = fromMatch[1]!.trim().replace(/[()]/g, '').replace(/\\\s*$/, '');
      for (const part of rest.split(',')) {
        const p = part.trim();
        if (!p || p === '*') continue;
        const m = /^(\w+)(?:\s+as\s+(\w+))?/.exec(p);
        if (m) names.add(m[2] ?? m[1]!);
      }
      continue;
    }

    const importMatch = /^import\s+(.+)$/.exec(t);
    if (importMatch) {
      for (const part of importMatch[1]!.split(',')) {
        const p = part.trim();
        const m = /^([\w.]+)(?:\s+as\s+(\w+))?/.exec(p);
        if (!m) continue;
        if (m[2]) names.add(m[2]);
        else names.add(m[1]!.split('.')[0]!);
      }
    }
  }
  return names;
}

function parseJavaImports(source: string): Set<string> {
  const names = new Set<string>();
  const regex = /^[\t ]*import\s+(?:static\s+)?([^;]+);/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) {
    const full = m[1]!.trim();
    if (full.endsWith('.*')) continue;
    const idx = full.lastIndexOf('.');
    names.add(idx >= 0 ? full.slice(idx + 1) : full);
  }
  return names;
}
