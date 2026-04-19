import type { HotEntry } from '../index/hotIndex';
import { SymbolFlag } from '../index/types';

export function computeScore(
  prefix: string,
  name: string,
  entry: HotEntry,
  pathDepth: number,
): number {
  const lowerName = name.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  let score = 0;

  if (name === prefix) score += 1000;
  else if (name.startsWith(prefix)) score += 500;
  else if (lowerName.startsWith(lowerPrefix)) score += 300;

  score -= Math.max(0, name.length - prefix.length * 2);

  if (entry.flags & SymbolFlag.ReExport) score -= 10;
  if (entry.flags & SymbolFlag.DefaultExport) score += 5;

  score -= pathDepth * 2;

  return score;
}
