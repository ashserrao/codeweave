/**
 * Parses the change format CodeWeave asks models to use (see CHANGE_FORMAT_INSTRUCTIONS).
 * Only fenced blocks carrying an explicit marker become proposals; ordinary code blocks stay
 * display-only. Parsing never touches the file system.
 */

export type ParsedProposal =
  | { kind: 'file'; path: string; lang: string; body: string; mode: 'search-replace' | 'full' }
  | { kind: 'delete'; path: string }
  | { kind: 'command'; command: string; shell: string; cwd?: string };

export const SEARCH_MARK = '<<<<<<< SEARCH';
export const DIVIDER_MARK = '=======';
export const REPLACE_MARK = '>>>>>>> REPLACE';

const SHELLS = new Set(['shell', 'sh', 'bash', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'console', 'terminal']);

export const CHANGE_FORMAT_INSTRUCTIONS = [
  'To propose changes, use these fenced block formats. The user reviews each change as a diff and accepts or rejects it, so never claim a change has been applied.',
  '1. Edit an existing file with one or more SEARCH/REPLACE sections. SEARCH must copy the current lines exactly (including indentation) and be just long enough to be unique:',
  '```ts path=src/example.ts',
  SEARCH_MARK,
  'const timeout = 1000;',
  DIVIDER_MARK,
  'const timeout = 5000;',
  REPLACE_MARK,
  '```',
  '2. Create a new file (or fully replace a small file): a block with path= containing the complete file content and no SEARCH sections.',
  '3. Delete a file: an empty block written as ```delete path=old/file.ts followed by the closing fence.',
  '4. Suggest a terminal command: ```shell run (add cwd=sub/dir if needed) with exactly one command; it runs only if the user clicks Run.',
  'Paths are relative to the workspace root and use forward slashes. Code blocks without path= or run are treated as illustrations only.',
].join('\n');

/** Parses `key=value` / `key="value with spaces"` attributes and bare flags from a fence info string. */
export function parseInfo(info: string): { lang: string; attrs: Record<string, string>; flags: Set<string> } {
  const tokens = info.trim().match(/[^\s"=]+="[^"]*"|[^\s"=]+='[^']*'|[^\s"=]+=\S+|\S+/g) ?? [];
  const attrs: Record<string, string> = {};
  const flags = new Set<string>();
  let lang = '';
  tokens.forEach((t, i) => {
    const eq = t.indexOf('=');
    if (eq > 0) {
      attrs[t.slice(0, eq).toLowerCase()] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
    } else if (i === 0) {
      lang = t.toLowerCase();
    } else {
      flags.add(t.toLowerCase());
    }
  });
  return { lang, attrs, flags };
}

interface Fence {
  info: string;
  body: string;
}

/** Extracts top-level fenced blocks (``` or ~~~, length >= 3). Unclosed fences are ignored. */
export function extractFences(markdown: string): Fence[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const fences: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    const body: string[] = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]);
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
        fences.push({ info: open[2], body: body.join('\n') });
        i = j;
        closed = true;
        break;
      }
      body.push(lines[j]);
    }
    if (!closed) break; // still streaming or malformed: ignore the rest
  }
  return fences;
}

export function parseProposals(markdown: string): ParsedProposal[] {
  const out: ParsedProposal[] = [];
  for (const fence of extractFences(markdown)) {
    const { lang, attrs, flags } = parseInfo(fence.info);
    const path = (attrs.path ?? attrs.file ?? attrs.filepath)?.trim();
    if (lang === 'delete' && path) {
      out.push({ kind: 'delete', path });
    } else if (path) {
      const mode = fence.body.includes(SEARCH_MARK) ? 'search-replace' : 'full';
      out.push({ kind: 'file', path, lang, body: fence.body, mode });
    } else if (SHELLS.has(lang) && flags.has('run')) {
      const command = fence.body.replace(/^\s*[$>]\s+/gm, '').trim(); // drop prompt characters
      if (command) out.push({ kind: 'command', command, shell: lang, cwd: attrs.cwd });
    }
  }
  return out;
}
