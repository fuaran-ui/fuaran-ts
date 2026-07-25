// @fuaran-ui/mock — the HTTP server wrapper.
//
// A stdlib-only (`node:http`) server that speaks the generation endpoint's
// contract. POST any path with a TurnRequest body and it replies with a
// TurnResult; a GET /health is a readiness probe. No dependency, no secret, no
// logging in the hot path — safe for CI and agent sandboxes.

import { createServer, type Server } from 'node:http';

import { handleTurnBody } from './handler.js';

/** Options for {@link createMockServer}. */
export interface MockServerOptions {
  /** Port to listen on. Defaults to 8123 (override with the CLI `--port` flag
   *  or the `FUARAN_MOCK_PORT` env var). */
  readonly port?: number;
  /** Host/interface to bind. Defaults to `127.0.0.1` (loopback only). */
  readonly host?: string;
}

export const DEFAULT_MOCK_PORT = 8123;

/** Read the whole request body as a string (bounded by Node's socket, adequate
 *  for the small TurnRequest bodies the mock serves). */
function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Build (but do not start) the mock HTTP server. Call `.listen(port, host)` —
 *  or use {@link startMockServer} which resolves once it is listening. */
export function createMockServer(): Server {
  return createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mock: '@fuaran-ui/mock' }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Reason: 'method not allowed; POST a TurnRequest' }));
        return;
      }

      const bodyText = await readBody(req);
      const reply = handleTurnBody(bodyText);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    })();
  });
}

/** Start the mock server and resolve with the running server + resolved port. */
export function startMockServer(
  options?: MockServerOptions,
): Promise<{ server: Server; port: number }> {
  const port = options?.port ?? DEFAULT_MOCK_PORT;
  const host = options?.host ?? '127.0.0.1';
  const server = createMockServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve({ server, port: boundPort });
    });
  });
}
