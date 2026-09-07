// ============================================================================
//  Phase 1585 — `Chart.stacked` is omit-at-default, and the explicit form is
//  still read.
//
//  Until 1585 the encoder always emitted `stacked` while every host's decoder
//  already restored `false` on absence — a tolerance five hosts happened to
//  share rather than a stated rule. The IDL now declares the member
//  `omitDefault false`, so the omission is the CONTRACT: the encoder omits at
//  `false`, the decoder restores `false`, and the corpus's chart fixtures carry
//  the shorter bytes.
//
//  The half worth testing is the one a corpus of re-emitted fixtures cannot
//  state, because every fixture in it now omits the member: that a document
//  carrying the OLD explicit `"stacked": false` still decodes to exactly the
//  same tree. This is the read-compat leg, and it is here rather than in the
//  corpus because it is about bytes the corpus deliberately no longer contains.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, encodeNode } from '../src/index.js';

const omitted =
  '{"id":"c1","kind":{"$type":"Chart","kind":"Bar","source":{"$type":"Static","value":[]},"xField":"quarter","yFields":["revenue"]}}';

const explicitFalse =
  '{"id":"c1","kind":{"$type":"Chart","kind":"Bar","source":{"$type":"Static","value":[]},"stacked":false,"xField":"quarter","yFields":["revenue"]}}';

const explicitTrue =
  '{"id":"c1","kind":{"$type":"Chart","kind":"Bar","source":{"$type":"Static","value":[]},"stacked":true,"xField":"quarter","yFields":["revenue"]}}';

describe('Chart.stacked — omit-at-default (1585)', () => {
  it('the omitted form decodes to `stacked: false` and re-encodes unchanged', () => {
    const r = decodeNode(omitted);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nk = r.value.kind;
    expect(nk.kind).toBe('Visualisation');
    if (nk.kind !== 'Visualisation') return;
    expect(nk.visualisation.kind).toBe('Chart');
    if (nk.visualisation.kind !== 'Chart') return;
    expect(nk.visualisation.spec.stacked).toBe(false);
    expect(encodeNode(r.value)).toBe(omitted);
  });

  it('the pre-phase explicit `false` decodes IDENTICALLY — read-compat', () => {
    const before = decodeNode(explicitFalse);
    const after = decodeNode(omitted);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    // The same tree, reached from either spelling.
    expect(before.value).toEqual(after.value);
    // …and it normalises to the shorter bytes on re-encode (§3.6 scope note),
    // which is what makes the explicit spelling a lenient accept rather than a
    // second canonical form.
    expect(encodeNode(before.value)).toBe(omitted);
  });

  it('`true` is still carried, both ways', () => {
    const r = decodeNode(explicitTrue);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nk = r.value.kind;
    expect(nk.kind).toBe('Visualisation');
    if (nk.kind !== 'Visualisation') return;
    expect(nk.visualisation.kind).toBe('Chart');
    if (nk.visualisation.kind !== 'Chart') return;
    expect(nk.visualisation.spec.stacked).toBe(true);
    expect(encodeNode(r.value)).toBe(explicitTrue);
  });
});
