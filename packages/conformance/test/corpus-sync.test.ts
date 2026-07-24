// ============================================================================
//  Bundled-snapshot drift guard. The package ships a snapshot of the
//  authoritative workspace wire-format-fixtures corpus; this test fails the
//  build if the snapshot diverges byte-for-byte from the authority (i.e. the
//  corpus was regenerated without re-running scripts/sync-corpus.mjs).
//  Skipped outside the canonical workspace layout (e.g. a third party running
//  the published package's tests) — there the bundled snapshot IS the corpus.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = join(here, '..', 'corpus');
const authority = join(here, '..', '..', '..', '..', 'wire-format-fixtures');

const certificationFiles = (root: string): string[] => {
  const files = ['manifest.json', 'schema.json'];
  for (const dir of ['nodes', 'ops', 'reject', 'lenient', 'envelope', 'elicitation'])
    for (const f of readdirSync(join(root, dir))) files.push(`${dir}/${f}`);
  return files.sort();
};

describe.skipIf(!existsSync(join(authority, 'manifest.json')))(
  'bundled corpus snapshot matches the authoritative workspace corpus',
  () => {
    it('ships the same certification file set', () => {
      expect(certificationFiles(snapshot)).toEqual(certificationFiles(authority));
    });

    it('every file is byte-identical (re-run scripts/sync-corpus.mjs on mismatch)', () => {
      for (const rel of certificationFiles(authority)) {
        const a = readFileSync(join(authority, rel), 'utf8');
        const s = readFileSync(join(snapshot, rel), 'utf8');
        expect(s, `snapshot drift in ${rel}`).toBe(a);
      }
    });
  },
);
