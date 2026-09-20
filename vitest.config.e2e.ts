import { defineConfig } from 'vitest/config';

/**
 * e2e tests against MySQL (DB_DATABASE_TEST). globalSetup rebuilds the test
 * database with migrations once per run; suites run one at a time because they
 * share it.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    exclude: ['node_modules', 'dist', '_archive'],
    globalSetup: ['./test/utils/global-setup.ts'],
    setupFiles: ['./test/utils/test-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
