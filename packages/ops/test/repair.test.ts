// ============================================================================
//  Phase 1923 — deliberate repair (WIRE_FORMAT.md §28): this host's
//  certification of the `repair/` corpus family.
//
//  Each case names an input, the STRICT decoder's answer to it, and what
//  `repair` must return — the repaired text byte for byte with the applied ids,
//  or the refusal token. The reference host certifies the same declaration from
//  its own suite, so the two hosts produce identical bytes and identical ids on
//  every case.
// ============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeNode, repair, REPAIR_CATALOGUE, REPAIR_CATALOGUE_VERSION } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures, unless a worktree
// names its corpus explicitly.
const corpusRoot =
  process.env['FUARAN_WIRE_FIXTURES'] || join(here, '..', '..', '..', '..', 'wire-format-fixtures');

type Verdict = 'accept' | { readonly code: string; readonly path: string };

interface RepairCase {
  readonly id: string;
  readonly inputFile: string;
  readonly strict: Verdict;
  readonly outcome: 'repaired' | 'not-repairable';
  readonly applied?: readonly string[];
  readonly expectedFile?: string;
  readonly repairedDecodes?: Verdict;
  readonly reason?: string;
}

interface RepairFamily {
  readonly kind: string;
  readonly catalogueVersion: number;
  readonly catalogue: readonly string[];
  readonly refusals: readonly string[];
  readonly hostStatements: Readonly<Record<string, string>>;
  readonly hostCatalogueVersions: Readonly<Record<string, number>>;
  readonly cases: readonly RepairCase[];
}

const family = JSON.parse(
  readFileSync(join(corpusRoot, 'repair', 'manifest.json'), 'utf8'),
) as RepairFamily;

// Byte-exact: read as UTF-8 with no newline translation.
const read = (rel: string): string => readFileSync(join(corpusRoot, rel), 'utf8');

const answer = (r: ReturnType<typeof decodeNode>): string =>
  r.ok ? 'accept' : `${r.error.code} at ${r.error.path}`;

const show = (v: Verdict): string => (v === 'accept' ? 'accept' : `${v.code} at ${v.path}`);

describe('repair — WIRE_FORMAT.md §28 (Phase 1923)', () => {
  it('is the family this leg was written for, and exercises every outcome', () => {
    expect(family.kind).toBe('repair-catalogue');
    expect(family.cases.length).toBeGreaterThanOrEqual(20);
    for (const id of REPAIR_CATALOGUE) {
      expect(family.cases.some((c) => c.applied?.length === 1 && c.applied[0] === id)).toBe(true);
    }
    for (const r of family.refusals) expect(family.cases.some((c) => c.reason === r)).toBe(true);
  });

  it('declares this host’s catalogue, version and statement', () => {
    expect(family.catalogue).toEqual([...REPAIR_CATALOGUE]);
    expect(family.catalogueVersion).toBe(REPAIR_CATALOGUE_VERSION);
    expect(family.hostStatements['fuaran-ts']).toBe('implements');
    expect(family.hostCatalogueVersions['fuaran-ts']).toBe(REPAIR_CATALOGUE_VERSION);
  });

  it('composes wrong-type-close with implied-node-close, in that order, and nothing else (§28.2.3)', () => {
    const composed = ['wrong-type-close', 'implied-node-close'];
    expect(family.cases.some((c) => JSON.stringify(c.applied) === JSON.stringify(composed))).toBe(
      true,
    );
    for (const c of family.cases) {
      if ((c.applied?.length ?? 0) > 1) expect(c.applied).toEqual(composed);
    }
  });

  it('declares every file in repair/, and nothing else', () => {
    const onDisk = readdirSync(join(corpusRoot, 'repair'))
      .filter((f) => f !== 'manifest.json' && f !== 'README.md')
      .sort();
    const declared = [
      ...new Set(
        family.cases
          .flatMap((c) => [c.inputFile, ...(c.expectedFile === undefined ? [] : [c.expectedFile])])
          .filter((f) => f.startsWith('repair/'))
          .map((f) => f.slice('repair/'.length)),
      ),
    ].sort();
    expect(onDisk).toEqual(declared);
  });

  it('is idempotent — a repaired text needs nothing further', () => {
    for (const c of family.cases) {
      const r = repair(read(c.inputFile));
      if (r.kind === 'Repaired')
        expect(repair(r.text)).toEqual({ kind: 'Repaired', text: r.text, applied: [] });
    }
  });

  for (const c of family.cases) {
    it(`${c.id}: ${c.outcome}`, () => {
      const input = read(c.inputFile);
      expect(answer(decodeNode(input))).toBe(show(c.strict));
      const r = repair(input);
      if (c.outcome === 'repaired') {
        expect(r.kind).toBe('Repaired');
        if (r.kind !== 'Repaired') return;
        expect(r.text).toBe(read(c.expectedFile!));
        expect([...r.applied]).toEqual([...(c.applied ?? [])]);
        expect(answer(decodeNode(r.text))).toBe(show(c.repairedDecodes!));
      } else {
        expect(r).toEqual({ kind: 'NotRepairable', reason: c.reason });
      }
    });
  }
});
