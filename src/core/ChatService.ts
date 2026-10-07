import * as vscode from 'vscode';
import type { ChatState } from '../shared/protocol';
import type { ChatMessage, Conversation, ModelTarget } from '../shared/types';
import type { ConversationStore } from './ConversationStore';
import type { EditorContext } from './EditorContext';
import type { ContextService } from './ContextService';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import type { Router } from '../providers/Router';
import { ProviderError, describeError } from '../providers/errors';
import { CONTINUE_PROMPT, packContext, selectFoldCount, unsummarized, type PackOptions } from './ContextPacker';
import { estimateTokens } from './tokens';
import { newId } from './ids';
import type { Logger } from './Logger';

const TARGET_KEY = 'codeweave.chat.target';
const CURRENT_KEY = 'codeweave.chat.current';
const DELTA_FLUSH_MS = 40;
const DEFAULT_MARGIN = 0.1;
/** Margin used after a provider rejected the prompt as too long (our estimate was off). */
const RETRY_MARGIN = 0.35;

function systemPrompt(extra: string): string {
  const folders = vscode.workspace.workspaceFolders?.map((f) => f.name).join(', ') || 'no folder open';
  const base = [
    'You are CodeWeave, an expert software engineering assistant running inside VS Code.',
    `Workspace: ${folders}. Platform: ${process.platform}.`,
    'Give precise, correct answers. When you show code changes, use fenced code blocks with a language tag and state the target file path above each block.',
    'You cannot modify files or run commands yourself in this mode; the user applies changes. Never claim you have changed a file.',
    'If information is missing (for example a file you have not seen), say so instead of guessing.',
  ].join('\n');
  return extra.trim() ? `${base}\n\nAdditional instructions from the user:\n${extra.trim()}` : base;
}

