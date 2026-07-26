import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FuaranClient } from '@fuaran-ui/client';
import { startMockServer } from '@fuaran-ui/mock';

import { checkScaffold, TARGETS } from '../scaffold/parity.js';

const execFileAsync = promisify(execFile);

// Scaffold parity + conformance (TS <-> F#). Two guarantees:
//  1. Structural — each target's emission wires its SDK + renderer and bundles
//     no secret literal.
//  2. Behavioral — the two SDK legs the scaffolds wire produce the SAME
//     canonical tree for the same turn against the local mock. The F# leg runs
//     the built `Fuaran.UI.Cli` dotnet tool (the F# SDK, wired); it skips
//     gracefully when the dll is not built (a dotnet-less CI still runs the rest).

describe('scaffold structural parity', () => {
  it.each(TARGETS)('%s wires its SDK + renderer and bundles no secret', (target) => {
    const report = checkScaffold(target);
    expect(report.missingRefs).toEqual([]);
    expect(report.hasSecretLiteral).toBe(false);
  });

  it.each(TARGETS)('%s references nothing its host tier cannot compile', (target) => {
    // The F#/Fable panel must not name the .NET-only Fuaran.UI.Client (it opens
    // System.Net.Http and is not source-packed for Fable) — that emission would
    // be broken on arrival.
    expect(checkScaffold(target).forbiddenRefs).toEqual([]);
  });
});

describe('scaffold behavioral parity — both SDK legs vs the mock', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const started = await startMockServer({ port: 0 });
    server = started.server;
    url = `http://127.0.0.1:${started.port}`;
  });
  afterAll(() => {
    // The F# tool's .NET HttpClient holds a keep-alive socket open; close it so
    // `server.close()` resolves and the test process can exit.
    server.closeAllConnections?.();
    server.close();
  });

  const prompt = 'a metric strip showing revenue';

  const fsCliDll = fileURLToPath(
    new URL(
      '../../../../fuaran-dotnet/src/Fuaran.UI.Cli/bin/Debug/net10.0/Fuaran.UI.Cli.dll',
      import.meta.url,
    ),
  );
  const hasFsCli = existsSync(fsCliDll);

  it.skipIf(!hasFsCli)('the TS SDK and the F# dotnet tool produce an identical tree', async () => {
    // TS leg: the @fuaran-ui/client SDK the ts-react scaffold wires.
    const tsResult = await new FuaranClient({ endpoint: url }).generate({ prompt });
    expect(tsResult.kind).toBe('produced');
    const tsTree = tsResult.kind === 'produced' ? tsResult.treeJson : '';

    // F# leg: the F# Fuaran.UI.Client SDK, exercised through the shipped dotnet
    // tool. Async execFile (not sync) so the in-process mock's event loop stays
    // free to answer the dotnet child — a sync spawn would deadlock.
    const { stdout } = await execFileAsync('dotnet', [fsCliDll, 'generate', prompt, '--mock', url]);
    const fsTree = stdout.trim();

    expect(fsTree).toBe(tsTree.trim());
    expect(tsTree).toContain('"$type":"Metric"');
  });

  it('the TS SDK leg round-trips a turn against the mock', async () => {
    // Always-on half (no dotnet needed): proves the TS scaffold's SDK leg works.
    const result = await new FuaranClient({ endpoint: url }).generate({ prompt: 'a sign up form' });
    expect(result.kind).toBe('produced');
  });
});
