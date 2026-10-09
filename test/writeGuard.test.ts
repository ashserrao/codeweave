import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Architecture guard: only src/approval/Applier.ts may change the user's workspace or run
 * commands. Two storage modules may write, but only inside the extension's private storage folder.
 */
const WRITE_APIS: [RegExp, string][] = [
  [/\bapplyEdit\s*\(/, 'workspace.applyEdit'],
  [/\bWorkspaceEdit\b/, 'WorkspaceEdit'],
  [/\.sendText\s*\(/, 'Terminal.sendText'],
  // Terminal execution (shellIntegration.executeCommand). vscode.commands.executeCommand only runs UI commands.
  [/(?<!commands)\.executeCommand\s*\(/, 'shellIntegration.executeCommand'],
  [/\bcreateTerminal\s*\(/, 'window.createTerminal'],
  [/\bchild_process\b/, 'child_process'],
  [/\bfs\.(writeFile|delete|rename|copy|createDirectory)\s*\(/, 'workspace.fs write'],
  [/\.save\s*\(\s*\)/, 'TextDocument.save'],
  [/from\s+['"]fs['"]|require\(\s*['"]fs['"]\s*\)/, 'Node fs'],
];

const ALLOWED: Record<string, string[] | 'all'> = {
  'approval/Applier.ts': 'all',
  // Extension-private storage (context.storageUri), never the workspace:
  'core/ConversationStore.ts': ['workspace.fs write'],
  'approval/ProposalStore.ts': ['workspace.fs write'],
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('write guard', () => {
  const srcRoot = path.join(__dirname, '..', 'src');

  it('only the Applier writes to the workspace or runs commands', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      const rel = path.relative(srcRoot, file).replace(/\\/g, '/');
      const allowed = ALLOWED[rel];
      if (allowed === 'all') continue;
      const code = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''); // ignore comments
      for (const [pattern, name] of WRITE_APIS) {
        if (pattern.test(code) && !allowed?.includes(name)) violations.push(`${rel} uses ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the guard actually detects write APIs', () => {
    const applier = fs.readFileSync(path.join(srcRoot, 'approval', 'Applier.ts'), 'utf8');
    for (const name of ['workspace.applyEdit', 'Terminal.sendText', 'shellIntegration.executeCommand']) {
      const pattern = WRITE_APIS.find(([, n]) => n === name)![0];
      expect(pattern.test(applier), name).toBe(true);
    }
  });
});
