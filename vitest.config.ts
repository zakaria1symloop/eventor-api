import { defineConfig } from 'vitest/config';

/** Unit tests: `src/**\/*.spec.ts`, no database. */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/unit/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', '_archive'],
  },
});
