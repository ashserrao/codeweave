/**
 * AI gateways route one request to one of many upstream providers. When a gateway says which one
 * it picked, CodeWeave shows it next to the reply. Currently understood:
 *  - OmniRoute: `X-OmniRoute-Decision: strategy=<name>; provider=<alias>; latency_ms=<n>` (every
 *    completion) and `X-OmniRoute-Provider` / `X-OmniRoute-Model` (non-streaming responses).
 * Returns undefined when no such header is present.
 */
export function parseGatewayDecision(headers: Headers): string | undefined {
  const decision = headers.get('x-omniroute-decision');
  const fields: Record<string, string> = {};
  if (decision) {
    for (const part of decision.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) fields[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
  }
  const provider = headers.get('x-omniroute-provider')?.trim() || fields.provider;
  const model = headers.get('x-omniroute-model')?.trim();
  if (!provider && !model) return undefined;
  const strategy = fields.strategy ? ` (${fields.strategy})` : '';
  return `${[provider, model].filter(Boolean).join(' / ')}${strategy}`;
}
