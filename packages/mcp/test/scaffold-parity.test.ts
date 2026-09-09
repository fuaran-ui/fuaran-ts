import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
//     the `Fuaran.UI.Cli` dotnet tool (the F# SDK, wired).
//
// THE BEHAVIORAL LEG OWNS ITS INPUT, and that was a correction (Phase 1625).
// It used to be `it.skipIf(!existsSync(<sibling>/bin/Debug/net10.0/…dll))` — a
// guard on a sibling repository's BUILD OUTPUT, which is wrong twice over:
//
//   * Green by absence. On CI and on any machine that had not recently built
//     the sibling in Debug, the assertion was never made and the suite reported
//     green — silent on exactly the machines that would catch a divergence.
//   * Green (or red) by STALENESS. `bin/Debug/` is a path the sibling's own
//     gate never writes: its build configuration defaults to Release, so the
//     Debug output is whatever an ad-hoc build left behind, of unknown age.
//     That is not hypothetical — on 2026-09-08 the assertion ran for the first
//     time in a while against a months-stale Debug dll whose client still spoke
//     the retired `{TreeJson}` reply shape, read no tree out of the mock's
//     `{version, tree, …}` 200, and printed an empty line at exit 0. Both SDK
//     legs were correct at HEAD; only the artefact under test was old.
//
// So the prerequisite is now the sibling SOURCE repository — a declared input
// CI provides, the same posture the corpus-driven suites take — and the suite
// BUILDS the CLI itself before asserting against it. A present-but-unbuildable
// sibling FAILS, naming what went wrong; it never degrades to a skip. The only
// skip left is a genuinely standalone clone with no sibling repository at all,
// and `FUARAN_REQUIRE_FS_CLI=1` (which the parity CI lane sets) turns even that
// into a failure, so on CI the assertion cannot be skipped by any means.

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

// The sibling F# repository's CLI project — the SOURCE, not an output of it.
// Resolved as a sibling of this repo's root, the layout CONTRIBUTING.md
// documents and CI reassembles (`../fuaran-dotnet`, beside
// `../wire-format-fixtures`).
const fsCliProject = fileURLToPath(
  new URL('../../../../fuaran-dotnet/src/Fuaran.UI.Cli/Fuaran.UI.Cli.fsproj', import.meta.url),
);
const fsCliRepoRoot = fileURLToPath(new URL('../../../../fuaran-dotnet/', import.meta.url));

// Which configuration this suite builds. DEBUG on purpose: the sibling's own
// gate builds Release, so a build driven from here cannot contend with a gate
// running beside it — and because the suite builds the artefact itself, the
// configuration no longer decides whether what it runs is current.
const fsCliConfiguration = process.env['FUARAN_FS_CLI_CONFIGURATION'] ?? 'Debug';

// `1` makes an absent sibling repository a FAILURE rather than a skip. CI sets
// it, because there the sibling is a checkout step and its absence is a layout
// drift, not a standalone clone.
const fsCliRequired = process.env['FUARAN_REQUIRE_FS_CLI'] === '1';

const fsCliSiblingPresent = existsSync(fsCliProject);
const runBehavioralParity = fsCliSiblingPresent || fsCliRequired;

/**
 * Resolve the `Fuaran.UI.Cli` dll this suite will run, BUILDING it first so it
 * is current by construction. Throws — never returns a sentinel — because every
 * failure here is a real one: a missing sibling under `FUARAN_REQUIRE_FS_CLI`,
 * an override pointing at nothing, a build that did not succeed, or a build
 * that succeeded and produced no dll where one was expected.
 */
