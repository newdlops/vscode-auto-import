import * as vscode from 'vscode';
import type { Config } from '../../config';
import type { HotEntry } from '../../index/hotIndex';
import type { IndexedFile, SymbolIndex } from '../../index/symbolIndex';
import type { ParserLanguage } from '../../parsers/base';
import { buildJavaImportEdits } from './java';
import { buildPythonImportEdits } from './python';
import { buildTsImportEdits } from './typescript';

export function buildImportEdits(
  doc: vscode.TextDocument,
  lang: ParserLanguage,
  name: string,
  entry: HotEntry,
  targetFile: IndexedFile,
  index: SymbolIndex,
  config: Config,
): vscode.TextEdit[] {
  const targetPath = index.paths.get(targetFile.pathId);
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return buildTsImportEdits(doc, name, targetPath, entry.flags, config);
    case 'python': {
      const module = targetFile.fileQualifier;
      if (!module) return [];
      return buildPythonImportEdits(doc, name, module);
    }
    case 'java': {
      const pkg = targetFile.fileQualifier;
      if (!pkg) return [];
      const parent =
        entry.parentNameId !== undefined ? index.names.get(entry.parentNameId) : undefined;
      return buildJavaImportEdits(doc, name, pkg, parent);
    }
  }
}
