import type { ParserLanguage } from '../parsers/base';
import { collectImportedNames, parseTsImports } from './importInserter/tsImportParser';
import { parsePyImportNames } from './importInserter/pyImportParser';

export function getAlreadyImportedSymbols(source: string, lang: ParserLanguage): Set<string> {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return collectImportedNames(parseTsImports(source));
    case 'python':
      return parsePyImportNames(source);
    case 'java':
      return parseJavaImports(source);
  }
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