export class ChatService implements vscode.Disposable {
  private conversation: Conversation;
  private abort: AbortController | undefined;
  private status: string | undefined;
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  private readonly deltaEmitter = new vscode.EventEmitter<{ messageId: string; offset: number; text: string }>();
  private readonly messageEmitter = new vscode.EventEmitter<ChatMessage>();
  private readonly statusEmitter = new vscode.EventEmitter<string | undefined>();
  readonly onState = this.stateEmitter.event;
  readonly onDelta = this.deltaEmitter.event;
  readonly onMessage = this.messageEmitter.event;
  readonly onStatus = this.statusEmitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly store: ConversationStore,
    private readonly registry: ProviderRegistry,
    private readonly router: Router,
    private readonly context: ContextService,
    private readonly editor: EditorContext,
    private readonly workspaceState: vscode.Memento,
    private readonly log: Logger,
  ) {
    this.conversation = store.create();
    this.subs.push(registry.onDidChange(() => this.stateEmitter.fire()));
  }

  async restore(): Promise<void> {
    const id = this.workspaceState.get<string>(CURRENT_KEY);
    const loaded = id ? await this.store.load(id) : undefined;
    if (loaded) this.conversation = loaded;
  }

  get busy(): boolean {
    return !!this.abort;
  }

  private setStatus(text: string | undefined): void {
    this.status = text;
    this.statusEmitter.fire(text);
  }

  private get target(): ModelTarget {
    const t = this.workspaceState.get<ModelTarget>(TARGET_KEY) ?? { mode: 'auto' };
    if (t.mode === 'pinned') {
      const p = this.registry.get(t.providerId);
      if (!p || p.role !== 'intelligence' || !p.models.some((m) => m.id === t.modelId)) return { mode: 'auto' };
    }
    return t;
  }

  async setTarget(target: ModelTarget): Promise<void> {
    await this.workspaceState.update(TARGET_KEY, target);
    this.stateEmitter.fire();
  }

  async getState(): Promise<ChatState> {
    const intelligence = this.registry.byRole('intelligence');
    return {
      conversation: this.conversation,
      history: await this.store.list(),
      busy: this.busy,
      status: this.status,
      target: this.target,
      targets: intelligence.flatMap((p) =>
        p.models
          .filter((m) => m.enabled)
          .map((m) => ({ providerId: p.id, providerName: p.name, modelId: m.id, model: m.model })),
      ),
      hasIntelligenceProvider: intelligence.some((p) => p.enabled && p.models.some((m) => m.enabled)),
      hasContextModel: this.context.isAvailable(),
    };
  }

  async newConversation(): Promise<void> {
    if (this.busy) this.cancel();
    this.conversation = this.store.create();
    await this.workspaceState.update(CURRENT_KEY, undefined);
    this.stateEmitter.fire();
  }

  async open(id: string): Promise<void> {
    if (this.busy) this.cancel();
    const loaded = await this.store.load(id);
    if (!loaded) throw new Error('Conversation not found');
    this.conversation = loaded;
    await this.workspaceState.update(CURRENT_KEY, id);
    this.stateEmitter.fire();
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
    if (this.conversation.id === id) await this.newConversation();
    else this.stateEmitter.fire();
  }

  cancel(): void {
    this.abort?.abort();
  }

  /**
   * Makes sure the conversation fits the primary model. Older turns are folded into a rolling
   * summary by the local context model (cached on the conversation, so it is not regenerated each
   * turn). Without a local model the packer drops the oldest turns instead. Returns a note for the UI.
   */
  private async fitContext(
    conv: Conversation,
    history: ChatMessage[],
    system: string,
    target: ModelTarget,
    marginRatio: number,
    force: boolean,
    signal: AbortSignal,
    idleTimeoutMs: number,
  ): Promise<string | undefined> {
    const primary = this.router.candidates(target, 'intelligence')[0];
    if (!primary) return undefined; // the router reports the configuration problem
    const opts: PackOptions = {
      contextWindow: primary.model.contextWindow,
      maxOutputTokens: primary.model.maxOutputTokens,
      marginRatio,
    };
    const pending = unsummarized(history, conv.summary);
    const allowance = Math.max(600, estimateTokens(conv.summary?.text ?? ''));
    let fold = selectFoldCount(system, pending, opts, allowance);
    if (force && fold === 0) fold = Math.floor((pending.length - 1) / 2);
    if (fold <= 0) return undefined;

    const enabled = vscode.workspace.getConfiguration('codeweave').get<boolean>('context.summarize', true);
    if (!enabled || !this.context.isAvailable()) {
      return `The conversation is longer than ${primary.model.model} can take, so the oldest messages were left out of the request. ` +
        (enabled ? 'Configure a local context model to summarise them instead.' : 'Summarisation is turned off (codeweave.context.summarize).');
    }

    this.setStatus(`Summarising ${fold} earlier message(s) with the local context model…`);
    try {
      const folded = pending.slice(0, fold);
      const result = await this.context.summarize(conv.summary, folded, signal, idleTimeoutMs);
      conv.summary = {
        text: result.text,
        coversThroughId: folded[folded.length - 1].id,
        messageCount: (conv.summary?.messageCount ?? 0) + fold,
        providerName: result.providerName,
        model: result.model,
        createdAt: Date.now(),
      };
      return `${fold} earlier message(s) were condensed into a summary by ${result.model} (local) to fit ${primary.model.model}.`;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'cancelled') throw err;
      this.log.warn(`Local summarisation failed: ${describeError(err)}`);
      return `The local context model could not summarise (${describeError(err)}), so the oldest messages were left out instead.`;
    } finally {
      this.setStatus(undefined);
    }
  }

  async send(text: string, includeEditor: boolean): Promise<void> {
    const content = text.trim();
    if (!content) return;
    if (this.busy) throw new Error('A request is already running. Stop it first.');

    const cfg = vscode.workspace.getConfiguration('codeweave');
    const attachment = includeEditor
      ? this.editor.attachment(cfg.get<number>('chat.maxEditorContextChars', 24000))
      : undefined;

    const conv = this.conversation;
    const userMsg: ChatMessage = {
      id: newId(),
      role: 'user',
      content,
      createdAt: Date.now(),
      attachments: attachment ? [attachment] : undefined,
    };
    conv.messages.push(userMsg);
    if (conv.title === 'New chat') conv.title = content.replace(/\s+/g, ' ').slice(0, 60);

    const assistant: ChatMessage = { id: newId(), role: 'assistant', content: '', createdAt: Date.now(), meta: {} };
    conv.messages.push(assistant);
    conv.updatedAt = Date.now();

    const abort = new AbortController();
    this.abort = abort;
    await this.workspaceState.update(CURRENT_KEY, conv.id);
    this.stateEmitter.fire();

    // Deltas carry their offset so the webview can apply them idempotently even if a
    // full state snapshot (which already contains some of the text) arrives in between.
    let pending = '';
    let sent = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (!pending) return;
      this.deltaEmitter.fire({ messageId: assistant.id, offset: sent, text: pending });
      sent += pending.length;
      pending = '';
    };

    const system = systemPrompt(cfg.get<string>('chat.systemPrompt', ''));
    const history = conv.messages.filter((m) => m !== assistant);
    const target = this.target;
    const idleTimeoutMs = cfg.get<number>('request.timeoutSeconds', 120) * 1000;
    const routeNotes: string[] = [];
    const contextNotes: string[] = [];
    let marginRatio = DEFAULT_MARGIN;

    try {
      const note = await this.fitContext(conv, history, system, target, marginRatio, false, abort.signal, idleTimeoutMs);
      if (note) contextNotes.push(note);

      for (let attempt = 0; ; attempt++) {
        try {
          const result = await this.router.complete({
            target,
            role: 'intelligence',
            signal: abort.signal,
            idleTimeoutMs,
            buildMessages: (c, partial) => {
              const msgs: ChatMessage[] = partial
                ? [
                    ...history,
                    { id: 'partial', role: 'assistant', content: partial, createdAt: 0 },
                    { id: 'continue', role: 'user', content: CONTINUE_PROMPT, createdAt: 0 },
                  ]
                : history;
              return packContext(system, msgs, {
                contextWindow: c.model.contextWindow,
                maxOutputTokens: c.model.maxOutputTokens,
                marginRatio,
              }, conv.summary).messages;
            },
            onText: (t) => {
              assistant.content += t;
              pending += t;
              if (!timer) timer = setTimeout(flush, DELTA_FLUSH_MS);
            },
            onSwitch: (n) => {
              routeNotes.push(n);
              vscode.window.setStatusBarMessage(`CodeWeave: ${n}`, 6000);
            },
          });
          assistant.meta = {
            providerId: result.candidate.provider.id,
            providerName: result.candidate.provider.name,
            model: result.candidate.model.model,
            servedBy: result.servedBy,
            keyId: result.candidate.key?.id,
            usage: result.usage,
          };
          if (result.finishReason === 'length') {
            assistant.meta.error = "Response stopped at the model's max output tokens. Ask it to continue or raise the limit in Settings.";
          }
          break;
        } catch (err) {
          // Our token estimate was too optimistic: shrink harder and retry once, if nothing streamed yet.
          if (attempt === 0 && err instanceof ProviderError && err.kind === 'context_length' && !assistant.content) {
            marginRatio = RETRY_MARGIN;
            routeNotes.push('The provider rejected the prompt as too long; context was reduced and the request retried.');
            const retryNote = await this.fitContext(conv, history, system, target, marginRatio, true, abort.signal, idleTimeoutMs);
            if (retryNote) contextNotes.push(retryNote);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      const cancelled = err instanceof ProviderError && err.kind === 'cancelled';
      assistant.meta = { ...assistant.meta, cancelled, error: cancelled ? undefined : describeError(err) };
      if (!cancelled) this.log.error('Chat request failed', err);
    } finally {
      if (timer) clearTimeout(timer);
      flush();
      if (routeNotes.length) assistant.meta = { ...assistant.meta, route: routeNotes };
      if (contextNotes.length) assistant.meta = { ...assistant.meta, contextNote: contextNotes.join(' ') };
      this.abort = undefined;
      this.setStatus(undefined);
      conv.updatedAt = Date.now();
      if (this.conversation.id === conv.id) this.messageEmitter.fire(assistant);
      try {
        await this.store.save(conv);
      } catch (err) {
        this.log.error('Failed to save conversation', err);
      }
      this.stateEmitter.fire();
    }
  }

  dispose(): void {
    this.cancel();
    this.subs.forEach((s) => s.dispose());
    this.stateEmitter.dispose();
    this.deltaEmitter.dispose();
    this.messageEmitter.dispose();
    this.statusEmitter.dispose();
  }
}
