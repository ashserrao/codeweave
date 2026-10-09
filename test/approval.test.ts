import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { extractFences, parseInfo, parseProposals } from '../src/approval/changeFormat';
import { applySearchReplace, diffStats, parseSearchReplace } from '../src/approval/searchReplace';
import { resolveInside } from '../src/approval/paths';

const fence = '```';

describe('change format parsing', () => {
  it('reads language, attributes and flags from the info string', () => {
    expect(parseInfo('ts path="src/my file.ts" extra')).toEqual({ lang: 'ts', attrs: { path: 'src/my file.ts' }, flags: new Set(['extra']) });
    expect(parseInfo('shell run cwd=web')).toEqual({ lang: 'shell', attrs: { cwd: 'web' }, flags: new Set(['run']) });
  });

  it('extracts fences of any length and ignores an unclosed trailing fence', () => {
    const md = `text\n${fence}ts\na\n${fence}\n\n\`\`\`\`md\n${fence}inner${fence}\n\`\`\`\`\n${fence}js\nstill streaming`;
    expect(extractFences(md).map((f) => f.info)).toEqual(['ts', 'md']);
  });

  it('turns only marked blocks into proposals', () => {
    const md = [
      'Here is an illustration:',
      `${fence}ts`, 'const x = 1;', fence,
      `${fence}ts path=src/a.ts`, '<<<<<<< SEARCH', 'old', '=======', 'new', '>>>>>>> REPLACE', fence,
      `${fence}md path=docs/new.md`, '# Title', fence,
      `${fence}delete path=old.txt`, fence,
      `${fence}bash run cwd=web`, '$ npm test', fence,
      `${fence}bash`, 'echo not runnable', fence,
    ].join('\n');
    expect(parseProposals(md)).toEqual([
      { kind: 'file', path: 'src/a.ts', lang: 'ts', body: '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE', mode: 'search-replace' },
      { kind: 'file', path: 'docs/new.md', lang: 'md', body: '# Title', mode: 'full' },
      { kind: 'delete', path: 'old.txt' },
      { kind: 'command', command: 'npm test', shell: 'bash', cwd: 'web' },
    ]);
  });
});

describe('SEARCH/REPLACE', () => {
  const file = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';

  it('applies multiple sections in order', () => {
    const blocks = parseSearchReplace('<<<<<<< SEARCH\n  return 1;\n=======\n  return 10;\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n  return 2;\n=======\n  return 20;\n>>>>>>> REPLACE');
    const r = applySearchReplace(file, blocks);
    expect(r).toEqual({ ok: true, content: file.replace('return 1', 'return 10').replace('return 2', 'return 20') });
  });

  it('tolerates indentation / trailing-space differences in SEARCH', () => {
    const r = applySearchReplace(file, parseSearchReplace('<<<<<<< SEARCH\nfunction b() {\n    return 2;   \n}\n=======\nconst b = () => 2;\n>>>>>>> REPLACE'));
    expect(r.ok && r.content).toBe('function a() {\n  return 1;\n}\n\nconst b = () => 2;\n');
  });

  it('keeps Windows line endings', () => {
    const crlf = file.replace(/\n/g, '\r\n');
    const r = applySearchReplace(crlf, parseSearchReplace('<<<<<<< SEARCH\n  return 1;\n=======\n  return 1; // one\n>>>>>>> REPLACE'));
    expect(r.ok && r.content).toBe(crlf.replace('return 1;', 'return 1; // one'));
  });

  it('reports which section did not match', () => {
    const r = applySearchReplace(file, parseSearchReplace('<<<<<<< SEARCH\nnot in file\n=======\nx\n>>>>>>> REPLACE'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Section 1: the SEARCH text was not found.*not in file/);
  });

  it('appends on empty SEARCH and rejects malformed sections', () => {
    expect(applySearchReplace('a\n', parseSearchReplace('<<<<<<< SEARCH\n=======\nb\n>>>>>>> REPLACE'))).toEqual({ ok: true, content: 'a\nb' });
    expect(() => parseSearchReplace('<<<<<<< SEARCH\nx\n=======\ny')).toThrow(/REPLACE end marker/);
    expect(() => parseSearchReplace('no markers')).toThrow(/No complete/);
  });

  it('counts added and removed lines', () => {
    expect(diffStats('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual({ added: 2, removed: 1 });
    expect(diffStats('', 'x\ny\n')).toEqual({ added: 2, removed: 0 });
  });
});

describe('workspace path safety', () => {
  const root = path.resolve('/work/project');

  it('resolves normal relative paths', () => {
    expect(resolveInside(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveInside(root, './src\\b.ts')).toBe(path.join(root, 'src', 'b.ts'));
  });

  it('rejects escapes, absolute paths elsewhere, the root itself and .git', () => {
    expect(() => resolveInside(root, '../secrets.txt')).toThrow(/outside the workspace/);
    expect(() => resolveInside(root, 'src/../../x')).toThrow(/outside the workspace/);
    expect(() => resolveInside(root, path.resolve('/etc/passwd'))).toThrow(/outside the workspace/);
    expect(() => resolveInside(root, '.')).toThrow(/outside the workspace/);
    expect(() => resolveInside(root, '.git/config')).toThrow(/\.git/);
    expect(() => resolveInside(root, '')).toThrow(/Empty path/);
  });
});
