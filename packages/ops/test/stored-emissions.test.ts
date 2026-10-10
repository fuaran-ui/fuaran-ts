// ============================================================================
//  Phase 1910 — the stored-emission sample: this host's leg.
//
//  `wire-format-fixtures/stored-emissions/` is a fixed sample of REAL model
//  emissions with the answer every conformant node decoder gives each one. The
//  authored families (round-trip, reject, the decoder fuzzer) probe what they
//  were written to probe; none of them reaches the defects models actually
//  produce, and that is where two hosts part company unnoticed. The reference
//  host certifies the same declaration from its own suite, so a change to either
//  decoder that moves its answer on a real emission reddens that host's gate.
//
//  The verdict is the STRICT decoder's answer (WIRE_FORMAT.md §28.1), which
//  is this host's only decoder. Each fixture also declares what `repair` (§28)
//  returns for the emission, and the strict decode of the repaired text; this
//  host implements the catalogue, so it asserts both, byte-for-byte with the
//  reference host's `repair` (compared through the `repair/` family's pinned
//  outputs and, here, through the applied ids and the resulting verdict).
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeNode, repair, REPAIR_CATALOGUE } from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const corpusRoot = wireCorpusRoot();
const familyDir = join(corpusRoot, 'stored-emissions');

interface StoredEmission {
  readonly id: string;
  readonly decoder: 'node';
  readonly inputFile: string;
  readonly verdict: 'accept' | 'reject';
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
  readonly repair: {
    readonly outcome: 'repaired' | 'not-repairable';
    readonly applied?: readonly string[];
    readonly reason?: string;
    readonly repairedVerdict?: 'accept' | { readonly code: string; readonly path: string };
  };
}

interface StoredEmissionManifest {
  readonly kind: string;
  readonly fixtures: readonly StoredEmission[];
}

const manifest = JSON.parse(
  readFileSync(join(familyDir, 'manifest.json'), 'utf8'),
) as StoredEmissionManifest;

describe('stored-emission sample (Phase 1910)', () => {
  it('is the family this leg was written for, and is not empty', () => {
    expect(manifest.kind).toBe('stored-emission-sample');
    // A sample that shrank to nothing would certify nothing and stay green.
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(30);
    expect(manifest.fixtures.some((f) => f.verdict === 'accept')).toBe(true);
    expect(manifest.fixtures.some((f) => f.verdict === 'reject')).toBe(true);
  });

  it('declares every emission file in the family directory, and nothing else', () => {
    const onDisk = readdirSync(familyDir)
      .filter((f) => f !== 'manifest.json' && f !== 'README.md')
      .sort();
    const declared = manifest.fixtures.map((f) => f.inputFile.split('/').pop()!).sort();
    expect(onDisk).toEqual(declared);
  });

  it('samples the repair class, by both catalogue ids', () => {
    for (const id of REPAIR_CATALOGUE) {
      expect(
        manifest.fixtures.some((f) => f.repair.applied?.length === 1 && f.repair.applied[0] === id),
      ).toBe(true);
    }
  });

  for (const fx of manifest.fixtures) {
    it(`${fx.id}: ${fx.verdict}${fx.verdict === 'reject' ? ` ${fx.expectedErrorCode} at ${fx.expectedPath}` : ''}`, () => {
      const text = readFileSync(join(corpusRoot, fx.inputFile), 'utf8');
      const result = decodeNode(text);
      if (fx.verdict === 'accept') {
        expect(result.ok ? 'accepted' : `${result.error.code} at ${result.error.path}`).toBe(
          'accepted',
        );
      } else {
        expect(result.ok ? 'accepted' : `${result.error.code} at ${result.error.path}`).toBe(
          `${fx.expectedErrorCode} at ${fx.expectedPath}`,
        );
      }
      const r = repair(text);
      if (fx.repair.outcome === 'repaired') {
        expect(r.kind).toBe('Repaired');
        if (r.kind !== 'Repaired') return;
        expect([...r.applied]).toEqual([...(fx.repair.applied ?? [])]);
        const after = decodeNode(r.text);
        const v = fx.repair.repairedVerdict!;
        expect(after.ok ? 'accept' : `${after.error.code} at ${after.error.path}`).toBe(
          v === 'accept' ? 'accept' : `${v.code} at ${v.path}`,
        );
      } else {
        expect(r).toEqual({ kind: 'NotRepairable', reason: fx.repair.reason });
      }
    });
  }
});
