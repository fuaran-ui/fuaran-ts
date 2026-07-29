// ============================================================================
//  Bundled-snapshot drift guard. The package ships a snapshot of the
//  authoritative wire-format corpus; this test fails the build if the snapshot
//  diverges from the authority (i.e. the corpus was regenerated without
//  re-running the sync).
//
//  It delegates to `scripts/sync-corpus.mjs --check` rather than reimplementing
//  the comparison, so the sync and the guard share ONE notion of what the
//  payload set is and cannot drift apart from each other — the failure mode
//  they exist to catch. The script's stderr names every missing, extra and
//  byte-drifted file, and is surfaced verbatim on failure.
//
//  Skipped outside the canonical workspace layout (e.g. a third party running
//  the published package's tests) — there the bundled snapshot IS the corpus.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const script = join(packageRoot, 'scripts', 'sync-corpus.mjs');
const authority = join(packageRoot, '..', '..', '..', 'wire-format-fixtures');

describe.skipIf(!existsSync(join(authority, 'manifest.json')))(
  'bundled corpus snapshot matches the authoritative workspace corpus',
  () => {
    it('is byte-identical to the authority (re-run sync-corpus on mismatch)', () => {
      const result = spawnSync(process.execPath, [script, '--check'], {
        encoding: 'utf8',
        cwd: packageRoot,
      });

      // On drift the script exits 1 having named every offending file; hand
      // that report to the reader instead of a bare status code.
      const report = (result.stderr || result.stdout || '').trim();
      expect(result.status, `sync-corpus --check said:\n${report}`).toBe(0);
    });
  },
);
