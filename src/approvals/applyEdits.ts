import type { EditHunk } from '../shared/types';
import { unescapeNewlines } from '../shared/proposalFormat';

export type ApplyResult = { ok: true; text: string; notes?: string[] } | { ok: false; error: string };

const splitLines = (s: string) => (s === '' ? [] : s.split('\n'));
const indentOf = (s: string) => /^\s*/.exec(s)![0];

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

function findWindow(file: string[], search: string[], eq: (a: string, b: string) => boolean): number {
  if (search.length === 0 || search.length > file.length) return -1;
  outer: for (let s = 0; s + search.length <= file.length; s++) {
    for (let j = 0; j < search.length; j++) if (!eq(file[s + j], search[j])) continue outer;
    return s;
  }
  return -1;
}

/** Shifts replacement lines by the indentation difference between the file and the SEARCH text. */
function reindent(replace: string[], searchFirst: string, fileFirst: string): string[] {
  const from = indentOf(searchFirst);
  const to = indentOf(fileFirst);
  if (from === to) return replace;
  return replace.map((l) => {
    if (!l.trim()) return l;
    if (to.startsWith(from)) return to.slice(from.length) + l;
    if (from.startsWith(to) && l.startsWith(from.slice(to.length))) return l.slice(from.length - to.length);
    return l;
  });
}

/**
 * Replaces the first match of `search` in `text`. It tries progressively looser matching:
 * whole lines exactly, then ignoring trailing whitespace, then ignoring indentation (the
 * replacement is re-indented to match), and finally a plain substring (unless `linesOnly`).
 */
function replaceOnce(text: string, search: string, replace: string, linesOnly = false): string | undefined {
  const file = text.split('\n');
  const rep = splitLines(replace);
  const join = (s: number, len: number, lines: string[]) =>
    [...file.slice(0, s), ...lines, ...file.slice(s + len)].join('\n');

  const exact = splitLines(search);
  let s = findWindow(file, exact, (a, b) => a === b);
  if (s !== -1) return join(s, exact.length, rep);

  const core = trimBlankEdges(exact);
  s = findWindow(file, core, (a, b) => a.trimEnd() === b.trimEnd());
  if (s !== -1) return join(s, core.length, trimBlankEdges(rep));

  s = findWindow(file, core, (a, b) => a.trim() === b.trim());
  if (s !== -1) return join(s, core.length, reindent(trimBlankEdges(rep), core[0], file[s]));

  if (linesOnly) return undefined;
  const i = text.indexOf(search);
  if (i !== -1) return text.slice(0, i) + replace + text.slice(i + search.length);
  return undefined;
}

/** Applies SEARCH/REPLACE hunks in order. Line endings of the original are preserved. */
export function applyHunks(original: string, hunks: EditHunk[]): ApplyResult {
  const crlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  const notes: string[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const search = hunks[i].search.replace(/\r\n/g, '\n');
    const replace = hunks[i].replace.replace(/\r\n/g, '\n');
    const label = hunks.length > 1 ? `SEARCH section ${i + 1} of ${hunks.length}` : 'The SEARCH section';
    if (!search.trim()) {
      if (text.trim()) return { ok: false, error: `${label} is empty, but the file is not.` };
      text = replace && !replace.endsWith('\n') ? `${replace}\n` : replace;
      continue;
    }
    // Models often repeat an identical section once per occurrence ("every <li>"), sometimes
    // once too often. A repeat only matches whole lines (a substring match could land inside
    // text an earlier section produced); when nothing is left to match, it is redundant.
    const repeat = hunks.slice(0, i).some((h) => h.search === hunks[i].search && h.replace === hunks[i].replace);
    let next = replaceOnce(text, search, replace, repeat);
    // The model may have written line breaks as literal "\n" escapes.
    if (next === undefined && /\\n/.test(search)) {
      next = replaceOnce(text, unescapeNewlines(search), unescapeNewlines(replace), repeat);
    }
    if (next === undefined && repeat) {
      notes.push(`${label} repeats an earlier section and had nothing left to match, so it was skipped.`);
      continue;
    }
    if (next === undefined) {
      const first = search.split('\n').find((l) => l.trim())?.trim() ?? '';
      return {
        ok: false,
        error: `${label} does not match the current file (starts with "${first.slice(0, 60)}"). The file may have changed since the model saw it.`,
      };
    }
    text = next;
  }
  const out = crlf ? text.replace(/\n/g, '\r\n') : text;
  return notes.length ? { ok: true, text: out, notes } : { ok: true, text: out };
}

const LCS_MAX_CELLS = 4_000_000;

/** Length of the longest common subsequence of two line arrays (two-row dynamic programming). */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * Added/removed line counts, as a line diff would show them. The unchanged prefix and suffix are
 * trimmed first; the middle is compared exactly unless it is very large (then it is an upper bound).
 */
export function lineStats(before: string, after: string): { added: number; removed: number } {
  const a = splitLines(before.replace(/\r\n/g, '\n').replace(/\n$/, ''));
  const b = splitLines(after.replace(/\r\n/g, '\n').replace(/\n$/, ''));
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const midA = a.slice(p, a.length - q);
  const midB = b.slice(p, b.length - q);
  const common = midA.length * midB.length <= LCS_MAX_CELLS ? lcsLength(midA, midB) : 0;
  return { added: midB.length - common, removed: midA.length - common };
}
