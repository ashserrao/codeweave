import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// The extension renders its own HTML shell (src/webview/html.ts), so we only need
// deterministic JS/CSS asset names: dist/webview/assets/index.js and index.css.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, '../dist/webview'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: resolve(__dirname, 'src/main.tsx'),
      output: {
        format: 'es',
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (info) => (info.name?.endsWith('.css') ? 'assets/index.css' : 'assets/[name][extname]'),
      },
    },
  },
});
