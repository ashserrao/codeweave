import * as vscode from 'vscode';

/** Writes to the "CodeWeave" output channel. Never log key values or full prompts. */
export class Logger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('CodeWeave', { log: true });

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, err?: unknown): void {
    this.channel.error(err instanceof Error ? `${message}: ${err.message}` : message);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
