import * as path from 'node:path';
import * as vscode from 'vscode';
import { DaemonQuickFixProvider } from './codeActions/daemonQuickFixProvider';
import { AutoImportEngine } from './completion/autoImportEngine';
import { DaemonCompletionProvider } from './completion/daemonProvider';
import { getConfig, type Config } from './config';
import { DaemonClient, ensureDaemonBinary, type InitParams, type InitResult } from './daemon/client';
import { createLogger, type Logger } from './logger';
import { languageForPath } from './parsers/base';

let logger: Logger | undefined;
let client: DaemonClient | undefined;
let lastInitResult: InitResult | undefined;
let lastInitParams: InitParams | undefined;
let daemonBinaryPath: string | undefined;
const debounceTimers = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 200;

function scheduleIndex(filePath: string, task: () => Promise<void>): void {
  cancelScheduled(filePath);
  const t = setTimeout(() => {
    debounceTimers.delete(filePath);
    task().catch((err) => logger?.warn(`indexer task failed: ${filePath} — ${err}`));
  }, DEBOUNCE_MS);
  debounceTimers.set(filePath, t);
}

function cancelScheduled(filePath: string): void {
  const t = debounceTimers.get(filePath);
  if (t) {
    clearTimeout(t);
    debounceTimers.delete(filePath);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = getConfig();
  logger = createLogger('Auto Import', config.logLevel === 'debug');
  context.subscriptions.push({ dispose: () => logger?.dispose() });

  logger.info(`=== Auto Import activating ===`);
  logger.info(`extensionPath: ${context.extensionPath}`);
  logger.info(`languages: [${config.languages.join(', ')}]`);
  logger.info(
    `minPrefix=${config.minPrefixLength} maxResults=${config.maxResults} logLevel=${config.logLevel}`,
  );

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    logger.info('no workspace folder — daemon not started');
  } else {
    let binaryPath: string;
    try {
      binaryPath = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Auto Import: preparing native indexer',
        },
        () =>
          ensureDaemonBinary({
            extensionPath: context.extensionPath,
            storagePath: context.globalStorageUri.fsPath,
            extensionVersion: String(context.extension.packageJSON.version ?? 'dev'),
            logger: logger!,
          }),
      );
    } catch (err) {
      const msg =
        'native daemon build failed. Install Rust/Cargo and check the Auto Import output log.';
      logger.error(msg, err);
      const choice = await vscode.window.showErrorMessage(`Auto Import: ${msg}`, 'Show Logs');
      if (choice === 'Show Logs') logger.show();
      return;
    }
    logger.info(`daemon binary: ${binaryPath}`);

    const cacheDir =
      config.cache.location === 'global'
        ? path.join(context.globalStorageUri.fsPath, 'index-cache')
        : path.join(workspaceRoot, '.vscode', '.auto-import-cache');
    logger.info(`cache dir: ${cacheDir}`);
    daemonBinaryPath = binaryPath;
    const initParams: InitParams = {
      workspaceRoot,
      excludeGlobs: config.excludeGlobs,
      languages: config.languages,
      pythonRespectAll: config.python.respectAllDunder,
      javaIncludeInner: config.java.includeInnerClasses,
      librariesEnabled: config.libraries.enabled,
      librariesTsNodeModules: config.libraries.tsNodeModules,
      librariesPythonSitePackages: config.libraries.pythonSitePackages,
      librariesPythonMaxDepth: config.libraries.pythonMaxDepth,
      librariesPythonExtraPaths: config.libraries.pythonExtraPaths,
      logLevel: config.logLevel,
      cacheDir,
    };
    lastInitParams = initParams;
    client = new DaemonClient(binaryPath, logger);
    wireDaemonNotifications(client, logger);
    try {
      lastInitResult = await client.start(initParams);
      logger.info(
        `daemon initialized (cacheLoaded=${lastInitResult.cacheLoaded} cachedFiles=${lastInitResult.cachedFiles})`,
      );
      void client.scan().then(() => logger?.info('scan complete')).catch((err) => {
        logger?.error('scan failed', err);
      });
    } catch (err) {
      logger.error('daemon failed to start', err);
      client = undefined;
    }
  }

  if (client) {
    const autoImport = new AutoImportEngine(() => client, config, logger);
    const completionProvider = new DaemonCompletionProvider(autoImport);
    const quickFixProvider = new DaemonQuickFixProvider(autoImport);
    const selectors = buildSelectors(config);
    if (selectors.length > 0) {
      context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(selectors, completionProvider),
        vscode.languages.registerCodeActionsProvider(
          selectors,
          quickFixProvider,
          DaemonQuickFixProvider.metadata,
        ),
      );
      logger.info(
        `completion/code action providers registered for [${selectors.map((s) => s.language).join(', ')}]`,
      );
    }

    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!client) return;
        if (e.document.uri.scheme !== 'file') return;
        const lang = languageForPath(e.document.uri.fsPath);
        if (!lang || !config.languages.includes(lang)) return;
        scheduleIndex(e.document.uri.fsPath, () =>
          client!.indexFile(e.document.uri.fsPath, e.document.getText()),
        );
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        if (!client) return;
        for (const uri of e.files) {
          client.removeFile(uri.fsPath).catch((err) => logger?.warn(`removeFile: ${err}`));
        }
      }),
    );

    const fsGlob = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,pyi,java}';
    const fsWatcher = vscode.workspace.createFileSystemWatcher(fsGlob);
    fsWatcher.onDidCreate((uri) => {
      if (!client) return;
      logger?.debug(`fs create: ${uri.fsPath}`);
      scheduleIndex(uri.fsPath, () => client!.indexFile(uri.fsPath));
    });
    fsWatcher.onDidChange((uri) => {
      if (!client) return;
      logger?.debug(`fs change: ${uri.fsPath}`);
      scheduleIndex(uri.fsPath, () => client!.indexFile(uri.fsPath));
    });
    fsWatcher.onDidDelete((uri) => {
      if (!client) return;
      logger?.debug(`fs delete: ${uri.fsPath}`);
      cancelScheduled(uri.fsPath);
      client.removeFile(uri.fsPath).catch((err) => logger?.warn(`removeFile: ${err}`));
    });
    context.subscriptions.push(fsWatcher);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('autoImport.rebuildIndex', async () => {
      if (!client) {
        await vscode.window.showWarningMessage('Auto Import: daemon not running');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Auto Import: rebuilding index' },
        async () => {
          await client!.scan();
          const { index } = await client!.stats();
          logger?.info(`rebuild done — ${index.files} files, ${index.hot_entries} symbols`);
        },
      );
    }),
    vscode.commands.registerCommand('autoImport.showCacheStats', async () => {
      if (!client) {
        await vscode.window.showWarningMessage('Auto Import: daemon not running');
        return;
      }
      const { index, indexer } = await client.stats();
      const msg = `files=${index.files} symbols=${index.hot_entries} names=${index.names} | parsed=${indexer.parsed} failed=${indexer.parse_failures} fallback=${indexer.python_regex_fallbacks}`;
      logger?.info(msg);
      await vscode.window.showInformationMessage(`Auto Import — ${msg}`);
    }),
    vscode.commands.registerCommand('autoImport.showLogs', () => {
      logger?.show();
    }),
    vscode.commands.registerCommand('autoImport.daemonStatus', () => {
      return {
        running: client?.isRunning() ?? false,
        lastInit: lastInitResult,
      };
    }),
    vscode.commands.registerCommand('autoImport.restartDaemon', async () => {
      if (!daemonBinaryPath || !lastInitParams || !logger) return false;
      logger.info('restarting daemon…');
      if (client) {
        try {
          await client.shutdown();
        } catch (err) {
          logger.warn(`shutdown during restart: ${err}`);
        }
      }
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      client = new DaemonClient(daemonBinaryPath, logger);
      wireDaemonNotifications(client, logger);
      try {
        lastInitResult = await client.start(lastInitParams);
        logger.info(
          `daemon restarted (cacheLoaded=${lastInitResult.cacheLoaded} cachedFiles=${lastInitResult.cachedFiles})`,
        );
        return true;
      } catch (err) {
        logger.error('daemon restart failed', err);
        client = undefined;
        return false;
      }
    }),
  );

  logger.info('activated');
}

