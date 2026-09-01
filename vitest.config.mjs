import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    exclude: ['tests/e2e/**', 'tests/live/**', '**/node_modules/**', '**/dist/**'],
  },
});
