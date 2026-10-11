import * as vscode from 'vscode';
import type { ChatMessage, CommandProposal, Conversation, FileChangeProposal, Proposal } from '../shared/types';
import type { ChatService } from '../core/ChatService';
import type { Logger } from '../core/Logger';
import type { ProposalWorkspace } from './ProposalWorkspace';
import type { TerminalRunner } from './TerminalRunner';
import { parseProposals } from '../shared/proposalFormat';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const keyFor = (messageId: string, proposalId: string) => `${messageId}.${proposalId}`;

/** Re-parses the reply and updates a file proposal's hunks/content from the matching block. */
function refreshFromReply(p: FileChangeProposal, reply: string): void {
  const fresh = parseProposals(reply).find((f) => f.kind === 'file' && f.path === p.path && f.op === p.op);
  if (fresh?.kind !== 'file') return;
  p.hunks = fresh.hunks;
  p.content = fresh.content;
  p.error = fresh.error;
}

interface Located<P extends Proposal = Proposal> {
  conv: Conversation;
  msg: ChatMessage;
  proposal: P;
}

/**
 * The approval workflow: every proposed file change and command waits for an explicit user
 * decision. File changes are applied one at a time (so two accepts on the same file cannot race),
 * and commands run only after Run is clicked, with a second confirmation for destructive ones.
 */
