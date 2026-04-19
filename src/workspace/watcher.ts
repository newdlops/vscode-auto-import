import * as vscode from 'vscode';
import type { Config } from '../config';
import type { Logger } from '../logger';
import { languageForPath } from '../parsers/base';
import type { WorkspaceIndexer } from './workspaceIndexer';

const DEBOUNCE_MS = 200;

export class WorkspaceWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly indexer: WorkspaceIndexer,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onTextChange(e)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
    );

    const globs = ['**/*.{ts,tsx,mts,cts}', '**/*.{js,jsx,mjs,cjs}', '**/*.{py,pyi}', '**/*.java'];
    for (const g of globs) {
      const w = vscode.workspace.createFileSystemWatcher(g);
      w.onDidCreate((uri) => this.schedule(uri.fsPath, () => this.indexer.indexFile(uri.fsPath)));
      w.onDidChange((uri) => this.schedule(uri.fsPath, () => this.indexer.indexFile(uri.fsPath)));
      w.onDidDelete((uri) => {
        this.cancel(uri.fsPath);
        this.indexer.removeFile(uri.fsPath).catch((err) =>
          this.logger.error(`remove failed: ${uri.fsPath}`, err),
        );
      });
      this.disposables.push(w);
    }
  }

  private onTextChange(e: vscode.TextDocumentChangeEvent): void {
    if (!this.shouldHandle(e.document)) return;
    const filePath = e.document.uri.fsPath;
    const text = e.document.getText();
    this.schedule(filePath, () => this.indexer.indexFile(filePath, text));
  }

  private onSave(doc: vscode.TextDocument): void {
    if (!this.shouldHandle(doc)) return;
    const filePath = doc.uri.fsPath;
    this.cancel(filePath);
    this.indexer
      .indexFile(filePath, doc.getText())
      .catch((err) => this.logger.error(`index failed on save: ${filePath}`, err));
  }

  private shouldHandle(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file') return false;
    const lang = languageForPath(doc.uri.fsPath);
    if (!lang) return false;
    if (!this.config.languages.includes(lang)) return false;
    return true;
  }

  private schedule(key: string, fn: () => Promise<void>): void {
    this.cancel(key);
    const t = setTimeout(() => {
      this.timers.delete(key);
      fn().catch((err) => this.logger.error(`indexer task failed: ${key}`, err));
    }, DEBOUNCE_MS);
    this.timers.set(key, t);
  }

  private cancel(key: string): void {
    const t = this.timers.get(key);
    if (t) {
      clearTimeout(t);
      this.timers.delete(key);
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
