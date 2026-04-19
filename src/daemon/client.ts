import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { Logger } from '../logger';

export interface InitParams {
  workspaceRoot: string;
  excludeGlobs: string[];
  languages: string[];
  pythonRespectAll: boolean;
  javaIncludeInner: boolean;
  librariesEnabled: boolean;
  librariesTsNodeModules: boolean;
  librariesPythonSitePackages: boolean;
  librariesPythonMaxDepth: number;
  librariesPythonExtraPaths: string[];
  logLevel: string;
  cacheDir?: string;
}

export interface Suggestion {
  name: string;
  kind: number;
  flags: number;
  targetPath: string;
  fileQualifier?: string;
  parentQualifier?: string;
  score: number;
}

export interface InitResult {
  ok: boolean;
  cacheLoaded: boolean;
  cachedFiles: number;
}

export interface IndexStats {
  files: number;
  names: number;
  paths: number;
  hot_entries: number;
}

export interface IndexerStats {
  parsed: number;
  parse_failures: number;
  python_regex_fallbacks: number;
  skipped_large: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export type NotificationHandler = (method: string, params: unknown) => void;

export class DaemonClient {
  private proc: ChildProcess | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private listeners: NotificationHandler[] = [];
  private exited = false;

  constructor(
    private readonly binaryPath: string,
    private readonly logger: Logger,
  ) {}

  onNotification(fn: NotificationHandler): void {
    this.listeners.push(fn);
  }

  isRunning(): boolean {
    return !this.exited && this.proc !== undefined;
  }

  async start(init: InitParams): Promise<InitResult> {
    this.logger.info(`spawning daemon: ${this.binaryPath}`);
    this.proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout!.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.logger.warn(`daemon[stderr]: ${text}`);
    });
    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.logger.info(`daemon exited (code=${code} signal=${signal})`);
      for (const { reject } of this.pending.values()) {
        reject(new Error(`daemon exited (code=${code})`));
      }
      this.pending.clear();
    });

    const result = await this.request<InitResult>('init', init);
    return result;
  }

  async shutdown(): Promise<void> {
    if (!this.proc || this.exited) return;
    try {
      await Promise.race([
        this.request('shutdown', {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      // ignore
    }
    if (!this.exited) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.proc || this.exited) {
      return Promise.reject(new Error('daemon not running'));
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params });
    this.proc.stdin!.write(msg + '\n');
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
  }

  async scan(): Promise<void> {
    await this.request('scan', {});
  }

  async indexFile(filePath: string, source?: string, overrideQualifier?: string): Promise<void> {
    await this.request('indexFile', { path: filePath, source, overrideQualifier });
  }

  async removeFile(filePath: string): Promise<void> {
    await this.request('removeFile', { path: filePath });
  }

  async query(params: {
    prefix: string;
    currentPath: string;
    alreadyImported: string[];
    limit: number;
    language: string;
  }): Promise<Suggestion[]> {
    const res = await this.request<{ suggestions: Suggestion[] }>('query', params);
    return res.suggestions;
  }

  async stats(): Promise<{ index: IndexStats; indexer: IndexerStats }> {
    return await this.request('stats', {});
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
    let nlIdx: number;
    while ((nlIdx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      if (line.trim().length > 0) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.logger.warn(`daemon bad JSON: ${line}`);
      return;
    }
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const errObj = msg.error as { code?: number; message?: string };
        pending.reject(new Error(errObj.message ?? 'daemon error'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      for (const listener of this.listeners) {
        try {
          listener(msg.method, msg.params);
        } catch (err) {
          this.logger.error('notification handler failed', err);
        }
      }
    }
  }
}

export function resolveDaemonBinary(extensionPath: string): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const suffix = `${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`;
  const candidate = path.join(extensionPath, 'resources', 'bin', `autoimport-daemon-${suffix}`);
  return candidate;
}
