import * as vscode from 'vscode';
import type { Config } from '../../config';
import type { ParserLanguage } from '../../parsers/base';
import { buildJavaImportEdits } from './java';
import { buildPythonImportEdits } from './python';
import { buildTsImportEdits } from './typescript';

export interface ImportContext {
  name: string;
  flags: number;
  targetPath: string;
  fileQualifier?: string;
  parentQualifier?: string;
}

export function buildImportEditsFor(
  doc: vscode.TextDocument,
  lang: ParserLanguage,
  ctx: ImportContext,
  config: Config,
): vscode.TextEdit[] {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return buildTsImportEdits(
        doc,
        ctx.name,
        ctx.targetPath,
        ctx.fileQualifier,
        ctx.flags,
        config,
      );
    case 'python': {
      if (!ctx.fileQualifier) return [];
      return buildPythonImportEdits(doc, ctx.name, ctx.fileQualifier);
    }
    case 'java': {
      if (!ctx.fileQualifier) return [];
      return buildJavaImportEdits(doc, ctx.name, ctx.fileQualifier, ctx.parentQualifier);
    }
  }
}
