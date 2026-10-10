import * as vscode from 'vscode';
import type { ChatService } from './ChatService';

const VIEW_FOCUS = 'codeweave.chat.focus';

/** Lightbulb quick fix: "Fix with CodeWeave" for diagnostics under the cursor/selection. */
export class FixWithCodeWeaveProvider implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const diagnostics = context.diagnostics.filter(
      (d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning,
    );
    if (!diagnostics.length || document.uri.scheme !== 'file') return [];
    const action = new vscode.CodeAction('Fix with CodeWeave', vscode.CodeActionKind.QuickFix);
    action.command = {
      command: 'codeweave.fixDiagnostics',
      title: 'Fix with CodeWeave',
      arguments: [document.uri, range, diagnostics],
    };
    return [action];
  }
}

function describeDiagnostics(document: vscode.TextDocument, diagnostics: readonly vscode.Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      const code = typeof d.code === 'object' ? d.code.value : d.code;
      const src = [d.source, code].filter(Boolean).join(' ');
      return `- line ${d.range.start.line + 1}: ${sev}${src ? ` (${src})` : ''}: ${d.message}`;
    })
    .join('\n') + `\n\nFile: ${vscode.workspace.asRelativePath(document.uri, false)}`;
}

/** Sends a prompt as a new chat message with the active editor attached, and reveals the chat. */
async function ask(chat: ChatService, prompt: string): Promise<void> {
  await vscode.commands.executeCommand(VIEW_FOCUS);
  if (chat.busy) {
    void vscode.window.showInformationMessage('CodeWeave is still answering. Stop it or wait, then try again.');
    return;
  }
  await chat.send(prompt, true);
}

export function registerEditorActions(chat: ChatService): vscode.Disposable[] {
  return [
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new FixWithCodeWeaveProvider(), {
      providedCodeActionKinds: FixWithCodeWeaveProvider.kinds,
    }),
    vscode.commands.registerCommand(
      'codeweave.fixDiagnostics',
      async (uri?: vscode.Uri, range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
        const editor = vscode.window.activeTextEditor;
        const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
        if (!doc) return;
        const diags =
          diagnostics ??
          vscode.languages
            .getDiagnostics(doc.uri)
            .filter((d) => !range || d.range.intersection(range))
            .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
        if (!diags.length) {
          void vscode.window.showInformationMessage('CodeWeave: no errors or warnings here to fix.');
          return;
        }
        // Make sure the attached editor context covers the problem lines.
        const shown = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
        const first = diags[0].range;
        if (shown.selection.isEmpty) shown.selection = new vscode.Selection(first.start.line, 0, first.start.line, 0);
        await ask(chat, `Fix these problems. Propose the fix as a SEARCH/REPLACE change.\n\n${describeDiagnostics(doc, diags)}`);
      },
    ),
    vscode.commands.registerCommand('codeweave.explainSelection', () => ask(chat, 'Explain what this code does, step by step.')),
    vscode.commands.registerCommand('codeweave.generateTests', () =>
      ask(chat, 'Write unit tests for this code using the project’s existing test framework. Propose them as a new test file.'),
    ),
    vscode.commands.registerCommand('codeweave.refactorSelection', () =>
      ask(chat, 'Refactor this code to be simpler and clearer without changing its behaviour. Propose the change as a SEARCH/REPLACE edit.'),
    ),
    vscode.commands.registerCommand('codeweave.fixSelection', () => vscode.commands.executeCommand('codeweave.fixDiagnostics')),
  ];
}
