import type { BalanceSnapshot, KeyBudget, RateLimitSnapshot, TokenTotals, TokenUsage } from '../shared/types';

/** Minimal Memento shape so the ledger can be unit-tested without VS Code. */
export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

interface DayBucket {
  date: string; // YYYY-MM-DD, local time
  providerId: string;
  keyId: string; // '' for keyless providers
  totals: TokenTotals;
}

interface LedgerData {
  version: 1;
  days: Record<string, DayBucket>;
  rateLimits: Record<string, RateLimitSnapshot>;
  balances: Record<string, BalanceSnapshot>;
}

const STORAGE_KEY = 'codeweave.usage.v1';
const RETENTION_DAYS = 400;

export const emptyTotals = (): TokenTotals => ({
  requests: 0,
  failures: 0,
  reportedPrompt: 0,
  reportedCompletion: 0,
  estimatedPrompt: 0,
  estimatedCompletion: 0,
});

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    requests: a.requests + b.requests,
    failures: a.failures + b.failures,
    reportedPrompt: a.reportedPrompt + b.reportedPrompt,
    reportedCompletion: a.reportedCompletion + b.reportedCompletion,
    estimatedPrompt: a.estimatedPrompt + b.estimatedPrompt,
    estimatedCompletion: a.estimatedCompletion + b.estimatedCompletion,
  };
}

export const totalTokens = (t: TokenTotals) =>
  t.reportedPrompt + t.reportedCompletion + t.estimatedPrompt + t.estimatedCompletion;

export const hasEstimates = (t: TokenTotals) => t.estimatedPrompt + t.estimatedCompletion > 0;

export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const slot = (providerId: string, keyId: string | undefined) => `${providerId}|${keyId ?? ''}`;

/**
 * Owns token accounting: what CodeWeave sent and received per key per day, plus the latest
 * provider-reported rate-limit and balance snapshots. Reported and estimated counts are kept
 * apart so the dashboard never presents an estimate as a provider figure.
 */
export class UsageLedger {
  private data: LedgerData;
  private readonly listeners = new Set<() => void>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {
    const raw = store.get<LedgerData | undefined>(STORAGE_KEY, undefined);
    this.data = raw?.version === 1 ? raw : { version: 1, days: {}, rateLimits: {}, balances: {} };
  }

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private persist(): Promise<void> {
    this.listeners.forEach((fn) => fn());
    // Serialise writes so a slow update never overwrites a newer one.
    this.writeChain = this.writeChain.then(() => Promise.resolve(this.store.update(STORAGE_KEY, this.data))).catch(() => undefined);
    return this.writeChain;
  }

  /** Records one request attempt. `usage` is undefined when nothing is known (e.g. connection refused). */
  record(providerId: string, keyId: string | undefined, usage: TokenUsage | undefined, ok: boolean): Promise<void> {
    const date = localDate(this.now());
    const id = `${date}|${slot(providerId, keyId)}`;
    const bucket = (this.data.days[id] ??= { date, providerId, keyId: keyId ?? '', totals: emptyTotals() });
    const t = bucket.totals;
    t.requests += 1;
    if (!ok) t.failures += 1;
    if (usage) {
      if (usage.source === 'reported') {
        t.reportedPrompt += usage.promptTokens;
        t.reportedCompletion += usage.completionTokens;
      } else {
        t.estimatedPrompt += usage.promptTokens;
        t.estimatedCompletion += usage.completionTokens;
      }
    }
    this.prune();
    return this.persist();
  }

  setRateLimit(providerId: string, keyId: string | undefined, snap: RateLimitSnapshot): Promise<void> {
    this.data.rateLimits[slot(providerId, keyId)] = snap;
    return this.persist();
  }

  rateLimit(providerId: string, keyId: string | undefined): RateLimitSnapshot | undefined {
    return this.data.rateLimits[slot(providerId, keyId)];
  }

  setBalance(providerId: string, keyId: string | undefined, snap: BalanceSnapshot): Promise<void> {
    this.data.balances[slot(providerId, keyId)] = snap;
    return this.persist();
  }

  balance(providerId: string, keyId: string | undefined): BalanceSnapshot | undefined {
    return this.data.balances[slot(providerId, keyId)];
  }

  /** Totals for a key whose bucket date satisfies `include`. */
  totals(providerId: string, keyId: string | undefined, include: (date: string) => boolean = () => true): TokenTotals {
    let sum = emptyTotals();
    const k = keyId ?? '';
    for (const b of Object.values(this.data.days)) {
      if (b.providerId === providerId && b.keyId === k && include(b.date)) sum = addTotals(sum, b.totals);
    }
    return sum;
  }

  todayFilter(): (date: string) => boolean {
    const today = localDate(this.now());
    return (d) => d === today;
  }

  monthFilter(): (date: string) => boolean {
    const month = localDate(this.now()).slice(0, 7);
    return (d) => d.startsWith(month);
  }

  /** Usage counted against a budget in its current period. */
  budgetUsage(providerId: string, keyId: string, budget: KeyBudget): { used: number; remaining: number; includesEstimates: boolean } {
    const filter = budget.period === 'day' ? this.todayFilter() : budget.period === 'month' ? this.monthFilter() : () => true;
    const t = this.totals(providerId, keyId, filter);
    const used = totalTokens(t);
    return { used, remaining: Math.max(0, budget.tokens - used), includesEstimates: hasEstimates(t) };
  }

  /** Removes records for keys or providers that no longer exist, and buckets past retention. */
  forget(providerId: string, keyId?: string): Promise<void> {
    for (const [id, b] of Object.entries(this.data.days)) {
      if (b.providerId === providerId && (keyId === undefined || b.keyId === keyId)) delete this.data.days[id];
    }
    for (const map of [this.data.rateLimits, this.data.balances]) {
      for (const id of Object.keys(map)) {
        if (id.startsWith(`${providerId}|`) && (keyId === undefined || id === slot(providerId, keyId))) delete map[id];
      }
    }
    return this.persist();
  }

  clear(): Promise<void> {
    this.data = { version: 1, days: {}, rateLimits: {}, balances: {} };
    return this.persist();
  }

  private prune(): void {
    const cutoff = localDate(this.now() - RETENTION_DAYS * 86_400_000);
    for (const [id, b] of Object.entries(this.data.days)) if (b.date < cutoff) delete this.data.days[id];
  }
}
