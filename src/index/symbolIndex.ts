import { HotIndex } from './hotIndex';
import { PrefixIndex } from './prefixIndex';
import { StringTable } from './stringTable';
import { TrigramIndex } from './trigramIndex';
import type { ExportedSymbol, FileId } from './types';

export interface IndexedFile {
  pathId: FileId;
  contentHash: Buffer;
  mtime: number;
  fileQualifier?: string;
  exports: ExportedSymbol[];
}

export interface IndexStats {
  files: number;
  names: number;
  paths: number;
  hotEntries: number;
  trigrams: number;
}

export class SymbolIndex {
  readonly names = new StringTable();
  readonly paths = new StringTable();
  readonly hot = new HotIndex();
  readonly prefix = new PrefixIndex(this.names);
  readonly trigrams = new TrigramIndex();
  private files = new Map<FileId, IndexedFile>();

  upsertFile(
    path: string,
    contentHash: Buffer,
    mtime: number,
    exports: ExportedSymbol[],
    fileQualifier?: string,
  ): void {
    const pathId = this.paths.intern(path);
    if (this.files.has(pathId)) {
      this.hot.removeFile(pathId);
    }

    if (fileQualifier) this.names.intern(fileQualifier);
    const record: IndexedFile = { pathId, contentHash, mtime, fileQualifier, exports };
    this.files.set(pathId, record);

    for (const sym of exports) {
      const nameId = this.names.intern(sym.name);
      const parentNameId = sym.parentQualifier
        ? this.names.intern(sym.parentQualifier)
        : undefined;
      this.hot.add(nameId, {
        fileId: pathId,
        kind: sym.kind,
        flags: sym.flags,
        parentNameId,
      });
      this.trigrams.add(nameId, sym.name);
    }
    this.prefix.markDirty();
  }

  removeFile(path: string): boolean {
    const pathId = this.paths.lookup(path);
    if (pathId === undefined) return false;
    if (!this.files.has(pathId)) return false;
    this.hot.removeFile(pathId);
    this.files.delete(pathId);
    this.prefix.markDirty();
    return true;
  }

  getFile(path: string): IndexedFile | undefined {
    const pathId = this.paths.lookup(path);
    if (pathId === undefined) return undefined;
    return this.files.get(pathId);
  }

  getFileById(pathId: FileId): IndexedFile | undefined {
    return this.files.get(pathId);
  }

  fileCount(): number {
    return this.files.size;
  }

  allFiles(): IterableIterator<IndexedFile> {
    return this.files.values();
  }

  stats(): IndexStats {
    return {
      files: this.files.size,
      names: this.names.size(),
      paths: this.paths.size(),
      hotEntries: this.hot.totalEntries(),
      trigrams: this.trigrams.size(),
    };
  }
}
