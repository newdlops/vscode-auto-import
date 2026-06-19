import * as vscode from 'vscode';
import type { Config } from '../config';
import type { DaemonClient, Suggestion } from '../daemon/client';
import { SymbolFlag, SymbolKind } from '../index/types';
import type { Logger } from '../logger';
import { languageForPath, type ParserLanguage } from '../parsers/base';
import { getAlreadyImportedSymbols } from './existingImports';
import { buildImportEditsFor } from './importInserter';
import { resolveTsModuleSpecifier } from './importInserter/tsModuleResolver';

const IDENT_RE = /[A-Za-z_$][\w$]*/;
const EXACT_IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const PROVIDER_LABEL = 'Auto Import Plus';

interface ImportsCacheEntry {
  version: number;
  set: Set<string>;
}

export interface AutoImportResolution {
  suggestion: Suggestion;
  wordRange: vscode.Range;
  edits: vscode.TextEdit[];
  detail: string;
  labelDescription: string;
}

export class AutoImportEngine {
  private readonly importsCache = new WeakMap<vscode.TextDocument, ImportsCacheEntry>();

  constructor(
    private readonly getClient: () => DaemonClient | undefined,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async resolveAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<AutoImportResolution[] | undefined> {
    const wordRange = document.getWordRangeAtPosition(position, IDENT_RE);
    return this.resolve(document, wordRange, token);
  }

  async resolveAtRange(
    document: vscode.TextDocument,
    range: vscode.Range,
    token: vscode.CancellationToken,
  ): Promise<AutoImportResolution[] | undefined> {
    return this.resolve(document, this.resolveWordRange(document, range), token);
  }

  toCompletionItem(
    resolution: AutoImportResolution,
    index: number,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
      {
        label: resolution.suggestion.name,
        detail: `  ${PROVIDER_LABEL}`,
        description: resolution.labelDescription,
      },
      toVsCodeKind(resolution.suggestion.kind),
    );
    item.range = resolution.wordRange;
    item.insertText = resolution.suggestion.name;
    item.detail = resolution.detail;
    item.filterText = resolution.suggestion.name;
    item.additionalTextEdits = resolution.edits;
    item.sortText = String(index).padStart(4, '0');
    return item;
  }

  toCodeAction(
    document: vscode.TextDocument,
    resolution: AutoImportResolution,
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(
      `Add import for '${resolution.suggestion.name}' from ${resolution.labelDescription}`,
      vscode.CodeActionKind.QuickFix,
    );
    const edit = new vscode.WorkspaceEdit();
    edit.set(document.uri, [
      vscode.TextEdit.replace(resolution.wordRange, resolution.suggestion.name),
      ...resolution.edits,
    ]);
    action.edit = edit;
    return action;
  }

  private async resolve(
    document: vscode.TextDocument,
    wordRange: vscode.Range | undefined,
    token: vscode.CancellationToken,
  ): Promise<AutoImportResolution[] | undefined> {
    const lang = languageForPath(document.uri.fsPath);
    if (!lang || !this.config.languages.includes(lang)) return undefined;
    if (!wordRange) return undefined;

    const prefix = document.getText(wordRange);
    if (!EXACT_IDENT_RE.test(prefix)) return undefined;
    if (prefix.length < this.config.minPrefixLength) return undefined;
    if (token.isCancellationRequested) return undefined;

    const client = this.getClient();
    if (!client || !client.isRunning()) return undefined;
    const alreadyImported = this.getCachedImports(document, lang);

    let suggestions: Suggestion[];
    try {
      const t0 = performance.now();
      suggestions = await client.query({
        prefix,
        currentPath: document.uri.fsPath,
        alreadyImported: [...alreadyImported],
        limit: this.config.maxResults,
        language: lang,
      });
      this.logger.debug(
        `query "${prefix}" → ${suggestions.length} suggestions in ${(performance.now() - t0).toFixed(1)}ms`,
      );
    } catch (err) {
      this.logger.warn(`daemon query failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }

    if (token.isCancellationRequested) return undefined;

    const resolutions: AutoImportResolution[] = [];
    for (const suggestion of suggestions) {
      const edits = buildImportEditsFor(
        document,
        lang,
        {
          name: suggestion.name,
          flags: suggestion.flags,
          targetPath: suggestion.targetPath,
          fileQualifier: suggestion.fileQualifier,
          parentQualifier: suggestion.parentQualifier,
        },
        this.config,
      );
      if (edits.length === 0) continue;

      const labelDescription = importSpecifier(document, suggestion, lang);
      const reExportMark =
        suggestion.flags & SymbolFlag.ReExport ? ' (re-export)' : '';
      const standardLibraryMark =
        suggestion.flags & SymbolFlag.StandardLibrary ? ' [standard library]' : '';
      resolutions.push({
        suggestion,
        wordRange,
        edits,
        labelDescription: `${labelDescription}${reExportMark}`,
        detail: `↪ auto-import from ${labelDescription}${reExportMark}${standardLibraryMark}`,
      });
    }

    return resolutions;
  }

  private getCachedImports(doc: vscode.TextDocument, lang: ParserLanguage): Set<string> {
    const cached = this.importsCache.get(doc);
    if (cached && cached.version === doc.version) return cached.set;
    const set = getAlreadyImportedSymbols(doc.getText(), lang);
    this.importsCache.set(doc, { version: doc.version, set });
    return set;
  }

  private resolveWordRange(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.Range | undefined {
    if (!range.isEmpty) {
      const selected = document.getText(range);
      if (EXACT_IDENT_RE.test(selected)) return range;
    }
    return (
      document.getWordRangeAtPosition(range.start, IDENT_RE) ??
      document.getWordRangeAtPosition(range.end, IDENT_RE)
    );
  }
}

function importSpecifier(
  doc: vscode.TextDocument,
  suggestion: Suggestion,
  lang: ParserLanguage,
): string {
  if (suggestion.fileQualifier) {
    if (lang === 'java' && suggestion.parentQualifier) {
      return `${suggestion.fileQualifier}.${suggestion.parentQualifier}.${suggestion.name}`;
    }
    if (lang === 'java') return `${suggestion.fileQualifier}.${suggestion.name}`;
    return suggestion.fileQualifier;
  }
  if (lang === 'typescript' || lang === 'javascript') {
    const resolved = resolveTsModuleSpecifier(doc.uri.fsPath, suggestion.targetPath);
    if (resolved) return resolved;
  }
  return suggestion.targetPath;
}

function toVsCodeKind(kind: number): vscode.CompletionItemKind {
  switch (kind as SymbolKind) {
    case SymbolKind.Class:
      return vscode.CompletionItemKind.Class;
    case SymbolKind.Function:
      return vscode.CompletionItemKind.Function;
    case SymbolKind.Variable:
      return vscode.CompletionItemKind.Variable;
    case SymbolKind.Interface:
      return vscode.CompletionItemKind.Interface;
    case SymbolKind.TypeAlias:
      return vscode.CompletionItemKind.TypeParameter;
    case SymbolKind.Enum:
      return vscode.CompletionItemKind.Enum;
    case SymbolKind.Namespace:
    case SymbolKind.Module:
      return vscode.CompletionItemKind.Module;
    case SymbolKind.Method:
      return vscode.CompletionItemKind.Method;
    case SymbolKind.Property:
      return vscode.CompletionItemKind.Property;
    default:
      return vscode.CompletionItemKind.Value;
  }
}
