import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { parseGatewayDecision } from '../src/providers/gateway';
import { OpenAICompatAdapter, dedupeModelIds } from '../src/providers/OpenAICompatAdapter';
import { PROVIDER_PRESETS } from '../src/providers/presets';
import type { ProviderConfig } from '../src/shared/types';

describe('parseGatewayDecision', () => {
  it('reads the OmniRoute decision header (streaming responses)', () => {
    const h = new Headers({ 'X-OmniRoute-Decision': 'strategy=priority; provider=cc; latency_ms=812' });
    expect(parseGatewayDecision(h)).toBe('cc (priority)');
  });

  it('prefers explicit provider/model headers (non-streaming responses)', () => {
    const h = new Headers({
      'X-OmniRoute-Decision': 'strategy=cost-optimized; provider=gh; latency_ms=5',
      'X-OmniRoute-Provider': 'github',
      'X-OmniRoute-Model': 'gpt-5-mini',
    });
    expect(parseGatewayDecision(h)).toBe('github / gpt-5-mini (cost-optimized)');
  });

  it('returns undefined for ordinary providers', () => {
    expect(parseGatewayDecision(new Headers({ 'content-type': 'text/event-stream' }))).toBeUndefined();
  });
});

describe('dedupeModelIds', () => {
  it('drops alias/canonical mirrors whose parent is listed', () => {
    const list = [
      { id: 'cc/claude-sonnet-4-6' },
      { id: 'claude/claude-sonnet-4-6', parent: 'cc/claude-sonnet-4-6' },
      { id: 'auto/coding' },
      { id: 'orphan/x', parent: 'not-listed' },
      'plain-model',
      { name: 'ollama-style' },
    ];
    expect(dedupeModelIds(list)).toEqual(['auto/coding', 'cc/claude-sonnet-4-6', 'ollama-style', 'orphan/x', 'plain-model']);
  });
});

describe('OmniRoute preset', () => {
  it('points at the default local gateway and disables memory injection', () => {
    const p = PROVIDER_PRESETS.find((x) => x.label.startsWith('OmniRoute'))!;
    expect(p.baseUrl).toBe('http://localhost:20128/v1');
    expect(p.requiresKey).toBe(true);
    expect(p.headers).toEqual({ 'x-omniroute-no-memory': 'true' });
  });
});

describe('adapter against a gateway', () => {
  let server: Server;
  let baseUrl = '';
  let seenHeaders: Record<string, string | string[] | undefined> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenHeaders = req.headers;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-omniroute-decision': 'strategy=priority; provider=kimi; latency_ms=40' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sends the preset headers and reports which upstream served the reply', async () => {
    const provider: ProviderConfig = {
      id: 'o', name: 'OmniRoute', kind: 'openai-compatible', role: 'intelligence', baseUrl, priority: 0, enabled: true,
      requiresKey: true, headers: { 'x-omniroute-no-memory': 'true' }, models: [], keys: [],
    };
    const r = await new OpenAICompatAdapter().stream(
      { provider, model: 'auto/coding', apiKey: 'or-key', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, signal: new AbortController().signal, idleTimeoutMs: 5000 },
      () => undefined,
    );
    expect(seenHeaders['x-omniroute-no-memory']).toBe('true');
    expect(seenHeaders.authorization).toBe('Bearer or-key');
    expect(r.servedBy).toBe('kimi (priority)');
  });
});
