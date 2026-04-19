import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setWasmRoot } from '../parsers/treeSitter';
import { SymbolIndex } from '../index/symbolIndex';
import { WorkspaceIndexer } from '../workspace/workspaceIndexer';
import { SymbolFlag, SymbolKind } from '../index/types';
import type { Config } from '../config';
import type { Logger } from '../logger';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const stubLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: (msg, err) => {
    console.error('[logger error]', msg, err);
  },
  dispose: () => {},
};

const stubConfig: Config = {
  languages: ['typescript', 'javascript', 'python', 'java'],
  excludeGlobs: [],
  minPrefixLength: 2,
  maxResults: 20,
  preferBarrelImports: true,
  python: { respectAllDunder: true },
  typescript: { preferTypeImports: 'auto' },
  java: { includeInnerClasses: true },
  cache: { maxDiskMB: 20, location: 'workspace' },
};

async function main(): Promise<void> {
  setWasmRoot(path.resolve(__dirname, '..', 'resources', 'wasm'));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscai-smoke-'));
  try {
    await setupFixture(root);

    const index = new SymbolIndex();
    const wi = new WorkspaceIndexer(index, stubConfig, stubLogger, root);

    const files = [
      path.join(root, 'src', 'user.ts'),
      path.join(root, 'src', 'order.ts'),
      path.join(root, 'src', 'index.ts'),
      path.join(root, 'pkg', 'user.py'),
      path.join(root, 'pkg', 'order.py'),
      path.join(root, 'pkg', '__init__.py'),
      path.join(root, 'com', 'example', 'Outer.java'),
    ];
    for (const f of files) await wi.indexFile(f);
    await wi.reflattenAllBarrels();

    // TS: own exports
    const userFile = index.getFile(path.join(root, 'src', 'user.ts'));
    assert(userFile !== undefined, 'user.ts indexed');
    assert(userFile!.exports.some((e) => e.name === 'User'), 'user.ts has User');

    // TS: barrel flattening
    const barrelFile = index.getFile(path.join(root, 'src', 'index.ts'));
    assert(barrelFile !== undefined, 'index.ts indexed');
    const barrelNames = barrelFile!.exports.map((e) => e.name).sort();
    assert(
      barrelNames.includes('User') && barrelNames.includes('Order'),
      `TS barrel expected User+Order, got ${JSON.stringify(barrelNames)}`,
    );
    const userInBarrel = barrelFile!.exports.find((e) => e.name === 'User')!;
    assert(
      (userInBarrel.flags & SymbolFlag.ReExport) !== 0,
      'User in barrel should be ReExport',
    );
    assert(
      userInBarrel.sourcePath === path.join(root, 'src', 'user.ts'),
      `User sourcePath expected user.ts, got ${userInBarrel.sourcePath}`,
    );

    // TS: hot index
    const userNameId = index.names.lookup('User')!;
    const userEntries = index.hot.lookup(userNameId)!;
    const barrelEntry = userEntries.find(
      (e) => index.paths.get(e.fileId) === path.join(root, 'src', 'index.ts'),
    );
    assert(barrelEntry !== undefined, 'hot index has barrel entry for User');
    assert(
      (barrelEntry!.flags & SymbolFlag.ReExport) !== 0,
      'barrel hot entry flagged ReExport',
    );

    // Python: __init__.py barrel
    const pkgInit = index.getFile(path.join(root, 'pkg', '__init__.py'));
    assert(pkgInit !== undefined, '__init__.py indexed');
    const pyBarrelNames = pkgInit!.exports.map((e) => e.name).sort();
    assert(
      pyBarrelNames.includes('User') && pyBarrelNames.includes('Order'),
      `Python barrel expected User+Order, got ${JSON.stringify(pyBarrelNames)}`,
    );
    // Python module qualifier
    assert(
      pkgInit!.fileQualifier === 'pkg',
      `pkg/__init__.py qualifier expected 'pkg', got ${pkgInit!.fileQualifier}`,
    );
    const pyUserFile = index.getFile(path.join(root, 'pkg', 'user.py'));
    assert(
      pyUserFile!.fileQualifier === 'pkg.user',
      `pkg/user.py qualifier expected 'pkg.user', got ${pyUserFile!.fileQualifier}`,
    );

    // Java
    const javaFile = index.getFile(path.join(root, 'com', 'example', 'Outer.java'));
    assert(javaFile !== undefined, 'Outer.java indexed');
    assert(
      javaFile!.fileQualifier === 'com.example',
      `Java package expected 'com.example', got ${javaFile!.fileQualifier}`,
    );
    const javaNames = javaFile!.exports
      .map((e) => (e.parentQualifier ? `${e.parentQualifier}.${e.name}` : e.name))
      .sort();
    assert(
      javaNames.includes('Outer') && javaNames.includes('Outer.Inner'),
      `Java expected Outer + Outer.Inner, got ${JSON.stringify(javaNames)}`,
    );

    // Incremental: edit user.ts — remove User, add NewUser
    const newUserSource = `export class NewUser {}
export class Account {}`;
    await fs.writeFile(path.join(root, 'src', 'user.ts'), newUserSource, 'utf-8');
    await wi.indexFile(path.join(root, 'src', 'user.ts'));

    const barrelAfter = index.getFile(path.join(root, 'src', 'index.ts'));
    const barrelNamesAfter = barrelAfter!.exports.map((e) => e.name).sort();
    assert(
      !barrelNamesAfter.includes('User') &&
        barrelNamesAfter.includes('NewUser') &&
        barrelNamesAfter.includes('Account'),
      `after edit: expected NewUser+Account, no User. Got ${JSON.stringify(barrelNamesAfter)}`,
    );

    // Hot index after cascade: old User should have no barrel entry
    const userEntriesAfter = index.hot.lookup(userNameId);
    const barrelEntryAfter = userEntriesAfter?.find(
      (e) => index.paths.get(e.fileId) === path.join(root, 'src', 'index.ts'),
    );
    assert(
      barrelEntryAfter === undefined,
      'User barrel entry should be gone after user.ts no longer exports User',
    );

    // Delete a file
    await wi.removeFile(path.join(root, 'src', 'order.ts'));
    const barrelAfterDelete = index.getFile(path.join(root, 'src', 'index.ts'));
    const barrelNamesAfterDelete = barrelAfterDelete!.exports.map((e) => e.name).sort();
    assert(
      !barrelNamesAfterDelete.includes('Order'),
      `after delete: Order should be gone, got ${JSON.stringify(barrelNamesAfterDelete)}`,
    );

    // Silence unused warning
    void SymbolKind;

    console.log('OK — workspace indexer (barrel flattening + cascading + delete)');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function setupFixture(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'user.ts'),
    `export class User {}
export type UserId = number;`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'order.ts'),
    `export class Order {}
export function createOrder() {}`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'index.ts'),
    `export * from './user';
export { Order } from './order';`,
    'utf-8',
  );

  await fs.mkdir(path.join(root, 'pkg'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'pkg', 'user.py'),
    `class User:
    pass
`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'pkg', 'order.py'),
    `class Order:
    pass
`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'pkg', '__init__.py'),
    `__all__ = ['User', 'Order']
from .user import User
from .order import Order
`,
    'utf-8',
  );

  await fs.mkdir(path.join(root, 'com', 'example'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'com', 'example', 'Outer.java'),
    `package com.example;

public class Outer {
    public static class Inner {}
}
`,
    'utf-8',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
