import * as vscode from 'vscode';
import type { UsageService } from '../usage/UsageService';
import type { Logger } from '../core/Logger';
import { renderHtml } from './html';
import { RpcHost } from './RpcHost';

/** Usage dashboard: tokens per key/provider, provider-reported limits and balances, budgets. */
export class UsagePanel {
  private static current: UsagePanel | undefined;
  private readonly rpc: RpcHost;
  private readonly subs: vscode.Disposable[] = [];
  private pushTimer: ReturnType<typeof setTimeout> | undefined;

  static show(extensionUri: vscode.Uri, usage: UsageService, log: Logger): void {
    if (UsagePanel.current) {
      UsagePanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('codeweave.usage', 'CodeWeave Usage', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    UsagePanel.current = new UsagePanel(panel, extensionUri, usage, log);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    usage: UsageService,
    log: Logger,
  ) {
    panel.webview.html = renderHtml(panel.webview, extensionUri, 'usage');
    this.rpc = new RpcHost(
      panel.webview,
      {
        'usage/getState': () => usage.state(),
        'usage/refreshBalances': () => usage.refreshBalances(),
        'usage/clear': async () => {
          const answer = await vscode.window.showWarningMessage(
            'Clear all recorded token usage, rate-limit snapshots and balances? Budgets restart from zero.',
            { modal: true },
            'Clear',
          );
          if (answer === 'Clear') await usage.clear();
        },
        'usage/openAdmin': () => void vscode.commands.executeCommand('codeweave.openAdmin'),
      },
      (method, err) => log.error(`Usage RPC ${method} failed`, err),
    );
    // Coalesce bursts of ledger writes (one per request attempt) into one UI update.
    this.subs.push(
      usage.onDidChange(() => {
        if (this.pushTimer) return;
        this.pushTimer = setTimeout(() => {
          this.pushTimer = undefined;
          this.rpc.emit('usage/state', usage.state());
        }, 250);
      }),
    );
    panel.onDidDispose(() => this.dispose());
  }

  private dispose(): void {
    UsagePanel.current = undefined;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.rpc.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
