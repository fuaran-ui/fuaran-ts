// Phase 425 / cat:Fuaran.UI.ProgressFieldCell (2026-08-10) — the field-driven
// Progress grid cell, parity with the .NET decoder's suite. Before this, every
// wire-decoded Progress cell rendered a zero fill regardless of the data (the
// fraction slot is closure-typed and decoded to an inert placeholder) —
// silently wrong rather than failing. Now the column-level `field` drives a
// synthesized per-row projection: clamp 0..1, missing / non-numeric → 0.

import { describe, expect, it } from 'vitest';

import { decodeNode } from '../src/index.js';

const gridJson = (progressColumn: string): string =>
  `{"id":"g","kind":{"$type":"DataGrid","rowKeyField":"name","columns":[${progressColumn}],` +
  `"source":{"$type":"Transform","pipeline":[],"source":{"columns":{` +
  `"name":{"values":["Alpha","Beta"],"validity":[true,true]},` +
  `"capacity":{"values":[0.9,0.5],"validity":[true,true]}}}}},` +
  `"state":{},"style":{"emphasis":"Normal","tone":"Default","weight":"Standard"}}`;

const decodeFraction = (progressColumn: string): ((row: unknown) => number) => {
  const r = decodeNode(gridJson(progressColumn));
  if (!r.ok) throw new Error(`expected the grid to decode: ${JSON.stringify(r.error)}`);
  const kind = r.value.kind;
  if (kind.kind !== 'Visualisation') throw new Error(`expected a Visualisation, got ${kind.kind}`);
  const vis = kind.visualisation;
  if (vis.kind !== 'Grid') throw new Error(`expected a Grid, got ${vis.kind}`);
  const col = vis.spec.columns[0];
  if (col === undefined || col.kind.kind !== 'Progress')
    throw new Error('expected one Progress column');
  return col.kind.fraction;
};

describe('Phase 425 — field-driven Progress grid cell', () => {
  it('a field-carrying Progress column projects the row fraction, clamped 0..1', () => {
    const fraction = decodeFraction(
      '{"field":"capacity","label":"Capacity","kind":{"$type":"Progress"}}',
    );
    expect(fraction({ capacity: 0.9 })).toBeCloseTo(0.9);
    expect(fraction({ capacity: 3 })).toBe(1);
    expect(fraction({ capacity: -0.2 })).toBe(0);
  });

  it('missing or non-numeric row values project 0 — never a throw', () => {
    const fraction = decodeFraction(
      '{"field":"capacity","label":"Capacity","kind":{"$type":"Progress"}}',
    );
    expect(fraction({ other: 0.5 })).toBe(0);
    expect(fraction({ capacity: 'high' })).toBe(0);
    expect(fraction(null)).toBe(0);
  });

  it('a fieldless Progress column keeps the inert placeholder (unchanged behaviour)', () => {
    const fraction = decodeFraction('{"label":"Capacity","kind":{"$type":"Progress"}}');
    expect(fraction({ capacity: 0.9 })).toBe(0);
  });

  it('junk *Fn payloads inside the kind are ignored — the field drives regardless', () => {
    const fraction = decodeFraction(
      '{"field":"capacity","label":"Capacity","kind":{"$type":"Progress","fractionFn":{"$type":"col","name":"capacity"}}}',
    );
    expect(fraction({ capacity: 0.75 })).toBeCloseTo(0.75);
  });
});
