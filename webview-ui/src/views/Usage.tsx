import { useEffect, useState } from 'react';
import type { KeyUsageRow, ProviderUsageRow, RateLimitSnapshot, TokenTotals, UsageState } from '../../../src/shared/types';
import { on, request } from '../rpc';

const fmt = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
const total = (t: TokenTotals) => t.reportedPrompt + t.reportedCompletion + t.estimatedPrompt + t.estimatedCompletion;
const estimated = (t: TokenTotals) => t.estimatedPrompt + t.estimatedCompletion;
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ms).toLocaleDateString();
};

type Source = 'reported' | 'counted' | 'budget' | 'unknown';
const SOURCE_TEXT: Record<Source, { label: string; help: string }> = {
  reported: { label: 'Reported', help: 'Returned by the provider (response headers or its balance API).' },
  counted: { label: 'Counted', help: "Counted by CodeWeave from each response's usage field; any part the provider did not report is estimated (~4 chars/token) and shown separately." },
  budget: { label: 'Your budget', help: 'Calculated from a budget you set minus the usage CodeWeave counted. Not a provider quota.' },
  unknown: { label: 'Not reported', help: 'The provider does not expose this; CodeWeave does not guess.' },
};

function SourceBadge({ source }: { source: Source }) {
  return (
    <span className={`src src-${source}`} title={SOURCE_TEXT[source].help}>
      {SOURCE_TEXT[source].label}
    </span>
  );
}

