import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function setupWorkspace(): Promise<{ root: string; pyLibRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscai-e2e-'));

  // --- TypeScript workspace ---
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'src', 'user.ts'),
    `export class User {\n  id: number = 0;\n  constructor(public name: string) {}\n}\n\nexport function getCurrentUser(): User {\n  return new User('anonymous');\n}\n\nexport type UserId = number;\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'order.ts'),
    `export class Order {\n  constructor(public id: string) {}\n}\n\nexport function createOrder(id: string): Order {\n  return new Order(id);\n}\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'barrel.ts'),
    `export * from './user';\nexport { Order } from './order';\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'src', 'consumer.ts'),
    `// markers: User Order FakeClient UserId readFileSync fs createRequire\nfunction main(): void {\n  const u = User;\n  const o = Order;\n  const c = FakeClient;\n  const i: UserId = 0;\n  const r = readFileSync;\n  const f = fs;\n  const cr = createRequire;\n}\n`,
    'utf-8',
  );

  // --- TS library (node_modules/fake-lib) ---
  await fs.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'e2e-host',
      dependencies: { 'fake-lib': '*' },
    }),
    'utf-8',
  );
  const fakeLib = path.join(root, 'node_modules', 'fake-lib');
  await fs.mkdir(fakeLib, { recursive: true });
  await fs.writeFile(
    path.join(fakeLib, 'package.json'),
    JSON.stringify({ name: 'fake-lib', types: 'index.d.ts' }),
    'utf-8',
  );
  await fs.writeFile(
    path.join(fakeLib, 'index.d.ts'),
    `export declare class FakeClient {\n  greet(): string;\n}\nexport declare function fakeFn(): number;\n`,
    'utf-8',
  );

  // --- Python workspace ---
  await fs.mkdir(path.join(root, 'pkg'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'pkg', 'models.py'),
    `class Account:\n    pass\n\nclass Invoice:\n    pass\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'pkg', '__init__.py'),
    `from .models import Account\n__all__ = ['Account']\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'pkg', 'consumer.py'),
    `# markers: Account Invoice FakeLibCls Q F Path json ThreadPoolExecutor\ndef main():\n    a = Account\n    b = Invoice\n    c = FakeLibCls\n    d = Q\n    e = F\n    p = Path\n    j = json\n    t = ThreadPoolExecutor\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'pkg', 'query.py'),
    `class Q:\n    pass\n\nclass F:\n    pass\n`,
    'utf-8',
  );

  // --- Python library (custom path OUTSIDE workspace via pythonExtraPaths) ---
  const pyLibRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vscai-pylib-'));
  await fs.mkdir(path.join(pyLibRoot, 'fakelib'), { recursive: true });
  await fs.writeFile(
    path.join(pyLibRoot, 'fakelib', '__init__.py'),
    `class FakeLibCls:\n    pass\n\ndef fake_util():\n    pass\n`,
    'utf-8',
  );

  // --- Java workspace ---
  await fs.mkdir(path.join(root, 'com', 'example'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'com', 'example', 'Foo.java'),
    `package com.example;\n\npublic class Foo {\n    public static class Inner {}\n}\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'com', 'example', 'Bar.java'),
    `package com.example;\n\npublic interface Bar {\n}\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(root, 'com', 'example', 'Consumer.java'),
    `// markers: Foo Bar Inner ArrayList ReentrantLock\npackage com.example;\n\npublic class Consumer {\n    void run() {\n        Object x = Foo;\n        Object y = Inner;\n        Object z = Bar;\n        Object a = ArrayList;\n        Object l = ReentrantLock;\n    }\n}\n`,
    'utf-8',
  );

  // --- .vscode/settings.json ---
  await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.vscode', 'settings.json'),
    JSON.stringify({
      'autoImport.logLevel': 'debug',
      'autoImport.libraries.enabled': true,
      'autoImport.libraries.tsNodeModules': true,
      'autoImport.libraries.pythonSitePackages': true,
      'autoImport.libraries.pythonExtraPaths': [pyLibRoot],
      'autoImport.minPrefixLength': 1,
    }),
    'utf-8',
  );

  return { root, pyLibRoot };
}

async function main(): Promise<void> {
  let paths: { root: string; pyLibRoot: string } | undefined;
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    paths = await setupWorkspace();
    console.log(`e2e workspace: ${paths.root}`);
    console.log(`e2e pyLibRoot: ${paths.pyLibRoot}`);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [paths.root, '--disable-extensions'],
    });
  } catch (err) {
    console.error('E2E test run failed:', err);
    process.exitCode = 1;
  } finally {
    if (paths) {
      await fs.rm(paths.root, { recursive: true, force: true }).catch(() => {});
      await fs.rm(paths.pyLibRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

void main();
