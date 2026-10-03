import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/providers/sse';

describe('SseParser', () => {
  it('parses events split across chunks', () => {
    const p = new SseParser();
    expect(p.push('data: {"a":')).toEqual([]);
    expect(p.push('1}\n\ndata: [DONE]\n\n')).toEqual(['{"a":1}', '[DONE]']);
  });

  it('handles CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\r\ndata: line1\r\ndata: line2\r\n\r\n')).toEqual(['line1\nline2']);
  });

  it('flushes a trailing event without blank line', () => {
    const p = new SseParser();
    p.push('data: tail');
    expect(p.end()).toEqual(['tail']);
  });
});
