/**
 * Prism mock server lifecycle — the consumer side of the OpenAPI contract,
 * exactly as named in 02-architecture.v1.md §5 ("Consumer test: Prism mock").
 *
 * Prism is generated from contracts/openapi.yaml at run time. Nothing about
 * the mock's responses is hand-written here, so a consumer test can only pass
 * against responses the contract actually permits.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { OPENAPI_PATH, REPO_ROOT } from './openapi.js';

export type PrismMock = { baseUrl: string; stop(): Promise<void> };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number, child: ChildProcess, log: () => string) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Prism exited with code ${child.exitCode}. Output:\n${log()}`);
    }
    try {
      const res = await fetch(url);
      if (res.status > 0) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`Prism did not become ready within ${timeoutMs}ms. Output:\n${log()}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function startPrismMock(): Promise<PrismMock> {
  const port = await freePort();
  let output = '';

  const child = spawn(
    process.execPath,
    [
      // resolve the locally installed Prism CLI without going through npx
      require_resolve_prism(),
      'mock',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      OPENAPI_PATH,
    ],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout?.on('data', (d) => (output += d.toString()));
  child.stderr?.on('data', (d) => (output += d.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttp(`${baseUrl}/v1/leagues`, 60_000, child, () => output);

  return {
    baseUrl,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 200));
    },
  };
}

function require_resolve_prism(): string {
  // node_modules/.bin/prism is a shell shim; the CLI entry point is the real JS.
  return new URL('../../node_modules/@stoplight/prism-cli/dist/index.js', import.meta.url).pathname;
}
