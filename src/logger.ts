import * as vscode from 'vscode';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
  debug(msg: string): void;
  show(): void;
  dispose(): void;
}

export function createLogger(name: string, debugEnabled: boolean): Logger {
  const channel = vscode.window.createOutputChannel(name);
  return {
    info(msg) {
      channel.appendLine(`[${ts()}] ${msg}`);
    },
    warn(msg) {
      channel.appendLine(`[${ts()}] [warn] ${msg}`);
    },
    error(msg, err) {
      channel.appendLine(`[${ts()}] [error] ${msg}`);
      if (err instanceof Error) channel.appendLine(err.stack ?? err.message);
      else if (err !== undefined) channel.appendLine(String(err));
    },
    debug(msg) {
      if (debugEnabled) channel.appendLine(`[${ts()}] [debug] ${msg}`);
    },
    show() {
      channel.show(true);
    },
    dispose() {
      channel.dispose();
    },
  };
}

function ts(): string {
  const d = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}
