import { diffLines } from 'diff';
import { DIVIDER_MARK, REPLACE_MARK, SEARCH_MARK } from './changeFormat';

export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

/** Splits a block body into SEARCH/REPLACE pairs. Throws on malformed markers. */
export function parseSearchReplace(body: string): SearchReplaceBlock[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const blocks: SearchReplaceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== SEARCH_MARK) {
      i++;
      continue;
    }
    const search: string[] = [];
    const replace: string[] = [];
    i++;
    while (i < lines.length && lines[i].trim() !== DIVIDER_MARK) search.push(lines[i++]);
    if (i >= lines.length) throw new Error('A SEARCH section has no ======= divider');
    i++;
    while (i < lines.length && lines[i].trim() !== REPLACE_MARK) replace.push(lines[i++]);
    if (i >= lines.length) throw new Error('A SEARCH section has no >>>>>>> REPLACE end marker');
    i++;
    blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
  }
  if (!blocks.length) throw new Error('No complete SEARCH/REPLACE sections found');
  return blocks;
}

/**
 * Finds `search` in `content` (both \n-normalised). Exact match first; if that fails, a match that
 * ignores trailing whitespace and indentation differences, returned as an exact range of original lines.
 */
function locate(content: string, search: string): { start: number; end: number } | undefined {
  const exact = content.indexOf(search);
  if (exact !== -1) return { start: exact, end: exact + search.length };

  const lines = content.split('\n');
  const want = search.split('\n').map((l) => l.trim());
  while (want.length && want[want.length - 1] === '') want.pop();
  if (!want.length) return undefined;
  const offsets: number[] = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[i + k].trim() !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const last = i + want.length - 1;
      return { start: offsets[i], end: offsets[last] + lines[last].length };
    }
  }
  return undefined;
}

/** Applies blocks in order. Returns the new content or the first block that could not be matched. */
export function applySearchReplace(
  original: string,
  blocks: SearchReplaceBlock[],
): { ok: true; content: string } | { ok: false; error: string } {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let content = original.replace(/\r\n/g, '\n');
  for (const [n, b] of blocks.entries()) {
    if (b.search.trim() === '') {
      // Empty SEARCH means "append" (or the whole content of a new file).
      content = content ? `${content.replace(/\n?$/, '\n')}${b.replace}` : b.replace;
      continue;
    }
    const at = locate(content, b.search);
    if (!at) {
      const preview = b.search.split('\n').find((l) => l.trim()) ?? '';
      return { ok: false, error: `Section ${n + 1}: the SEARCH text was not found in the file (starts with "${preview.trim().slice(0, 60)}")` };
    }
    content = content.slice(0, at.start) + b.replace + content.slice(at.end);
  }
  return { ok: true, content: eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content };
}

/** Lines added/removed between two texts. */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before.replace(/\r\n/g, '\n'), after.replace(/\r\n/g, '\n'))) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}
