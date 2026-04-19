import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ParserLanguage } from '../parsers/base';

const TS_EXTS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_INDEX_FILES = [
  'index.ts',
  'index.tsx',
  'index.d.ts',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
];

export async function resolveReExportPath(
  fromPath: string,
  barrelFilePath: string,
  lang: ParserLanguage,
): Promise<string | undefined> {
  if (lang === 'typescript' || lang === 'javascript') {
    return resolveTs(fromPath, barrelFilePath);
  }
  if (lang === 'python') {
    return resolvePython(fromPath, barrelFilePath);
  }
  return undefined;
}

async function resolveTs(fromPath: string, barrelPath: string): Promise<string | undefined> {
  if (!fromPath.startsWith('.') && !fromPath.startsWith('/')) {
    return undefined;
  }
  const barrelDir = path.dirname(barrelPath);
  const absBase = path.resolve(barrelDir, fromPath);

  for (const ext of TS_EXTS) {
    const candidate = absBase + ext;
    if (await fileExists(candidate)) return candidate;
  }
  for (const indexFile of TS_INDEX_FILES) {
    const candidate = path.join(absBase, indexFile);
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function resolvePython(fromPath: string, barrelPath: string): Promise<string | undefined> {
  if (!fromPath.startsWith('.')) return undefined;
  let leadingDots = 0;
  while (leadingDots < fromPath.length && fromPath[leadingDots] === '.') leadingDots++;

  let dir = path.dirname(barrelPath);
  for (let i = 1; i < leadingDots; i++) {
    dir = path.dirname(dir);
  }

  const afterDots = fromPath.slice(leadingDots);
  const parts = afterDots ? afterDots.split('.') : [];
  const targetBase = parts.length > 0 ? path.resolve(dir, ...parts) : dir;

  const pyFile = targetBase + '.py';
  if (await fileExists(pyFile)) return pyFile;
  const initPy = path.join(targetBase, '__init__.py');
  if (await fileExists(initPy)) return initPy;
  return undefined;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}
