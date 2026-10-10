import * as vscode from 'vscode';
import type { Attachment, EditorInfo } from '../shared/types';

/**
 * Tracks the last focused text editor. When the chat webview has focus,
 * `activeTextEditor` can be undefined, so we remember the most recent one.
 */
export class EditorContext implements vscode.Disposable {
  private last: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires (debounced) when the active file or its selection changes. */
  readonly onDidChange = this.changed.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subs = [
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e && e.document.uri.scheme !== 'output') this.last = e;
      this.schedule();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => this.schedule()),
  ];

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed.fire(), 150);
  }

  describe(): EditorInfo | undefined {
    const editor = this.current();
    if (!editor || editor.document.uri.scheme === 'output') return undefined;
    const path = vscode.workspace.asRelativePath(editor.document.uri, false);
    const sel = editor.selection;
    return {
      path,
      fileName: path.split(/[\\/]/).pop() ?? path,
      selection: sel.isEmpty ? undefined : { startLine: sel.start.line + 1, endLine: sel.end.line + 1 },
    };
  }

  current(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active) return active;
    if (this.last && vscode.window.visibleTextEditors.includes(this.last)) return this.last;
    return undefined;
  }

  /** Selection if non-empty, otherwise a bounded excerpt of the file around the cursor. */
  attachment(maxChars: number): Attachment | undefined {
    const editor = this.current();
    if (!editor) return undefined;
    const doc = editor.document;
    const path = vscode.workspace.asRelativePath(doc.uri, false);
    const sel = editor.selection;

    if (!sel.isEmpty) {
      const text = doc.getText(sel);
      return {
        kind: 'selection',
        path,
        language: doc.languageId,
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        content: text.slice(0, maxChars),
        truncated: text.length > maxChars,
      };
    }

    const full = doc.getText();
    if (full.length <= maxChars) {
      return { kind: 'file', path, language: doc.languageId, content: full, truncated: false };
    }
    // Window of lines centred on the cursor.
    const cursor = sel.active.line;
    let start = cursor;
    let end = cursor;
    let size = doc.lineAt(cursor).text.length + 1;
    while (size < maxChars && (start > 0 || end < doc.lineCount - 1)) {
      if (start > 0) size += doc.lineAt(--start).text.length + 1;
      if (end < doc.lineCount - 1 && size < maxChars) size += doc.lineAt(++end).text.length + 1;
    }
    const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    return {
      kind: 'file',
      path,
      language: doc.languageId,
      startLine: start + 1,
      endLine: end + 1,
      content: doc.getText(range),
      truncated: true,
    };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
