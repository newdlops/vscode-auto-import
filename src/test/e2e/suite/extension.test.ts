import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'kodebox.vscode-auto-import';

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function labelOf(item: vscode.CompletionItem): string {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

async function suggestionsAt(
  root: string,
  relPath: string,
  marker: string,
  prefixLen: number,
): Promise<vscode.CompletionList> {
  const uri = vscode.Uri.file(path.join(root, relPath));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true });
  const text = doc.getText();
  const positions = wordPositions(text, marker);
  assert.ok(positions.length >= 2, `${relPath} should contain '${marker}' at least twice`);
  const idx = positions[1]!;
  const pos = doc.positionAt(idx + prefixLen);
  return (await vscode.commands.executeCommand(
    'vscode.executeCompletionItemProvider',
    uri,
    pos,
  )) as vscode.CompletionList;
}

function wordPositions(text: string, word: string): number[] {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m.index);
  return out;
}

function autoImportItems(list: vscode.CompletionList): vscode.CompletionItem[] {
  return list.items.filter(
    (i) => typeof i.detail === 'string' && i.detail.startsWith('↪ auto-import'),
  );
}

suite('Auto Import E2E', function () {
  this.timeout(60000);

  let root: string;

  suiteSetup(async function () {
    this.timeout(45000);
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be discoverable`);
    if (!ext!.isActive) await ext!.activate();

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'workspace folder should be opened');
    root = folder!.uri.fsPath;

    const deadline = Date.now() + 30000;
    let lastLog = 0;
    let ts = false, py = false, java = false, lib = false;
    while (Date.now() < deadline) {
      await wait(400);
      ts = await hasLabel(root, 'src/consumer.ts', 'User', 2);
      py = await hasLabel(root, 'pkg/consumer.py', 'Account', 3);
      java = await hasLabel(root, 'com/example/Consumer.java', 'Foo', 2);
      lib = await hasLabel(root, 'src/consumer.ts', 'FakeClient', 4);
      if (ts && py && java && lib) {
        console.log(`[e2e] all symbols ready at ${Date.now() - (deadline - 30000)}ms`);
        return;
      }
      if (Date.now() - lastLog > 2500) {
        lastLog = Date.now();
        console.log(`[e2e] waiting: ts=${ts} py=${py} java=${java} lib=${lib}`);
      }
    }
    throw new Error(
      `initial scan did not index all expected symbols: ts=${ts} py=${py} java=${java} lib=${lib}`,
    );
  });

  test('commands are registered', async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('autoImport.rebuildIndex'));
    assert.ok(cmds.includes('autoImport.showCacheStats'));
    assert.ok(cmds.includes('autoImport.showLogs'));
  });

  test('TS: suggests User with relative import edit', async () => {
    const list = await suggestionsAt(root, 'src/consumer.ts', 'User', 2);
    const item = findByLabel(list, 'User');
    const detail = typeof item.detail === 'string' ? item.detail : '';
    assert.match(detail, /auto-import from/);
    assert.ok(item.additionalTextEdits && item.additionalTextEdits.length > 0);
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /import\s+\{\s*User\s*\}\s+from\s+'\.\/user'/, `edit: ${text}`);
    // Right-aligned description should always expose the import source
    assert.ok(typeof item.label === 'object', 'label should be a CompletionItemLabel');
    const desc = (item.label as vscode.CompletionItemLabel).description ?? '';
    assert.match(desc, /\.\/user/, `description should show import path, got "${desc}"`);
  });

  test('Python: label.description shows module path', async () => {
    const list = await suggestionsAt(root, 'pkg/consumer.py', 'Invoice', 3);
    const item = findByLabel(list, 'Invoice');
    assert.ok(typeof item.label === 'object', 'label should be a CompletionItemLabel');
    const desc = (item.label as vscode.CompletionItemLabel).description ?? '';
    assert.strictEqual(desc, 'pkg.models', `description should be 'pkg.models', got "${desc}"`);
  });

  test('Java: label.description shows FQCN', async () => {
    const list = await suggestionsAt(root, 'com/example/Consumer.java', 'Foo', 2);
    const item = findByLabel(list, 'Foo');
    assert.ok(typeof item.label === 'object', 'label should be a CompletionItemLabel');
    const desc = (item.label as vscode.CompletionItemLabel).description ?? '';
    assert.strictEqual(desc, 'com.example.Foo', `description should be 'com.example.Foo', got "${desc}"`);
  });

  test('node_modules library: label.description shows package name', async () => {
    const list = await suggestionsAt(root, 'src/consumer.ts', 'FakeClient', 4);
    const item = findByLabel(list, 'FakeClient');
    const desc = (item.label as vscode.CompletionItemLabel).description ?? '';
    assert.strictEqual(desc, 'fake-lib', `description should be 'fake-lib', got "${desc}"`);
  });

  test('TS: 1-char "O" yields Order', async () => {
    const list = await suggestionsAt(root, 'src/consumer.ts', 'Order', 1);
    const labels = autoImportItems(list).map(labelOf);
    assert.ok(labels.includes('Order'), `got: ${labels.slice(0, 10)}`);
  });

  test('TS: type-only import for UserId uses import type', async () => {
    const list = await suggestionsAt(root, 'src/consumer.ts', 'UserId', 4);
    const item = findByLabel(list, 'UserId');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /import\s+type\s+\{\s*UserId\s*\}/, `edit: ${text}`);
  });

  test('TS: node_modules library FakeClient → "from \'fake-lib\'"', async () => {
    const list = await suggestionsAt(root, 'src/consumer.ts', 'FakeClient', 4);
    const item = findByLabel(list, 'FakeClient');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /from\s+'fake-lib'/, `edit: ${text}`);
  });

  test('Python: suggests Account with dotted-path import', async () => {
    const list = await suggestionsAt(root, 'pkg/consumer.py', 'Account', 3);
    const item = findByLabel(list, 'Account');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /from\s+pkg(\.models|\b)\s+import\s+Account/, `edit: ${text}`);
  });

  test('Python: Invoice from submodule', async () => {
    const list = await suggestionsAt(root, 'pkg/consumer.py', 'Invoice', 3);
    const item = findByLabel(list, 'Invoice');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /from\s+pkg\.models\s+import\s+Invoice/, `edit: ${text}`);
  });

  test('Python: single-char class Q is suggested', async () => {
    const list = await suggestionsAt(root, 'pkg/consumer.py', 'Q', 1);
    const item = findByLabel(list, 'Q');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /from\s+pkg\.query\s+import\s+Q/, `edit: ${text}`);
  });

  test('Python: single-char class F is suggested', async () => {
    const list = await suggestionsAt(root, 'pkg/consumer.py', 'F', 1);
    const item = findByLabel(list, 'F');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /from\s+pkg\.query\s+import\s+F/, `edit: ${text}`);
  });

  test('Python: extraPaths library FakeLibCls', async () => {
    const list = await suggestionsAt(root, 'pkg/consumer.py', 'FakeLibCls', 4);
    const item = findByLabel(list, 'FakeLibCls');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /from\s+fakelib\s+import\s+FakeLibCls/, `edit: ${text}`);
  });

  test('Java: suggests Foo with FQCN import', async () => {
    const list = await suggestionsAt(root, 'com/example/Consumer.java', 'Foo', 2);
    const item = findByLabel(list, 'Foo');
    const text = item.additionalTextEdits![0]!.newText;
    assert.match(text, /import\s+com\.example\.Foo;/, `edit: ${text}`);
  });

  test('Java: inner class Inner resolves with parent qualifier', async () => {
    const list = await suggestionsAt(root, 'com/example/Consumer.java', 'Inner', 4);
    const labels = autoImportItems(list).map(labelOf);
    const item = list.items.find((i) => labelOf(i) === 'Inner');
    assert.ok(item, `Inner not suggested, labels: ${labels}`);
    const text = item!.additionalTextEdits![0]!.newText;
    assert.match(text, /import\s+com\.example\.Foo\.Inner;/, `edit: ${text}`);
  });

  test('filters already-imported symbol', async () => {
    const importedFile = path.join(root, 'src', 'withImport.ts');
    const content = `import { User } from './user';\n\nfunction f(): User {\n  return User;\n}\n`;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(importedFile),
      Buffer.from(content, 'utf-8'),
    );
    await wait(400);

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(importedFile));
    await vscode.window.showTextDocument(doc);
    const idx = doc.getText().indexOf('return User');
    const pos = doc.positionAt(idx + 'return Use'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const autoImports = autoImportItems(list).filter((i) => labelOf(i) === 'User');
    assert.strictEqual(autoImports.length, 0, 'User should not be suggested as auto-import');
  });

  test('persistent cache file is written', async () => {
    const cacheDir = path.join(root, '.vscode', '.auto-import-cache');
    const cacheFile = path.join(cacheDir, 'index.bin');
    console.log(`[e2e] checking cache at: ${cacheFile}`);
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(cacheFile));
        return;
      } catch {
        await wait(500);
      }
    }
    // Diagnostic: list parent directory
    let listing = 'n/a';
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(root, '.vscode')));
      listing = entries.map(([n]) => n).join(', ');
    } catch (e) {
      listing = String(e);
    }
    // Also try rebuild command to force another save
    console.log(`[e2e] .vscode contents: ${listing}`);
    await vscode.commands.executeCommand('autoImport.rebuildIndex');
    await wait(1000);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(cacheFile));
      console.log('[e2e] cache appeared after rebuild');
      return;
    } catch {}
    assert.fail(`cache file missing: ${cacheFile} — .vscode contains: ${listing}`);
  });

  test('rebuildIndex command completes', async () => {
    await vscode.commands.executeCommand('autoImport.rebuildIndex');
    // After rebuild, the User symbol should still be discoverable
    const list = await suggestionsAt(root, 'src/consumer.ts', 'User', 2);
    const labels = autoImportItems(list).map(labelOf);
    assert.ok(labels.includes('User'), `after rebuild, User missing: ${labels.slice(0, 10)}`);
  });

  test('daemon restart reuses persistent cache', async () => {
    // Ensure the cache file exists (prior test already waited for it).
    const cacheFile = path.join(root, '.vscode', '.auto-import-cache', 'index.bin');
    await vscode.workspace.fs.stat(vscode.Uri.file(cacheFile));

    const restarted = await vscode.commands.executeCommand<boolean>('autoImport.restartDaemon');
    assert.strictEqual(restarted, true, 'restartDaemon should succeed');

    const status = await vscode.commands.executeCommand<{
      running: boolean;
      lastInit?: { cacheLoaded: boolean; cachedFiles: number };
    }>('autoImport.daemonStatus');
    assert.ok(status?.running, 'daemon should be running after restart');
    assert.ok(status!.lastInit?.cacheLoaded, 'cache should be loaded on restart');
    assert.ok(
      status!.lastInit!.cachedFiles > 0,
      `cachedFiles > 0, got ${status!.lastInit!.cachedFiles}`,
    );

    // Completion still works immediately after restart (no rescan needed).
    const list = await suggestionsAt(root, 'src/consumer.ts', 'User', 2);
    const labels = autoImportItems(list).map(labelOf);
    assert.ok(labels.includes('User'), `after restart, User missing: ${labels.slice(0, 10)}`);
  });

  test('TS: merges into existing named import block', async () => {
    const target = path.join(root, 'src', 'mergeTs.ts');
    const src = `import { User } from './user';\n\nfunction f() {\n  const a = User;\n  const b = UserId;\n}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const markerIdx = text.indexOf('b = UserId');
    const pos = doc.positionAt(markerIdx + 'b = User'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'UserId');
    const edit = item.additionalTextEdits![0]!;
    const replaced = doc
      .getText()
      .slice(doc.offsetAt(edit.range.start), doc.offsetAt(edit.range.end));
    void replaced;
    assert.match(
      edit.newText,
      /import\s+type\s*\{\s*UserId\s*\}\s+from\s+'\.\/user'/,
      `type import expected on new line, got: ${edit.newText}`,
    );
  });

  test('TS: merges another value into existing value import', async () => {
    const target = path.join(root, 'src', 'mergeValue.ts');
    const src = `import { getCurrentUser } from './user';\n\nfunction f() {\n  const u = User;\n}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('= User');
    const pos = doc.positionAt(idx + '= Us'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'User');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      "import { getCurrentUser, User } from './user';",
      `merge result: ${edit.newText}`,
    );
  });

  test('TS: multi-line import with trailing comma preserves multi-line style', async () => {
    const target = path.join(root, 'src', 'mergeMulti.ts');
    const src = `import {\n  getCurrentUser,\n} from './user';\n\nfunction f() {\n  const u = User;\n}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('= User');
    const pos = doc.positionAt(idx + '= Us'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'User');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      "import {\n  getCurrentUser,\n  User,\n} from './user';",
      `multi-line merge (trailing comma): ${JSON.stringify(edit.newText)}`,
    );
  });

  test('TS: multi-line import without trailing comma adds comma + name', async () => {
    const target = path.join(root, 'src', 'mergeMultiNoComma.ts');
    const src = `import {\n  getCurrentUser\n} from './user';\n\nfunction f() {\n  const u = User;\n}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('= User');
    const pos = doc.positionAt(idx + '= Us'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'User');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      "import {\n  getCurrentUser,\n  User\n} from './user';",
      `multi-line merge (no trailing comma): ${JSON.stringify(edit.newText)}`,
    );
  });

  test('TS: multi-line import with tab indent preserves tabs', async () => {
    const target = path.join(root, 'src', 'mergeTabs.ts');
    const src = `import {\n\tgetCurrentUser,\n} from './user';\n\nfunction f() {\n  const u = User;\n}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('= User');
    const pos = doc.positionAt(idx + '= Us'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'User');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      "import {\n\tgetCurrentUser,\n\tUser,\n} from './user';",
      `tab-indented merge: ${JSON.stringify(edit.newText)}`,
    );
  });

  test('TS: multi-line import with 4-space indent preserves it', async () => {
    const target = path.join(root, 'src', 'mergeFour.ts');
    const src = `import {\n    getCurrentUser,\n    type UserId,\n} from './user';\n\nfunction f() {\n  const u = User;\n}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('= User');
    const pos = doc.positionAt(idx + '= Us'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'User');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      "import {\n    getCurrentUser,\n    type UserId,\n    User,\n} from './user';",
      `4-space indent merge: ${JSON.stringify(edit.newText)}`,
    );
  });

  test('Python: multi-line parenthesized import preserves style', async () => {
    const target = path.join(root, 'pkg', 'mergePyMulti.py');
    const src = `from pkg.models import (\n    Account,\n)\n\ndef foo():\n    b = Invoice\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('b = Invoice');
    const pos = doc.positionAt(idx + 'b = Inv'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'Invoice');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      'from pkg.models import (\n    Account,\n    Invoice,\n)',
      `py multi-line paren: ${JSON.stringify(edit.newText)}`,
    );
  });

  test('Python: parenthesized single-line import preserves parens', async () => {
    const target = path.join(root, 'pkg', 'mergePyParen.py');
    const src = `from pkg.models import (Account)\n\ndef foo():\n    b = Invoice\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('b = Invoice');
    const pos = doc.positionAt(idx + 'b = Inv'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'Invoice');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      'from pkg.models import (Account, Invoice)',
      `py single-line paren: ${JSON.stringify(edit.newText)}`,
    );
  });

  test('Python: merges into existing from...import list', async () => {
    const target = path.join(root, 'pkg', 'merge_consumer.py');
    const src = `from pkg.models import Account\n\ndef foo():\n    a = Account\n    b = Invoice\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(src, 'utf-8'));
    await wait(400);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(doc);
    const text = doc.getText();
    const idx = text.indexOf('b = Invoice');
    const pos = doc.positionAt(idx + 'b = Inv'.length);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      pos,
    )) as vscode.CompletionList;
    const item = findByLabel(list, 'Invoice');
    const edit = item.additionalTextEdits![0]!;
    assert.strictEqual(
      edit.newText,
      'from pkg.models import Account, Invoice',
      `merge result: ${edit.newText}`,
    );
  });

  test('incremental edit removes stale symbol', async () => {
    const target = path.join(root, 'src', 'order.ts');
    const original = (await vscode.workspace.fs.readFile(vscode.Uri.file(target))).toString();
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(target),
        Buffer.from(`export class RenamedOrder {}\n`, 'utf-8'),
      );
      const deadline = Date.now() + 8000;
      let labels: string[] = [];
      while (Date.now() < deadline) {
        await wait(400);
        const list = await suggestionsAt(root, 'src/consumer.ts', 'Order', 5);
        labels = autoImportItems(list).map(labelOf);
        if (!labels.includes('Order')) return;
      }
      assert.fail(`Order should be gone but still got: ${labels.slice(0, 10).join(',')}`);
    } finally {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(original, 'utf-8'));
      await wait(400);
    }
  });
});

async function hasLabel(
  root: string,
  relPath: string,
  label: string,
  prefixLen: number,
): Promise<boolean> {
  try {
    const uri = vscode.Uri.file(path.join(root, relPath));
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    const positions = wordPositions(text, label);
    const idx = positions[1] ?? positions[0];
    if (idx === undefined) return false;
    const pos = doc.positionAt(idx + prefixLen);
    const list = (await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      uri,
      pos,
    )) as vscode.CompletionList | undefined;
    if (!list) return false;
    return list.items.some(
      (i) => labelOf(i) === label && typeof i.detail === 'string' && i.detail.startsWith('↪'),
    );
  } catch {
    return false;
  }
}

function findByLabel(list: vscode.CompletionList, label: string): vscode.CompletionItem {
  const item = autoImportItems(list).find((i) => labelOf(i) === label);
  if (!item) {
    const all = list.items.map(labelOf).slice(0, 10).join(', ');
    throw new Error(`${label} not found in auto-import suggestions. labels: ${all}`);
  }
  return item;
}
