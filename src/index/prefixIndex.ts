import type { NameId } from './types';
import type { StringTable } from './stringTable';

export class PrefixIndex {
  private sortedIds: Uint32Array | null = null;
  private sortedLowers: string[] | null = null;
  private dirty = true;

  constructor(private readonly stringTable: StringTable) {}

  markDirty(): void {
    this.dirty = true;
  }

  private rebuild(): void {
    const n = this.stringTable.size();
    const lowers: string[] = new Array(n);
    const ids: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      lowers[i] = this.stringTable.get(i).toLowerCase();
      ids[i] = i;
    }
    ids.sort((a, b) => {
      const sa = lowers[a]!;
      const sb = lowers[b]!;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
    this.sortedIds = new Uint32Array(ids);
    const sortedLowers: string[] = new Array(n);
    for (let i = 0; i < n; i++) sortedLowers[i] = lowers[ids[i]!]!;
    this.sortedLowers = sortedLowers;
    this.dirty = false;
  }

  lookupPrefix(prefix: string, limit: number): NameId[] {
    if (this.dirty || this.sortedIds === null) this.rebuild();
    const ids = this.sortedIds!;
    const lowers = this.sortedLowers!;
    const lower = prefix.toLowerCase();
    if (lower.length === 0 || ids.length === 0) return [];

    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const s = lowers[mid]!;
      if (s < lower) lo = mid + 1;
      else hi = mid;
    }

    const results: NameId[] = [];
    for (let i = lo; i < ids.length && results.length < limit; i++) {
      if (!lowers[i]!.startsWith(lower)) break;
      results.push(ids[i]!);
    }
    return results;
  }

  matchesCamel(query: string, candidate: string): boolean {
    if (query.length === 0) return true;
    let qi = 0;
    let lastWasBoundary = true;
    for (let ci = 0; ci < candidate.length && qi < query.length; ci++) {
      const cc = candidate.charCodeAt(ci);
      const isUpper = cc >= 0x41 && cc <= 0x5a;
      const isBoundary = isUpper || candidate[ci] === '_' || candidate[ci] === '.';
      const qc = query.charCodeAt(qi);
      if ((cc | 0x20) === (qc | 0x20) && (qi === 0 || lastWasBoundary || isBoundary)) {
        qi++;
        lastWasBoundary = false;
      } else {
        lastWasBoundary = isBoundary;
      }
    }
    return qi === query.length;
  }
}
