import { describe, expect, it } from 'vitest';
import { UsageLedger, totalTokens } from '../src/usage/UsageLedger';
import { buildUsageState, keysOverBudget } from '../src/usage/usageReport';
import { key, memStore, provider } from './helpers';

describe('UsageLedger', () => {
  it('keeps reported and estimated tokens apart and persists', async () => {
    const store = memStore();
    const ledger = new UsageLedger(store);
    await ledger.record('p', 'k', { promptTokens: 100, completionTokens: 50, source: 'reported' }, true);
    await ledger.record('p', 'k', { promptTokens: 10, completionTokens: 5, source: 'estimated' }, true);
    await ledger.record('p', 'k', undefined, false);
    const t = new UsageLedger(store).totals('p', 'k');
    expect(t).toMatchObject({ requests: 3, failures: 1, reportedPrompt: 100, reportedCompletion: 50, estimatedPrompt: 10, estimatedCompletion: 5 });
    expect(totalTokens(t)).toBe(165);
  });

  it('scopes day budgets to today and month budgets to this month', async () => {
    let now = new Date(2026, 9, 1, 12).getTime();
    const ledger = new UsageLedger(memStore(), () => now);
    await ledger.record('p', 'k', { promptTokens: 600, completionTokens: 0, source: 'reported' }, true);
    now = new Date(2026, 9, 2, 12).getTime();
    await ledger.record('p', 'k', { promptTokens: 300, completionTokens: 0, source: 'reported' }, true);
    expect(ledger.budgetUsage('p', 'k', { tokens: 1000, period: 'day' })).toMatchObject({ used: 300, remaining: 700 });
    expect(ledger.budgetUsage('p', 'k', { tokens: 1000, period: 'month' })).toMatchObject({ used: 900, remaining: 100 });
    now = new Date(2026, 10, 1, 12).getTime();
    expect(ledger.budgetUsage('p', 'k', { tokens: 1000, period: 'month' }).used).toBe(0);
    expect(ledger.budgetUsage('p', 'k', { tokens: 1000, period: 'total' }).used).toBe(900);
  });

  it('forgets a deleted key', async () => {
    const ledger = new UsageLedger(memStore());
    await ledger.record('p', 'k1', { promptTokens: 1, completionTokens: 1, source: 'reported' }, true);
    await ledger.record('p', 'k2', { promptTokens: 1, completionTokens: 1, source: 'reported' }, true);
    await ledger.forget('p', 'k1');
    expect(ledger.totals('p', 'k1').requests).toBe(0);
    expect(ledger.totals('p', 'k2').requests).toBe(1);
  });
});

describe('usage report', () => {
  it('flags over-budget keys and only sums known values', async () => {
    const ledger = new UsageLedger(memStore());
    const providers = [
      provider('a', 0, [key('a1', { budget: { tokens: 100, period: 'total' } }), key('a2')]),
      provider('local', 0, [], { requiresKey: false, role: 'context' }),
    ];
    await ledger.record('a', 'a1', { promptTokens: 80, completionTokens: 30, source: 'reported' }, true);
    await ledger.setRateLimit('a', 'a2', { at: Date.now(), remainingTokens: 5000, resetTokensAt: Date.now() + 60_000 });

    expect([...keysOverBudget(providers, ledger)]).toEqual(['a1']);
    const s = buildUsageState(providers, ledger);
    expect(s.totals.keysTotal).toBe(2);
    expect(s.totals.keysUsable).toBe(1);
    expect(s.totals.budget).toMatchObject({ keysWithBudget: 1, keysWithoutBudget: 1, remainingTokens: 0 });
    expect(s.totals.rateLimit).toMatchObject({ keysReporting: 1, remainingTokens: 5000 });
    expect(s.totals.balances).toEqual([]);
    expect(s.providers[1].keys[0]).toMatchObject({ keyId: '', status: 'n/a' });
  });

  it('ignores rate-limit windows that already reset', async () => {
    const ledger = new UsageLedger(memStore());
    await ledger.setRateLimit('a', 'a1', { at: 0, remainingTokens: 999, resetTokensAt: 1 });
    const s = buildUsageState([provider('a', 0, [key('a1')])], ledger);
    expect(s.totals.rateLimit.remainingTokens).toBe(0);
  });
});
