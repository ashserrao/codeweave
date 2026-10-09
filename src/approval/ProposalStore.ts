import * as vscode from 'vscode';
import type { ChangeKind } from '../shared/types';

/** Everything needed to show a diff, apply, re-base or undo one change. Kept out of chat history. */
export interface ProposalRecord {
  kind: ChangeKind;
  path?: string;
  /** File content the proposal was computed against; null when the file did not exist. */
  baseContent?: string | null;
  /** Proposed content; null for deletions. */
  newContent?: string | null;
  /** How to recompute the proposal if the file changes before it is accepted. */
  rebase?: { mode: 'search-replace'; bodies: string[] } | { mode: 'full' };
  command?: string;
  cwd?: string;
}

/** Stores proposals in the extension's private storage folder (never in the user's workspace). */
export class ProposalStore {
  private readonly dir: vscode.Uri;
  private readonly cache = new Map<string, ProposalRecord>();

  constructor(storageRoot: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(storageRoot, 'proposals');
  }

  private file(id: string): vscode.Uri {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid proposal id');
    return vscode.Uri.joinPath(this.dir, `${id}.json`);
  }

  async save(id: string, record: ProposalRecord): Promise<void> {
    this.cache.set(id, record);
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(this.file(id), Buffer.from(JSON.stringify(record), 'utf8'));
  }

  async load(id: string): Promise<ProposalRecord | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    try {
      const record = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.file(id))).toString('utf8'));
      this.cache.set(id, record);
      return record;
    } catch {
      return undefined;
    }
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.cache.delete(id);
      try {
        await vscode.workspace.fs.delete(this.file(id));
      } catch {
        /* already gone */
      }
    }
  }
}
