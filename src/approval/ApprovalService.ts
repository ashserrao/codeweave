import * as vscode from 'vscode';
import * as path from 'path';
import type { ChangeItem } from '../shared/types';
import { newId } from '../core/ids';
import type { Logger } from '../core/Logger';
import { parseProposals } from './changeFormat';
import { applySearchReplace, diffStats, parseSearchReplace } from './searchReplace';
import { resolveInside } from './paths';
import type { ProposalRecord, ProposalStore } from './ProposalStore';
import type { Applier } from './Applier';

export const PROPOSAL_SCHEME = 'codeweave-proposal';

const lineCount = (s: string) => (s ? s.replace(/\r?\n$/, '').split(/\r?\n/).length : 0);

/** Where an "Apply to editor" code block should go. */
export interface EditorTarget {
  uri: vscode.Uri;
  /** Non-empty selected text to replace; undefined inserts after the cursor line. */
  selectedText?: string;
  cursorLine: number;
}

/**
 * Turns proposals in assistant replies into reviewable ChangeItems and carries out the user's
 * decisions. Reading files is free; every write or command goes through Applier, and only from
 * accept/undo/stop, which are only called from explicit user clicks.
 */
export class ApprovalService implements vscode.TextDocumentContentProvider {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly store: ProposalStore,
    private readonly applier: Applier,
    private readonly log: Logger,
  ) {}

  private root(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error('Open a folder to apply changes');
    return folder.uri.fsPath;
  }

  /** Current text of a file: the open editor buffer if any (includes unsaved edits), else disk. */
  private async readText(abs: string): Promise<string | undefined> {
    const uri = vscode.Uri.file(abs);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  hasProposals(markdown: string): boolean {
    return parseProposals(markdown).length > 0;
  }

  /** Builds change items for every proposal in a reply. Invalid proposals become 'failed' items with a reason. */
  async propose(markdown: string): Promise<ChangeItem[]> {
    const proposals = parseProposals(markdown);
    if (!proposals.length) return [];
    let root: string;
    try {
      root = this.root();
    } catch (err) {
      return [{ id: newId(), kind: 'edit', status: 'failed', error: (err as Error).message }];
    }

    const items: ChangeItem[] = [];
    // Several blocks for the same file in one reply apply on top of each other.
    const byPath = new Map<string, { item: ChangeItem; record: ProposalRecord }>();

    for (const p of proposals) {
      const id = newId();
      if (p.kind === 'command') {
        let cwd = root;
        try {
          if (p.cwd && p.cwd !== '.') cwd = resolveInside(root, p.cwd);
        } catch (err) {
          items.push({ id, kind: 'command', command: p.command, cwd: p.cwd, status: 'failed', error: (err as Error).message });
          continue;
        }
        const item: ChangeItem = { id, kind: 'command', command: p.command, cwd: path.relative(root, cwd) || '.', status: 'pending' };
        await this.store.save(id, { kind: 'command', command: p.command, cwd });
        items.push(item);
        continue;
      }

      let abs: string;
      try {
        abs = resolveInside(root, p.path);
      } catch (err) {
        items.push({ id, kind: p.kind === 'delete' ? 'delete' : 'edit', path: p.path, status: 'failed', error: (err as Error).message });
        continue;
      }
      const rel = path.relative(root, abs).replace(/\\/g, '/');

      if (p.kind === 'delete') {
        const current = await this.readText(abs);
        if (current === undefined) {
          items.push({ id, kind: 'delete', path: rel, status: 'failed', error: 'The file does not exist' });
          continue;
        }
        const item: ChangeItem = { id, kind: 'delete', path: rel, status: 'pending', added: 0, removed: lineCount(current) };
        await this.store.save(id, { kind: 'delete', path: abs, baseContent: current, newContent: null });
        items.push(item);
        byPath.delete(abs);
        continue;
      }

      const earlier = byPath.get(abs);
      const base = earlier ? earlier.record.newContent ?? '' : await this.readText(abs);
      const built = this.compute(base ?? undefined, p.mode, p.body);
      if (!built.ok) {
        items.push({ id, kind: base === undefined ? 'create' : 'edit', path: rel, status: 'failed', error: built.error });
        continue;
      }

      if (earlier) {
        // Fold into the earlier item for this file.
        const rec = earlier.record;
        rec.newContent = built.content;
        rec.rebase = rec.rebase?.mode === 'search-replace' && p.mode === 'search-replace'
          ? { mode: 'search-replace', bodies: [...rec.rebase.bodies, p.body] }
          : { mode: 'full' };
        Object.assign(earlier.item, diffStats(rec.baseContent ?? '', built.content));
        await this.store.save(earlier.item.id, rec);
        continue;
      }

      if (base !== undefined && built.content === base) continue; // no-op proposal
      const record: ProposalRecord = {
        kind: base === undefined ? 'create' : 'edit',
        path: abs,
        baseContent: base ?? null,
        newContent: built.content,
        rebase: p.mode === 'search-replace' ? { mode: 'search-replace', bodies: [p.body] } : { mode: 'full' },
      };
      const item: ChangeItem = { id, kind: record.kind, path: rel, status: 'pending', ...diffStats(base ?? '', built.content) };
      await this.store.save(id, record);
      byPath.set(abs, { item, record });
      items.push(item);
    }
    return items;
  }

  private compute(
    base: string | undefined,
    mode: 'search-replace' | 'full',
    body: string,
  ): { ok: true; content: string } | { ok: false; error: string } {
    if (mode === 'full') {
      const eol = base?.includes('\r\n') ? '\r\n' : '\n';
      const content = body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
      return { ok: true, content: eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content };
    }
    let blocks;
    try {
      blocks = parseSearchReplace(body);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    if (base === undefined) {
      if (blocks.every((b) => !b.search.trim())) return { ok: true, content: blocks.map((b) => b.replace).join('\n') + '\n' };
      return { ok: false, error: 'The file does not exist, so its SEARCH text cannot be matched' };
    }
    return applySearchReplace(base, blocks);
  }

  /** "Apply to editor" on a plain code block: replace the selection, or insert after the cursor line. */
  async proposeForEditor(code: string, target: EditorTarget): Promise<ChangeItem> {
    const id = newId();
    const root = this.root();
    const abs = target.uri.fsPath;
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    try {
      resolveInside(root, rel);
    } catch (err) {
      return { id, kind: 'edit', path: rel, status: 'failed', error: (err as Error).message };
    }
    const base = (await this.readText(abs)) ?? '';
    let content: string;
    let body: string;
    if (target.selectedText && base.includes(target.selectedText)) {
      body = `<<<<<<< SEARCH\n${target.selectedText}\n=======\n${code.replace(/\n$/, '')}\n>>>>>>> REPLACE`;
      content = base.replace(target.selectedText, code.replace(/\n$/, ''));
    } else {
      const lines = base.split('\n');
      const at = Math.min(Math.max(target.cursorLine, 0), lines.length - 1);
      const anchor = lines[at] ?? '';
      body = `<<<<<<< SEARCH\n${anchor}\n=======\n${anchor}\n${code.replace(/\n$/, '')}\n>>>>>>> REPLACE`;
      lines.splice(at + 1, 0, code.replace(/\n$/, ''));
      content = lines.join('\n');
    }
    const record: ProposalRecord = { kind: 'edit', path: abs, baseContent: base, newContent: content, rebase: { mode: 'search-replace', bodies: [body] } };
    await this.store.save(id, record);
    return {
      id,
      kind: 'edit',
      path: rel,
      status: 'pending',
      ...diffStats(base, content),
      note: target.selectedText ? 'Replaces the current selection' : `Inserted after line ${target.cursorLine + 1}`,
    };
  }

  // ---------- diffs ----------

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const [, id] = uri.path.split('/');
    const side = uri.query;
    return this.store.load(id).then((rec) => {
      if (!rec) return '';
      if (side === 'new') return rec.newContent ?? '';
      if (side === 'base') return rec.baseContent ?? '';
      return '';
    });
  }

  async showDiff(item: ChangeItem): Promise<void> {
    if (item.kind === 'command' || !item.path) return;
    const rec = await this.store.load(item.id);
    if (!rec?.path) throw new Error('This proposal is no longer available');
    const name = path.basename(rec.path);
    const virt = (side: string) => vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${item.id}/${name}`, query: side });
    const fileUri = vscode.Uri.file(rec.path);
    const pending = item.status === 'pending';
    let left: vscode.Uri;
    let right: vscode.Uri;
    let label: string;
    if (item.kind === 'delete') {
      left = pending ? fileUri : virt('base');
      right = virt('empty');
      label = 'Delete';
    } else if (item.kind === 'create') {
      left = virt('base');
      right = virt('new');
      label = 'New file';
    } else {
      left = pending ? fileUri : virt('base');
      right = virt('new');
      label = pending ? 'Current ↔ Proposed' : 'Before ↔ After';
    }
    this.changed.fire(right);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${item.path} (${label})`, { preview: true });
  }

  async openFile(item: ChangeItem): Promise<void> {
    const rec = await this.store.load(item.id);
    if (rec?.path) await vscode.window.showTextDocument(vscode.Uri.file(rec.path), { preview: true });
  }

  // ---------- decisions (only ever called from user clicks) ----------

  /** Applies one pending change. If the file changed since the proposal, refreshes it instead and asks for re-review. */
  async accept(item: ChangeItem, onProgress: () => void): Promise<void> {
    if (item.status !== 'pending') return;
    const rec = await this.store.load(item.id);
    if (!rec) {
      item.status = 'failed';
      item.error = 'This proposal is no longer available';
      return;
    }
    item.note = undefined;
    item.error = undefined;
    try {
      if (rec.kind === 'command') {
        item.status = 'running';
        onProgress();
        const result = await this.applier.runCommand(rec.command!, rec.cwd!);
        item.output = result;
        item.status = !result.captured || result.exitCode === 0 || result.exitCode === undefined ? 'applied' : 'failed';
        if (result.captured && result.exitCode !== undefined && result.exitCode !== 0) item.error = `Exited with code ${result.exitCode}`;
        if (!result.captured) item.note = 'The terminal has no shell integration, so the output could not be captured. See the CodeWeave terminal.';
      } else {
        const uri = vscode.Uri.file(rec.path!);
        const current = await this.readText(rec.path!);
        if ((current ?? null) !== (rec.baseContent ?? null)) {
          await this.rebase(item, rec, current);
          return;
        }
        if (rec.kind === 'delete') await this.applier.deleteFile(uri);
        else await this.applier.writeFile(uri, rec.newContent ?? '');
        item.status = 'applied';
      }
      item.decidedAt = Date.now();
    } catch (err) {
      item.status = 'failed';
      item.error = (err as Error).message;
      this.log.error(`Applying change to ${item.path ?? item.command} failed`, err);
    }
  }

  /** The file changed after the proposal was made: recompute it on top of the current content. */
  private async rebase(item: ChangeItem, rec: ProposalRecord, current: string | undefined): Promise<void> {
    if (rec.kind === 'delete') {
      if (current === undefined) {
        item.status = 'failed';
        item.error = 'The file no longer exists';
        return;
      }
      rec.baseContent = current;
      item.removed = lineCount(current);
    } else if (rec.rebase?.mode === 'search-replace' && current !== undefined) {
      let content: string | undefined = current;
      for (const body of rec.rebase.bodies) {
        const r = applySearchReplace(content!, parseSearchReplace(body));
        if (!r.ok) {
          content = undefined;
          item.status = 'failed';
          item.error = `The file changed after this proposal and it no longer applies. ${r.error}`;
          break;
        }
        content = r.content;
      }
      if (content === undefined) return;
      rec.baseContent = current;
      rec.newContent = content;
    } else {
      // Whole-file proposals cannot be merged; show exactly what accepting would overwrite.
      rec.baseContent = current ?? null;
      rec.kind = current === undefined ? 'create' : 'edit';
      item.kind = rec.kind;
    }
    if (rec.kind !== 'delete') Object.assign(item, diffStats(rec.baseContent ?? '', rec.newContent ?? ''));
    item.note = 'This file changed after the proposal was made. The diff has been refreshed; review it and accept again.';
    await this.store.save(item.id, rec);
  }

  reject(item: ChangeItem): void {
    if (item.status !== 'pending') return;
    item.status = 'rejected';
    item.decidedAt = Date.now();
  }

  /** Restores the file to its content before the change, unless it was edited again since. */
  async undo(item: ChangeItem): Promise<void> {
    if (item.status !== 'applied' || item.kind === 'command') return;
    const rec = await this.store.load(item.id);
    if (!rec?.path) return;
    const current = await this.readText(rec.path);
    const expected = rec.kind === 'delete' ? undefined : rec.newContent ?? undefined;
    if (current !== expected) {
      item.note = 'The file was edited after this change was applied, so Undo was skipped to avoid losing those edits. Use the editor’s undo instead.';
      return;
    }
    const uri = vscode.Uri.file(rec.path);
    try {
      if (rec.baseContent === null || rec.baseContent === undefined) await this.applier.deleteFile(uri);
      else await this.applier.writeFile(uri, rec.baseContent);
      item.status = 'undone';
      item.note = undefined;
    } catch (err) {
      item.error = `Undo failed: ${(err as Error).message}`;
    }
  }

  stop(item: ChangeItem): void {
    if (item.status === 'running') this.applier.interrupt();
  }

  forget(ids: string[]): Promise<void> {
    return this.store.delete(ids);
  }
}
