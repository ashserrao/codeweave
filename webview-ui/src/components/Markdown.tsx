import { useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { request } from '../rpc';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = escapeHtml((lang ?? '').split(/\s/)[0] || 'text');
      return `<div class="code-block"><div class="code-head"><span>${language}</span><button class="link-btn" data-copy>Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
    },
  },
});

/** Renders untrusted model output as sanitised markdown with copyable code blocks. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['data-copy'], FORBID_TAGS: ['style', 'form', 'input'] });
  }, [text]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.matches('[data-copy]')) {
      const code = target.closest('.code-block')?.querySelector('code')?.textContent ?? '';
      void request('chat/copy', { text: code });
    }
    // http(s) links are intercepted by VS Code and opened externally.
  };

  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
