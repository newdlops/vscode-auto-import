import * as vscode from 'vscode';
import type { Config, SupportedLanguage } from '../config';
import type { Logger } from '../logger';
import type { WorkspaceIndexer } from './workspaceIndexer';

const LANGUAGE_PATTERNS: Record<SupportedLanguage, string> = {
  typescript: '**/*.{ts,tsx,mts,cts}',
  javascript: '**/*.{js,jsx,mjs,cjs}',
  python: '**/*.{py,pyi}',
  java: '**/*.java',
};

export async function scanWorkspace(
  indexer: WorkspaceIndexer,
  config: Config,
  logger: Logger,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const excludePattern =
    config.excludeGlobs.length > 0 ? `{${config.excludeGlobs.join(',')}}` : undefined;
  const allFiles: vscode.Uri[] = [];
  for (const lang of config.languages) {
    const pattern = LANGUAGE_PATTERNS[lang];
    if (!pattern) continue;
    const uris = await vscode.workspace.findFiles(pattern, excludePattern);
    allFiles.push(...uris);
  }

  logger.info(`scanning ${allFiles.length} files…`);
  const start = Date.now();

  const CONCURRENCY = 8;
  let done = 0;
  await parallelMap(allFiles, CONCURRENCY, async (uri) => {
    await indexer.indexFile(uri.fsPath);
    done++;
    onProgress?.(done, allFiles.length);
  });

  await indexer.reflattenAllBarrels();

  const elapsed = Date.now() - start;
  logger.info(`scan complete: ${allFiles.length} files in ${elapsed}ms`);
  return allFiles.length;
}

async function parallelMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (true) {
          const my = idx++;
          if (my >= items.length) break;
          try {
            await fn(items[my]!);
          } catch {
            // swallow — logger already warned inside indexFile
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
}
