import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringTable } from './stringTable';
import { SymbolIndex } from './symbolIndex';
import type { ExportedSymbol, SymbolFlags, SymbolKind } from './types';

const MAGIC = Buffer.from('VSCAUTO\0');
const VERSION = 2;
const HEADER_SIZE = 28;
const CACHE_FILENAME = 'cache.bin';
const NO_NAME = 0xffffffff;
const EXPORT_RECORD_SIZE = 14;
const FILE_HEADER_SIZE = 36;

export async function loadIndex(cacheDir: string): Promise<SymbolIndex | null> {
  try {
    const buf = await fs.readFile(path.join(cacheDir, CACHE_FILENAME));
    return deserializeIndex(buf);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveIndex(cacheDir: string, index: SymbolIndex): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const buf = serializeIndex(index);
  const finalPath = path.join(cacheDir, CACHE_FILENAME);
  const tmpPath = `${finalPath}.tmp`;
  await fs.writeFile(tmpPath, buf);
  await fs.rename(tmpPath, finalPath);
}

export function serializeIndex(index: SymbolIndex): Buffer {
  const stringsBuf = index.names.serialize();
  const pathsBuf = index.paths.serialize();
  const filesBuf = serializeFiles(index);

  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(VERSION, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(stringsBuf.length, 16);
  header.writeUInt32LE(pathsBuf.length, 20);
  header.writeUInt32LE(filesBuf.length, 24);

  return Buffer.concat([header, stringsBuf, pathsBuf, filesBuf]);
}

export function deserializeIndex(buf: Buffer): SymbolIndex {
  if (buf.length < HEADER_SIZE) throw new Error('cache: truncated header');
  if (!MAGIC.equals(buf.subarray(0, 8))) throw new Error('cache: bad magic');
  const version = buf.readUInt32LE(8);
  if (version !== VERSION) {
    throw new Error(`cache: version mismatch (got ${version}, expected ${VERSION})`);
  }

  const stringsLen = buf.readUInt32LE(16);
  const pathsLen = buf.readUInt32LE(20);
  const filesLen = buf.readUInt32LE(24);

  let off = HEADER_SIZE;
  const names = StringTable.deserialize(buf.subarray(off, off + stringsLen));
  off += stringsLen;
  const paths = StringTable.deserialize(buf.subarray(off, off + pathsLen));
  off += pathsLen;
  const filesBuf = buf.subarray(off, off + filesLen);

  const index = new SymbolIndex();
  for (const [id, s] of names.entries()) {
    const nid = index.names.intern(s);
    if (nid !== id) throw new Error(`cache: name id mismatch at ${id}`);
  }
  for (const [id, p] of paths.entries()) {
    const pid = index.paths.intern(p);
    if (pid !== id) throw new Error(`cache: path id mismatch at ${id}`);
  }

  deserializeFiles(filesBuf, index);
  return index;
}

function serializeFiles(index: SymbolIndex): Buffer {
  const files = [...index.allFiles()];
  const parts: Buffer[] = [];

  const count = Buffer.alloc(4);
  count.writeUInt32LE(files.length, 0);
  parts.push(count);

  for (const f of files) {
    const head = Buffer.alloc(FILE_HEADER_SIZE);
    head.writeUInt32LE(f.pathId, 0);
    if (f.contentHash.length !== 16) {
      throw new Error(`cache: contentHash must be 16 bytes (got ${f.contentHash.length})`);
    }
    f.contentHash.copy(head, 4);
    head.writeBigUInt64LE(BigInt(f.mtime), 20);
    const qualifierId = f.fileQualifier
      ? (index.names.lookup(f.fileQualifier) ?? NO_NAME)
      : NO_NAME;
    head.writeUInt32LE(qualifierId, 28);
    head.writeUInt32LE(f.exports.length, 32);
    parts.push(head);

    for (const e of f.exports) {
      const exp = Buffer.alloc(EXPORT_RECORD_SIZE);
      const nameId = index.names.lookup(e.name);
      if (nameId === undefined) throw new Error(`cache: name not interned: ${e.name}`);
      const parentNameId = e.parentQualifier
        ? (index.names.lookup(e.parentQualifier) ?? NO_NAME)
        : NO_NAME;
      exp.writeUInt32LE(nameId, 0);
      exp.writeUInt8(e.kind & 0xff, 4);
      exp.writeUInt8(e.flags & 0xff, 5);
      exp.writeUInt32LE(parentNameId, 6);
      exp.writeUInt16LE(Math.min(e.line ?? 0, 0xffff), 10);
      exp.writeUInt16LE(Math.min(e.col ?? 0, 0xffff), 12);
      parts.push(exp);
    }
  }

  return Buffer.concat(parts);
}

function deserializeFiles(buf: Buffer, index: SymbolIndex): void {
  const count = buf.readUInt32LE(0);
  let off = 4;
  for (let i = 0; i < count; i++) {
    const pathId = buf.readUInt32LE(off);
    off += 4;
    const contentHash = Buffer.from(buf.subarray(off, off + 16));
    off += 16;
    const mtime = Number(buf.readBigUInt64LE(off));
    off += 8;
    const qualifierRaw = buf.readUInt32LE(off);
    off += 4;
    const fileQualifier = qualifierRaw === NO_NAME ? undefined : index.names.get(qualifierRaw);
    const exportCount = buf.readUInt32LE(off);
    off += 4;

    const exports: ExportedSymbol[] = [];
    for (let j = 0; j < exportCount; j++) {
      const nameId = buf.readUInt32LE(off);
      const kind = buf.readUInt8(off + 4) as SymbolKind;
      const flags = buf.readUInt8(off + 5) as SymbolFlags;
      const parentRaw = buf.readUInt32LE(off + 6);
      const line = buf.readUInt16LE(off + 10);
      const col = buf.readUInt16LE(off + 12);
      const name = index.names.get(nameId);
      const parentQualifier =
        parentRaw === NO_NAME ? undefined : index.names.get(parentRaw);
      exports.push({ name, kind, flags, parentQualifier, line, col });
      off += EXPORT_RECORD_SIZE;
    }

    const pathStr = index.paths.get(pathId);
    index.upsertFile(pathStr, contentHash, mtime, exports, fileQualifier);
  }
}
