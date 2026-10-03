import type { BalanceSnapshot, ProviderConfig } from '../shared/types';
import { classifyHttpError, describeError } from '../providers/errors';

/**
 * Providers with an official endpoint that reports account credit for an API key.
 * Everything else has no such API; the dashboard says so instead of guessing.
 * Probes run only when the user clicks "Refresh balances" (no background polling).
 */
interface BalanceProbe {
  label: string;
  matches(url: URL): boolean;
  fetch(url: URL, apiKey: string, signal: AbortSignal): Promise<Omit<BalanceSnapshot, 'at' | 'source'>>;
}

async function getJson(url: string, apiKey: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal });
  if (!res.ok) throw classifyHttpError(res.status, await res.text().catch(() => ''), res.headers);
  return res.json();
}

const finite = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const PROBES: BalanceProbe[] = [
  {
    // https://openrouter.ai/docs/api-reference/api-keys/get-current-key
    label: 'OpenRouter /api/v1/key',
    matches: (u) => u.hostname === 'openrouter.ai' || u.hostname.endsWith('.openrouter.ai'),
    async fetch(u, key, signal) {
      const json = await getJson(`${u.origin}/api/v1/key`, key, signal);
      const d = json?.data ?? {};
      const limit = d.limit === null ? null : finite(d.limit);
      const used = finite(d.usage);
      let remaining = d.limit_remaining === null ? null : finite(d.limit_remaining);
      if (remaining === undefined) {
        // Older responses omit limit_remaining; derive it only when both inputs are reported.
        remaining = limit === null ? null : limit !== undefined && used !== undefined ? limit - used : undefined;
      }
      return { currency: 'USD credits', limit, used, remaining };
    },
  },
  {
    // https://api-docs.deepseek.com/api/get-user-balance
    label: 'DeepSeek /user/balance',
    matches: (u) => u.hostname === 'api.deepseek.com',
    async fetch(u, key, signal) {
      const json = await getJson(`${u.origin}/user/balance`, key, signal);
      const info = Array.isArray(json?.balance_infos) ? json.balance_infos[0] : undefined;
      if (!info) return { error: 'Balance endpoint returned no balance information' };
      return { currency: String(info.currency ?? ''), remaining: finite(info.total_balance) };
    },
  },
];

export function balanceProbeFor(provider: ProviderConfig): BalanceProbe | undefined {
  try {
    const url = new URL(provider.baseUrl);
    return PROBES.find((p) => p.matches(url));
  } catch {
    return undefined;
  }
}

export async function probeBalance(provider: ProviderConfig, apiKey: string, signal: AbortSignal): Promise<BalanceSnapshot | undefined> {
  const probe = balanceProbeFor(provider);
  if (!probe) return undefined;
  try {
    const result = await probe.fetch(new URL(provider.baseUrl), apiKey, signal);
    return { at: Date.now(), source: probe.label, ...result };
  } catch (err) {
    return { at: Date.now(), source: probe.label, error: describeError(err) };
  }
}
