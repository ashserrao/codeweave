import * as vscode from 'vscode';
import type { ChatService } from '../core/ChatService';
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
    private readonly log: Logger,
  ) {
    this.subs.push(
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
