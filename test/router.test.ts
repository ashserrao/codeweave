import { describe, expect, it } from 'vitest';
import { Router } from '../src/providers/Router';
import { ProviderError } from '../src/providers/errors';
import type { CompletionRequest, CompletionResult, ProviderAdapter } from '../src/providers/types';
import type { KeyMeta, ProviderConfig } from '../src/shared/types';
import { UsageLedger } from '../src/usage/UsageLedger';
import { key, memStore, provider } from './helpers';

type Step = (req: CompletionRequest, onText: (t: string) => void) => Promise<CompletionResult>;

function setup(providers: ProviderConfig[], steps: Step[]) {
  const calls: CompletionRequest[] = [];
  const adapter: ProviderAdapter = {
    stream: async (req, onText) => {
      calls.push(req);
      const step = steps.shift();
      if (!step) throw new Error('unexpected call');
      return step(req, onText);
    },
    listModels: async () => [],
  };
  const registry = {
    list: () => providers,
    vault: { get: async () => 'secret' },
    updateKey: async (pid: string, kid: string, update: Partial<KeyMeta>) => {
      const k = providers.find((p) => p.id === pid)!.keys.find((x) => x.id === kid)!;
      Object.assign(k, update);
    },
    setStreamUsageSupport: async () => undefined,
  };
  const ledger = new UsageLedger(memStore());
  const router = new Router(registry as never, adapter, ledger, { warn: () => undefined, info: () => undefined });
  return { router, calls, ledger };
}

const ok =
  (text: string, extra: Partial<CompletionResult> = {}): Step =>
  async (_r, onText) => {
    onText(text);
    return { text, usage: { promptTokens: 10, completionTokens: 5, source: 'reported' }, ...extra };
  };
const fail =
  (err: ProviderError, partial = ''): Step =>
  async (_r, onText) => {
    if (partial) onText(partial);
    throw err;
  };

const baseReq = (partials: string[] = []) => ({
  target: { mode: 'auto' as const },
  role: 'intelligence' as const,
  signal: new AbortController().signal,
  idleTimeoutMs: 1000,
  onText: () => undefined,
  buildMessages: (_c: unknown, partial: string) => {
    partials.push(partial);
    return [{ role: 'user' as const, content: partial ? `continue after: ${partial}` : 'hi' }];
  },
});

describe('Router', () => {
  it('rotates to the next key on rate limit and cools the first key down', async () => {
    const providers = [provider('a', 0, [key('k1'), key('k2')])];
    const { router, calls, ledger } = setup(providers, [fail(new ProviderError('rate_limit', 'slow down', 429, 30_000)), ok('hello')]);
    const res = await router.complete(baseReq());
    expect(res.text).toBe('hello');
    expect(res.candidate.key?.id).toBe('k2');
    expect(calls).toHaveLength(2);
    expect(providers[0].keys[0].status).toBe('cooldown');
    expect(providers[0].keys[0].cooldownUntil).toBeGreaterThan(Date.now() + 25_000);
    expect(res.notes[0]).toContain('switched to');
    expect(ledger.totals('a', 'k1')).toMatchObject({ requests: 1, failures: 1 });
    expect(ledger.totals('a', 'k2').reportedPrompt).toBe(10);
  });

  it('marks quota-exhausted and invalid keys and falls back across providers', async () => {
    const providers = [provider('a', 0, [key('k1'), key('k2')]), provider('b', 1, [key('b1')])];
    const { router } = setup(providers, [
      fail(new ProviderError('quota', 'no credit', 402)),
      fail(new ProviderError('auth', 'bad key', 401)),
      ok('from b'),
    ]);
    const res = await router.complete(baseReq());
    expect(res.candidate.provider.id).toBe('b');
    expect(providers[0].keys.map((k) => k.status)).toEqual(['exhausted', 'invalid']);
  });

  it('continues a partial answer on the next provider (context transfer)', async () => {
    const partials: string[] = [];
    const providers = [provider('a', 0, [key('k1')]), provider('b', 1, [key('b1')])];
    const { router, ledger } = setup(providers, [
      fail(new ProviderError('server', 'overloaded', 503), 'The answer starts'),
      ok(' and finishes.'),
    ]);
    const res = await router.complete(baseReq(partials));
    expect(partials).toEqual(['', 'The answer starts']);
    expect(res.text).toBe('The answer starts and finishes.');
    expect(res.continued).toBe(true);
    expect(res.notes[0]).toContain('continuing on');
    expect(res.usage.source).toBe('estimated'); // the failed partial attempt could only be estimated
    expect(ledger.totals('a', 'k1').estimatedCompletion).toBeGreaterThan(0);
  });

  it('skips keys whose user budget is used up', async () => {
    const providers = [provider('a', 0, [key('k1', { budget: { tokens: 10, period: 'total' } }), key('k2')])];
    const { router, ledger } = setup(providers, [ok('x')]);
    await ledger.record('a', 'k1', { promptTokens: 10, completionTokens: 0, source: 'reported' }, true);
    const res = await router.complete(baseReq());
    expect(res.candidate.key?.id).toBe('k2');
  });

  it('rests a key when the provider reports its window is empty', async () => {
    const providers = [provider('a', 0, [key('k1')])];
    const reset = Date.now() + 45_000;
    const { router } = setup(providers, [ok('x', { rateLimits: { at: Date.now(), remainingRequests: 0, resetRequestsAt: reset } })]);
    await router.complete(baseReq());
    expect(providers[0].keys[0]).toMatchObject({ status: 'cooldown', cooldownUntil: reset });
  });

  it('does not retry non-retryable errors', async () => {
    const providers = [provider('a', 0, [key('k1'), key('k2')])];
    const { router, calls } = setup(providers, [fail(new ProviderError('bad_request', 'unknown model', 400))]);
    await expect(router.complete(baseReq())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(calls).toHaveLength(1);
  });

  it('keeps partial text on cancellation', async () => {
    const providers = [provider('a', 0, [key('k1'), key('k2')])];
    const { router, calls } = setup(providers, [fail(new ProviderError('cancelled', 'stop'), 'half')]);
    const err = await router.complete(baseReq()).catch((e) => e);
    expect(err.kind).toBe('cancelled');
    expect(err.partialText).toBe('half');
    expect(calls).toHaveLength(1);
  });

  it('explains when no key is usable', async () => {
    const providers = [provider('a', 0, [key('k1', { status: 'invalid' })])];
    const { router } = setup(providers, []);
    await expect(router.complete(baseReq())).rejects.toThrow(/exhausted, invalid, cooling down, over its budget/);
  });
});
