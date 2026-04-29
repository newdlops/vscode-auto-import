import * as fs from 'node:fs';
import * as path from 'node:path';

// Resolves the best module specifier for a TS/JS import.
//
// Order of preference:
//   1. node_modules → package name (+ optional sub-path) from package.json
//   2. tsconfig.json `paths` aliases (closest tsconfig walking up from the
//      current file) — if any pattern maps to the target file
//   3. Relative path from current file's directory
//
// Read results are cached with mtime-based invalidation to avoid re-parsing
// tsconfig.json on every completion.

export function resolveTsModuleSpecifier(
  currentFile: string,
  targetFile: string,
): string | undefined {
  if (!targetFile) return undefined;

  const pkg = resolveNodeModulesSpecifier(targetFile);
  if (pkg) return pkg;

  const aliased = resolveTsConfigAlias(currentFile, targetFile);
  if (aliased) return aliased;

  return toRelativeModule(currentFile, targetFile);
}

function resolveNodeModulesSpecifier(targetFile: string): string | undefined {
  const norm = targetFile.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/node_modules/');
  if (idx < 0) return undefined;
  const after = norm.slice(idx + '/node_modules/'.length);
  if (!after) return undefined;

  const segments = after.split('/');
  let pkgName: string;
  let pkgRootRel: string;
  if (segments[0] && segments[0].startsWith('@')) {
    if (segments.length < 2) return undefined;
    pkgName = `${segments[0]}/${segments[1]}`;
    pkgRootRel = `${segments[0]}/${segments[1]}`;
  } else {
    pkgName = segments[0]!;
    pkgRootRel = segments[0]!;
  }

  const pkgRootAbs = norm.slice(0, idx + '/node_modules/'.length) + pkgRootRel;
  const pkgJsonPath = path.join(pkgRootAbs, 'package.json');

  let actualName = pkgName;
  const cached = readPackageJsonCached(pkgJsonPath);
  if (cached?.name) actualName = cached.name;

  const subPath = norm.slice(pkgRootAbs.length).replace(/^\//, '');
  const stripped = stripTsExtension(subPath);
  if (!stripped || stripped === 'index' || stripped === 'index.d') return actualName;
  return `${actualName}/${stripped}`;
}

interface PackageJsonInfo {
  name?: string;
  mtimeMs: number;
}
const packageJsonCache = new Map<string, PackageJsonInfo | null>();

function readPackageJsonCached(pkgJsonPath: string): PackageJsonInfo | null {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(pkgJsonPath);
  } catch {
    packageJsonCache.set(pkgJsonPath, null);
    return null;
  }
  const cached = packageJsonCache.get(pkgJsonPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  try {
    const raw = fs.readFileSync(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    const info: PackageJsonInfo = {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      mtimeMs: stat.mtimeMs,
    };
    packageJsonCache.set(pkgJsonPath, info);
    return info;
  } catch {
    packageJsonCache.set(pkgJsonPath, null);
    return null;
  }
}

interface TsConfigAliases {
  baseDir: string;
  baseUrl?: string;
  paths: Array<{ pattern: string; targets: string[] }>;
  mtimeMs: number;
}
const tsConfigCache = new Map<string, TsConfigAliases | null>();
const tsConfigDirCache = new Map<string, string | undefined>();

function resolveTsConfigAlias(currentFile: string, targetFile: string): string | undefined {
  const tsconfigPath = findNearestTsConfig(path.dirname(currentFile));
  if (!tsconfigPath) return undefined;
  const cfg = readTsConfigCached(tsconfigPath);
  if (!cfg) return undefined;

  const baseAbs = cfg.baseUrl ? path.resolve(cfg.baseDir, cfg.baseUrl) : cfg.baseDir;
  const targetNorm = targetFile.replace(/\\/g, '/');

  let best: string | undefined;
  let bestSpecificity = -1;
  for (const entry of cfg.paths) {
    for (const target of entry.targets) {
      const candidate = matchAlias(entry.pattern, target, baseAbs, targetNorm);
      if (!candidate) continue;
      const specificity = entry.pattern.replace('*', '').length;
      if (specificity > bestSpecificity) {
        best = candidate;
        bestSpecificity = specificity;
      }
    }
  }
  return best;
}

function matchAlias(
  pattern: string,
  target: string,
  baseAbs: string,
  targetFile: string,
): string | undefined {
  const targetAbs = path
    .resolve(baseAbs, target)
    .replace(/\\/g, '/');
  const targetStripped = stripTsExtension(targetAbs);

  const patternStar = pattern.indexOf('*');
  const targetStar = target.indexOf('*');

  if (patternStar < 0 && targetStar < 0) {
    const exact = stripTsExtension(targetAbs);
    if (exact === stripTsExtension(targetFile) || targetAbs === targetFile) {
      return pattern;
    }
    return undefined;
  }

  if (patternStar < 0 || targetStar < 0) return undefined;

  const targetPrefix = targetAbs.slice(0, targetStar);
  const targetSuffix = targetAbs.slice(targetStar + 1);
  const fileNorm = targetFile.replace(/\\/g, '/');

  const candidates = [fileNorm, stripTsExtension(fileNorm)];
  for (const candidate of candidates) {
    if (!candidate.startsWith(targetPrefix)) continue;
    let middle = candidate.slice(targetPrefix.length);
    if (targetSuffix) {
      if (!middle.endsWith(targetSuffix)) continue;
      middle = middle.slice(0, middle.length - targetSuffix.length);
    } else {
      const stripped = stripTsExtension(middle);
      if (stripped !== middle && fileNorm === candidate) middle = stripped;
    }
    return pattern.slice(0, patternStar) + middle + pattern.slice(patternStar + 1);
  }

  if (targetStripped !== targetAbs) {
    return matchAlias(pattern, target.replace(/\.[^.]+$/, ''), baseAbs, targetFile);
  }

  return undefined;
}

function findNearestTsConfig(startDir: string): string | undefined {
  const cached = tsConfigDirCache.get(startDir);
  if (cached !== undefined) return cached;

  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(candidate)) {
      tsConfigDirCache.set(startDir, candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      tsConfigDirCache.set(startDir, undefined);
      return undefined;
    }
    dir = parent;
  }
}

function readTsConfigCached(tsconfigPath: string): TsConfigAliases | null {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(tsconfigPath);
  } catch {
    tsConfigCache.set(tsconfigPath, null);
    return null;
  }
  const cached = tsConfigCache.get(tsconfigPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const merged = readTsConfigMerged(tsconfigPath, new Set());
  if (!merged) {
    tsConfigCache.set(tsconfigPath, null);
    return null;
  }

  const result: TsConfigAliases = {
    baseDir: path.dirname(tsconfigPath),
    baseUrl: merged.baseUrl,
    paths: merged.paths,
    mtimeMs: stat.mtimeMs,
  };
  tsConfigCache.set(tsconfigPath, result);
  return result;
}

interface MergedTsConfig {
  baseUrl?: string;
  paths: Array<{ pattern: string; targets: string[] }>;
}

function readTsConfigMerged(
  tsconfigPath: string,
  visited: Set<string>,
): MergedTsConfig | undefined {
  if (visited.has(tsconfigPath)) return undefined;
  visited.add(tsconfigPath);

  let raw: string;
  try {
    raw = fs.readFileSync(tsconfigPath, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return undefined;
  }

  const result: MergedTsConfig = { paths: [] };

  if (typeof parsed.extends === 'string') {
    const extendedPath = resolveExtends(parsed.extends, tsconfigPath);
    if (extendedPath) {
      const extended = readTsConfigMerged(extendedPath, visited);
      if (extended) {
        result.baseUrl = extended.baseUrl;
        result.paths = extended.paths.slice();
      }
    }
  }

  const co = parsed.compilerOptions;
  if (co && typeof co === 'object') {
    if (typeof co.baseUrl === 'string') result.baseUrl = co.baseUrl;
    if (co.paths && typeof co.paths === 'object') {
      const newPaths: Array<{ pattern: string; targets: string[] }> = [];
      for (const [pattern, targets] of Object.entries(co.paths)) {
        if (!Array.isArray(targets)) continue;
        const stringTargets = targets.filter((t: unknown): t is string => typeof t === 'string');
        if (stringTargets.length === 0) continue;
        newPaths.push({ pattern, targets: stringTargets });
      }
      if (newPaths.length > 0) result.paths = newPaths;
    }
  }

  return result;
}

function resolveExtends(extendsPath: string, fromTsconfig: string): string | undefined {
  const dir = path.dirname(fromTsconfig);
  if (extendsPath.startsWith('.') || extendsPath.startsWith('/')) {
    const target = path.resolve(dir, extendsPath);
    if (fs.existsSync(target)) return target;
    if (fs.existsSync(target + '.json')) return target + '.json';
    return undefined;
  }
  const candidate = path.resolve(dir, 'node_modules', extendsPath);
  if (fs.existsSync(candidate)) return candidate;
  if (fs.existsSync(candidate + '.json')) return candidate + '.json';
  return undefined;
}

function stripJsonComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      if (i + 1 < s.length) i += 2;
      continue;
    }
    if (c === '"') {
      out += c;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          out += s.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += s[i] ?? '';
        i++;
      }
      if (i < s.length) {
        out += s[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function toRelativeModule(currentFile: string, targetFile: string): string | undefined {
  let rel = path.relative(path.dirname(currentFile), targetFile);
  if (!rel) return undefined;
  rel = rel.replace(/\\/g, '/');
  rel = stripTsExtension(rel);
  rel = rel.replace(/\/index$/, '');
  if (!rel.startsWith('.') && !rel.startsWith('/')) rel = './' + rel;
  return rel;
}

function stripTsExtension(p: string): string {
  return p
    .replace(/\.d\.(ts|mts|cts)$/, '')
    .replace(/\.(ts|tsx|mts|cts|jsx|mjs|cjs|js)$/, '');
}
