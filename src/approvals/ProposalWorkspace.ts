import * as vscode from 'vscode';
import * as nodePath from 'path';
import type { ChatMessage, FileChangeProposal, Proposal } from '../shared/types';
import { parseProposals } from '../shared/proposalFormat';
import { applyHunks, lineStats } from './applyEdits';
import { commandWarning } from './commands';
import { resolveWorkspacePath } from './paths';
import { newId } from '../core/ids';

export const PROPOSAL_SCHEME = 'codeweave-proposal';

interface Computed {
  uri: vscode.Uri;
  /** Current file text; undefined when the file does not exist. */
  original?: string;
  /** Text after the change; undefined when the change deletes the file. */
  proposed?: string;
  note?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Everything file-related for proposals: parsing a reply into proposals, checking them against
 * the current files, showing them as diffs and applying them as undoable workspace edits.
 * The proposed side of a diff is served read-only from the `codeweave-proposal:` scheme.
 */
export class ProposalWorkspace implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, this);

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Resolves a model-written path to a URI inside the workspace, or throws a readable error. */
  resolve(path: string, allowRoot = false): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const local = folders.every((f) => f.uri.scheme === 'file');
    const resolved = resolveWorkspacePath(
      path,
      folders.map((f) => ({ name: f.name, fsPath: local ? f.uri.fsPath : f.uri.path })),
      { allowRoot, path: local ? nodePath : nodePath.posix },
    );
    const folder = folders.find((f) => f.name === resolved.folder.name)!;
    return resolved.relative ? vscode.Uri.joinPath(folder.uri, ...resolved.relative.split('/')) : folder.uri;
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) throw new Error(`${vscode.workspace.asRelativePath(uri)} is a folder.`);
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') return undefined;
      throw err;
    }
    // Through the text model: respects the file's encoding and includes unsaved editor changes.
    return (await vscode.workspace.openTextDocument(uri)).getText();
  }

  /** Works out what a proposal would do to the current file. Throws if it cannot be applied. */
  async compute(p: FileChangeProposal): Promise<Computed> {
    const uri = this.resolve(p.path);
    const original = await this.read(uri);
    if (p.op === 'delete') {
      if (original === undefined) throw new Error(`${p.path} does not exist.`);
      return { uri, original };
    }
    if (p.op === 'write') {
      const content = p.content ?? '';
      return { uri, original, proposed: original?.includes('\r\n') ? content.replace(/\r?\n/g, '\r\n') : content };
    }
    if (p.error) throw new Error(p.error);
    const hunks = p.hunks ?? [];
    if (original === undefined) {
      if (hunks.some((h) => h.search.trim())) throw new Error(`${p.path} does not exist, so its SEARCH text cannot be found.`);
      return { uri, proposed: hunks.map((h) => h.replace).join('\n') + '\n' };
    }
    const result = applyHunks(original, hunks);
    if (!result.ok) throw new Error(result.error);
    if (result.text === original) throw new Error('The edit would not change the file.');
    return { uri, original, proposed: result.text, note: result.notes?.join(' ') };
  }

  /** Re-checks a file proposal against the current file and records diff stats or the error. */
  async preflight(p: FileChangeProposal): Promise<void> {
    try {
      const c = await this.compute(p);
      const stats = lineStats(c.original ?? '', c.proposed ?? '');
      Object.assign(p, { exists: c.original !== undefined, added: stats.added, removed: stats.removed, error: undefined, note: c.note });
      if (p.status === 'failed') p.status = 'pending';
    } catch (err) {
      p.status = 'failed';
      p.error = message(err);
    }
  }

  /** Parses a finished assistant reply into proposals and checks each file change. */
  async prepare(msg: ChatMessage): Promise<void> {
    const proposals: Proposal[] = parseProposals(msg.content).map((parsed) =>
      parsed.kind === 'command'
        ? { ...parsed, id: newId(), status: 'pending', warning: commandWarning(parsed.command) }
        : { ...parsed, id: newId(), status: parsed.error ? 'failed' : 'pending' },
    );
    for (const p of proposals) if (p.kind === 'file' && p.status === 'pending') await this.preflight(p);
    msg.proposals = proposals.length ? proposals : undefined;
  }

  /** Applies a file proposal as one undoable workspace edit. Saves the file unless it had unsaved changes. */
  async apply(p: FileChangeProposal): Promise<void> {
    const c = await this.compute(p);
    const edit = new vscode.WorkspaceEdit();
    let doc: vscode.TextDocument | undefined;
    let wasDirty = false;
    if (c.proposed === undefined) {
      edit.deleteFile(c.uri, { ignoreIfNotExists: true });
    } else if (c.original === undefined) {
      edit.createFile(c.uri, { overwrite: false, contents: Buffer.from(c.proposed, 'utf8') });
    } else {
      doc = await vscode.workspace.openTextDocument(c.uri);
      wasDirty = doc.isDirty;
      edit.replace(c.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), c.proposed);
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code did not apply the edit.');
    if (doc && !wasDirty) await doc.save();
    const stats = lineStats(c.original ?? '', c.proposed ?? '');
    Object.assign(p, { exists: c.original !== undefined, added: stats.added, removed: stats.removed, note: c.note });
  }

  private uris(p: FileChangeProposal, key: string): { right: vscode.Uri; base: vscode.Uri } {
    const path = '/' + p.path.replace(/\\/g, '/').replace(/^\/+/, '');
    return {
      right: vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path, query: key }),
      base: vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path, query: `${key}&base` }),
    };
  }

  /** Opens current-vs-proposed in VS Code's diff editor. `key` identifies the proposal for the title-bar buttons. */
  async openDiff(p: FileChangeProposal, key: string): Promise<void> {
    const c = await this.compute(p);
    const { right, base } = this.uris(p, key);
    this.contents.set(right.toString(), c.proposed ?? '');
    this.changeEmitter.fire(right);
    let left = c.uri;
    if (c.original === undefined) {
      this.contents.set(base.toString(), '');
      left = base;
    }
    const label = p.op === 'delete' ? 'delete' : c.original === undefined ? 'new file' : 'proposed';
    await vscode.commands.executeCommand('vscode.diff', left, right, `${p.path} (CodeWeave: ${label})`, { preview: true });
  }

  /** The proposal key of a `codeweave-proposal:` URI, e.g. from a diff editor title button. */
  keyOf(uri: vscode.Uri | undefined): string | undefined {
    if (uri?.scheme !== PROPOSAL_SCHEME) return undefined;
    return uri.query.replace(/&base$/, '') || undefined;
  }

  /** Closes any open diff for this proposal and forgets its content. */
  async closeDiff(key: string): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputTextDiff && this.keyOf(t.input.modified) === key);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    for (const k of [...this.contents.keys()]) if (this.keyOf(vscode.Uri.parse(k)) === key) this.contents.delete(k);
  }

  dispose(): void {
    this.registration.dispose();
    this.changeEmitter.dispose();
  }
}
