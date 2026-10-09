import * as vscode from 'vscode';

const MAX_OUTPUT = 20_000;
const SHELL_INTEGRATION_WAIT_MS = 4000;

export interface CommandResult {
  exitCode?: number;
  text: string;
  truncated: boolean;
  /** False when the terminal had no shell integration, so output could not be read back. */
  captured: boolean;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * THE ONLY MODULE THAT CHANGES THE USER'S WORKSPACE OR RUNS COMMANDS.
 * It is called exclusively by ApprovalService after the user clicks Accept / Run / Undo.
 * test/writeGuard.test.ts fails the build if any other module uses a write or execute API.
 */
export class Applier implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private terminalCwd: string | undefined;
  private readonly subs: vscode.Disposable[] = [
    vscode.window.onDidCloseTerminal((t) => {
      if (t === this.terminal) this.terminal = undefined;
    }),
  ];

  /** Creates or replaces a file through a WorkspaceEdit (so it is undoable in the editor), then saves it. */
  async writeFile(uri: vscode.Uri, content: string): Promise<void> {
    const exists = await this.exists(uri);
    const edit = new vscode.WorkspaceEdit();
    if (!exists) {
      edit.createFile(uri, { contents: Buffer.from(content, 'utf8'), ignoreIfExists: false });
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), content);
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the edit');
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty && !(await doc.save())) throw new Error('The file was changed but could not be saved');
  }

  async deleteFile(uri: vscode.Uri): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the delete');
  }

  /** Runs one command in the "CodeWeave" terminal and captures its output when shell integration allows. */
  async runCommand(command: string, cwd: string): Promise<CommandResult> {
    const terminal = this.terminalFor(cwd);
    terminal.show(true);
    const integration = await this.waitForShellIntegration(terminal);
    if (!integration) {
      terminal.sendText(command, true);
      return { text: '', truncated: false, captured: false };
    }

    const execution = integration.executeCommand(command);
    const ended = new Promise<number | undefined>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          sub.dispose();
          resolve(e.exitCode);
        }
      });
    });
    let text = '';
    let truncated = false;
    for await (const chunk of execution.read()) {
      text += chunk.replace(ANSI, '');
      if (text.length > MAX_OUTPUT) {
        text = text.slice(-MAX_OUTPUT);
        truncated = true;
      }
    }
    const exitCode = await ended;
    return { exitCode, text: text.replace(/\r\n/g, '\n').trimEnd(), truncated, captured: true };
  }

  /** Sends Ctrl+C to the CodeWeave terminal (user clicked Stop). */
  interrupt(): void {
    this.terminal?.sendText('\u0003', false);
  }

  private terminalFor(cwd: string): vscode.Terminal {
    if (!this.terminal || this.terminal.exitStatus !== undefined || this.terminalCwd !== cwd) {
      this.terminal = vscode.window.createTerminal({ name: 'CodeWeave', cwd, iconPath: new vscode.ThemeIcon('sparkle') });
      this.terminalCwd = cwd;
    }
    return this.terminal;
  }

  private async waitForShellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) return terminal.shellIntegration;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(undefined);
      }, SHELL_INTEGRATION_WAIT_MS);
      const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal === terminal) {
          clearTimeout(timer);
          sub.dispose();
          resolve(e.shellIntegration);
        }
      });
    });
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }
}
