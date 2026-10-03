import { describe, expect, it } from 'vitest';
import { classifyHttpError, parseDuration } from '../src/providers/errors';

const h = (o: Record<string, string> = {}) => new Headers(o);

describe('classifyHttpError', () => {
  it('detects quota exhaustion even on 429', () => {
    const body = JSON.stringify({ error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } });
    expect(classifyHttpError(429, body, h()).kind).toBe('quota');
  });

  it('treats plain 429 as rate limit with retry-after', () => {
    const err = classifyHttpError(429, '{"error":{"message":"Rate limit reached"}}', h({ 'retry-after': '7' }));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(7000);
  });

  it('maps auth, context length and server errors', () => {
    expect(classifyHttpError(401, 'bad key', h()).kind).toBe('auth');
    expect(classifyHttpError(400, "This model's maximum context length is 8192 tokens", h()).kind).toBe('context_length');
    expect(classifyHttpError(503, 'overloaded', h()).kind).toBe('server');
    expect(classifyHttpError(400, 'invalid model', h()).kind).toBe('bad_request');
  });

  it('reads OpenAI reset headers', () => {
    const err = classifyHttpError(429, 'slow down', h({ 'x-ratelimit-reset-tokens': '1m30s' }));
    expect(err.retryAfterMs).toBe(90_000);
  });
});

describe('parseDuration', () => {
  it('parses mixed units', () => {
    expect(parseDuration('6m0s')).toBe(360_000);
    expect(parseDuration('20ms')).toBe(20);
    expect(parseDuration('1.5')).toBe(1500);
    expect(parseDuration('soon')).toBeUndefined();
  });
});
