import * as nodePath from 'path';

export interface FolderRef {
  name: string;
  fsPath: string;
}

export interface ResolvedPath {
  fsPath: string;
  folder: FolderRef;
  /** Path relative to its workspace folder, with forward slashes. Empty for the folder itself. */
  relative: string;
}

type PathImpl = Pick<typeof nodePath, 'isAbsolute' | 'resolve' | 'relative' | 'sep'>;

/**
 * Resolves a path written by the model to a location inside an open workspace folder.
 * Relative paths are taken from the first folder, or from the folder whose name is the first
 * segment in a multi-root workspace. Anything outside the workspace, or inside `.git`, is refused.
 */
export function resolveWorkspacePath(
  input: string,
  folders: FolderRef[],
  opts: { allowRoot?: boolean; path?: PathImpl } = {},
): ResolvedPath {
  const path = opts.path ?? nodePath;
  if (folders.length === 0) throw new Error('Open a folder or workspace first.');
  const raw = input.trim().replace(/^["'`]|["'`]$/g, '');
  if (!raw) throw new Error('No path given.');

  let abs: string;
  if (path.isAbsolute(raw)) {
    abs = path.resolve(raw);
  } else {
    const rel = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    const first = rel.split('/')[0];
    const named = folders.length > 1 ? folders.find((f) => f.name === first) : undefined;
    abs = named ? path.resolve(named.fsPath, rel.slice(first.length + 1) || '.') : path.resolve(folders[0].fsPath, rel);
  }

  for (const folder of folders) {
    const rel = path.relative(folder.fsPath, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!rel && !opts.allowRoot) throw new Error(`"${input}" is a workspace folder, not a file.`);
    const relative = rel.split(path.sep).join('/');
    if (relative.split('/').some((seg) => seg.toLowerCase() === '.git')) {
      throw new Error(`"${input}" is inside .git; CodeWeave does not change repository internals.`);
    }
    return { fsPath: abs, folder, relative };
  }
  throw new Error(`"${input}" is outside the open workspace folder(s).`);
}
