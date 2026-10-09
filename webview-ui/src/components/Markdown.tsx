import { useMemo } from 'react';
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { request } from '../rpc';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Reads `path=...` / `run` markers from a fence info string (mirrors src/approval/changeFormat.ts). */
function proposalInfo(info: string): { kind: 'file' | 'delete' | 'command'; label: string } | undefined {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const path = /(?:^|\s)(?:path|file|filepath)=("[^"]*"|'[^']*'|\S+)/i.exec(info)?.[1]?.replace(/^["']|["']$/g, '');
  if (lang === 'delete' && path) return { kind: 'delete', label: path };
  if (path) return { kind: 'file', label: path };
  if (/(?:^|\s)run(?:\s|$)/i.test(info) && /^(shell|sh|bash|zsh|powershell|pwsh|ps1|cmd|bat|console|terminal)$/.test(lang)) {
    return { kind: 'command', label: 'Terminal command' };
  }
  return undefined;
}

const PROPOSAL_ICON = { file: 'edit', delete: 'trash', command: 'terminal' } as const;

function makeRenderer(applyEnabled: boolean) {
  return new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        const info = lang ?? '';
        const language = escapeHtml(info.split(/\s/)[0] || 'text');
        const proposal = proposalInfo(info);
        if (proposal) {
          // Proposed changes are reviewed in the Changes card; keep the raw block collapsed here.
          const label = escapeHtml(proposal.label);
          return `<details class="proposal-block"><summary><i class="codicon codicon-${PROPOSAL_ICON[proposal.kind]}"></i><span class="proposal-label">${label}</span><span class="proposal-hint">see Changes below</span></summary><pre><code>${escapeHtml(text)}</code></pre></details>`;
        }
        const apply = applyEnabled
          ? `<button class="icon-btn" data-apply title="Apply to the active editor (you review a diff first)"><i class="codicon codicon-insert"></i></button>`
          : '';
        return `<div class="code-block"><div class="code-toolbar"><span class="code-lang">${language}</span>${apply}<button class="icon-btn" data-copy title="Copy"><i class="codicon codicon-copy"></i></button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
      },
    },
  });
}

const withApply = makeRenderer(true);
const withoutApply = makeRenderer(false);

/** Renders untrusted model output as sanitised markdown with copyable (and optionally applicable) code blocks. */
export function Markdown({ text, onApply }: { text: string; onApply?: (code: string) => void }) {
  const html = useMemo(() => {
    const raw = (onApply ? withApply : withoutApply).parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['data-copy', 'data-apply'], FORBID_TAGS: ['style', 'form', 'input'] });
  }, [text, !!onApply]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // The click may land on the icon inside the button.
    const target = e.target as HTMLElement;
    const copyBtn = target.closest('[data-copy]');
    const applyBtn = target.closest('[data-apply]');
    const code = (copyBtn ?? applyBtn)?.closest('.code-block')?.querySelector('code')?.textContent ?? '';
    if (copyBtn) void request('chat/copy', { text: code });
    if (applyBtn && onApply) onApply(code);
    // http(s) links are intercepted by VS Code and opened externally.
  };

  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
