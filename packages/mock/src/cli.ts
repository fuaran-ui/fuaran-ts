// fuaran-mock — the one-command offline endpoint (`npx @fuaran-ui/mock`).
//
// Human-facing output goes to stderr; the server logs nothing per request.

import { startMockServer, DEFAULT_MOCK_PORT } from './server.js';

function parsePort(argv: readonly string[]): number {
  const flagIdx = argv.indexOf('--port');
  if (flagIdx !== -1 && argv[flagIdx + 1] !== undefined) {
    const n = Number(argv[flagIdx + 1]);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  const env = process.env['FUARAN_MOCK_PORT'];
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  return DEFAULT_MOCK_PORT;
}

const port = parsePort(process.argv.slice(2));

startMockServer({ port })
  .then(({ port: bound }) => {
    process.stderr.write(
      `@fuaran-ui/mock listening on http://127.0.0.1:${bound}\n` +
        `  Point an SDK at this base URL — no access token, no BYOK key required.\n` +
        `  POST a TurnRequest, or GET /health.\n`,
    );
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`@fuaran-ui/mock failed to start: ${message}\n`);
    process.exit(1);
  });
