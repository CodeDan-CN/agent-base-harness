import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: path.resolve(__dirname, 'apps/web'),
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@ui': path.resolve(__dirname, 'packages/app-ui/src'),
      '@client-contracts': path.resolve(__dirname, 'packages/protocol/src/client/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/healthz': {
        target: process.env.AGENT_HARNESS_SERVER_URL || 'http://127.0.0.1:4317',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => request.removeHeader('origin'));
        },
      },
      '/v1': {
        target: process.env.AGENT_HARNESS_SERVER_URL || 'http://127.0.0.1:4317',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => request.removeHeader('origin'));
        },
      },
    },
  },
});
