import type { KeyUsageRow, ProviderConfig, UsageState } from '../shared/types';
import { isKeyUsable } from '../providers/candidates';
import { balanceProbeFor } from './balanceProbes';
import { addTotals, emptyTotals, type UsageLedger } from './UsageLedger';

/**
 * Builds the dashboard model. Every figure is either provider-reported (rate-limit headers,
 * balance APIs), counted by CodeWeave (token totals, split reported/estimated), or derived from a
 * budget the user set. Unknown values stay undefined; totals only add up known values.
 */
export function buildUsageState(providers: ProviderConfig[], ledger: UsageLedger, now = Date.now()): UsageState {
  const today = ledger.todayFilter();
  const month = ledger.monthFilter();
  const totals: UsageState['totals'] = {
    today: emptyTotals(),
    month: emptyTotals(),
    allTime: emptyTotals(),
    keysTotal: 0,
    keysUsable: 0,
    budget: { keysWithBudget: 0, keysWithoutBudget: 0, remainingTokens: 0, includesEstimates: false },
    rateLimit: { keysReporting: 0, remainingTokens: 0, remainingRequests: 0 },
    balances: [],
  };
  const balanceMap = new Map<string, { remaining: number; keys: number; unlimitedKeys: number }>();

  const rows = providers.map((p) => {
    const keyRows: KeyUsageRow[] = [];
    const entries = p.requiresKey
      ? p.keys.map((k) => ({ keyId: k.id, label: k.label, hint: k.hint, enabled: k.enabled, status: k.status, k }))
      : [{ keyId: '', label: 'No key (local)', hint: '', enabled: true, status: 'n/a' as const, k: undefined }];

    for (const e of entries) {
      const row: KeyUsageRow = {
        keyId: e.keyId,
        label: e.label,
        hint: e.hint,
        enabled: e.enabled,
        status: e.status,
        cooldownUntil: e.k?.cooldownUntil,
        lastError: e.k?.lastError,
        today: ledger.totals(p.id, e.keyId, today),
        month: ledger.totals(p.id, e.keyId, month),
        allTime: ledger.totals(p.id, e.keyId),
        rateLimit: ledger.rateLimit(p.id, e.keyId),
        balance: ledger.balance(p.id, e.keyId),
      };
      if (e.k?.budget) {
        row.budget = { ...e.k.budget, ...ledger.budgetUsage(p.id, e.keyId, e.k.budget) };
      }
      keyRows.push(row);

      totals.today = addTotals(totals.today, row.today);
      totals.month = addTotals(totals.month, row.month);
      totals.allTime = addTotals(totals.allTime, row.allTime);

      if (p.requiresKey && e.k) {
        totals.keysTotal += 1;
        const overBudget = row.budget !== undefined && row.budget.remaining <= 0;
        if (p.enabled && isKeyUsable(e.k, now) && !overBudget) totals.keysUsable += 1;
        if (row.budget) {
          totals.budget.keysWithBudget += 1;
          totals.budget.remainingTokens += row.budget.remaining;
          totals.budget.includesEstimates ||= row.budget.includesEstimates;
        } else {
          totals.budget.keysWithoutBudget += 1;
        }
      }

      // Only count rate-limit windows that are still current.
      const rl = row.rateLimit;
      const windowOpen = (reset?: number) => reset === undefined || reset > now;
      if (rl && (rl.remainingTokens !== undefined || rl.remainingRequests !== undefined)) {
        totals.rateLimit.keysReporting += 1;
        if (rl.remainingTokens !== undefined && windowOpen(rl.resetTokensAt)) totals.rateLimit.remainingTokens += rl.remainingTokens;
        if (rl.remainingRequests !== undefined && windowOpen(rl.resetRequestsAt)) totals.rateLimit.remainingRequests += rl.remainingRequests;
      }

      const bal = row.balance;
      if (bal && !bal.error && bal.currency) {
        const agg = balanceMap.get(bal.currency) ?? { remaining: 0, keys: 0, unlimitedKeys: 0 };
        if (bal.remaining === null) agg.unlimitedKeys += 1;
        else if (bal.remaining !== undefined) {
          agg.remaining += bal.remaining;
          agg.keys += 1;
        }
        balanceMap.set(bal.currency, agg);
      }
    }

    return {
      id: p.id,
      name: p.name,
      role: p.role,
      enabled: p.enabled,
      baseUrl: p.baseUrl,
      balanceSupported: p.requiresKey && balanceProbeFor(p) !== undefined,
      keys: keyRows,
    };
  });

  totals.balances = [...balanceMap.entries()].map(([currency, v]) => ({ currency, ...v }));
  return { generatedAt: now, providers: rows, totals };
}

/** Keys whose user-set budget is used up for the current period. */
export function keysOverBudget(providers: ProviderConfig[], ledger: UsageLedger): Set<string> {
  const over = new Set<string>();
  for (const p of providers) {
    for (const k of p.keys) {
      if (k.budget && ledger.budgetUsage(p.id, k.id, k.budget).remaining <= 0) over.add(k.id);
    }
  }
  return over;
}
