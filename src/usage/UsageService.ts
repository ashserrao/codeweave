import * as vscode from 'vscode';
import type { UsageState } from '../shared/types';
import type { ProviderRegistry } from '../providers/ProviderRegistry';
import { balanceProbeFor, probeBalance } from './balanceProbes';
import { buildUsageState } from './usageReport';
import { totalTokens, type UsageLedger } from './UsageLedger';

/** Facade over the ledger + registry for the dashboard and status bar. */
export class UsageService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: { dispose(): void }[] = [];

  constructor(
    readonly ledger: UsageLedger,
    private readonly registry: ProviderRegistry,
  ) {
    this.subs.push(ledger.onDidChange(() => this.changed.fire()), registry.onDidChange(() => this.changed.fire()));
  }

  state(): UsageState {
    return buildUsageState(this.registry.list(), this.ledger);
  }

  todayTokens(): { total: number; estimated: boolean } {
    const s = this.state();
    return { total: totalTokens(s.totals.today), estimated: s.totals.today.estimatedPrompt + s.totals.today.estimatedCompletion > 0 };
  }

  /** Queries balance APIs for every enabled key of providers that have one. User-triggered only. */
  async refreshBalances(): Promise<{ checked: number; unsupported: number }> {
    let checked = 0;
    let unsupported = 0;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const jobs: Promise<void>[] = [];
      for (const p of this.registry.list()) {
        if (!p.requiresKey || !p.enabled) continue;
        if (!balanceProbeFor(p)) {
          unsupported += 1;
          continue;
        }
        for (const k of p.keys.filter((k) => k.enabled)) {
          jobs.push(
            (async () => {
              const secret = await this.registry.vault.get(p.id, k.id);
              if (!secret) return;
              const snap = await probeBalance(p, secret, abort.signal);
              if (snap) {
                checked += 1;
                await this.ledger.setBalance(p.id, k.id, snap);
              }
            })(),
          );
        }
      }
      await Promise.all(jobs);
    } finally {
      clearTimeout(timer);
    }
    return { checked, unsupported };
  }

  forgetKey(providerId: string, keyId: string): Promise<void> {
    return this.ledger.forget(providerId, keyId);
  }

  forgetProvider(providerId: string): Promise<void> {
    return this.ledger.forget(providerId);
  }

  clear(): Promise<void> {
    return this.ledger.clear();
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}
