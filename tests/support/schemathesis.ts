/**
 * Schemathesis runner — the provider side of the OpenAPI contract, exactly as
 * named in 02-architecture.v1.md §5 ("Provider test: Schemathesis").
 *
 * Setup (once): npm run setup:contract
 *   python3 -m venv .venv-contract && .venv-contract/bin/pip install schemathesis
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { OPENAPI_PATH, REPO_ROOT } from './openapi.js';

export const SCHEMATHESIS_BIN = path.join(REPO_ROOT, '.venv-contract', 'bin', 'schemathesis');

// Gives every fuzzed request its own simulated source IP (X-Forwarded-For),
// so the per-IP rate limiter sees the distinct-user traffic it is meant to
// see, rather than the single-process burst Schemathesis actually sends. See
// schemathesis_hooks.py for why this is a harness fix, not a test change.
const HOOKS_PATH = path.join(REPO_ROOT, 'tests', 'support', 'schemathesis_hooks.py');

export type SchemathesisResult = { exitCode: number; output: string };

export function runSchemathesis(opts: {
  baseUrl: string;
  operationId: string;
  headers?: Record<string, string>;
  maxExamples?: number;
}): SchemathesisResult {
  if (!existsSync(SCHEMATHESIS_BIN)) {
    throw new Error(
      `Schemathesis is not installed at ${SCHEMATHESIS_BIN}. Run: npm run setup:contract`,
    );
  }

  const args = [
    'run',
    OPENAPI_PATH,
    '--url',
    opts.baseUrl,
    '--include-operation-id',
    opts.operationId,
    '--max-examples',
    String(opts.maxExamples ?? 5),
    '--checks',
    'all',
  ];

  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    args.push('--header', `${name}:${value}`);
  }

  const res = spawnSync(SCHEMATHESIS_BIN, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1', SCHEMATHESIS_HOOKS: HOOKS_PATH },
  });

  return {
    exitCode: res.status ?? -1,
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}
