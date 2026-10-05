import type { KeyMeta, ProviderConfig } from '../src/shared/types';
import type { KeyValueStore } from '../src/usage/UsageLedger';

export const memStore = (): KeyValueStore => {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string, d: T) => (m.has(k) ? (m.get(k) as T) : d), update: async (k, v) => void m.set(k, v) };
};

export const key = (id: string, extra: Partial<KeyMeta> = {}): KeyMeta => ({
  id, label: id, hint: '', enabled: true, status: 'active', ...extra,
});

export const provider = (id: string, priority: number, keys: KeyMeta[], extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id, name: id, kind: 'openai-compatible', role: 'intelligence', baseUrl: `https://${id}.example/v1`, priority, enabled: true,
  requiresKey: true, headers: {}, keys,
  models: [{ id: `${id}-m`, model: `${id}-model`, contextWindow: 8000, maxOutputTokens: 1000, enabled: true }],
  ...extra,
});
