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
//  The verdict is the answer with decode-time recovery OFF. This host has no
//  recovery, so it answers every fixture — including the ones carrying
//  `referenceRecovery`, which name the open specification question the
//  family's README describes. Those fixtures assert what this host does today;
//  they are not a ruling on whether it should repair them.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeNode } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures, unless a worktree
// names its corpus explicitly.
const corpusRoot =
  process.env['FUARAN_WIRE_FIXTURES'] || join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const familyDir = join(corpusRoot, 'stored-emissions');

interface StoredEmission {
  readonly id: string;
  readonly decoder: 'node';
  readonly inputFile: string;
  readonly verdict: 'accept' | 'reject';
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
  readonly referenceRecovery?: string;
}

interface StoredEmissionManifest {
  readonly kind: string;
  readonly openQuestions: readonly {
    readonly id: string;
    readonly recoveries: readonly string[];
  }[];
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

  it('names only recoveries its open question lists', () => {
    const known = new Set(manifest.openQuestions.flatMap((q) => q.recoveries));
    const named = manifest.fixtures.flatMap((f) =>
      f.referenceRecovery === undefined ? [] : [f.referenceRecovery],
    );
    expect(named.length).toBeGreaterThan(0);
    for (const r of named) expect(known.has(r)).toBe(true);
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
    });
  }
});
