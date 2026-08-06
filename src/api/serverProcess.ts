/**
 * Entry point of the API process. Started by `startServer` in server.ts, and
 * by any deployment that runs the router as a standalone Node service.
 *
 * Arguments: <port> <databaseUrl> <adminToken>. It prints one `READY <url>`
 * line on stdout once it is listening, which is the only thing its parent
 * waits for.
 */

import { createApiServer } from './server.ts';

const [port, databaseUrl, adminToken] = process.argv.slice(2);

const server = await createApiServer({
  port: Number(port),
  databaseUrl: databaseUrl as string,
  adminToken: adminToken as string,
});

process.stdout.write(`READY ${server.url}\n`);
