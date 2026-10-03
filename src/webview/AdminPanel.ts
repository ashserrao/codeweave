import * as vscode from 'vscode';
import type { AdminState } from '../shared/protocol';
import type { TestResult } from '../shared/types';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import type { ProviderAdapter } from '../providers/types';
import { PROVIDER_PRESETS } from '../providers/presets';
import { describeError } from '../providers/errors';
import type { Logger } from '../core/Logger';
import type { UsageService } from '../usage/UsageService';
import { renderHtml } from './html';
import { RpcHost } from './RpcHost';

/** Settings / Admin dashboard: providers, models, keys, priority. Singleton editor panel. */
export class AdminPanel {
  private static current: AdminPanel | undefined;
  private readonly rpc: RpcHost;
  private readonly subs: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, registry: ProviderRegistry, adapter: ProviderAdapter, usage: UsageService, log: Logger): void {
    if (AdminPanel.current) {
      AdminPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('codeweave.admin', 'CodeWeave Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'codeweave.svg');
    AdminPanel.current = new AdminPanel(panel, extensionUri, registry, adapter, usage, log);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly registry: ProviderRegistry,
    private readonly adapter: ProviderAdapter,
    usage: UsageService,
    log: Logger,
  ) {
    panel.webview.html = renderHtml(panel.webview, extensionUri, 'admin');
    this.rpc = new RpcHost(
      panel.webview,
      {
        'admin/getState': () => this.state(),
        'admin/saveProvider': (p) => registry.save(p),
        'admin/deleteProvider': async ({ id }) => {
          const p = registry.get(id);
          const answer = await vscode.window.showWarningMessage(
            `Delete provider "${p?.name}" and its ${p?.keys.length ?? 0} stored key(s)?`,
            { modal: true },
            'Delete',
          );
          if (answer === 'Delete') {
            await registry.delete(id);
            await usage.forgetProvider(id);
          }
        },
        'admin/move': ({ id, direction }) => registry.move(id, direction),
        'admin/addKey': ({ providerId, label, secret }) => registry.addKey(providerId, label, secret),
        'admin/deleteKey': async ({ providerId, keyId }) => {
          await registry.deleteKey(providerId, keyId);
          await usage.forgetKey(providerId, keyId);
        },
        'admin/setBudget': ({ providerId, keyId, budget }) => {
          if (budget && (!Number.isFinite(budget.tokens) || budget.tokens <= 0)) throw new Error('Budget must be a positive number of tokens');
          return registry.updateKey(providerId, keyId, {
            budget: budget ? { tokens: Math.floor(budget.tokens), period: budget.period } : undefined,
          });
        },
        'admin/openUsage': () => void vscode.commands.executeCommand('codeweave.openUsage'),
        'admin/resetKey': ({ providerId, keyId }) =>
          registry.updateKey(providerId, keyId, { status: 'active', cooldownUntil: undefined, lastError: undefined }),
        'admin/test': ({ providerId }) => this.test(providerId),
      },
      (method, err) => log.error(`Admin RPC ${method} failed`, err),
    );
    this.subs.push(registry.onDidChange(() => this.rpc.emit('admin/state', this.state())));
    panel.onDidDispose(() => this.dispose());
  }

  private state(): AdminState {
    return { providers: this.registry.list(), presets: PROVIDER_PRESETS };
  }

  /** Lists models with the first usable key: proves URL + key work without spending tokens. */
  private async test(providerId: string): Promise<TestResult> {
    const provider = this.registry.get(providerId);
    if (!provider) return { ok: false, message: 'Provider not found' };
    const key = provider.keys.find((k) => k.enabled);
    if (provider.requiresKey && !key) return { ok: false, message: 'Add an API key first.' };
    const apiKey = key ? await this.registry.vault.get(provider.id, key.id) : undefined;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15000);
    try {
      const models = await this.adapter.listModels(provider, apiKey, abort.signal);
      const missing = provider.models.filter((m) => models.length && !models.includes(m.model)).map((m) => m.model);
      const note = missing.length ? ` Configured model(s) not in the list: ${missing.join(', ')}.` : '';
      return {
        ok: true,
        message: `Connected${key ? ` with "${key.label}"` : ''}. ${models.length} model(s) available.${note}`,
        models,
      };
    } catch (err) {
      return { ok: false, message: describeError(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  private dispose(): void {
    AdminPanel.current = undefined;
    this.rpc.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