export async function deactivate(): Promise<void> {
  logger?.info('deactivating');
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  if (client) {
    try {
      await client.shutdown();
    } catch (err) {
      logger?.warn(`shutdown: ${err}`);
    }
  }
  logger?.dispose();
}

function wireDaemonNotifications(client: DaemonClient, logger: Logger): void {
  client.onNotification((method, params) => {
    const p = params as Record<string, unknown>;
    switch (method) {
      case 'ready':
        logger.info(`daemon ready: protocol=${p.protocol} v${p.version}`);
        break;
      case 'log': {
        const level = (p.level as string) ?? 'info';
        const message = String(p.message ?? '');
        if (level === 'error') logger.error(message);
        else if (level === 'warn') logger.warn(message);
        else logger.info(message);
        break;
      }
      case 'scanProgress': {
        const done = Number(p.done ?? 0);
        const total = Number(p.total ?? 0);
        if (total > 0) {
          logger.info(`scan progress: ${done}/${total} (${Math.floor((done / total) * 100)}%)`);
        }
        break;
      }
      case 'scanComplete': {
        const total = Number(p.total ?? 0);
        const elapsed = Number(p.elapsedMs ?? 0);
        const index = (p.index as Record<string, number>) ?? {};
        logger.info(
          `scanComplete: ${total} files in ${elapsed}ms | symbols=${index.hot_entries} names=${index.names}`,
        );
        break;
      }
      case 'librariesScanComplete': {
        const ts = Number(p.ts ?? 0);
        const py = Number(p.python ?? 0);
        const elapsed = Number(p.elapsedMs ?? 0);
        const indexer = (p.indexer as Record<string, number>) ?? {};
        logger.info(
          `librariesScanComplete: ts=${ts} py=${py} in ${elapsed}ms | failures=${indexer.parse_failures} fallback=${indexer.python_regex_fallbacks}`,
        );
        break;
      }
      default:
        logger.debug(`daemon notif ${method}: ${JSON.stringify(params)}`);
    }
  });
}

function buildSelectors(config: Config): vscode.DocumentFilter[] {
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
  return selectors;
}