export class ApprovalService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly chat: ChatService,
    private readonly files: ProposalWorkspace,
    private readonly terminal: TerminalRunner,
    private readonly log: Logger,
  ) {}

  private locate(messageId: string, proposalId: string): Located {
    const found = this.chat.findMessage(messageId);
    const proposal = found?.msg.proposals?.find((p) => p.id === proposalId);
    if (!found || !proposal) throw new Error('This proposal is no longer in the open conversation.');
    return { ...found, proposal };
  }

  private locateFile(messageId: string, proposalId: string): Located<FileChangeProposal> {
    const l = this.locate(messageId, proposalId);
    if (l.proposal.kind !== 'file') throw new Error('Not a file change.');
    return l as Located<FileChangeProposal>;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async applyOne({ msg, proposal: p }: Located<FileChangeProposal>): Promise<void> {
    if (p.status !== 'pending' && p.status !== 'failed') return;
    // A retry re-reads the reply, so parser improvements (and a fixed file) both take effect.
    if (p.status === 'failed') refreshFromReply(p, msg.content);
    try {
      await this.files.apply(p);
      p.status = 'accepted';
      p.error = undefined;
      this.log.info(`Applied proposed change to ${p.path}`);
    } catch (err) {
      p.status = 'failed';
      p.error = message(err);
      this.log.warn(`Could not apply proposed change to ${p.path}: ${p.error}`);
    }
    p.decidedAt = Date.now();
    await this.files.closeDiff(keyFor(msg.id, p.id));
  }

  /** Applies one file change. A failed one is re-checked against the current file and retried. */
  accept(messageId: string, proposalId: string): Promise<void> {
    return this.serial(async () => {
      const l = this.locateFile(messageId, proposalId);
      await this.applyOne(l);
      await this.chat.commit(l.conv, l.msg);
    });
  }

  async reject(messageId: string, proposalId: string): Promise<void> {
    const { conv, msg, proposal: p } = this.locate(messageId, proposalId);
    if (p.status !== 'pending' && p.status !== 'failed') return;
    p.status = 'rejected';
    p.decidedAt = Date.now();
    if (p.kind === 'file') await this.files.closeDiff(keyFor(msg.id, p.id));
    await this.chat.commit(conv, msg);
  }

  /** Messages to act on in bulk: one message, or every message in the open conversation. */
  private targets(messageId?: string): { conv: Conversation; msg: ChatMessage }[] {
    if (messageId) {
      const found = this.chat.findMessage(messageId);
      return found ? [found] : [];
    }
    const conv = this.chat.current;
    return conv.messages.filter((m) => m.proposals?.length).map((msg) => ({ conv, msg }));
  }

  /** Applies every pending file change. Commands are never run in bulk. */
  acceptAll(messageId?: string): Promise<{ applied: number; failed: number }> {
    return this.serial(async () => {
      let applied = 0;
      let failed = 0;
      for (const { conv, msg } of this.targets(messageId)) {
        const pending = (msg.proposals ?? []).filter((p): p is FileChangeProposal => p.kind === 'file' && p.status === 'pending');
        if (!pending.length) continue;
        for (const proposal of pending) {
          await this.applyOne({ conv, msg, proposal });
          if (proposal.status === 'accepted') applied++;
          else failed++;
        }
        await this.chat.commit(conv, msg);
      }
      return { applied, failed };
    });
  }

  /** Rejects every undecided file change and skips every command that has not run. */
  async rejectAll(messageId?: string): Promise<number> {
    let count = 0;
    for (const { conv, msg } of this.targets(messageId)) {
      let changed = false;
      for (const p of msg.proposals ?? []) {
        const open = p.kind === 'file' ? p.status === 'pending' || p.status === 'failed' : p.status === 'pending';
        if (!open) continue;
        p.status = 'rejected';
        p.decidedAt = Date.now();
        if (p.kind === 'file') await this.files.closeDiff(keyFor(msg.id, p.id));
        changed = true;
        count++;
      }
      if (changed) await this.chat.commit(conv, msg);
    }
    return count;
  }

  /** Opens the diff. If the change no longer applies, the proposal is marked failed with the reason. */
  async diff(messageId: string, proposalId: string): Promise<void> {
    const l = this.locateFile(messageId, proposalId);
    try {
      await this.files.openDiff(l.proposal, keyFor(messageId, proposalId));
    } catch (err) {
      if (l.proposal.status === 'pending') {
        l.proposal.status = 'failed';
        l.proposal.error = message(err);
        await this.chat.commit(l.conv, l.msg);
      }
      throw err;
    }
  }

  /** Accept/Reject buttons in the diff editor's title bar. */
  async decideFromDiff(uri: vscode.Uri | undefined, decision: 'accept' | 'reject'): Promise<void> {
    const key = this.files.keyOf(uri ?? vscode.window.activeTextEditor?.document.uri);
    const [messageId, proposalId] = key?.split('.') ?? [];
    if (!messageId || !proposalId) throw new Error('Open a CodeWeave proposal diff first.');
    if (decision === 'accept') await this.accept(messageId, proposalId);
    else await this.reject(messageId, proposalId);
  }

  /** Runs an approved command (again, if it already ran). Destructive-looking commands need a second confirmation. */
  async run(messageId: string, proposalId: string): Promise<void> {
    const { conv, msg, proposal } = this.locate(messageId, proposalId);
    if (proposal.kind !== 'command') throw new Error('Not a command.');
    const p: CommandProposal = proposal;
    if (p.status === 'running') return;

    if (p.warning) {
      const answer = await vscode.window.showWarningMessage(
        `Run this command?\n\n${p.command}\n\n${p.warning}`,
        { modal: true },
        'Run',
      );
      if (answer !== 'Run') return;
    }

    let cwd: vscode.Uri;
    try {
      cwd = this.files.resolve(p.cwd ?? '.', true);
    } catch (err) {
      Object.assign(p, { status: 'failed', error: message(err), decidedAt: Date.now() });
      await this.chat.commit(conv, msg);
      return;
    }

    Object.assign(p, { status: 'running', output: '', exitCode: undefined, error: undefined, outputCaptured: undefined, decidedAt: Date.now() });
    await this.chat.commit(conv, msg, false);
    this.log.info(`Running approved command: ${p.command}`);
    try {
      const result = await this.terminal.run(p.id, p.command, cwd, (output) => {
        p.output = output;
        void this.chat.commit(conv, msg, false);
      });
      Object.assign(p, {
        status: 'done',
        exitCode: result.exitCode,
        output: result.output,
        outputCaptured: result.captured,
        error: result.note,
      });
    } catch (err) {
      Object.assign(p, { status: 'failed', error: message(err) });
      this.log.error('Approved command failed to start', err);
    }
    await this.chat.commit(conv, msg);
  }

  stop(proposalId: string): void {
    this.terminal.stop(proposalId);
  }
}
