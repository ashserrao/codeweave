import { describe, expect, it } from 'vitest';
import { chunkText, packContext, promptBudget, renderTranscript, selectFoldCount, unsummarized } from '../src/core/ContextPacker';
import { ContextService } from '../src/core/ContextService';
import { estimateTokens } from '../src/core/tokens';
import type { ChatMessage, ContextSummary } from '../src/shared/types';

let n = 0;
const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ id: `m${n++}`, role, content, createdAt: 0 });

describe('context folding', () => {
  const opts = { contextWindow: 4000, maxOutputTokens: 1000, marginRatio: 0 };

  it('folds nothing when everything fits', () => {
    expect(selectFoldCount('sys', [msg('user', 'hi'), msg('assistant', 'yo')], opts, 600)).toBe(0);
  });

  it('folds oldest messages down to the target ratio and never the newest', () => {
    const big = 'x'.repeat(2000); // ~500 tokens each, 5000 total vs a 3000 budget
    const history = Array.from({ length: 10 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', big));
    const fold = selectFoldCount('sys', history, opts, 600);
    expect(fold).toBeGreaterThan(0);
    expect(fold).toBeLessThan(history.length);
    const remaining = history.slice(fold).reduce((a, m) => a + estimateTokens(m.content), 0);
    const target = promptBudget(opts) * 0.6 - estimateTokens('sys') - 600;
    expect(remaining).toBeLessThanOrEqual(target);
  });

  it('packs the summary into the system prompt and skips summarised messages', () => {
    const history = [msg('user', 'old question'), msg('assistant', 'old answer'), msg('user', 'new question')];
    const summary: ContextSummary = {
      text: '- user asked an old question',
      coversThroughId: history[1].id,
      messageCount: 2,
      providerName: 'local',
      model: 'qwen',
      createdAt: 0,
    };
    expect(unsummarized(history, summary).map((m) => m.content)).toEqual(['new question']);
    const packed = packContext('sys', history, opts, summary);
    expect(packed.messages[0].content).toContain('- user asked an old question');
    expect(packed.messages.map((m) => m.content)).not.toContain('old answer');
    expect(packed.messages.at(-1)!.content).toBe('new question');
  });

  it('chunks long transcripts on paragraph boundaries without losing text', () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i} `.repeat(20)).join('\n\n');
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('abbreviates large attachments in the transcript', () => {
    const m: ChatMessage = {
      ...msg('user', 'q'),
      attachments: [{ kind: 'file', path: 'a.ts', language: 'ts', content: 'y'.repeat(5000), truncated: false }],
    };
    const t = renderTranscript([m], 100);
    expect(t.length).toBeLessThan(300);
    expect(t).toContain('a.ts');
  });
});

describe('ContextService', () => {
  it('summarises chunk by chunk with the context role, carrying the summary forward', async () => {
    const roles: string[] = [];
    const prompts: string[] = [];
    const fakeRouter = {
      candidates: () => [{ provider: { name: 'Ollama' }, model: { model: 'qwen2.5:3b', contextWindow: 2048, maxOutputTokens: 512 } }],
      complete: async (req: { role: string; buildMessages: (c: unknown, p: string) => { content: string }[] }) => {
        roles.push(req.role);
        prompts.push(req.buildMessages({}, '')[1].content);
        return { text: `summary v${roles.length}`, candidate: { provider: { name: 'Ollama' }, model: { model: 'qwen2.5:3b' } } };
      },
    };
    const svc = new ContextService(fakeRouter as never);
    const history = Array.from({ length: 8 }, (_, i) => msg('user', `message ${i} `.repeat(150)));
    const res = await svc.summarize(undefined, history, new AbortController().signal, 1000);
    expect(roles.length).toBeGreaterThan(1);
    expect(roles.every((r) => r === 'context')).toBe(true);
    expect(prompts[1]).toContain('Existing summary:\nsummary v1');
    expect(res).toEqual({ text: `summary v${roles.length}`, providerName: 'Ollama', model: 'qwen2.5:3b' });
  });

  it('reports unavailability when no context model exists', async () => {
    const svc = new ContextService({ candidates: () => [] } as never);
    expect(svc.isAvailable()).toBe(false);
    await expect(svc.summarize(undefined, [msg('user', 'x')], new AbortController().signal, 1000)).rejects.toThrow(/No local context model/);
  });
});
