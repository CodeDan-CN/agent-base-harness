import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      '@client-contracts': `${import.meta.dirname}/src/client-contracts/index.ts`,
    },
  },
  test: {
    exclude: ['tests/e2e/**', 'tests/live/**', '**/node_modules/**', '**/dist/**'],
  },
});
