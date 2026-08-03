import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { loadApiServer } from '../support/seams.js';
import { contractOperations } from '../support/openapi.js';
import { runSchemathesis } from '../support/schemathesis.js';
import { startTestDatabase, type TestDatabase } from '../support/pg.js';

/**
 * PROVIDER side of the OpenAPI contract. Schemathesis fuzzes the real running
 * API against contracts/openapi.yaml, one operation per test, so a failure
 * names the operation that broke its own contract.
 *
 * At the red gate the provider does not exist. Schemathesis is still invoked
 * for real (not stubbed) so the whole tool chain — venv, CLI, schema parsing,
 * operation filtering — is proven by the same run that proves the provider is
 * missing. The single reason every test below fails is: there is no provider.
 */

const ADMIN_TOKEN = 'red-gate-admin-token';

let db: TestDatabase | null = null;
let server: { url: string; stop(): Promise<void> } | null = null;
let providerStartFailure = 'provider was started successfully';
let baseUrl = '';

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

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  try {
    // Load the provider entry point before paying for a database container,
    // so the reported reason is the most direct one available.
    const { startServer } = await loadApiServer();
    db = await startTestDatabase();
    server = await startServer({ port, databaseUrl: db.connectionUri, adminToken: ADMIN_TOKEN });
    baseUrl = server.url;
  } catch (err) {
    providerStartFailure = (err as Error).message;
    await db?.stop().catch(() => undefined);
    db = null;
  }
}, 240_000);

afterAll(async () => {
  await server?.stop().catch(() => undefined);
  await db?.stop().catch(() => undefined);
});

describe('OpenAPI provider contract (Schemathesis)', () => {
  it.each(
    contractOperations().map(
      (o) =>
        [
          `CONTRACT-PROVIDER-${o.operationId}: the running API satisfies the contract for ${o.method} ${o.path}`,
          o,
        ] as const,
    ),
  )('%s', (_title, { operationId }) => {
      const result = runSchemathesis({
        baseUrl,
        operationId,
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });

      expect(
        result.exitCode,
        `provider status: ${providerStartFailure}\n\nschemathesis output:\n${result.output}`,
      ).toBe(0);
    },
  );
});
