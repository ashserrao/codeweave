import { describe, expect, it } from 'vitest';
import { exhaustedUntil, parseRateLimitHeaders, parseResetAt } from '../src/providers/rateLimits';

describe('rate-limit headers', () => {
  const now = 1_700_000_000_000;

  it('parses OpenAI-style request/token windows', () => {
    const s = parseRateLimitHeaders(new Headers({
      'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '499', 'x-ratelimit-reset-requests': '120ms',
      'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '29000', 'x-ratelimit-reset-tokens': '2s',
    }), now)!;
    expect(s).toMatchObject({ limitRequests: 500, remainingRequests: 499, resetRequestsAt: now + 120, limitTokens: 30000, remainingTokens: 29000, resetTokensAt: now + 2000 });
  });

  it('parses generic headers with epoch reset (OpenRouter style)', () => {
    const s = parseRateLimitHeaders(new Headers({ 'x-ratelimit-limit': '20', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 30_000) }), now)!;
    expect(s.remainingRequests).toBe(0);
    expect(s.resetRequestsAt).toBe(now + 30_000);
    expect(exhaustedUntil(s, now)).toBe(now + 30_000);
  });

  it('returns undefined when no headers are present', () => {
    expect(parseRateLimitHeaders(new Headers({ 'content-type': 'text/plain' }), now)).toBeUndefined();
  });

  it('interprets reset formats', () => {
    expect(parseResetAt('1700000005', now)).toBe(1_700_000_005_000);
    expect(parseResetAt('30', now)).toBe(now + 30_000);
    expect(parseResetAt('1m', now)).toBe(now + 60_000);
    expect(parseResetAt('', now)).toBeUndefined();
  });

  it('does not report exhaustion while capacity remains', () => {
    expect(exhaustedUntil({ at: now, remainingRequests: 3, resetRequestsAt: now + 1000 }, now)).toBeUndefined();
  });
});
