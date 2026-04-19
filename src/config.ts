import * as vscode from 'vscode';

export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'java';
export type TypeImportPolicy = 'auto' | 'always' | 'never';
export type CacheLocation = 'workspace' | 'global';

export interface Config {
  languages: SupportedLanguage[];
  excludeGlobs: string[];
  minPrefixLength: number;
  maxResults: number;
  preferBarrelImports: boolean;
  python: {
    respectAllDunder: boolean;
  };
  typescript: {
    preferTypeImports: TypeImportPolicy;
  };
  java: {
    includeInnerClasses: boolean;
  };
  cache: {
    maxDiskMB: number;
    location: CacheLocation;
  };
}

export function getConfig(): Config {
  const c = vscode.workspace.getConfiguration('autoImport');
  return {
    languages: c.get<SupportedLanguage[]>('languages', [
      'typescript',
      'javascript',
      'python',
      'java',
    ]),
    excludeGlobs: c.get<string[]>('excludeGlobs', [
      '**/node_modules/**',
      '**/.venv/**',
      '**/venv/**',
      '**/__pycache__/**',
      '**/target/**',
      '**/build/**',
      '**/dist/**',
      '**/out/**',
      '**/.git/**',
    ]),
    minPrefixLength: c.get<number>('minPrefixLength', 2),
    maxResults: c.get<number>('maxResults', 20),
    preferBarrelImports: c.get<boolean>('preferBarrelImports', true),
    python: {
      respectAllDunder: c.get<boolean>('python.respectAllDunder', true),
    },
    typescript: {
      preferTypeImports: c.get<TypeImportPolicy>('typescript.preferTypeImports', 'auto'),
    },
    java: {
      includeInnerClasses: c.get<boolean>('java.includeInnerClasses', true),
    },
    cache: {
      maxDiskMB: c.get<number>('cache.maxDiskMB', 20),
      location: c.get<CacheLocation>('cache.location', 'workspace'),
    },
  };
}
