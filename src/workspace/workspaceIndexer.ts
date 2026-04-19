import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type Parser from 'web-tree-sitter';
import type { Config } from '../config';
import { equalHash, hashContent } from '../index/hash';
import type { SymbolIndex } from '../index/symbolIndex';
import { SymbolFlag, SymbolKind, type ExportedSymbol } from '../index/types';
import type { Logger } from '../logger';
import { languageForPath, type ExtractionResult, type ParserLanguage, type ReExportEntry } from '../parsers/base';
import { extractJava } from '../parsers/java';
import { extractPython } from '../parsers/python';
import { extractTypeScript } from '../parsers/typescript';
import { parseSource } from '../parsers/treeSitter';
import { resolveReExportPath } from './reExportResolver';

export class WorkspaceIndexer {
  private reExportsByBarrel = new Map<string, ReExportEntry[]>();
  private resolvedTargetsByBarrel = new Map<string, Set<string>>();
  private barrelsByTarget = new Map<string, Set<string>>();
  private inFlight = new Set<string>();

  constructor(
    private readonly index: SymbolIndex,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly workspaceRoot: string,
  ) {}

  async indexFile(filePath: string, overrideSource?: string): Promise<void> {
    if (this.inFlight.has(filePath)) return;
    this.inFlight.add(filePath);
    try {
      await this.doIndexFile(filePath, overrideSource);
    } finally {
      this.inFlight.delete(filePath);
    }
  }

  async removeFile(filePath: string): Promise<void> {
    this.clearBarrelDeps(filePath);
    this.reExportsByBarrel.delete(filePath);
    this.index.removeFile(filePath);
    await this.cascadeToBarrels(filePath);
  }

  async reflattenAllBarrels(): Promise<void> {
    for (const [barrelPath, reExports] of this.reExportsByBarrel) {
      if (reExports.length === 0) continue;
      await this.reflattenBarrel(barrelPath);
    }
  }

  private async doIndexFile(filePath: string, overrideSource?: string): Promise<void> {
    const lang = languageForPath(filePath);
    if (!lang || !this.config.languages.includes(lang)) return;

    let source: string;
    let mtime: number;
    if (overrideSource !== undefined) {
      source = overrideSource;
      mtime = Date.now();
    } else {
      try {
        const stat = await fs.stat(filePath);
        mtime = stat.mtimeMs;
        source = await fs.readFile(filePath, 'utf-8');
      } catch (err) {
        this.logger.error(`read failed: ${filePath}`, err);
        return;
      }
    }

    const hash = hashContent(source);
    const existing = this.index.getFile(filePath);
    if (
      existing &&
      equalHash(existing.contentHash, hash) &&
      overrideSource === undefined
    ) {
      return;
    }

    let tree: Parser.Tree;
    try {
      tree = await parseSource(lang, source);
    } catch (err) {
      this.logger.error(`parse failed: ${filePath}`, err);
      return;
    }

    const result = extractForLang(lang, tree, this.config);
    const fileQualifier = this.computeFileQualifier(filePath, lang, result);

    this.clearBarrelDeps(filePath);
    this.reExportsByBarrel.set(filePath, result.reExports);

    const flattened = await this.flattenBarrel(filePath, lang, result.reExports);
    const allExports = mergeExports(result.exports, flattened);
    this.index.upsertFile(filePath, hash, mtime, allExports, fileQualifier);

    await this.cascadeToBarrels(filePath);
  }

  private async reflattenBarrel(barrelPath: string): Promise<void> {
    const lang = languageForPath(barrelPath);
    if (!lang) return;
    const reExports = this.reExportsByBarrel.get(barrelPath) ?? [];
    const file = this.index.getFile(barrelPath);
    if (!file) return;
    const ownExports = file.exports.filter((e) => !(e.flags & SymbolFlag.ReExport));

    this.clearBarrelDeps(barrelPath);
    const flattened = await this.flattenBarrel(barrelPath, lang, reExports);
    const allExports = mergeExports(ownExports, flattened);
    this.index.upsertFile(barrelPath, file.contentHash, file.mtime, allExports, file.fileQualifier);
  }

