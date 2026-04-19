import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Config } from '../config';
import type { HotEntry } from '../index/hotIndex';
import type { SymbolIndex } from '../index/symbolIndex';
import { SymbolFlag, SymbolKind } from '../index/types';
import { languageForPath } from '../parsers/base';
import { getAlreadyImportedSymbols } from './existingImports';
import { buildImportEdits } from './importInserter';
import { computeScore } from './scorer';

const IDENT_RE = /[A-Za-z_$][\w$]*/;

export class AutoImportCompletionProvider implements vscode.CompletionItemProvider {
  constructor(
    private readonly index: SymbolIndex,
    private readonly config: Config,
  ) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lang = languageForPath(document.uri.fsPath);
    if (!lang || !this.config.languages.includes(lang)) return undefined;

    const wordRange = document.getWordRangeAtPosition(position, IDENT_RE);
    if (!wordRange) return undefined;
    const prefix = document.getText(wordRange);
    if (prefix.length < this.config.minPrefixLength) return undefined;

    const source = document.getText();
    const alreadyImported = getAlreadyImportedSymbols(source, lang);
    const currentPath = document.uri.fsPath;

    const candidateIds = this.index.prefix.lookupPrefix(prefix, this.config.maxResults * 5);

    const scored: { item: vscode.CompletionItem; score: number }[] = [];
    for (const nameId of candidateIds) {
      const name = this.index.names.get(nameId);
      if (alreadyImported.has(name)) continue;
      const entries = this.index.hot.lookup(nameId);
      if (!entries || entries.length === 0) continue;

      for (const entry of entries) {
        const targetPath = this.index.paths.get(entry.fileId);
        if (targetPath === currentPath) continue;
        const targetLang = languageForPath(targetPath);
        if (targetLang !== lang) continue;

        const targetFile = this.index.getFile(targetPath);
        if (!targetFile) continue;

        const edits = buildImportEdits(
          document,
          lang,
          name,
          entry,
          targetFile,
          this.index,
          this.config,
        );
        if (edits.length === 0) continue;

        const item = this.buildItem(document, wordRange, name, entry, targetPath);
        item.additionalTextEdits = edits;

        const depth = targetPath.split(path.sep).length;
        scored.push({ item, score: computeScore(prefix, name, entry, depth) });

        if (scored.length >= this.config.maxResults * 5) break;
      }
      if (scored.length >= this.config.maxResults * 5) break;
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, this.config.maxResults);
    top.forEach((x, i) => {
      x.item.sortText = String(i).padStart(4, '0');
    });
    return top.map((x) => x.item);
  }

  private buildItem(
    doc: vscode.TextDocument,
    wordRange: vscode.Range,
    name: string,
    entry: HotEntry,
    targetPath: string,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, toVsCodeKind(entry.kind));
    item.range = wordRange;
    item.insertText = name;
    const rel = path.relative(path.dirname(doc.uri.fsPath), targetPath).replace(/\\/g, '/');
    const reMark = entry.flags & SymbolFlag.ReExport ? ' (re-export)' : '';
    item.detail = `↪ auto-import from ${rel}${reMark}`;
    item.filterText = name;
    return item;
  }
}

function toVsCodeKind(kind: SymbolKind): vscode.CompletionItemKind {
  switch (kind) {
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
