import * as vscode from 'vscode';
import { AutoImportEngine } from './autoImportEngine';

export class DaemonCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly autoImport: AutoImportEngine) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const resolutions = await this.autoImport.resolveAtPosition(document, position, token);
    if (!resolutions?.length) return undefined;
    return resolutions.map((resolution, index) => this.autoImport.toCompletionItem(resolution, index));
  }
}
