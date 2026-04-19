import type { ExportedSymbol } from '../index/types';

export type ParserLanguage = 'typescript' | 'javascript' | 'python' | 'java';

export interface ReExportName {
  exportedName: string;
  sourceName?: string;
}

export interface ReExportEntry {
  fromPath: string;
  names: ReExportName[] | 'all';
  isTypeOnly: boolean;
}

export interface ExtractionResult {
  exports: ExportedSymbol[];
  reExports: ReExportEntry[];
  fileQualifier?: string;
}

export function unquote(s: string): string {
  if (s.length < 2) return s;
  const first = s[0];
  const last = s[s.length - 1];
  if ((first === '"' || first === "'" || first === '`') && first === last) {
    return s.slice(1, -1);
  }
  return s;
}

export function languageForPath(filePath: string): ParserLanguage | undefined {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    case '.java':
      return 'java';
    default:
      return undefined;
  }
}
