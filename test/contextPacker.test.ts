import { describe, expect, it } from 'vitest';
import { packContext } from '../src/core/ContextPacker';
import type { ChatMessage } from '../src/shared/types';

const msg = (role: 'user' | 'assistant', content: string): ChatMessage => ({ id: Math.random().toString(), role, content, createdAt: 0 });

describe('packContext', () => {
  it('keeps everything when it fits', () => {
    const r = packContext('sys', [msg('user', 'hi'), msg('assistant', 'hello'), msg('user', 'q')], { contextWindow: 8000, maxOutputTokens: 1000 });
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(r.droppedMessages).toBe(0);
  });

  it('drops oldest messages first and notes it in the system prompt', () => {
    const big = 'x'.repeat(4000); // ~1000 tokens
    const history = [msg('user', big), msg('assistant', big), msg('user', big), msg('assistant', big), msg('user', 'latest')];
    const r = packContext('sys', history, { contextWindow: 3000, maxOutputTokens: 500, marginRatio: 0 });
    expect(r.messages.at(-1)?.content).toBe('latest');
    expect(r.droppedMessages).toBeGreaterThan(0);
    expect(r.messages[0].content).toContain('omitted');
  });

  it('truncates an oversized latest message instead of failing', () => {
    const r = packContext('sys', [msg('user', 'y'.repeat(100_000))], { contextWindow: 2048, maxOutputTokens: 512 });
    expect(r.messages[1].content).toContain('truncated');
    expect(r.messages[1].content.length).toBeLessThan(10_000);
  });
});