  private async flattenBarrel(
    barrelPath: string,
    lang: ParserLanguage,
    reExports: ReExportEntry[],
  ): Promise<ExportedSymbol[]> {
    const out: ExportedSymbol[] = [];
    const resolvedTargets = new Set<string>();

    for (const re of reExports) {
      const targetPath = await resolveReExportPath(re.fromPath, barrelPath, lang);
      if (!targetPath) continue;
      if (targetPath === barrelPath) continue;
      resolvedTargets.add(targetPath);

      const targetFile = this.index.getFile(targetPath);
      if (!targetFile) continue;

      if (re.names === 'all') {
        for (const exp of targetFile.exports) {
          if (exp.flags & SymbolFlag.DefaultExport) continue;
          out.push({
            name: exp.name,
            kind: exp.kind,
            flags: (exp.flags | SymbolFlag.ReExport) & ~SymbolFlag.DefaultExport,
            parentQualifier: exp.parentQualifier,
            sourcePath: exp.sourcePath ?? targetPath,
          });
        }
      } else {
        const byName = new Map<string, ExportedSymbol>();
        for (const e of targetFile.exports) byName.set(e.name, e);
        for (const n of re.names) {
          const sourceName = n.sourceName ?? n.exportedName;
          const sourceExp = byName.get(sourceName);
          out.push({
            name: n.exportedName,
            kind: sourceExp?.kind ?? SymbolKind.Variable,
            flags: (sourceExp?.flags ?? 0) | SymbolFlag.ReExport,
            parentQualifier: sourceExp?.parentQualifier,
            sourcePath: sourceExp?.sourcePath ?? targetPath,
          });
        }
      }
    }

    this.resolvedTargetsByBarrel.set(barrelPath, resolvedTargets);
    for (const target of resolvedTargets) {
      this.addBarrelDep(target, barrelPath);
    }
    return out;
  }

  private addBarrelDep(target: string, barrel: string): void {
    let set = this.barrelsByTarget.get(target);
    if (!set) {
      set = new Set();
      this.barrelsByTarget.set(target, set);
    }
    set.add(barrel);
  }

  private clearBarrelDeps(barrelPath: string): void {
    const targets = this.resolvedTargetsByBarrel.get(barrelPath);
    if (!targets) return;
    for (const target of targets) {
      const barrels = this.barrelsByTarget.get(target);
      if (!barrels) continue;
      barrels.delete(barrelPath);
      if (barrels.size === 0) this.barrelsByTarget.delete(target);
    }
    this.resolvedTargetsByBarrel.delete(barrelPath);
  }

  private async cascadeToBarrels(changedFile: string): Promise<void> {
    const barrels = this.barrelsByTarget.get(changedFile);
    if (!barrels || barrels.size === 0) return;
    const snapshot = [...barrels];
    for (const barrel of snapshot) {
      if (this.inFlight.has(barrel)) continue;
      await this.reflattenBarrel(barrel);
    }
  }

  private computeFileQualifier(
    filePath: string,
    lang: ParserLanguage,
    result: ExtractionResult,
  ): string | undefined {
    if (result.fileQualifier) return result.fileQualifier;
    if (lang === 'python') {
      return computePythonModule(filePath, this.workspaceRoot);
    }
    return undefined;
  }
}

function extractForLang(
  lang: ParserLanguage,
  tree: Parser.Tree,
  config: Config,
): ExtractionResult {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return extractTypeScript(tree);
    case 'python':
      return extractPython(tree, config.python.respectAllDunder);
    case 'java':
      return extractJava(tree, config.java.includeInnerClasses);
  }
}

function mergeExports(
  own: ExportedSymbol[],
  flattened: ExportedSymbol[],
): ExportedSymbol[] {
  if (flattened.length === 0) return own;
  const seenOwn = new Set<string>();
  for (const e of own) seenOwn.add(keyForDedup(e));
  const out = [...own];
  for (const e of flattened) {
    if (!seenOwn.has(keyForDedup(e))) out.push(e);
  }
  return out;
}

function keyForDedup(e: ExportedSymbol): string {
  return `${e.parentQualifier ?? ''}::${e.name}`;
}

function computePythonModule(filePath: string, workspaceRoot: string): string | undefined {
  const rel = path.relative(workspaceRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const noExt = rel.replace(/\.(py|pyi)$/, '');
  const parts = noExt.split(path.sep);
  if (parts[parts.length - 1] === '__init__') parts.pop();
  if (parts.length === 0) return undefined;
  return parts.join('.');
}
