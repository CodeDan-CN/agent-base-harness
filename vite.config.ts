import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Renderer-only Vite config. Main / Preload / Worker are built by scripts/build.mjs
// so that Node-only dependencies never leak into the Renderer bundle.
export default defineConfig({
  root: path.resolve(__dirname, 'ui'),
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@ui': path.resolve(__dirname, 'ui/src'),
      '@client-contracts': path.resolve(__dirname, 'src/client-contracts/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
