import * as vscode from 'vscode';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
  dispose(): void;
}

export function createLogger(name: string): Logger {
  const channel = vscode.window.createOutputChannel(name);
  return {
    info(msg) {
      channel.appendLine(`[info] ${msg}`);
    },
    warn(msg) {
      channel.appendLine(`[warn] ${msg}`);
    },
    error(msg, err) {
      channel.appendLine(`[error] ${msg}`);
      if (err instanceof Error) {
        channel.appendLine(err.stack ?? err.message);
      } else if (err !== undefined) {
        channel.appendLine(String(err));
      }
    },
    dispose() {
      channel.dispose();
    },
  };
}
