import type { RateLimitSnapshot } from '../shared/types';

export type ProviderErrorKind =
  | 'rate_limit' // 429 without quota exhaustion: back off and retry later
  | 'quota' // billing / credit / quota exhausted
  | 'auth' // 401 / 403
  | 'context_length' // prompt too large for the model
  | 'bad_request' // other 4xx
  | 'server' // 5xx
  | 'network' // DNS, connection refused, TLS
  | 'timeout' // no data within the idle timeout
  | 'cancelled'; // user aborted

export class ProviderError extends Error {
  /** Rate-limit headers that came with the error response, when any. */
  rateLimits?: RateLimitSnapshot;
  /** Text streamed before the failure (set by the router for context transfer). */
  partialText?: string;

  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number,
    /** Milliseconds the provider asked us to wait, when it said so. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const QUOTA_PATTERNS = /insufficient_quota|quota|billing|credit|exceeded your current|payment required|out of credits/i;
const CONTEXT_PATTERNS =
  /context[_ ]length|maximum context|context window|too many tokens|prompt is too long|reduce the length|token limit/i;

/** Parse Retry-After (seconds or HTTP date) and OpenAI-style reset headers ("6m0s", "1.5s", "20ms"). */
export function parseRetryAfter(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const resets = ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']
    .map((h) => headers.get(h))
    .filter((v): v is string => !!v)
    .map(parseDuration)
    .filter((v): v is number => v !== undefined);
  return resets.length ? Math.max(...resets) : undefined;
}

export function parseDuration(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed))) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  return matched ? total : undefined;
}

/** Extract a readable message from an error response body (JSON or text). */
export function extractErrorMessage(body: string): string {
  try {
    const json = JSON.parse(body);
    const err = json.error ?? json;
    const msg = typeof err === 'string' ? err : err.message ?? err.msg ?? json.message;
    const code = typeof err === 'object' ? err.code ?? err.type : undefined;
    if (msg) return code && !String(msg).includes(String(code)) ? `${msg} (${code})` : String(msg);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500).trim() || 'Empty error response';
}

export function classifyHttpError(status: number, body: string, headers: Headers): ProviderError {
  const message = extractErrorMessage(body);
  const retryAfterMs = parseRetryAfter(headers);
  if (status === 401 || status === 403) return new ProviderError('auth', message, status);
  if (status === 402 || QUOTA_PATTERNS.test(body)) {
    // Some providers return 429 for quota exhaustion; the body tells them apart.
    if (status === 429 && !/insufficient_quota|billing|credit|payment/i.test(body) && retryAfterMs !== undefined) {
      return new ProviderError('rate_limit', message, status, retryAfterMs);
    }
    return new ProviderError('quota', message, status, retryAfterMs);
  }
  if (status === 429) return new ProviderError('rate_limit', message, status, retryAfterMs);
  if (status === 413 || CONTEXT_PATTERNS.test(body)) return new ProviderError('context_length', message, status);
  if (status >= 500) return new ProviderError('server', message, status, retryAfterMs);
  return new ProviderError('bad_request', message, status);
}

export function describeError(err: unknown): string {
  if (err instanceof ProviderError) {
    const label: Record<ProviderErrorKind, string> = {
      rate_limit: 'Rate limited',
      quota: 'Quota exhausted',
      auth: 'Authentication failed',
      context_length: 'Context too long',
      bad_request: 'Request rejected',
      server: 'Provider error',
      network: 'Network error',
      timeout: 'Timed out',
      cancelled: 'Cancelled',
    };
    return `${label[err.kind]}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
