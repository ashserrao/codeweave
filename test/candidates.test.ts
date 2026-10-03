import { describe, expect, it } from 'vitest';
import { buildCandidates } from '../src/providers/candidates';
import type { KeyMeta, ProviderConfig } from '../src/shared/types';

const key = (id: string, extra: Partial<KeyMeta> = {}): KeyMeta => ({ id, label: id, hint: '', enabled: true, status: 'active', ...extra });
const provider = (id: string, priority: number, keys: KeyMeta[], extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id, name: id, kind: 'openai-compatible', role: 'intelligence', baseUrl: 'https://x', priority, enabled: true,
  requiresKey: true, headers: {}, keys,
  models: [{ id: `${id}-m`, model: `${id}-model`, contextWindow: 8000, maxOutputTokens: 1000, enabled: true }],
  ...extra,
});

describe('buildCandidates', () => {
  it('orders by provider priority then key order, skipping unusable keys', () => {
    const now = 1000;
    const list = buildCandidates(
      [
        provider('b', 1, [key('b1')]),
        provider('a', 0, [key('a1', { status: 'exhausted' }), key('a2'), key('a3', { status: 'cooldown', cooldownUntil: 500 })]),
        provider('c', 2, [key('c1', { status: 'cooldown', cooldownUntil: 5000 })]),
      ],
      { mode: 'auto' },
      'intelligence',
      now,
    );
    expect(list.map((c) => c.key?.id)).toEqual(['a2', 'a3', 'b1']);
  });

  it('respects pinned target and keyless providers', () => {
    const list = buildCandidates(
      [provider('a', 0, [key('a1')]), provider('local', 1, [], { requiresKey: false })],
      { mode: 'pinned', providerId: 'local', modelId: 'local-m' },
      'intelligence',
      0,
    );
    expect(list).toHaveLength(1);
    expect(list[0].key).toBeUndefined();
  });
});
