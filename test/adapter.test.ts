import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { OpenAICompatAdapter } from '../src/providers/OpenAICompatAdapter';
import { ProviderError } from '../src/providers/errors';
import type { ProviderConfig } from '../src/shared/types';

let server: Server;
let baseUrl = '';
let lastBody: any;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }] }));
        return;
      }
      lastBody = JSON.parse(raw);
      const auth = req.headers.authorization;
      if (auth === 'Bearer limited') {
        res.writeHead(429, { 'retry-after': '3', 'content-type': 'application/json', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '3s' });
        res.end('{"error":{"message":"Rate limit"}}');
        return;
      }
      if (auth === 'Bearer nousage' && lastBody.stream_options) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"Unrecognized field stream_options"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '987' });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      chunk({ choices: [{ delta: { content: 'Hel' } }] });
      chunk({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] });
      if (lastBody.stream_options) chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const provider = (): ProviderConfig => ({
  id: 'p', name: 'mock', kind: 'openai-compatible', role: 'intelligence', baseUrl, priority: 0, enabled: true,
  requiresKey: true, headers: {}, models: [], keys: [],
});

const run = (apiKey: string, signal = new AbortController().signal) => {
  let streamed = '';
  return new OpenAICompatAdapter()
    .stream(
      { provider: provider(), model: 'm1', apiKey, messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, signal, idleTimeoutMs: 5000 },
      (t) => (streamed += t),
    )
    .then((r) => ({ ...r, streamed }));
};

describe('OpenAICompatAdapter', () => {
  it('streams text and reports provider usage', async () => {
    const r = await run('good');
    expect(r.streamed).toBe('Hello');
    expect(r.finishReason).toBe('stop');
    expect(r.usage).toEqual({ promptTokens: 11, completionTokens: 2, source: 'reported' });
    expect(lastBody.model).toBe('m1');
    expect(r.rateLimits).toMatchObject({ limitTokens: 1000, remainingTokens: 987 });
  });

  it('classifies 429 with retry-after', async () => {
    const err = await run('limited').catch((e) => e);
    expect(err).toMatchObject({ kind: 'rate_limit', retryAfterMs: 3000 });
    expect(err.rateLimits.remainingRequests).toBe(0);
  });

  it('retries without stream_options and labels usage as estimated', async () => {
    const r = await run('nousage');
    expect(r.streamed).toBe('Hello');
    expect(r.streamUsageUnsupported).toBe(true);
    expect(r.usage.source).toBe('estimated');
  });

  it('reports cancellation distinctly', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await run('good', ac.signal).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('cancelled');
  });

  it('lists models sorted', async () => {
    expect(await new OpenAICompatAdapter().listModels(provider(), 'good', new AbortController().signal)).toEqual(['m1', 'm2']);
  });

  it('reports network errors for unreachable endpoints', async () => {
    const p = { ...provider(), baseUrl: 'http://127.0.0.1:1/v1' };
    const err = await new OpenAICompatAdapter().listModels(p, 'x', new AbortController().signal).catch((e) => e);
    expect(err.kind).toBe('network');
  });
});
