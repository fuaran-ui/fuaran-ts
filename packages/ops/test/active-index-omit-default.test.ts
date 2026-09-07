// ============================================================================
//  Phase 1585 — `Tabs.activeIndex` is omit-at-default, and the explicit form is
//  still read.
//
//  The sibling of `stacked-omit-default.test.ts`, landed one step behind it.
//  Until 1585 the encoder always emitted `activeIndex` while every host's
//  decoder already restored the `Static` binding carrying `0` on absence — a
//  tolerance five hosts happened to share rather than a stated rule. The IDL
//  now declares the member `omitDefault Static{value=0}`, so the omission is the
//  CONTRACT: the encoder omits at that identity, the decoder restores it, and
//  the corpus's tabs fixtures carry the shorter bytes.
//
//  The half worth testing is the one a corpus of re-emitted fixtures cannot
//  state, because every fixture carrying the identity now omits the member:
//  that a document carrying the OLD explicit `{"$type":"Static","value":0}`
//  still decodes to exactly the same tree. This is the read-compat leg, and it
//  is here rather than in the corpus because it is about bytes the corpus
//  deliberately no longer contains.
//
//  The third and fourth cases are the ones a bool-valued member does not have:
//  the identity is one INHABITANT of a union with an infinite payload domain, so
//  a `Static` carrying any other index must still ride, and so must every other
//  binding case. An encoder that tested only the tag would silently drop a
//  document's authored tab.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, encodeNode } from '../src/index.js';

const child = '{"id":"p1","kind":{"$type":"Markdown","text":"one"}}';

const omitted = `{"id":"t1","kind":{"$type":"Tabs","children":[${child}]}}`;

const explicitZero = `{"id":"t1","kind":{"$type":"Tabs","activeIndex":{"$type":"Static","value":0},"children":[${child}]}}`;

const explicitOne = `{"id":"t1","kind":{"$type":"Tabs","activeIndex":{"$type":"Static","value":1},"children":[${child}]}}`;

const stateBound = `{"id":"t1","kind":{"$type":"Tabs","activeIndex":{"$type":"State","key":"pane"},"children":[${child}]}}`;

/** The `TabsSpec` behind a decoded node, or `undefined` if it decoded to something else. */
const tabsSpecOf = (wire: string) => {
  const r = decodeNode(wire);
  expect(r.ok).toBe(true);
  if (!r.ok) return undefined;
  const nk = r.value.kind;
  if (nk.kind !== 'Layout' || nk.layout.kind !== 'Tabs') {
    expect.unreachable('expected a Layout/Tabs node');
    return undefined;
  }
  return { node: r.value, spec: nk.layout.spec };
};

describe('Tabs.activeIndex — omit-at-default (1585)', () => {
  it('the omitted form decodes to `Static 0` and re-encodes unchanged', () => {
    const t = tabsSpecOf(omitted);
    if (t === undefined) return;
    expect(t.spec.activeIndex).toEqual({ kind: 'Static', value: 0 });
    expect(encodeNode(t.node)).toBe(omitted);
  });

  it('the pre-phase explicit `Static 0` decodes IDENTICALLY — read-compat', () => {
    const before = decodeNode(explicitZero);
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

  it('a `Static` carrying any OTHER index is still carried, both ways', () => {
    const t = tabsSpecOf(explicitOne);
    if (t === undefined) return;
    expect(t.spec.activeIndex).toEqual({ kind: 'Static', value: 1 });
    expect(encodeNode(t.node)).toBe(explicitOne);
  });

  it('a non-`Static` binding is still carried, both ways', () => {
    const t = tabsSpecOf(stateBound);
    if (t === undefined) return;
    expect(t.spec.activeIndex).toEqual({ kind: 'State', key: 'pane' });
    expect(encodeNode(t.node)).toBe(stateBound);
  });
});
