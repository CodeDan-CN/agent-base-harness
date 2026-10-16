import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { HttpProxy } from 'vite';

// Browser preview only proxies an explicitly selected remote Runtime; never starts one.
export default defineConfig({
  root: path.resolve(__dirname, 'apps/mobile'),
  plugins: [
    react(),
    {
      name: 'mobile-dev-csp',
      apply: 'serve',
      // React's development refresh preamble is inline. Production APK keeps its strict CSP.
      transformIndexHtml: (html) =>
        html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''),
    },
  ],
  base: './',
  resolve: {
    alias: {
      '@ui': path.resolve(__dirname, 'packages/app-ui/src'),
      '@client-contracts': path.resolve(__dirname, 'packages/protocol/src/client/index.ts'),
    },
  },
  build: { outDir: path.resolve(__dirname, 'dist/mobile'), emptyOutDir: true },
  server: {
    host: 'localhost',
    port: 5175,
    strictPort: true,
    proxy: Object.fromEntries(
      ['/v1', '/healthz'].map((route) => [
        route,
        {
          target: process.env.AGENT_HARNESS_SERVER_URL || 'http://127.0.0.1:4317',
          changeOrigin: true,
          configure: (proxy: HttpProxy.Server) => {
            proxy.on('proxyReq', (request) => request.removeHeader('origin'));
          },
        },
      ]),
    ),
  },
});
