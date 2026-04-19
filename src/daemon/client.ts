import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
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
  return findPackagedDaemonBinary(extensionPath);
}

export interface EnsureDaemonBinaryOptions {
  extensionPath: string;
  storagePath: string;
  extensionVersion: string;
  logger: Logger;
}

export async function ensureDaemonBinary(options: EnsureDaemonBinaryOptions): Promise<string> {
  const packaged = findPackagedDaemonBinary(options.extensionPath);
  if (packaged) return packaged;

  const dest = storageDaemonBinaryPath(options.storagePath, options.extensionVersion);
  if (fs.existsSync(dest)) return dest;

  await buildDaemonBinary(options, dest);
  return dest;
}

function findPackagedDaemonBinary(extensionPath: string): string | undefined {
  const binDir = path.join(extensionPath, 'resources', 'bin');
  const { platform, arch } = process;
  const ext = platform === 'win32' ? '.exe' : '';
  const candidates: string[] = [];

  if (platform === 'darwin') {
    candidates.push(path.join(binDir, 'autoimport-daemon-darwin-universal'));
  }
  candidates.push(path.join(binDir, `autoimport-daemon-${platform}-${arch}${ext}`));

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function storageDaemonBinaryPath(storagePath: string, extensionVersion: string): string {
  const { platform, arch } = process;
  const ext = platform === 'win32' ? '.exe' : '';
  return path.join(
    storagePath,
    'bin',
    extensionVersion,
    `autoimport-daemon-${platform}-${arch}${ext}`,
  );
}

async function buildDaemonBinary(
  options: EnsureDaemonBinaryOptions,
  dest: string,
): Promise<void> {
  const daemonDir = path.join(options.extensionPath, 'daemon');
  const manifestPath = path.join(daemonDir, 'Cargo.toml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`daemon source missing: ${manifestPath}`);
  }

  const targetDir = path.join(options.storagePath, 'cargo-target', options.extensionVersion);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  options.logger.info(`building daemon from source: ${daemonDir}`);
  options.logger.info(`cargo target dir: ${targetDir}`);
  const cargo = await ensureCargo(options);
  await runCargoBuild(daemonDir, targetDir, cargo, options.logger);

  const ext = process.platform === 'win32' ? '.exe' : '';
  const built = path.join(targetDir, 'release', `autoimport-daemon${ext}`);
  if (!fs.existsSync(built)) {
    throw new Error(`cargo build succeeded but binary was not found: ${built}`);
  }

  fs.copyFileSync(built, dest);
  if (process.platform !== 'win32') {
    fs.chmodSync(dest, 0o755);
  }
  const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
  options.logger.info(`daemon ready: ${dest} (${size} MB)`);
}

interface CargoCommand {
  command: string;
  env: NodeJS.ProcessEnv;
}

async function ensureCargo(options: EnsureDaemonBinaryOptions): Promise<CargoCommand> {
  const systemCargo = await probeCargo('cargo', process.env);
  if (systemCargo) {
    options.logger.info(`using system Cargo: ${systemCargo}`);
    return { command: systemCargo, env: process.env };
  }

  const managed = managedCargo(options.storagePath);
  if (await probeCargo(managed.command, managed.env)) {
    options.logger.info(`using managed Cargo: ${managed.command}`);
    return managed;
  }

  await installManagedRust(options, managed);
  if (await probeCargo(managed.command, managed.env)) {
    options.logger.info(`using managed Cargo: ${managed.command}`);
    return managed;
  }

  throw new Error(`Rust/Cargo install completed but cargo was not runnable: ${managed.command}`);
}

function managedCargo(storagePath: string): CargoCommand {
  const cargoHome = path.join(storagePath, 'rust', 'cargo');
  const rustupHome = path.join(storagePath, 'rust', 'rustup');
  const cargoBin = path.join(cargoHome, 'bin');
  const ext = process.platform === 'win32' ? '.exe' : '';
  return {
    command: path.join(cargoBin, `cargo${ext}`),
    env: {
      ...process.env,
      CARGO_HOME: cargoHome,
      RUSTUP_HOME: rustupHome,
      PATH: `${cargoBin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  };
}

function probeCargo(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const proc = spawn(command, ['--version'], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.on('error', () => finish(undefined));
    proc.on('exit', (code) => {
      finish(code === 0 ? command : undefined);
    });
  });
}

async function installManagedRust(
  options: EnsureDaemonBinaryOptions,
  cargo: CargoCommand,
): Promise<void> {
  const triple = rustupHostTriple();
  const rustupDir = path.join(options.storagePath, 'rustup-init', triple);
  const ext = process.platform === 'win32' ? '.exe' : '';
  const installer = path.join(rustupDir, `rustup-init${ext}`);
  const url = `https://static.rust-lang.org/rustup/dist/${triple}/rustup-init${ext}`;
  const shaUrl = `${url}.sha256`;

  fs.mkdirSync(rustupDir, { recursive: true });
  fs.mkdirSync(path.dirname(cargo.command), { recursive: true });
  fs.mkdirSync(String(cargo.env.RUSTUP_HOME), { recursive: true });

  options.logger.info(`Cargo not found; downloading Rust toolchain via rustup (${triple})`);
  options.logger.info(`rustup-init: ${url}`);
  await downloadFile(url, installer);
  if (process.platform !== 'win32') {
    fs.chmodSync(installer, 0o755);
  }

  try {
    const expected = parseSha256(await downloadText(shaUrl));
    const actual = await sha256File(installer);
    if (actual !== expected) {
      throw new Error(`sha256 mismatch for rustup-init: expected ${expected}, got ${actual}`);
    }
    options.logger.info('rustup-init checksum verified');
  } catch (err) {
    fs.rmSync(installer, { force: true });
    throw err;
  }

  await runRustupInit(installer, cargo, options.logger);
}

function rustupHostTriple(): string {
  const { platform, arch } = process;
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  throw new Error(`unsupported Rust host platform: ${platform}-${arch}`);
}

function runRustupInit(
  installer: string,
  cargo: CargoCommand,
  logger: Logger,
): Promise<void> {
  return runCommand(
    installer,
    ['-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', 'stable'],
    {
      ...cargo.env,
      RUSTUP_INIT_SKIP_PATH_CHECK: 'yes',
      RUSTUP_TERM_COLOR: 'never',
    },
    logger,
    'rustup-init',
  );
}

function runCargoBuild(
  daemonDir: string,
  targetDir: string,
  cargo: CargoCommand,
  logger: Logger,
): Promise<void> {
  return runCommand(
    cargo.command,
    ['build', '--release', '--locked'],
    {
      ...cargo.env,
      CARGO_TARGET_DIR: targetDir,
    },
    logger,
    'cargo',
    daemonDir,
  );
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logger: Logger,
  label: string,
  cwd?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    pipeBuildOutput(proc.stdout, (line) => logger.info(`${label}: ${line}`));
    pipeBuildOutput(proc.stderr, (line) => logger.info(`${label}: ${line}`));

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    proc.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed (code=${code} signal=${signal})`));
      }
    });
  });
}

function downloadFile(url: string, dest: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (isRedirect(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error(`too many redirects while downloading ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        downloadFile(next, dest, redirects + 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed (${res.statusCode}) ${url}`));
        return;
      }

      const file = fs.createWriteStream(dest, { mode: 0o755 });
      res.pipe(file);
      file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
      file.on('error', (err) => {
        fs.rmSync(dest, { force: true });
        reject(err);
      });
    });
    req.on('error', reject);
  });
}

function downloadText(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (isRedirect(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 5) {
          reject(new Error(`too many redirects while downloading ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        downloadText(next, redirects + 1).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed (${res.statusCode}) ${url}`));
        return;
      }

      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
  });
}

function isRedirect(statusCode: number | undefined): boolean {
  return statusCode !== undefined && statusCode >= 300 && statusCode < 400;
}

function parseSha256(text: string): string {
  const match = text.match(/\b[a-fA-F0-9]{64}\b/);
  if (!match) {
    throw new Error('could not parse rustup-init sha256 file');
  }
  return match[0].toLowerCase();
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function pipeBuildOutput(stream: NodeJS.ReadableStream | null, log: (line: string) => void): void {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nlIdx).trimEnd();
      buffer = buffer.slice(nlIdx + 1);
      if (line.trim()) log(line);
    }
  });
  stream.on('end', () => {
    const line = buffer.trimEnd();
    if (line.trim()) log(line);
  });
}
