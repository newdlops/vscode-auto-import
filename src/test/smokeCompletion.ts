import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config';
import { buildImportEdits } from '../completion/importInserter';
import { getAlreadyImportedSymbols } from '../completion/existingImports';
import { computeScore } from '../completion/scorer';
import { SymbolIndex } from '../index/symbolIndex';
import { SymbolFlag, SymbolKind } from '../index/types';
import type { Logger } from '../logger';
import { setWasmRoot } from '../parsers/treeSitter';
import { WorkspaceIndexer } from '../workspace/workspaceIndexer';
import { MockDocument } from './mockVscode';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const stubLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: (m, e) => console.error('[logger]', m, e),
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

  testExistingImports();
  testScorer();
  await testImportInserter();

  console.log('OK — completion pipeline (existingImports + scorer + importInserter)');
}

function testExistingImports(): void {
  const ts = `
import { A, B as C } from './x';
import D from './y';
import * as NS from './z';
import type { T } from './t';
`;
  const tsNames = getAlreadyImportedSymbols(ts, 'typescript');
  assert(
    tsNames.has('A') && tsNames.has('C') && tsNames.has('D') && tsNames.has('NS') && tsNames.has('T'),
    `TS imports: ${[...tsNames].join(',')}`,
  );

  const py = `
import os
import sys as _sys
from pkg.sub import Foo, Bar as BazAlias
from .local import *
`;
  const pyNames = getAlreadyImportedSymbols(py, 'python');
  assert(
    pyNames.has('os') && pyNames.has('_sys') && pyNames.has('Foo') && pyNames.has('BazAlias'),
    `Python imports: ${[...pyNames].join(',')}`,
  );

  const java = `
package com.example;
import com.foo.Bar;
import static com.foo.Baz.QUX;
import com.wild.*;
`;
  const javaNames = getAlreadyImportedSymbols(java, 'java');
  assert(
    javaNames.has('Bar') && javaNames.has('QUX'),
    `Java imports: ${[...javaNames].join(',')}`,
  );
  console.log(` existingImports ok`);
}

function testScorer(): void {
  const entryNormal = { fileId: 0, kind: SymbolKind.Class, flags: SymbolFlag.None };
  const entryReExport = { fileId: 0, kind: SymbolKind.Class, flags: SymbolFlag.ReExport };
  const entryDefault = { fileId: 0, kind: SymbolKind.Class, flags: SymbolFlag.DefaultExport };

  const sExact = computeScore('User', 'User', entryNormal, 2);
  const sPrefix = computeScore('Us', 'User', entryNormal, 2);
  const sReExport = computeScore('Us', 'User', entryReExport, 2);
  const sDefault = computeScore('Us', 'User', entryDefault, 2);

  assert(sExact > sPrefix, `exact ${sExact} > prefix ${sPrefix}`);
  assert(sPrefix > sReExport, `prefix ${sPrefix} > re-export ${sReExport}`);
  assert(sDefault > sPrefix, `default ${sDefault} > normal ${sPrefix}`);

  const sShallow = computeScore('Us', 'User', entryNormal, 2);
  const sDeep = computeScore('Us', 'User', entryNormal, 8);
  assert(sShallow > sDeep, `shallow ${sShallow} > deep ${sDeep}`);
  console.log(` scorer ok`);
}

