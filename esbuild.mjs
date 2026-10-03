import * as esbuild from 'esbuild';
import { rmSync } from 'fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Production builds ship without source maps; remove any left over from dev builds.
if (production) rmSync('dist/extension.js.map', { force: true });

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
