export type NameId = number;
export type FileId = number;

export enum SymbolKind {
  Variable = 0,
  Function = 1,
  Class = 2,
  Interface = 3,
  TypeAlias = 4,
  Enum = 5,
  Namespace = 6,
  Module = 7,
  Method = 8,
  Property = 9,
}

export const SymbolFlag = {
  None: 0,
  DefaultExport: 1 << 0,
  TypeOnly: 1 << 1,
  ReExport: 1 << 2,
  Deprecated: 1 << 3,
  InnerClass: 1 << 4,
} as const;

export type SymbolFlags = number;

export interface ExportedSymbol {
  name: string;
  kind: SymbolKind;
  flags: SymbolFlags;
  parentQualifier?: string;
  sourcePath?: string;
  line?: number;
  col?: number;
}

export interface ParsedFile {
  filePath: string;
  contentHash: string;
  mtime: number;
  language: 'typescript' | 'javascript' | 'python' | 'java';
  fileQualifier?: string;
  exports: ExportedSymbol[];
}
