import * as vscode from 'vscode';
import type { ChatService } from '../core/ChatService';
import type { EditorContext } from '../core/EditorContext';
import type { Logger } from '../core/Logger';
import { renderHtml } from './html';
import { RpcHost } from './RpcHost';

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'codeweave.chat';
  private rpc: RpcHost | undefined;
  private view: vscode.WebviewView | undefined;
  private pendingPrefill: string | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chat: ChatService,
    private readonly editor: EditorContext,
    private readonly log: Logger,
  ) {
    this.subs.push(
      editor.onDidChange(() => this.rpc?.emit('chat/editor', { editor: this.editor.describe() })),
      chat.onState(() => void this.pushState()),
      chat.onDelta((d) => this.rpc?.emit('chat/delta', d)),
      chat.onMessage((m) => this.rpc?.emit('chat/message', m)),
      chat.onStatus((text) => this.rpc?.emit('chat/status', { text })),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = renderHtml(view.webview, this.extensionUri, 'chat');
    this.rpc?.dispose();
    this.rpc = new RpcHost(
      view.webview,
      {
        'chat/getState': () => {
          const state = this.chat.getState();
          if (this.pendingPrefill) {
            const text = this.pendingPrefill;
            this.pendingPrefill = undefined;
            setTimeout(() => this.rpc?.emit('prefill', { text }), 50);
          }
          return state;
        },
        'chat/send': (p) => {
          // Run in background: progress arrives through events, not this response.
          void this.chat.send(p.text, p.includeEditor).catch((err) =>
            vscode.window.showErrorMessage(`CodeWeave: ${err instanceof Error ? err.message : err}`),
          );
        },
        'chat/cancel': () => this.chat.cancel(),
        'chat/new': () => this.chat.newConversation(),
        'chat/open': (p) => this.chat.open(p.id),
        'chat/delete': (p) => this.chat.delete(p.id),
        'chat/setTarget': (t) => this.chat.setTarget(t),
        'chat/openAdmin': () => void vscode.commands.executeCommand('codeweave.openAdmin'),
        'chat/openUsage': () => void vscode.commands.executeCommand('codeweave.openUsage'),
        'chat/pickModel': () => this.pickModel(),
        'changes/act': (p) => this.notifyOnError(this.chat.changeAction(p.messageId, p.itemIds, p.action)),
        'changes/applyBlock': (p) => this.notifyOnError(this.chat.applyCodeBlock(p.messageId, p.code)),
        'chat/copy': async (p) => {
          await vscode.env.clipboard.writeText(p.text);
          vscode.window.setStatusBarMessage('CodeWeave: copied to clipboard', 2000);
        },
      },
      (method, err) => this.log.error(`Chat RPC ${method} failed`, err),
    );
    view.onDidDispose(() => {
      this.rpc?.dispose();
      this.rpc = undefined;
      this.view = undefined;
    });
  }

  private async pushState(): Promise<void> {
    if (!this.rpc) return;
    this.rpc.emit('chat/state', await this.chat.getState());
  }

  private async notifyOnError(work: Promise<void>): Promise<void> {
    try {
      await work;
    } catch (err) {
      void vscode.window.showWarningMessage(`CodeWeave: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Searchable model list grouped by provider; handles hundreds of gateway models (e.g. OmniRoute). */
  private async pickModel(): Promise<void> {
    const state = await this.chat.getState();
    type Item = vscode.QuickPickItem & { target?: Parameters<ChatService['setTarget']>[0] };
    const current = state.target;
    const isCurrent = (providerId?: string, modelId?: string) =>
      providerId === undefined
        ? current.mode === 'auto'
        : current.mode === 'pinned' && current.providerId === providerId && current.modelId === modelId;

    const items: Item[] = [
      {
        label: `${isCurrent() ? '$(check) ' : ''}Auto`,
        description: 'Provider priority with key rotation and fallback',
        target: { mode: 'auto' },
      },
    ];
    for (const providerName of [...new Set(state.targets.map((t) => t.providerName))]) {
      items.push({ label: providerName, kind: vscode.QuickPickItemKind.Separator });
      for (const t of state.targets.filter((x) => x.providerName === providerName)) {
        items.push({
          label: `${isCurrent(t.providerId, t.modelId) ? '$(check) ' : ''}${t.model}`,
          description: providerName,
          target: { mode: 'pinned', providerId: t.providerId, modelId: t.modelId },
        });
      }
    }
    items.push(
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(settings-gear) Manage models…', description: 'Settings & Providers' },
    );

    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select a model', matchOnDescription: true });
    if (!picked) return;
    if (picked.target) await this.chat.setTarget(picked.target);
    else await vscode.commands.executeCommand('codeweave.openAdmin');
  }

  /** Reveal the chat and put text into the input box (used by "Ask About Selection"). */
  async prefill(text: string): Promise<void> {
    if (this.view && this.rpc) {
      this.view.show(true);
      this.rpc.emit('prefill', { text });
    } else {
      this.pendingPrefill = text;
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }
  }

  dispose(): void {
    this.rpc?.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
