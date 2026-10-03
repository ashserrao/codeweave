import * as vscode from 'vscode';
import type { Conversation, ConversationSummary } from '../shared/types';
import { newId } from './ids';

/**
 * Chat continuity only: conversations are stored per workspace in the extension's
 * private storage folder (not in the user's repository). Persistent project knowledge
 * belongs to the docs and the code graph, not here.
 */
export class ConversationStore {
  private readonly dir: vscode.Uri;
  private index: ConversationSummary[] | undefined;

  constructor(storageRoot: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(storageRoot, 'conversations');
  }

  private fileFor(id: string): vscode.Uri {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid conversation id');
    return vscode.Uri.joinPath(this.dir, `${id}.json`);
  }

  private get indexFile(): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, 'index.json');
  }

  create(): Conversation {
    const now = Date.now();
    return { id: newId(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
  }

  async list(): Promise<ConversationSummary[]> {
    if (!this.index) {
      try {
        const raw = await vscode.workspace.fs.readFile(this.indexFile);
        this.index = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        this.index = [];
      }
    }
    return [...this.index!].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<Conversation | undefined> {
    try {
      const raw = await vscode.workspace.fs.readFile(this.fileFor(id));
      return JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  async save(conversation: Conversation): Promise<void> {
    if (conversation.messages.length === 0) return; // don't persist empty chats
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(
      this.fileFor(conversation.id),
      Buffer.from(JSON.stringify(conversation), 'utf8'),
    );
    const list = (await this.list()).filter((c) => c.id !== conversation.id);
    list.push({
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
    });
    await this.writeIndex(list);
  }

  async delete(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.fileFor(id));
    } catch {
      /* already gone */
    }
    await this.writeIndex((await this.list()).filter((c) => c.id !== id));
  }

  private async writeIndex(list: ConversationSummary[]): Promise<void> {
    this.index = list;
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(this.indexFile, Buffer.from(JSON.stringify(list), 'utf8'));
  }
}
