// ============================================================================
//  WIRE_FORMAT.md §5 "The two encode refusals" — the `row-encode/` corpus
//  family (Phase 1960).
//
//  Each vector is a row feed in host-neutral cell descriptors and either its
//  canonical bytes or its refusal. This host maps an `int64` descriptor onto a
//  `bigint` cell and a `utc` dateTime onto a `Date`, and runs them through
//  `encodeRows`, the encoder a DataGrid / Chart `source` takes. The family is
//  hand-authored, so this suite reads its manifest directly.
//
//  A descriptor this host cannot hold is named below with its reason, and the
//  suite fails when it skips a vector it did not name, or names one the
//  family does not have.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeNode, encodeNode, encodeRows } from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

type Descriptor = { int64: string } | { dateTime: string; kind: 'utc' | 'unspecified' };
interface Vector {
  id: string;
  rows: Record<string, Descriptor>[];
  expected?: string;
  refused?: { code: string; row: number; key: string };
}

const manifest = JSON.parse(
  readFileSync(join(wireCorpusRoot(), 'row-encode', 'manifest.json'), 'utf8'),
) as {
  vectors: Vector[];
};

/** The vectors this host's authoring surface cannot express, and why. */
const UNREPRESENTABLE: Record<string, string> = {
  'row-encode-refuse-datetime-unspecified':
    'a JavaScript Date always names an instant, so a date-time naming none cannot be authored here',
};

class Unrepresentable extends Error {}

const cell = (d: Descriptor): unknown => {
  if ('int64' in d) return BigInt(d.int64);
  if (d.kind === 'utc') return new Date(`${d.dateTime}Z`);
  throw new Unrepresentable(d.kind);
};

const feed = (v: Vector): Record<string, unknown>[] =>
  v.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, d]) => [k, cell(d)])));

describe('row-encode — the two encode refusals (WIRE_FORMAT.md §5)', () => {
  it('names exactly the vectors it cannot express', () => {
    const ids = new Set(manifest.vectors.map((v) => v.id));
    for (const id of Object.keys(UNREPRESENTABLE)) expect(ids.has(id), id).toBe(true);
    for (const v of manifest.vectors) {
      let skipped = false;
      try {
        feed(v);
      } catch (e) {
        if (!(e instanceof Unrepresentable)) throw e;
        skipped = true;
      }
      expect(skipped, v.id).toBe(v.id in UNREPRESENTABLE);
    }
  });

  for (const v of manifest.vectors.filter((x) => !(x.id in UNREPRESENTABLE))) {
    it(v.id, () => {
      const rows = feed(v);
      if (v.refused) {
        let thrown: unknown;
        try {
          encodeRows(rows);
        } catch (e) {
          thrown = e;
        }
        expect(thrown, 'refused').toBeDefined();
        const err = thrown as { name: string; code: string; row: number; key: string };
        expect(err.name).toBe('RowCellRefusedError');
        expect({ code: err.code, row: err.row, key: err.key }).toEqual(v.refused);
      } else {
        expect(encodeRows(rows)).toBe(v.expected);
      }
    });
  }

  it('a node carrying a refused cell does not encode', () => {
    const node = decodeNode(
      '{"id":"g","kind":{"$type":"DataGrid","columns":[],"source":{"$type":"Static","value":[]}}}',
    );
    if (!node.ok) throw new Error(JSON.stringify(node.error));
    const spec = (
      node.value.kind as unknown as { visualisation: { spec: { source: { value: unknown[] } } } }
    ).visualisation.spec;
    spec.source.value = [{ n: 9007199254740993n }];
    expect(() => encodeNode(node.value)).toThrow(/row 0, cell 'n'/);
    spec.source.value = [{ n: 9007199254740992n }];
    expect(encodeNode(node.value)).toContain('"value":[{"n":9007199254740992}]');
  });
});
