import * as path from 'node:path';
import Parser from 'web-tree-sitter';
import type { ParserLanguage } from './base';

const GRAMMAR_FILES: Record<ParserLanguage, string> = {
  typescript: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
};

let wasmRoot: string | undefined;
let initPromise: Promise<void> | undefined;
const languages = new Map<ParserLanguage, Parser.Language>();
const parsers = new Map<ParserLanguage, Parser>();

export function setWasmRoot(root: string): void {
  wasmRoot = root;
}

function ensureInit(): Promise<void> {
  if (!wasmRoot) throw new Error('tree-sitter: wasmRoot not set');
  if (!initPromise) {
    const root = wasmRoot;
    initPromise = Parser.init({
      locateFile: (name: string) => path.join(root, name),
    });
  }
  return initPromise;
}

export async function getParser(lang: ParserLanguage): Promise<Parser> {
  await ensureInit();
  let parser = parsers.get(lang);
  if (parser) return parser;

  let language = languages.get(lang);
  if (!language) {
    if (!wasmRoot) throw new Error('tree-sitter: wasmRoot not set');
    const wasmPath = path.join(wasmRoot, GRAMMAR_FILES[lang]);
    language = await Parser.Language.load(wasmPath);
    languages.set(lang, language);
  }
  parser = new Parser();
  parser.setLanguage(language);
  parsers.set(lang, parser);
  return parser;
}

export async function parseSource(lang: ParserLanguage, source: string): Promise<Parser.Tree> {
  const parser = await getParser(lang);
  return parser.parse(source);
}

export function disposeTreeSitter(): void {
  for (const parser of parsers.values()) parser.delete();
  parsers.clear();
  languages.clear();
}
