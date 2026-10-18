// ============================================================================
//  This host runs the shared corpus's exact-decimal law family (Phase 2001).
//
//  `laws/decimal` carries AUTHORED vectors over every behaviour a host mirrors
//  of the exact decimal: the canonical text, the numeric order, the exact sum,
//  the nearest-double reading, the decimal column's codec (decode and the
//  guarded encode), and the aggregates over a decimal column. Each `expected`
//  was computed by the reference kit; this leg recomputes every one with THIS
//  host's own decimal arithmetic, codec and aggregate, and compares.
//
//  EVERY vector of EVERY case is run. A `reject` vector requires a refusal; the
//  class it names is not compared, because this host's refusals are strings,
//  not the reference's classes — gating on a name this host does not carry
//  would be gating on nothing.
//
//  The case set is asserted exactly against what this leg runs, and the vector
//  count against the family manifest, so a new case kind fails loudly.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  aggregateCells,
  decimalAdd,
  decimalCanonical,
  decimalCompare,
  decimalToFloat,
  num,
} from '@fuaran-ui/core-twins';
import type { AggFn, Cell } from '@fuaran-ui/schema';

import { decodeDataSource } from '../src/decode.js';
import { encodeDataSource, tryEncodeDataSource } from '../src/encode.js';
import { parse } from '../src/parse.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const lawsRoot = join(wireCorpusRoot(), 'laws');

interface LawFamily {
  readonly id: string;
  readonly kind: string;
  readonly file: string;
  readonly kitVersion: string;
  readonly vectors: number;
}

interface CellSpec {
  readonly kind: 'decimal' | 'int' | 'null';
  readonly text?: string;
}

interface DecimalVector {
  readonly id: string;
  readonly case: string;
  readonly input: {
    readonly text?: string;
    readonly a?: string;
    readonly b?: string;
    readonly document?: string;
    readonly cells?: readonly CellSpec[];
    readonly fn?: string;
  };
  readonly expected: {
    readonly verdict: 'accept' | 'reject';
    readonly error?: string;
    readonly canonical?: string;
    readonly order?: number;
    readonly sum?: string;
    readonly float?: string;
    readonly token?: string;
  };
}

interface DecimalLawFile {
  readonly family: string;
  readonly kitVersion: string;
  readonly vectors: readonly DecimalVector[];
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const manifest = readJson<{ readonly families: readonly LawFamily[] }>(
  join(lawsRoot, 'manifest.json'),
);
const family = manifest?.families.find((f) => f.id === 'decimal');
const lawFile = family ? readJson<DecimalLawFile>(join(lawsRoot, family.file)) : undefined;

// ─── this host's answer to one vector ───────────────────────────────────────

/** A host answer: an accepted value rendered as the vector's expected field, or a refusal. */
type Answer = { readonly accept: string | number } | { readonly reject: string };

const accept = (v: string | number | undefined, why: string): Answer =>
  v === undefined ? { reject: why } : { accept: v };

const cellOf = (c: CellSpec): Cell =>
  c.kind === 'null'
    ? { kind: 'Null' }
    : c.kind === 'int'
      ? { kind: 'Int', value: Number(c.text) }
      : // Held exactly as the vector states it: the guarded encode and the aggregate's admission
        // are what must refuse a text that is not canonical (or not decimal at all).
        { kind: 'Decimal', value: c.text ?? '' };

/** The corpus's cell token: `m:` a decimal, `i:` an int, `f:` a float, in the canonical layout. */
const token = (c: Cell): string => {
  switch (c.kind) {
    case 'Decimal':
      return 'm:' + c.value;
    case 'Int':
      return 'i:' + String(c.value);
    case 'Float':
      return 'f:' + (Number.isNaN(c.value) ? 'NaN' : num(c.value));
    case 'Null':
      return 'n:';
    default:
      return 'unexpected:' + c.kind;
  }
};

const column = (cells: readonly CellSpec[] | undefined): readonly Cell[] =>
  (cells ?? []).map(cellOf);

const RUNNERS: Readonly<Record<string, (v: DecimalVector) => Answer>> = {
  canonical: (v) => accept(decimalCanonical(v.input.text ?? ''), 'not decimal text'),
  compare: (v) => accept(decimalCompare(v.input.a ?? '', v.input.b ?? ''), 'not decimal text'),
  add: (v) => accept(decimalAdd(v.input.a ?? '', v.input.b ?? ''), 'not decimal text'),
  toFloat: (v) => {
    const f = decimalToFloat(v.input.text ?? '');
    return accept(
      f === undefined ? undefined : num(f),
      'not decimal text, or past the float range',
    );
  },
  codecDecode: (v) => {
    const ast = parse(v.input.document ?? '');
    if (!ast.ok) return { reject: 'not well-formed JSON' };
    const src = decodeDataSource(ast.value);
    return src.ok ? { accept: encodeDataSource(src.value) } : { reject: src.error };
  },
  codecEncode: (v) => {
    const cells = column(v.input.cells);
    const r = tryEncodeDataSource({
      kind: 'Embedded',
      table: {
        schema: [{ name: 'c', type: 'decimal' }],
        columns: [{ name: 'c', type: 'decimal', cells }],
      },
    });
    return r.ok ? { accept: r.value } : { reject: r.error };
  },
  aggregate: (v) => {
    const r = aggregateCells(v.input.fn as AggFn, 'decimal', column(v.input.cells));
    return r.ok ? { accept: token(r.value) } : { reject: JSON.stringify(r.error) };
  },
};

/** The field of `expected` an accepted answer is compared with, per case. */
const EXPECTED_FIELD: Readonly<Record<string, keyof DecimalVector['expected']>> = {
  canonical: 'canonical',
  compare: 'order',
  add: 'sum',
  toFloat: 'float',
  codecDecode: 'canonical',
  codecEncode: 'canonical',
  aggregate: 'token',
};

// ─── the leg ─────────────────────────────────────────────────────────────────

describe('decimal law vectors (shared corpus laws/ family)', () => {
  if (!family || !lawFile) {
    it.skip('law-vector family not present in this corpus checkout', () => {});
    return;
  }

  it('the vector file agrees with the family manifest', () => {
    expect(lawFile.family).toBe(family.id);
    expect(family.kind).toBe('law-vectors');
    expect(lawFile.kitVersion).toBe(family.kitVersion);
    expect(lawFile.vectors.length).toBe(family.vectors);
  });

  it('every case the family carries is one this host runs, and no other', () => {
    const carried = [...new Set(lawFile.vectors.map((v) => v.case))].sort();
    expect(carried).toEqual(Object.keys(RUNNERS).sort());
  });

  for (const v of lawFile.vectors) {
    it(v.id, () => {
      const run = RUNNERS[v.case];
      if (run === undefined)
        throw new Error(`vector case ${v.case} is not run by this host's harness — port it`);
      const answer = run(v);
      if (v.expected.verdict === 'reject') {
        expect(
          'reject' in answer,
          `the reference refused this vector (${String(v.expected.error)}); this host accepted ` +
            JSON.stringify(answer),
        ).toBe(true);
        return;
      }
      expect(v.expected.verdict).toBe('accept');
      if ('reject' in answer)
        throw new Error(
          `the reference accepted this vector; this host refused it — ${answer.reject}`,
        );
      expect(answer.accept).toBe(v.expected[EXPECTED_FIELD[v.case]!]);
    });
  }
});
