// ============================================================================
//  Phase 1071 — the encoder is TOTAL at a typed float slot.
//
//  `encodeNode` must never emit a bare `NaN` / `Infinity` / `-Infinity` token.
//  Those are valid JavaScript literals and are NOT valid JSON, so an emission
//  carrying one cannot be parsed back by anything — including this tier's own
//  decoder. The defect is therefore a correctness failure on its own terms,
//  independent of any consumer that happens to trip it.
//
//  It is reachable because `Binding.Static` carries an UNTYPED payload and a
//  tree can be built without a typecheck at the slot (a projected tree, a tree
//  assembled from parsed JSON, a hand-authored one). Such a tree naturally
//  spells a non-finite the way the WIRE spells it — the quoted sentinel string
//  of §5/§7 — and before this phase that spelling fell through the float
//  formatter's arithmetic and came out bare.
//
//  Both spellings are pinned here, and the pairing is the point: the numeric
//  path was already correct, so a test covering only the string path would not
//  show that the fix left the finite and non-finite NUMBER paths byte-unchanged.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, encodeNode } from '../src/index.js';

/** Build a Sparkline whose Static source is a float SEQUENCE. */
const sparkWith = (value: unknown) =>
  ({
    id: 'spark',
    kind: {
      kind: 'Display',
      display: { kind: 'Sparkline', spec: { source: { kind: 'Static', value } } },
    },
    state: {},
    style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

describe('non-finite floats encode as quoted sentinels (§5/§7)', () => {
  it('encodes real non-finite NUMBERS as the quoted sentinels', () => {
    expect(encodeNode(sparkWith([1, NaN, 3, Infinity, -Infinity, 5]))).toContain(
      '[1,"NaN",3,"Infinity","-Infinity",5]',
    );
  });

  it('encodes the WIRE SPELLING of a non-finite (the sentinel STRING) identically', () => {
    // The shape an untypechecked tree carries. Before Phase 1071 this emitted
    // `[1,NaN,3,Infinity,-Infinity,5]` — bare, and not JSON.
    expect(encodeNode(sparkWith([1, 'NaN', 3, 'Infinity', '-Infinity', 5]))).toContain(
      '[1,"NaN",3,"Infinity","-Infinity",5]',
    );
  });

  it('emits parseable JSON for BOTH spellings — the property that actually matters', () => {
    for (const v of [
      [1, NaN, 3, Infinity, -Infinity, 5],
      [1, 'NaN', 3, 'Infinity', '-Infinity', 5],
    ]) {
      const encoded = encodeNode(sparkWith(v));
      expect(() => JSON.parse(encoded) as unknown).not.toThrow();
    }
  });

  it('round-trips: a wire-spelled sentinel decodes and re-encodes byte-identically', () => {
    const wire =
      '{"id":"spark","kind":{"$type":"Sparkline","source":{"$type":"Static","value":[1,"NaN",3,"Infinity","-Infinity",5]}}}';
    const decoded = decodeNode(wire);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(encodeNode(decoded.value)).toBe(wire);
  });

  it('an unrepresentable value at a float slot is the quoted "NaN", never a bare token', () => {
    // Total rather than correct: nothing can recover a float from "not-a-float",
    // so the contract is only that the output stays parseable JSON.
    const encoded = encodeNode(sparkWith([1, 'not-a-float', 3]));
    expect(encoded).toContain('[1,"NaN",3]');
    expect(() => JSON.parse(encoded) as unknown).not.toThrow();
  });

  it('leaves the FINITE path byte-unchanged (the fix is a guard, not a reformat)', () => {
    expect(encodeNode(sparkWith([0, -0, 1.5, -2.25, 1e21, 1e-7]))).toContain(
      '[0,0,1.5,-2.25,1E+21,1E-07]',
    );
  });
});
