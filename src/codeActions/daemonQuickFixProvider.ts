import * as vscode from 'vscode';
import { AutoImportEngine } from '../completion/autoImportEngine';

export class DaemonQuickFixProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly autoImport: AutoImportEngine) {}

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[] | undefined> {
    if (context.only && !context.only.contains(vscode.CodeActionKind.QuickFix)) {
      return undefined;
    }

    const resolutions = await this.autoImport.resolveAtRange(document, range, token);
    if (!resolutions?.length) return undefined;

    return resolutions.map((resolution, index) => {
      const action = this.autoImport.toCodeAction(document, resolution);
      if (context.diagnostics.length > 0) {
        action.diagnostics = [...context.diagnostics];
      }
      action.isPreferred = index === 0;
      return action;
    });
  }
}
