import { describe, expect, it } from 'vitest';
import { parseFenceInfo, parseHunks, parseProposals } from '../src/shared/proposalFormat';

const F = '```';

describe('parseFenceInfo', () => {
  it('reads kinds, paths and cwd', () => {
    expect(parseFenceInfo('edit path=src/a.ts')).toEqual({ kind: 'edit', path: 'src/a.ts' });
    expect(parseFenceInfo('file "src/my file.ts"')).toEqual({ kind: 'file', path: 'src/my file.ts' });
    expect(parseFenceInfo('edit path="src/my file.ts"')).toEqual({ kind: 'edit', path: 'src/my file.ts' });
    expect(parseFenceInfo('run cwd=packages/web')).toEqual({ kind: 'run', cwd: 'packages/web' });
    expect(parseFenceInfo('ts edit path=a.ts')).toEqual({ kind: 'edit', path: 'a.ts' });
  });

  it('ignores ordinary code blocks', () => {
    expect(parseFenceInfo('typescript')).toBeUndefined();
    expect(parseFenceInfo('')).toBeUndefined();
    expect(parseFenceInfo('bash')).toBeUndefined();
  });
});

describe('parseHunks', () => {
  it('splits SEARCH/REPLACE sections', () => {
    const body = ['<<<<<<< SEARCH', 'a', 'b', '=======', 'c', '>>>>>>> REPLACE', 'noise', '<<<<<<< SEARCH', 'x', '=======', '>>>>>>> REPLACE'].join('\n');
    expect(parseHunks(body)).toEqual({ hunks: [{ search: 'a\nb', replace: 'c' }, { search: 'x', replace: '' }] });
  });

  it('reports unfinished or missing sections', () => {
    expect(parseHunks('<<<<<<< SEARCH\na\n=======\nb').error).toMatch(/unfinished/);
    expect(parseHunks('just text').error).toMatch(/no SEARCH/);
  });
});

describe('parseProposals', () => {
  it('extracts edits, files, deletes and commands, skipping normal code blocks', () => {
    const text = [
      'Here is the fix:',
      `${F}ts`, 'const ignored = 1;', F,
      `${F}edit path=src/a.ts`, '<<<<<<< SEARCH', 'old', '=======', 'new', '>>>>>>> REPLACE', F,
      `${F}file path=src/b.ts`, 'export const b = 1;', F,
      `${F}delete path=src/c.ts`, F,
      `${F}run`, '$ npm test', F,
    ].join('\n');
    expect(parseProposals(text)).toEqual([
      { kind: 'file', op: 'edit', path: 'src/a.ts', hunks: [{ search: 'old', replace: 'new' }], error: undefined },
      { kind: 'file', op: 'write', path: 'src/b.ts', content: 'export const b = 1;\n' },
      { kind: 'file', op: 'delete', path: 'src/c.ts' },
      { kind: 'command', command: 'npm test', cwd: undefined },
    ]);
  });

  it('merges edit blocks for the same file', () => {
    const block = (s: string, r: string) => [`${F}edit path=a.ts`, '<<<<<<< SEARCH', s, '=======', r, '>>>>>>> REPLACE', F].join('\n');
    const result = parseProposals(`${block('1', 'one')}\ntext\n${block('2', 'two')}`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ hunks: [{ search: '1', replace: 'one' }, { search: '2', replace: 'two' }] });
  });

  it('keeps inner fences inside a longer outer fence', () => {
    const text = ['````file path=README.md', '# Title', F + 'sh', 'npm i', F, '````'].join('\n');
    expect(parseProposals(text)).toEqual([
      { kind: 'file', op: 'write', path: 'README.md', content: `# Title\n${F}sh\nnpm i\n${F}\n` },
    ]);
  });

  it('accepts SEARCH/REPLACE in an ordinary code block when the file is named above it', () => {
    const hunk = ['<<<<<<< SEARCH', '  return a - b;', '=======', '  return a + b;', '>>>>>>> REPLACE'];
    for (const above of ['math.js', '**math.js**', '`math.js`:', 'File: math.js']) {
      expect(parseProposals([above, `${F}javascript`, ...hunk, F].join('\n')), above).toEqual([
        { kind: 'file', op: 'edit', path: 'math.js', hunks: [{ search: '  return a - b;', replace: '  return a + b;' }], error: undefined },
      ]);
    }
    expect(parseProposals([`${F}math.js`, ...hunk, F].join('\n'))).toHaveLength(1);
  });

  it('does not guess a path from prose or for blocks without markers', () => {
    expect(parseProposals(['Change this in the file:', `${F}js`, '<<<<<<< SEARCH', 'a', '=======', 'b', '>>>>>>> REPLACE', F].join('\n'))).toEqual([]);
    expect(parseProposals(['math.js', `${F}js`, 'function add(a, b) { return a + b; }', F].join('\n'))).toEqual([]);
  });

  it('reads sections whose line breaks were written as literal \\n (Mistral)', () => {
    const oneLine = `${F}edit path=nav.jsx\n<<<<<<< SEARCH\\n      </nav>\\n    </div>\\n=======\\n      </nav>\\n    </>\\n>>>>>>> REPLACE\n${F}`;
    expect(parseProposals(oneLine)).toEqual([
      { kind: 'file', op: 'edit', path: 'nav.jsx', hunks: [{ search: '      </nav>\n    </div>', replace: '      </nav>\n    </>' }], error: undefined },
    ]);
    // Code that legitimately contains "\n" in a string literal is left as written.
    const literal = `${F}edit path=a.js\n<<<<<<< SEARCH\nlog("a\\nb")\n=======\nlog("a\\n\\nb")\n>>>>>>> REPLACE\n${F}`;
    expect(parseProposals(literal)[0]).toMatchObject({ hunks: [{ search: 'log("a\\nb")', replace: 'log("a\\n\\nb")' }] });
  });

  it('ignores an unterminated block (reply cut off mid-stream)', () => {
    expect(parseProposals(`${F}edit path=a.ts\n<<<<<<< SEARCH\nold`)).toEqual([]);
  });

  it('handles CRLF replies', () => {
    expect(parseProposals(`${F}run\r\nnpm run build\r\n${F}\r\n`)).toEqual([{ kind: 'command', command: 'npm run build', cwd: undefined }]);
  });
});
