import { deserializeIndex, serializeIndex } from '../index/persistence';
import { SymbolIndex } from '../index/symbolIndex';
import { hashContent } from '../index/hash';
import { SymbolFlag, SymbolKind } from '../index/types';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const a = new SymbolIndex();
a.upsertFile(
  '/src/user.ts',
  hashContent('content1'),
  1700000000000,
  [
    { name: 'User', kind: SymbolKind.Class, flags: SymbolFlag.None, line: 10, col: 5 },
    { name: 'UserId', kind: SymbolKind.TypeAlias, flags: SymbolFlag.TypeOnly, line: 1, col: 0 },
  ],
);
a.upsertFile(
  '/src/pkg/Outer.java',
  hashContent('content2'),
  1700000001000,
  [
    { name: 'Outer', kind: SymbolKind.Class, flags: SymbolFlag.None },
    {
      name: 'Inner',
      kind: SymbolKind.Class,
      flags: SymbolFlag.InnerClass,
      parentQualifier: 'Outer',
    },
  ],
);

const buf = serializeIndex(a);
console.log(`serialized size: ${buf.length} bytes`);

const b = deserializeIndex(buf);
const sa = a.stats();
const sb = b.stats();
assert(sa.files === sb.files, `files ${sa.files} vs ${sb.files}`);
assert(sa.names === sb.names, `names ${sa.names} vs ${sb.names}`);
assert(sa.paths === sb.paths, `paths ${sa.paths} vs ${sb.paths}`);
assert(sa.hotEntries === sb.hotEntries, `hotEntries ${sa.hotEntries} vs ${sb.hotEntries}`);

const userFile = b.getFile('/src/user.ts');
assert(userFile !== undefined, 'user.ts should exist');
assert(userFile!.exports.length === 2, 'user.ts exports count');
assert(userFile!.exports[0]!.name === 'User', 'first export name');

const userNameId = b.names.lookup('User')!;
const userEntries = b.hot.lookup(userNameId);
assert(userEntries !== undefined && userEntries.length === 1, 'User hot entry');

const innerFile = b.getFile('/src/pkg/Outer.java');
const innerSym = innerFile!.exports.find((e) => e.name === 'Inner');
assert(innerSym?.parentQualifier === 'Outer', 'Inner parentQualifier');

const prefixHits = b.prefix.lookupPrefix('use', 10);
assert(prefixHits.length === 2, `prefix 'use' should hit 2 (User, UserId), got ${prefixHits.length}`);

const trigramHits = b.trigrams.search('use', 10);
assert(trigramHits.length >= 2, `trigram 'use' should hit >=2, got ${trigramHits.length}`);

console.log('OK — persistence roundtrip + lookups');