async function buildFsCli(): Promise<string> {
  // An override lets a lane build once in its own step and point here, rather
  // than paying a build inside the test process.
  const override = process.env['FUARAN_FS_CLI_DLL'];
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) {
      throw new Error(
        `FUARAN_FS_CLI_DLL names ${override}, which does not exist. The behavioral parity leg ` +
          `runs that dll; it will not fall back to searching for another one.`,
      );
    }
    return override;
  }

  if (!fsCliSiblingPresent) {
    throw new Error(
      `the F# host repository is absent — expected its CLI project at ${fsCliProject}. ` +
        `FUARAN_REQUIRE_FS_CLI is set, so this is a failure rather than a skip: check the sibling ` +
        `out beside this repo (the layout in CONTRIBUTING.md) and re-run.`,
    );
  }

  try {
    await execFileAsync('dotnet', ['build', fsCliProject, '-c', fsCliConfiguration, '--nologo'], {
      cwd: fsCliRepoRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // The sibling is present, so this is a real failure and not a standalone
    // clone — but the two ways it fails want different remedies, and a bare
    // `spawn dotnet ENOENT` names neither.
    const detail =
      (error as { code?: unknown }).code === 'ENOENT'
        ? `no \`dotnet\` on PATH. The behavioral parity leg runs the F# SDK, so it needs the .NET ` +
          `SDK the sibling's global.json pins`
        : `\`dotnet build ${fsCliProject} -c ${fsCliConfiguration}\` failed:\n` +
          `${String((error as { stdout?: unknown }).stdout ?? (error as Error).message)}`;
    throw new Error(
      `could not build the F# CLI the behavioral parity leg asserts against — ${detail}`,
    );
  }

  // The TFM is read off the build's own output rather than written down here —
  // a hardcoded framework moniker is one more path that can quietly stop
  // naming the artefact, which is the defect this whole block exists to close.
  const outputRoot = join(dirname(fsCliProject), 'bin', fsCliConfiguration);
  const built = existsSync(outputRoot)
    ? readdirSync(outputRoot)
        .map((tfm) => join(outputRoot, tfm, 'Fuaran.UI.Cli.dll'))
        .filter((candidate) => existsSync(candidate))
    : [];

  if (built.length !== 1) {
    throw new Error(
      `expected exactly one Fuaran.UI.Cli.dll under ${outputRoot} after building ` +
        `${fsCliProject} in ${fsCliConfiguration}; found ${built.length}` +
        (built.length > 1 ? ` (${built.join(', ')})` : '') +
        `. The behavioral parity leg has no artefact it can honestly run.`,
    );
  }
  return built[0]!;
}

describe('scaffold behavioral parity — both SDK legs vs the mock', () => {
  let server: Server;
  let url: string;
  let fsCliDll = '';
  // Held rather than thrown, so a prerequisite failure reddens the ONE test
  // that depends on it instead of the always-on TS leg beside it.
  let fsCliFailure: unknown = null;

  beforeAll(async () => {
    const started = await startMockServer({ port: 0 });
    server = started.server;
    url = `http://127.0.0.1:${started.port}`;

    if (runBehavioralParity) {
      try {
        fsCliDll = await buildFsCli();
      } catch (error) {
        fsCliFailure = error;
      }
    }
    // A cold restore + build of the CLI's project graph is minutes, not
    // seconds; an incremental one is a few seconds.
  }, 900_000);
  afterAll(() => {
    // The F# tool's .NET HttpClient holds a keep-alive socket open; close it so
    // `server.close()` resolves and the test process can exit.
    server.closeAllConnections?.();
    server.close();
  });

  const prompt = 'a metric strip showing revenue';

  it.skipIf(!runBehavioralParity)(
    'the TS SDK and the F# dotnet tool produce an identical tree',
    async () => {
      // The declared prerequisite did not resolve. Rethrown here so the failure
      // arrives ON the assertion it belongs to, with its own message intact.
      if (fsCliFailure !== null) throw fsCliFailure;

      // TS leg: the @fuaran-ui/client SDK the ts-react scaffold wires.
      const tsResult = await new FuaranClient({ endpoint: url }).generate({ prompt });
      expect(tsResult.kind).toBe('produced');
      const tsTree = tsResult.kind === 'produced' ? tsResult.treeJson : '';

      // F# leg: the F# Fuaran.UI.Client SDK, exercised through the shipped dotnet
      // tool. Async execFile (not sync) so the in-process mock's event loop stays
      // free to answer the dotnet child — a sync spawn would deadlock.
      const { stdout } = await execFileAsync('dotnet', [
        fsCliDll,
        'generate',
        prompt,
        '--mock',
        url,
      ]);
      const fsTree = stdout.trim();

      // Named before the comparison: a leg that emitted NOTHING is a different
      // finding from two legs that disagree, and a bare string diff against ''
      // reads as the latter. The 2026-09-08 failure was exactly this.
      expect(
        fsTree,
        'the F# CLI wrote no tree to stdout — it produced an empty turn rather than disagreeing ' +
          'with the TS leg',
      ).not.toBe('');

      expect(fsTree).toBe(tsTree.trim());
      expect(tsTree).toContain('"$type":"Metric"');
    },
  );

  it('the TS SDK leg round-trips a turn against the mock', async () => {
    // Always-on half (no dotnet needed): proves the TS scaffold's SDK leg works.
    const result = await new FuaranClient({ endpoint: url }).generate({ prompt: 'a sign up form' });
    expect(result.kind).toBe('produced');
  });
});