function Tile({ label, value, sub, source, hero }: { label: string; value: string; sub?: string; source: Source; hero?: boolean }) {
  return (
    <div className={`tile ${hero ? 'hero' : ''}`}>
      <div className="tile-label">
        {label} <SourceBadge source={source} />
      </div>
      <div className="tile-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function TokenCell({ t }: { t: TokenTotals }) {
  const all = total(t);
  if (t.requests === 0) return <span className="muted">—</span>;
  const est = estimated(t);
  return (
    <span
      title={`Prompt ${(t.reportedPrompt + t.estimatedPrompt).toLocaleString()} · completion ${(t.reportedCompletion + t.estimatedCompletion).toLocaleString()}\nReported by provider: ${(all - est).toLocaleString()} · estimated: ${est.toLocaleString()}\nRequests ${t.requests} (failed ${t.failures})`}
    >
      {fmt(all)}
      {est > 0 && <span className="muted small"> ({fmt(est)} est.)</span>}
      <div className="muted small">{t.requests} req{t.failures ? ` · ${t.failures} failed` : ''}</div>
    </span>
  );
}

function Meter({ used, limit }: { used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 1;
  const level = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'ok';
  return (
    <div className={`meter meter-${level}`} role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} title={`${Math.round(ratio * 100)}% used`}>
      <div className="meter-fill" style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

function statusInfo(k: KeyUsageRow): { icon: string; text: string; cls: string } {
  if (!k.enabled) return { icon: '○', text: 'Disabled', cls: 'muted' };
  if (k.budget && k.budget.remaining <= 0) return { icon: '⛔', text: 'Budget reached', cls: 'serious' };
  switch (k.status) {
    case 'cooldown':
      if ((k.cooldownUntil ?? 0) > Date.now()) return { icon: '⏳', text: `Cooling down until ${time(k.cooldownUntil!)}`, cls: 'warning' };
      return { icon: '✓', text: 'Active', cls: 'good' };
    case 'exhausted':
      return { icon: '⛔', text: 'Quota exhausted', cls: 'critical' };
    case 'invalid':
      return { icon: '✕', text: 'Invalid key', cls: 'critical' };
    case 'n/a':
      return { icon: '✓', text: 'Local', cls: 'good' };
    default:
      return { icon: '✓', text: 'Active', cls: 'good' };
  }
}

function RateLimitCell({ rl }: { rl?: RateLimitSnapshot }) {
  if (!rl) return <span className="muted" title={SOURCE_TEXT.unknown.help}>—</span>;
  const now = Date.now();
  const line = (label: string, remaining?: number, limit?: number, reset?: number) => {
    if (remaining === undefined && limit === undefined) return null;
    const stale = reset !== undefined && reset <= now;
    return (
      <div className={stale ? 'muted' : ''} title={stale ? 'This window has reset since the snapshot; the value is out of date.' : reset ? `Resets at ${time(reset)}` : undefined}>
        {label}: {remaining !== undefined ? remaining.toLocaleString() : '?'}
        {limit !== undefined ? ` / ${limit.toLocaleString()}` : ''}
        {stale ? ' (reset since)' : ''}
      </div>
    );
  };
  return (
    <span>
      {line('Requests', rl.remainingRequests, rl.limitRequests, rl.resetRequestsAt)}
      {line('Tokens', rl.remainingTokens, rl.limitTokens, rl.resetTokensAt)}
      <div className="muted small">as of {ago(rl.at)}</div>
    </span>
  );
}

function BalanceCell({ row, supported }: { row: KeyUsageRow; supported: boolean }) {
  if (!supported) return <span className="muted" title="This provider has no balance API.">—</span>;
  const b = row.balance;
  if (!b) return <span className="muted">Not checked yet</span>;
  if (b.error) return <span className="error-text" title={b.error}>Check failed</span>;
  const value =
    b.remaining === null ? 'No limit' : b.remaining !== undefined ? `${b.remaining.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${b.currency ?? ''}` : '?';
  return (
    <span title={`Source: ${b.source}`}>
      {value}
      {b.used !== undefined && <div className="muted small">used {b.used.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>}
      <div className="muted small">as of {ago(b.at)}</div>
    </span>
  );
}

function ProviderTable({ p }: { p: ProviderUsageRow }) {
  return (
    <div className="card usage-provider">
      <div className="provider-head">
        <div className="provider-title">
          <strong>{p.name}</strong>
          <span className="muted small">
            {p.role === 'context' ? 'local context model' : 'intelligence'} · {p.baseUrl}
          </span>
          {!p.enabled && <span className="muted small">(disabled)</span>}
        </div>
      </div>
      {p.keys.length === 0 ? (
        <div className="muted small">No keys.</div>
      ) : (
        <div className="table-scroll">
          <table className="grid usage-grid">
            <thead>
              <tr>
                <th>Key</th>
                <th>Status</th>
                <th>Today <SourceBadge source="counted" /></th>
                <th>This month <SourceBadge source="counted" /></th>
                <th>Budget <SourceBadge source="budget" /></th>
                <th>Rate-limit window <SourceBadge source="reported" /></th>
                <th>Balance <SourceBadge source="reported" /></th>
              </tr>
            </thead>
            <tbody>
              {p.keys.map((k) => {
                const st = statusInfo(k);
                return (
                  <tr key={k.keyId || 'local'}>
                    <td>
                      <strong>{k.label}</strong>
                      {k.hint && <div className="muted small"><code>{k.hint}</code></div>}
                    </td>
                    <td>
                      <span className={`status status-${st.cls}`} title={k.lastError}>
                        {st.icon} {st.text}
                      </span>
                    </td>
                    <td><TokenCell t={k.today} /></td>
                    <td><TokenCell t={k.month} /></td>
                    <td>
                      {k.budget ? (
                        <div title={k.budget.includesEstimates ? 'Used amount includes locally estimated tokens.' : undefined}>
                          <Meter used={k.budget.used} limit={k.budget.tokens} />
                          <div className="small">
                            {fmt(k.budget.remaining)} left of {fmt(k.budget.tokens)} {k.budget.period === 'total' ? 'total' : `per ${k.budget.period}`}
                            {k.budget.includesEstimates ? ' *' : ''}
                          </div>
                        </div>
                      ) : (
                        <span className="muted" title="No budget set. Set one in Settings & Providers.">—</span>
                      )}
                    </td>
                    <td><RateLimitCell rl={k.rateLimit} /></td>
                    <td><BalanceCell row={k} supported={p.balanceSupported} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Usage() {
  const [state, setState] = useState<UsageState | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const off = on('usage/state', setState);
    request('usage/getState', undefined).then(setState, (e: Error) => setMessage(e.message));
    const timer = setInterval(() => setTick((t) => t + 1), 15000); // refresh "as of" / cooldown text
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  if (!state) return <div className="admin">{message ?? 'Loading…'}</div>;
  const t = state.totals;
  const anyBalanceProvider = state.providers.some((p) => p.balanceSupported);

  const refresh = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const r = await request('usage/refreshBalances', undefined);
      setMessage(
        r.checked === 0
          ? 'None of your providers offer a balance API, so there is nothing to check.'
          : `Checked ${r.checked} key(s).${r.unsupported ? ` ${r.unsupported} provider(s) have no balance API.` : ''}`,
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin usage">
      <header className="admin-header">
        <div>
          <h1>CodeWeave Usage</h1>
          <p className="muted">
            Token counts are recorded locally for every request. Each figure is labelled by where it comes from; values a
            provider does not expose are shown as “—”, never guessed.
          </p>
        </div>
        <div className="actions">
          <button className="btn" disabled={busy || !anyBalanceProvider} onClick={() => void refresh()} title={anyBalanceProvider ? 'Calls the provider balance API for each key' : 'None of your providers has a balance API'}>
            {busy ? 'Checking…' : 'Refresh balances'}
          </button>
          <button className="btn" onClick={() => request('usage/openAdmin', undefined)}>Settings &amp; budgets</button>
          <button className="btn danger" onClick={() => request('usage/clear', undefined)}>Clear history</button>
        </div>
      </header>

      {message && <div className="banner ok">{message}</div>}

      <div className="tiles">
        <Tile
          hero
          label="Tokens this month"
          value={fmt(total(t.month))}
          sub={`${t.month.requests} requests${estimated(t.month) ? ` · ${fmt(estimated(t.month))} estimated` : ''}`}
          source="counted"
        />
        <Tile label="Tokens today" value={fmt(total(t.today))} sub={estimated(t.today) ? `${fmt(estimated(t.today))} estimated` : undefined} source="counted" />
        <Tile label="Usable API keys" value={`${t.keysUsable} / ${t.keysTotal}`} sub="enabled, not cooling down, exhausted, invalid or over budget" source="counted" />
        <Tile
          label="Budget remaining"
          value={t.budget.keysWithBudget ? fmt(t.budget.remainingTokens) : '—'}
          sub={
            t.budget.keysWithBudget
              ? `across ${t.budget.keysWithBudget} key(s) with a budget${t.budget.keysWithoutBudget ? `; ${t.budget.keysWithoutBudget} without` : ''}${t.budget.includesEstimates ? ' · includes estimates' : ''}`
              : 'No budgets set'
          }
          source={t.budget.keysWithBudget ? 'budget' : 'unknown'}
        />
        <Tile
          label="Rate-limit headroom"
          value={t.rateLimit.keysReporting ? `${fmt(t.rateLimit.remainingTokens)} tok` : '—'}
          sub={
            t.rateLimit.keysReporting
              ? `${t.rateLimit.remainingRequests.toLocaleString()} requests left in current windows · ${t.rateLimit.keysReporting} key(s) reporting`
              : 'No provider has sent rate-limit headers yet'
          }
          source={t.rateLimit.keysReporting ? 'reported' : 'unknown'}
        />
        <Tile
          label="Account balance"
          value={t.balances.length ? t.balances.map((b) => `${b.remaining.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${b.currency}`).join(' · ') : '—'}
          sub={
            t.balances.length
              ? t.balances.map((b) => `${b.keys} key(s)${b.unlimitedKeys ? `, ${b.unlimitedKeys} unlimited` : ''}`).join(' · ')
              : anyBalanceProvider
                ? 'Click “Refresh balances”'
                : 'Your providers do not offer a balance API'
          }
          source={t.balances.length ? 'reported' : 'unknown'}
        />
      </div>

      <div className="legend muted small">
        {(['reported', 'counted', 'budget', 'unknown'] as Source[]).map((s) => (
          <span key={s}>
            <SourceBadge source={s} /> {SOURCE_TEXT[s].help}
          </span>
        ))}
      </div>

      {state.providers.length === 0 && <div className="card muted">No providers configured.</div>}
      {state.providers.map((p) => (
        <ProviderTable key={p.id} p={p} />
      ))}

      <p className="muted small">Updated {time(state.generatedAt)}. All-time: {fmt(total(t.allTime))} tokens over {t.allTime.requests} requests.</p>
    </div>
  );
}
