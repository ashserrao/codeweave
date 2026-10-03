import * as vscode from 'vscode';
import type { UsageService } from './UsageService';

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Shows today's token count and usable keys; click opens the usage dashboard. */
export class UsageStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('codeweave.usage', vscode.StatusBarAlignment.Right, 100);
  private readonly sub: vscode.Disposable;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly usage: UsageService) {
    this.item.name = 'CodeWeave Usage';
    this.item.command = 'codeweave.openUsage';
    this.sub = usage.onDidChange(() => this.schedule());
    this.render();
    this.item.show();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, 500);
  }

  private render(): void {
    const s = this.usage.state();
    const today = this.usage.todayTokens();
    const { keysTotal, keysUsable } = s.totals;
    const warn = keysTotal > 0 && keysUsable === 0;
    this.item.text = `$(${warn ? 'warning' : 'pulse'}) ${fmt(today.total)}${today.estimated ? '*' : ''}`;
    this.item.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.tooltip = new vscode.MarkdownString(
      [
        `**CodeWeave usage today:** ${today.total.toLocaleString()} tokens${today.estimated ? ' (* includes local estimates)' : ''}`,
        keysTotal ? `**Usable API keys:** ${keysUsable} of ${keysTotal}` : 'No API keys configured',
        '',
        'Click to open the usage dashboard.',
      ].join('\n\n'),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.sub.dispose();
    this.item.dispose();
  }
}
