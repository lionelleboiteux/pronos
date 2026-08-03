import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // DB tests boot a real Postgres 16 container; contract tests boot Prism and
    // shell out to Schemathesis. Neither is fast, neither is mocked.
    testTimeout: 120_000,
    hookTimeout: 240_000,
    // Fork pool: Testcontainers + child processes behave predictably here.
    pool: 'forks',
    reporters: ['verbose'],
    globalSetup: [],
  },
});
