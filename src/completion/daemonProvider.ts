import * as vscode from 'vscode';
import type { Config } from '../config';
import type { DaemonClient, Suggestion } from '../daemon/client';
import type { Logger } from '../logger';
import { languageForPath, type ParserLanguage } from '../parsers/base';
import { getAlreadyImportedSymbols } from './existingImports';
import { buildImportEditsFor } from './importInserter';
import { SymbolKind } from '../index/types';

const IDENT_RE = /[A-Za-z_$][\w$]*/;

interface ImportsCacheEntry {
  version: number;
  set: Set<string>;
}

export class DaemonCompletionProvider implements vscode.CompletionItemProvider {
  private readonly importsCache = new WeakMap<vscode.TextDocument, ImportsCacheEntry>();

  constructor(
    private readonly getClient: () => DaemonClient | undefined,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const lang = languageForPath(document.uri.fsPath);
    if (!lang || !this.config.languages.includes(lang)) return undefined;

    const wordRange = document.getWordRangeAtPosition(position, IDENT_RE);
    if (!wordRange) return undefined;
    const prefix = document.getText(wordRange);
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

    const items: vscode.CompletionItem[] = [];
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i]!;
      const edits = buildImportEditsFor(
        document,
        lang,
        {
          name: s.name,
          flags: s.flags,
          targetPath: s.targetPath,
          fileQualifier: s.fileQualifier,
          parentQualifier: s.parentQualifier,
        },
        this.config,
      );
      if (edits.length === 0) continue;
      const item = this.buildItem(document, wordRange, s, lang);
      item.additionalTextEdits = edits;
      item.sortText = String(i).padStart(4, '0');
      items.push(item);
    }
    return items;
  }

  private getCachedImports(doc: vscode.TextDocument, lang: ParserLanguage): Set<string> {
    const cached = this.importsCache.get(doc);
    if (cached && cached.version === doc.version) return cached.set;
    const set = getAlreadyImportedSymbols(doc.getText(), lang);
    this.importsCache.set(doc, { version: doc.version, set });
    return set;
  }

  private buildItem(
    doc: vscode.TextDocument,
    wordRange: vscode.Range,
    s: Suggestion,
    lang: ParserLanguage,
  ): vscode.CompletionItem {
    const from = importSpecifier(doc, s, lang);
    const reMark = s.flags & 0x04 ? ' (re-export)' : '';
    const item = new vscode.CompletionItem(
      { label: s.name, description: `${from}${reMark}` },
      toVsCodeKind(s.kind),
    );
    item.range = wordRange;
    item.insertText = s.name;
    item.detail = `↪ auto-import from ${from}${reMark}`;
    item.filterText = s.name;
    return item;
  }
}

function importSpecifier(
  doc: vscode.TextDocument,
  s: Suggestion,
  lang: ParserLanguage,
): string {
  if (s.fileQualifier) {
    if (lang === 'java' && s.parentQualifier) {
      return `${s.fileQualifier}.${s.parentQualifier}.${s.name}`;
    }
    if (lang === 'java') return `${s.fileQualifier}.${s.name}`;
    return s.fileQualifier;
  }
  const path = require('node:path') as typeof import('node:path');
  let rel = path.relative(path.dirname(doc.uri.fsPath), s.targetPath).replace(/\\/g, '/');
  rel = rel.replace(/\.d\.(ts|mts|cts)$/, '').replace(/\.(ts|tsx|mts|cts|jsx|mjs|cjs|js)$/, '');
  rel = rel.replace(/\/index$/, '');
  if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
  return rel;
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
