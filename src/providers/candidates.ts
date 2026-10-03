import type { KeyMeta, ModelConfig, ModelTarget, ProviderConfig } from '../shared/types';

export interface Candidate {
  provider: ProviderConfig;
  model: ModelConfig;
  /** Undefined for keyless (local) providers. */
  key?: KeyMeta;
}

export function isKeyUsable(key: KeyMeta, now: number): boolean {
  if (!key.enabled) return false;
  if (key.status === 'active') return true;
  // Cooldowns expire on their own; exhausted / invalid keys need a manual reset.
  return key.status === 'cooldown' && (key.cooldownUntil ?? 0) <= now;
}

/**
 * Ordered list of (provider, model, key) attempts for a request.
 * Order: provider priority -> model order within provider -> key order within provider.
 * Keys are the inner loop so a rate-limited key rotates to a sibling key on the same model first.
 */
export function buildCandidates(
  providers: ProviderConfig[],
  target: ModelTarget,
  role: ProviderConfig['role'],
  now: number,
  /** Key ids to skip, e.g. keys whose user-set budget is used up. */
  excludeKeys: ReadonlySet<string> = new Set(),
): Candidate[] {
  const pool = providers
    .filter((p) => p.enabled && p.role === role)
    .sort((a, b) => a.priority - b.priority)
    .filter((p) => target.mode === 'auto' || p.id === target.providerId);

  const result: Candidate[] = [];
  for (const provider of pool) {
    const models = provider.models.filter(
      (m) => m.enabled && (target.mode === 'auto' || m.id === target.modelId),
    );
    for (const model of models) {
      if (!provider.requiresKey) {
        result.push({ provider, model });
        continue;
      }
      for (const key of provider.keys) {
        if (isKeyUsable(key, now) && !excludeKeys.has(key.id)) result.push({ provider, model, key });
      }
    }
  }
  return result;
}

/** Why there were no candidates, for an actionable error message. */
export function explainNoCandidates(providers: ProviderConfig[], role: ProviderConfig['role'], now: number): string {
  const inRole = providers.filter((p) => p.role === role);
  if (inRole.length === 0) {
    return role === 'intelligence'
      ? 'No intelligence provider is configured. Open CodeWeave Settings & Providers to add one.'
      : 'No local context provider is configured.';
  }
  const enabled = inRole.filter((p) => p.enabled);
  if (enabled.length === 0) return 'All providers are disabled.';
  if (enabled.every((p) => !p.models.some((m) => m.enabled))) return 'No enabled models. Add a model to a provider.';
  const keyed = enabled.filter((p) => p.requiresKey);
  if (keyed.length === enabled.length && keyed.every((p) => p.keys.length === 0)) {
    return 'No API keys added. Add a key in CodeWeave Settings & Providers.';
  }
  const soonest = keyed
    .flatMap((p) => p.keys)
    .filter((k) => k.enabled && k.status === 'cooldown' && k.cooldownUntil)
    .map((k) => k.cooldownUntil!)
    .sort((a, b) => a - b)[0];
  const cooldownText = soonest ? ` The next key leaves cooldown in ${Math.ceil((soonest - now) / 1000)}s.` : '';
  return `Every API key is exhausted, invalid, cooling down, over its budget or disabled.${cooldownText} Check the CodeWeave Usage dashboard.`;
}
