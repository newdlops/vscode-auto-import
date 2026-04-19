import { createHash } from 'node:crypto';

const HASH_BYTES = 16;

export function hashContent(content: Buffer | string): Buffer {
  return createHash('sha256').update(content).digest().subarray(0, HASH_BYTES);
}

export function hashContentHex(content: Buffer | string): string {
  return hashContent(content).toString('hex');
}

export function equalHash(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export const HASH_SIZE = HASH_BYTES;
