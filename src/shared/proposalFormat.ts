// Parses the change-proposal blocks the model writes in its replies. Free of `vscode` and Node
// imports: the webview uses `parseFenceInfo` to label these blocks while they stream.
//
//   ```edit path=src/a.ts        SEARCH/REPLACE hunks against an existing file
//   ```file path=src/b.ts        full content (create or overwrite)
//   ```delete path=src/c.ts      remove a file (empty body)
//   ```run cwd=packages/web      one terminal command

import type { EditHunk } from './types';

export type ProposalBlockKind = 'edit' | 'file' | 'delete' | 'run';
const KINDS = new Set<ProposalBlockKind>(['edit', 'file', 'delete', 'run']);

export interface FenceInfo {
  kind: ProposalBlockKind;
  path?: string;
  cwd?: string;
}

export type ParsedProposal =
  | { kind: 'file'; op: 'edit' | 'write' | 'delete'; path: string; hunks?: EditHunk[]; content?: string; error?: string }
  | { kind: 'command'; command: string; cwd?: string };

function tokenize(info: string): string[] {
  const tokens: string[] = [];
  const re = /(\w+=)?(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(info))) tokens.push((m[1] ?? '') + (m[2] ?? m[3] ?? m[4] ?? ''));
  return tokens;
}

/** Reads a fence info string such as `edit path="src/my file.ts"`. Returns undefined for ordinary code blocks. */
export function parseFenceInfo(info: string): FenceInfo | undefined {
  const tokens = tokenize(info.trim());
  // Tolerate a language tag before the kind, e.g. "ts edit path=…".
  const at = tokens.slice(0, 2).findIndex((t) => KINDS.has(t.toLowerCase() as ProposalBlockKind));
  if (at === -1) return undefined;
  const result: FenceInfo = { kind: tokens[at].toLowerCase() as ProposalBlockKind };
  for (const t of tokens.slice(at + 1)) {
    const eq = t.indexOf('=');
    const name = eq > 0 ? t.slice(0, eq).toLowerCase() : '';
    const value = eq > 0 ? t.slice(eq + 1) : t;
    if (name === 'path' || name === 'file') result.path = value;
    else if (name === 'cwd') result.cwd = value;
    else if (!name && !result.path && result.kind !== 'run') result.path = value;
  }
  return result;
}

const SEARCH = /^\s*<{5,9}\s*SEARCH\s*$/;
const DIVIDER = /^\s*={5,9}\s*$/;
const REPLACE = /^\s*>{5,9}\s*REPLACE\s*$/;

/**
 * Turns literal "\n" / "\t" escapes into real characters. Some models write edit blocks as if
 * JSON-escaped; this is only used as a fallback when the text does not work as written.
 */
export function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t');
}

/** Splits an edit block body into SEARCH/REPLACE hunks. */
export function parseHunks(body: string): { hunks: EditHunk[]; error?: string } {
  const result = parseHunksAsWritten(body);
  if (result.error && /\\n/.test(body)) {
    const unescaped = parseHunksAsWritten(unescapeNewlines(body));
    if (!unescaped.error) return unescaped;
  }
  return result;
}

function parseHunksAsWritten(body: string): { hunks: EditHunk[]; error?: string } {
  const hunks: EditHunk[] = [];
  let state: 'outside' | 'search' | 'replace' = 'outside';
  let search: string[] = [];
  let replace: string[] = [];
  for (const line of body.split('\n')) {
    if (state === 'outside') {
      if (SEARCH.test(line)) {
        state = 'search';
        search = [];
        replace = [];
      }
    } else if (state === 'search') {
      if (DIVIDER.test(line)) state = 'replace';
      else search.push(line);
    } else if (REPLACE.test(line)) {
      hunks.push({ search: search.join('\n'), replace: replace.join('\n') });
      state = 'outside';
    } else {
      replace.push(line);
    }
  }
  if (state !== 'outside') return { hunks, error: 'An edit block has an unfinished SEARCH/REPLACE section.' };
  if (hunks.length === 0) return { hunks, error: 'The edit block has no SEARCH/REPLACE sections.' };
  return { hunks };
}

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// A line naming a file just above a block, e.g. "math.js", "**src/a.ts**:", "File: `src/a.ts`".
const PATH_LINE = /^[\s#>*-]*(?:(?:file(?:name)?|path)\s*:\s*)?[`*"']*([\w.@()[\]/\\-]+\.[\w-]+)[`*"']*\s*:?\s*$/i;

/** The file named on the nearest non-empty line above a fence, if that line is only a path. */
function pathAbove(lines: string[], fenceLine: number): string | undefined {
  for (let j = fenceLine - 1; j >= 0 && j >= fenceLine - 2; j--) {
    if (!lines[j].trim()) continue;
    return PATH_LINE.exec(lines[j])?.[1];
  }
  return undefined;
}

/**
 * Extracts proposals from a reply. Only complete (closed) fences count, so a reply cut off
 * mid-block proposes nothing for that block. Edit blocks for the same path are merged.
 */
export function parseProposals(text: string): ParsedProposal[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ParsedProposal[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i]);
    if (!open) continue;
    const fence = open[1];
    // Backtick fences cannot carry backticks in their info string (CommonMark).
    if (fence[0] === '`' && open[2].includes('`')) continue;
    const close = new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    if (end >= lines.length) break; // unterminated: ignore the rest
    let info = parseFenceInfo(open[2]);
    const body = lines.slice(i + 1, end).join('\n');
    // Tolerate the other common SEARCH/REPLACE style: an ordinary code block whose body has the
    // markers, with the file named on the line above (or as the only word of the info string).
    if (!info && body.split('\n').some((l) => SEARCH.test(l))) {
      const fromInfo = open[2].trim();
      const path = /^[\w.@()[\]/\\-]+\.[\w-]+$/.test(fromInfo) ? fromInfo : pathAbove(lines, i);
      if (path) info = { kind: 'edit', path };
    }
    i = end;
    if (!info) continue;

    if (info.kind === 'run') {
      const command = body
        .split('\n')
        .map((l) => l.replace(/^\s*(\$|PS [^>]*>|>)\s+/, ''))
        .join('\n')
        .trim();
      if (command) out.push({ kind: 'command', command, cwd: info.cwd });
      continue;
    }
    if (!info.path) continue;
    const path = info.path;
    if (info.kind === 'delete') {
      out.push({ kind: 'file', op: 'delete', path });
    } else if (info.kind === 'file') {
      out.push({ kind: 'file', op: 'write', path, content: body ? `${body}\n` : '' });
    } else {
      const { hunks, error } = parseHunks(body);
      const prev = out.find((p): p is Extract<ParsedProposal, { kind: 'file' }> =>
        p.kind === 'file' && p.op === 'edit' && p.path === path);
      if (prev) {
        prev.hunks = [...(prev.hunks ?? []), ...hunks];
        prev.error = prev.error ?? error;
      } else {
        out.push({ kind: 'file', op: 'edit', path, hunks, error });
      }
    }
  }
  return out;
}