async function testImportInserter(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscai-completion-'));
  try {
    await setupFixture(root);
    const index = new SymbolIndex();
    const wi = new WorkspaceIndexer(index, stubConfig, stubLogger, root);
    const files = [
      path.join(root, 'src', 'user.ts'),
      path.join(root, 'src', 'defaults.ts'),
      path.join(root, 'src', 'types.ts'),
      path.join(root, 'pkg', 'user.py'),
      path.join(root, 'com', 'example', 'Outer.java'),
    ];
    for (const f of files) await wi.indexFile(f);
    await wi.reflattenAllBarrels();

    // TS: insert new import
    {
      const docPath = path.join(root, 'src', 'consumer.ts');
      const doc = new MockDocument(docPath, `import { Existing } from './other';\n\nfunction foo() {}\n`) as any;
      const userPath = path.join(root, 'src', 'user.ts');
      const targetFile = index.getFile(userPath)!;
      const nameId = index.names.lookup('User')!;
      const entry = index.hot.lookup(nameId)!.find((e) => index.paths.get(e.fileId) === userPath)!;
      const edits = buildImportEdits(doc, 'typescript', 'User', entry, targetFile, index, stubConfig);
      assert(edits.length === 1, `ts insert: expected 1 edit, got ${edits.length}`);
      const edit = edits[0]!;
      assert(
        edit.newText.includes("import { User } from './user';"),
        `ts insert text: ${JSON.stringify(edit.newText)}`,
      );
      console.log(` ts insert ok`);
    }

    // TS: merge into existing named import
    {
      const docPath = path.join(root, 'src', 'consumer.ts');
      const doc = new MockDocument(docPath, `import { Foo } from './user';\n\nfunction bar() {}\n`) as any;
      const userPath = path.join(root, 'src', 'user.ts');
      const targetFile = index.getFile(userPath)!;
      const nameId = index.names.lookup('User')!;
      const entry = index.hot.lookup(nameId)!.find((e) => index.paths.get(e.fileId) === userPath)!;
      const edits = buildImportEdits(doc, 'typescript', 'User', entry, targetFile, index, stubConfig);
      assert(edits.length === 1, `ts merge: expected 1 edit`);
      assert(
        edits[0]!.newText === "import { Foo, User } from './user';",
        `ts merge text: ${JSON.stringify(edits[0]!.newText)}`,
      );
      console.log(` ts merge ok`);
    }

    // TS: default export
    {
      const docPath = path.join(root, 'src', 'consumer.ts');
      const doc = new MockDocument(docPath, `// empty\n`) as any;
      const defaultsPath = path.join(root, 'src', 'defaults.ts');
      const targetFile = index.getFile(defaultsPath)!;
      const nameId = index.names.lookup('DefaultApi')!;
      assert(nameId !== undefined, 'DefaultApi should exist');
      const entry = index.hot.lookup(nameId)!.find((e) => index.paths.get(e.fileId) === defaultsPath)!;
      const edits = buildImportEdits(doc, 'typescript', 'DefaultApi', entry, targetFile, index, stubConfig);
      const newText = edits[0]!.newText;
      assert(
        newText.includes("import DefaultApi from './defaults';"),
        `ts default text: ${JSON.stringify(newText)}`,
      );
      console.log(` ts default ok`);
    }

    // TS: type-only
    {
      const docPath = path.join(root, 'src', 'consumer.ts');
      const doc = new MockDocument(docPath, `// empty\n`) as any;
      const typesPath = path.join(root, 'src', 'types.ts');
      const targetFile = index.getFile(typesPath)!;
      const nameId = index.names.lookup('UserId')!;
      const entry = index.hot.lookup(nameId)!.find((e) => index.paths.get(e.fileId) === typesPath)!;
      const edits = buildImportEdits(doc, 'typescript', 'UserId', entry, targetFile, index, stubConfig);
      assert(
        edits[0]!.newText.includes("import type { UserId }"),
        `ts type-only: ${JSON.stringify(edits[0]!.newText)}`,
      );
      console.log(` ts type-only ok`);
    }

    // Python: new import
    {
      const docPath = path.join(root, 'pkg', 'consumer.py');
      const doc = new MockDocument(docPath, `from os import path\n\ndef foo(): pass\n`) as any;
      const userPath = path.join(root, 'pkg', 'user.py');
      const targetFile = index.getFile(userPath)!;
      const nameId = index.names.lookup('User')!;
      const entry = index.hot.lookup(nameId)!.find((e) => index.paths.get(e.fileId) === userPath)!;
      const edits = buildImportEdits(doc, 'python', 'User', entry, targetFile, index, stubConfig);
      assert(
        edits[0]!.newText.includes('from pkg.user import User'),
        `py insert: ${JSON.stringify(edits[0]!.newText)}`,
      );
      console.log(` py insert ok`);
    }

    // Python: merge
    {
      const docPath = path.join(root, 'pkg', 'consumer.py');
      const doc = new MockDocument(docPath, `from pkg.user import Foo\n`) as any;
      const userPath = path.join(root, 'pkg', 'user.py');
      const targetFile = index.getFile(userPath)!;
      const nameId = index.names.lookup('User')!;
      const entry = index.hot.lookup(nameId)!.find((e) => index.paths.get(e.fileId) === userPath)!;
      const edits = buildImportEdits(doc, 'python', 'User', entry, targetFile, index, stubConfig);
      assert(
        edits[0]!.newText === 'from pkg.user import Foo, User',
        `py merge: ${JSON.stringify(edits[0]!.newText)}`,
      );
      console.log(` py merge ok`);
    }

    // Java: FQCN import
    {
      const docPath = path.join(root, 'com', 'example', 'Consumer.java');
      const doc = new MockDocument(
        docPath,
        `package com.example;\n\npublic class Consumer {}\n`,
      ) as any;
      const outerPath = path.join(root, 'com', 'example', 'Outer.java');
      const targetFile = index.getFile(outerPath)!;
      const nameId = index.names.lookup('Inner')!;
      const entry = index.hot.lookup(nameId)!.find((e) => index.paths.get(e.fileId) === outerPath)!;
      const edits = buildImportEdits(doc, 'java', 'Inner', entry, targetFile, index, stubConfig);
      assert(
        edits[0]!.newText.includes('import com.example.Outer.Inner;'),
        `java inner import: ${JSON.stringify(edits[0]!.newText)}`,
      );
      console.log(` java inner class import ok`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function setupFixture(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'user.ts'),
    `export class User {}\nexport function getUser() {}`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'defaults.ts'),
    `export default class DefaultApi {}`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'types.ts'),
    `export type UserId = number;\nexport interface Entity {}`,
    'utf-8',
  );

  await fs.mkdir(path.join(root, 'pkg'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'pkg', 'user.py'),
    `class User:\n    pass\n`,
    'utf-8',
  );

  await fs.mkdir(path.join(root, 'com', 'example'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'com', 'example', 'Outer.java'),
    `package com.example;\n\npublic class Outer {\n    public static class Inner {}\n}\n`,
    'utf-8',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
