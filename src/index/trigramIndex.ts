import type { NameId } from './types';

export class TrigramIndex {
  private postings = new Map<number, Set<NameId>>();
  private nameTrigrams = new Map<NameId, number[]>();

  add(nameId: NameId, name: string): void {
    if (this.nameTrigrams.has(nameId)) return;
    const trigrams = trigramsOf(name);
    this.nameTrigrams.set(nameId, trigrams);
    for (const tg of trigrams) {
      let set = this.postings.get(tg);
      if (!set) {
        set = new Set();
        this.postings.set(tg, set);
      }
      set.add(nameId);
    }
  }

  remove(nameId: NameId): void {
    const trigrams = this.nameTrigrams.get(nameId);
    if (!trigrams) return;
    for (const tg of trigrams) {
      const set = this.postings.get(tg);
      if (!set) continue;
      set.delete(nameId);
      if (set.size === 0) this.postings.delete(tg);
    }
    this.nameTrigrams.delete(nameId);
  }

  search(query: string, limit: number): NameId[] {
    const trigrams = trigramsOf(query);
    if (trigrams.length === 0) return [];
    let result: Set<NameId> | null = null;
    for (const tg of trigrams) {
      const set = this.postings.get(tg);
      if (!set || set.size === 0) return [];
      if (result === null) {
        result = new Set(set);
      } else {
        for (const id of result) {
          if (!set.has(id)) result.delete(id);
        }
        if (result.size === 0) return [];
      }
    }
    if (!result) return [];
    const out: NameId[] = [];
    let i = 0;
    for (const id of result) {
      if (i >= limit) break;
      out.push(id);
      i++;
    }
    return out;
  }

  size(): number {
    return this.postings.size;
  }
}

function trigramsOf(s: string): number[] {
  if (s.length < 3) return [];
  const lower = s.toLowerCase();
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 3 <= lower.length; i++) {
    const a = lower.charCodeAt(i);
    const b = lower.charCodeAt(i + 1);
    const c = lower.charCodeAt(i + 2);
    if (a > 0xff || b > 0xff || c > 0xff) continue;
    const tg = (a << 16) | (b << 8) | c;
    if (seen.has(tg)) continue;
    seen.add(tg);
    out.push(tg);
  }
  return out;
}
