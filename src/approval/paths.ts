import * as path from 'path';

/**
 * Resolves a model-supplied path against a workspace root and rejects anything that would land
 * outside it (absolute paths elsewhere, `..` escapes, drive switches). Returns the absolute path.
 */
export function resolveInside(root: string, candidate: string): string {
  const cleaned = candidate.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (!cleaned) throw new Error('Empty path');
  if (/[\0]/.test(cleaned)) throw new Error('Invalid path');
  const abs = path.resolve(root, cleaned);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`"${candidate}" is outside the workspace folder`);
  }
  const parts = rel.split(/[\\/]/);
  if (parts.includes('.git')) throw new Error('Changes inside .git are not allowed');
  return abs;
}
