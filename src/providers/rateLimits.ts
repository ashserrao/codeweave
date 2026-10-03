import type { RateLimitSnapshot } from '../shared/types';
import { parseDuration } from './errors';

function num(headers: Headers, ...names: string[]): number | undefined {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Reset headers come in three shapes: a duration ("6m0s", "1.5s", "20ms"),
 * epoch seconds, or epoch milliseconds. Returns an absolute epoch-ms time.
 */
export function parseResetAt(raw: string | null, now: number): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = raw.trim();
  if (/^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (n > 1e12) return n; // epoch ms
    if (n > 1e9) return n * 1000; // epoch seconds
    return now + n * 1000; // seconds from now
  }
  const ms = parseDuration(value);
  return ms === undefined ? undefined : now + ms;
}

/**
 * Reads OpenAI-style (x-ratelimit-*-requests / -tokens, also used by Groq, Together, DeepSeek
 * and others) and generic (x-ratelimit-limit / -remaining / -reset, e.g. OpenRouter) headers.
 * Returns undefined when the provider sent none, so the dashboard can show "not reported".
 */
export function parseRateLimitHeaders(headers: Headers, now = Date.now()): RateLimitSnapshot | undefined {
  const snap: RateLimitSnapshot = {
    at: now,
    limitRequests: num(headers, 'x-ratelimit-limit-requests', 'x-ratelimit-limit'),
    remainingRequests: num(headers, 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining'),
    resetRequestsAt: parseResetAt(headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset'), now),
    limitTokens: num(headers, 'x-ratelimit-limit-tokens'),
    remainingTokens: num(headers, 'x-ratelimit-remaining-tokens'),
    resetTokensAt: parseResetAt(headers.get('x-ratelimit-reset-tokens'), now),
  };
  const hasData = Object.entries(snap).some(([k, v]) => k !== 'at' && v !== undefined);
  return hasData ? snap : undefined;
}

/** When the provider says a window is used up, returns when it reopens. */
export function exhaustedUntil(snap: RateLimitSnapshot | undefined, now: number): number | undefined {
  if (!snap) return undefined;
  const until: number[] = [];
  if (snap.remainingRequests === 0 && snap.resetRequestsAt && snap.resetRequestsAt > now) until.push(snap.resetRequestsAt);
  if (snap.remainingTokens === 0 && snap.resetTokensAt && snap.resetTokensAt > now) until.push(snap.resetTokensAt);
  return until.length ? Math.max(...until) : undefined;
}
