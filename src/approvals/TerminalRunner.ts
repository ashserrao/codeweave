import * as vscode from 'vscode';
import { cleanTerminalOutput, tail } from './commands';

const SHELL_INTEGRATION_WAIT_MS = 5000;
const OUTPUT_CHARS = 12_000;
const RAW_CHARS = 200_000;
const UPDATE_MS = 300;

export interface RunResult {
  exitCode?: number;
  output: string;
  captured: boolean;
  /** Why the result is incomplete, if it is. */
  note?: string;
}

/**
 * Runs user-approved commands in a visible "CodeWeave" terminal. With VS Code shell integration
 * the output and exit code are captured; without it the command is still sent to the terminal,
 * but the result is unknown. Terminals are reused per working directory when idle.
 */
export class TerminalRunner implements vscode.Disposable {
  private readonly idle = new Map<string, vscode.Terminal>();
  private readonly running = new Map<string, vscode.Terminal>();

  private waitForShellIntegration(t: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
    if (t.shellIntegration) return Promise.resolve(t.shellIntegration);
    return new Promise((resolve) => {
      const done = (si: vscode.TerminalShellIntegration | undefined) => {
        clearTimeout(timer);
        sub.dispose();
        resolve(si);
      };
      const timer = setTimeout(() => done(t.shellIntegration), SHELL_INTEGRATION_WAIT_MS);
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === t) done(e.shellIntegration);
      });
    });
  }

  private terminalFor(cwd: vscode.Uri): vscode.Terminal {
    const key = cwd.toString();
    const reusable = this.idle.get(key);
    this.idle.delete(key);
    if (reusable && reusable.exitStatus === undefined && vscode.window.terminals.includes(reusable)) return reusable;
    return vscode.window.createTerminal({ name: 'CodeWeave', cwd, iconPath: new vscode.ThemeIcon('sparkle') });
  }

  async run(id: string, command: string, cwd: vscode.Uri, onOutput: (output: string) => void): Promise<RunResult> {
    const terminal = this.terminalFor(cwd);
    this.running.set(id, terminal);
    terminal.show(true);
    try {
      const si = await this.waitForShellIntegration(terminal);
      if (!si) {
        terminal.sendText(command, true);
        return {
          output: '',
          captured: false,
          note: 'Shell integration is not active in this terminal, so CodeWeave could not capture the output or exit code.',
        };
      }

      const execution = si.executeCommand(command);
      const subs: vscode.Disposable[] = [];
      const ended = new Promise<{ exitCode?: number; closed?: boolean }>((resolve) => {
        subs.push(
          vscode.window.onDidEndTerminalShellExecution((e) => {
            if (e.execution === execution) resolve({ exitCode: e.exitCode });
          }),
          vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) resolve({ closed: true });
          }),
        );
      });

      let raw = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const reading = (async () => {
        for await (const chunk of execution.read()) {
          raw = (raw + chunk).slice(-RAW_CHARS);
          timer ??= setTimeout(() => {
            timer = undefined;
            onOutput(tail(cleanTerminalOutput(raw), OUTPUT_CHARS));
          }, UPDATE_MS);
        }
      })();

      const end = await ended;
      subs.forEach((s) => s.dispose());
      // The output stream can trail the end event slightly.
      await Promise.race([reading.catch(() => undefined), new Promise((r) => setTimeout(r, 500))]);
      if (timer) clearTimeout(timer);
      return {
        exitCode: end.exitCode,
        output: tail(cleanTerminalOutput(raw), OUTPUT_CHARS),
        captured: true,
        note: end.closed ? 'The terminal was closed before the command finished.' : undefined,
      };
    } finally {
      this.running.delete(id);
      if (terminal.exitStatus === undefined) this.idle.set(cwd.toString(), terminal);
    }
  }

  /** Sends Ctrl+C to the terminal running this command. */
  stop(id: string): boolean {
    const terminal = this.running.get(id);
    terminal?.sendText('\x03', false);
    return !!terminal;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  dispose(): void {
    this.idle.clear();
    this.running.clear();
  }
}
