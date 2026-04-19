import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfig, type Config } from './config';
import { loadIndex, saveIndex } from './index/persistence';
import { SymbolIndex } from './index/symbolIndex';
import { createLogger, type Logger } from './logger';
import { disposeTreeSitter, setWasmRoot } from './parsers/treeSitter';
import { scanWorkspace } from './workspace/scanner';
import { WorkspaceWatcher } from './workspace/watcher';
import { WorkspaceIndexer } from './workspace/workspaceIndexer';
import { AutoImportCompletionProvider } from './completion/provider';

let logger: Logger | undefined;
let index: SymbolIndex = new SymbolIndex();
let cacheDir: string | undefined;
let workspaceIndexer: WorkspaceIndexer | undefined;
let watcher: WorkspaceWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger = createLogger('Auto Import');
  context.subscriptions.push({ dispose: () => logger?.dispose() });

  const config = getConfig();
  logger.info(`activating — languages: [${config.languages.join(', ')}]`);

  setWasmRoot(path.join(context.extensionPath, 'resources', 'wasm'));

  cacheDir = resolveCacheDir(context, config);
  if (cacheDir) {
    try {
      const loaded = await loadIndex(cacheDir);
      if (loaded) {
        index = loaded;
        const { files, names, hotEntries } = index.stats();
        logger.info(
          `cache loaded (${files} files, ${names} names, ${hotEntries} symbols) from ${cacheDir}`,
        );
      } else {
        logger.info('no cache found, starting fresh');
      }
    } catch (err) {
      logger.error('failed to load cache', err);
    }
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    workspaceIndexer = new WorkspaceIndexer(index, config, logger, workspaceRoot);
    watcher = new WorkspaceWatcher(workspaceIndexer, config, logger);
    watcher.start();
    context.subscriptions.push(watcher);

    scanWorkspace(workspaceIndexer, config, logger).then(
      (count) => {
        const s = index.stats();
        logger?.info(
          `initial scan: ${count} files → ${s.hotEntries} symbols, ${s.names} names`,
        );
      },
      (err) => logger?.error('initial scan failed', err),
    );
  } else {
    logger.info('no workspace folder, skipping scan');
  }

  const completionProvider = new AutoImportCompletionProvider(index, config);
  const selectors: vscode.DocumentFilter[] = [];
  if (config.languages.includes('typescript')) {
    selectors.push({ language: 'typescript', scheme: 'file' });
    selectors.push({ language: 'typescriptreact', scheme: 'file' });
  }
  if (config.languages.includes('javascript')) {
    selectors.push({ language: 'javascript', scheme: 'file' });
    selectors.push({ language: 'javascriptreact', scheme: 'file' });
  }
  if (config.languages.includes('python')) {
    selectors.push({ language: 'python', scheme: 'file' });
  }
  if (config.languages.includes('java')) {
    selectors.push({ language: 'java', scheme: 'file' });
  }
  if (selectors.length > 0) {
    context.subscriptions.push(
      vscode.languages.registerCompletionItemProvider(selectors, completionProvider),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('autoImport.rebuildIndex', async () => {
      if (!workspaceIndexer) {
        await vscode.window.showWarningMessage('Auto Import: no workspace folder open');
        return;
      }
      logger?.info('rebuilding index…');
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Auto Import: rebuilding index' },
        async (progress) => {
          const count = await scanWorkspace(workspaceIndexer!, config, logger!, (done, total) => {
            progress.report({ message: `${done}/${total}` });
          });
          const s = index.stats();
          logger?.info(`rebuild: ${count} files → ${s.hotEntries} symbols`);
        },
      );
    }),
    vscode.commands.registerCommand('autoImport.showCacheStats', async () => {
      const s = index.stats();
      const msg =
        `files: ${s.files} | names: ${s.names} | paths: ${s.paths} | ` +
        `hot: ${s.hotEntries} | trigrams: ${s.trigrams}`;
      logger?.info(`stats: ${msg}`);
      await vscode.window.showInformationMessage(`Auto Import — ${msg}`);
    }),
  );

  logger.info('activated');
}

export async function deactivate(): Promise<void> {
  logger?.info('deactivating');
  watcher?.dispose();
  watcher = undefined;
  if (cacheDir && index.fileCount() > 0) {
    try {
      await saveIndex(cacheDir, index);
      logger?.info(`cache saved to ${cacheDir}`);
    } catch (err) {
      logger?.error('failed to save cache', err);
    }
  }
  disposeTreeSitter();
  logger?.dispose();
}

function resolveCacheDir(
  context: vscode.ExtensionContext,
  config: Config,
): string | undefined {
  if (config.cache.location === 'global') {
    return context.globalStorageUri.fsPath;
  }
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return undefined;
  return path.join(ws.uri.fsPath, '.vscode', '.auto-import-cache');
}
