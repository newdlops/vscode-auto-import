import type { FileId, NameId, SymbolFlags, SymbolKind } from './types';

export interface HotEntry {
  fileId: FileId;
  kind: SymbolKind;
  flags: SymbolFlags;
  parentNameId?: NameId;
}

export class HotIndex {
  private byName = new Map<NameId, HotEntry[]>();
  private byFile = new Map<FileId, NameId[]>();

  add(nameId: NameId, entry: HotEntry): void {
    let entries = this.byName.get(nameId);
    if (!entries) {
      entries = [];
      this.byName.set(nameId, entries);
    }
    entries.push(entry);

    let names = this.byFile.get(entry.fileId);
    if (!names) {
      names = [];
      this.byFile.set(entry.fileId, names);
    }
    names.push(nameId);
  }

  removeFile(fileId: FileId): NameId[] {
    const names = this.byFile.get(fileId);
    if (!names) return [];
    for (const nameId of names) {
      const entries = this.byName.get(nameId);
      if (!entries) continue;
      const filtered = entries.filter((e) => e.fileId !== fileId);
      if (filtered.length === 0) {
        this.byName.delete(nameId);
      } else {
        this.byName.set(nameId, filtered);
      }
    }
    this.byFile.delete(fileId);
    return names;
  }

  lookup(nameId: NameId): readonly HotEntry[] | undefined {
    return this.byName.get(nameId);
  }

  hasName(nameId: NameId): boolean {
    return this.byName.has(nameId);
  }

  totalEntries(): number {
    let total = 0;
    for (const list of this.byName.values()) total += list.length;
    return total;
  }

  totalNames(): number {
    return this.byName.size;
  }
}
