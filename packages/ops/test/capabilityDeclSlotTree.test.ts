// ============================================================================
//  The explicit "slotTree" value space (Phase 1860, from fuaran-core#229).
//
//  A non-slot hole may range over trees through an explicit "slotTree" space.
//  This host must DECODE that encoding — not refuse it as an unknown space —
//  re-encode it to the same bytes, and validate arguments against it as the
//  reference does. From Core 0.37.0 (fuaran-core Phase 409) a SLOT entry carries
//  its constraint and no space: it is its constraint, so a tree of another kind
//  is out of it. The declaration below is the reference's own canonical encoding
//  at Core 0.38.1, the release the reference host pins, with its verdicts; the
//  pre-0.37.0 form, which wrote a space on the slot entry, still reads and
//  re-encodes to it (Phase 2329 re-derived both from the reference's tests).
//
//  The runtime is read from `@fuaran-ui/ui`'s BUILT output, for the reasons
//  `capabilityLaws.test.ts` gives beside the same import.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { validateArgs } from '../../ui/dist/index.js';
import type { Capability, InvokeArg } from '@fuaran-ui/schema';

import { decodeCapabilityDeclaration, encodeCapabilityDeclaration } from '../src/capabilityDecl.js';

const SLOT_TREE_DECL =
  '{"$type":"capability","determinism":"random","id":"cap-tree","placement":{"$type":"server"},' +
  '"signature":{"effect":{"determinism":"random","host":"readsHost"},"holes":[' +
  '{"addr":"body","kind":"slot","name":"body","required":true,"slotKind":"Layout"},' +
  '{"addr":"chart","kind":"value","name":"chart","required":false,"space":{"$type":"slotTree","slotKind":"Chart"}}' +
  '],"name":"tree"}}';

/** The same declaration as pinned before Core 0.37.0: the slot entry also wrote a `slotTree` space. */
const SLOT_TREE_DECL_BEFORE_037 =
  '{"$type":"capability","determinism":"random","id":"cap-tree","placement":{"$type":"server"},' +
  '"signature":{"effect":{"determinism":"random","host":"readsHost"},"holes":[' +
  '{"addr":"body","kind":"slot","name":"body","required":true,"slotKind":"Layout","space":{"$type":"slotTree"}},' +
  '{"addr":"chart","kind":"value","name":"chart","required":false,"space":{"$type":"slotTree","slotKind":"Chart"}}' +
  '],"name":"tree"}}';

const decoded = (): Capability => {
  const r = decodeCapabilityDeclaration(SLOT_TREE_DECL);
  if (!r.ok)
    throw new Error(`a declaration carrying an explicit slotTree space was refused: ${r.error}`);
  return r.value;
};

describe('capability declaration — the explicit slotTree value space', () => {
  it('decodes rather than refusing an unknown space', () => {
    const [body, chart] = decoded().signature.holes;
    expect(body?.space).toBeUndefined();
    expect(body?.slotKind).toBe('Layout');
    expect(chart?.space).toEqual({ kind: 'SlotTree', slotKind: 'Chart' });
  });

  it('round-trips byte-identically', () => {
    expect(encodeCapabilityDeclaration(decoded())).toBe(SLOT_TREE_DECL);
  });

  it('reads the pre-0.37.0 form and re-encodes it without the slot entry space', () => {
    const r = decodeCapabilityDeclaration(SLOT_TREE_DECL_BEFORE_037);
    if (!r.ok) throw new Error(`the pre-0.37.0 slotTree declaration was refused: ${r.error}`);
    expect(encodeCapabilityDeclaration(r.value)).toBe(SLOT_TREE_DECL);
  });

  it.each([
    ['the slot constraint is accepted', [['body', '{"kind":"Layout"}']], undefined],
    ['another kind is out of the slot', [['body', '{"kind":"Text"}']], 'ArgOutOfSpace'],
    ['a scalar is no tree', [['body', '13']], 'UninvocableArg'],
    [
      'the constrained kind is accepted',
      [
        ['body', '{"kind":"Layout"}'],
        ['chart', '{"kind":"Chart"}'],
      ],
      undefined,
    ],
    [
      'another kind is out of the space',
      [
        ['body', '{"kind":"Layout"}'],
        ['chart', '{"kind":"Text"}'],
      ],
      'ArgOutOfSpace',
    ],
    ['a malformed document is no tree', [['body', '{"kind":']], 'UninvocableArg'],
    ['an object without a string kind is no tree', [['body', '{"kind":1}']], 'UninvocableArg'],
  ] as [string, [string, string][], string | undefined][])('validateArgs: %s', (_n, args, want) => {
    const r = validateArgs(
      decoded(),
      args.map(([addr, value]): InvokeArg => ({ addr, value })),
    );
    if (want === undefined) expect(r.ok).toBe(true);
    else expect(r.ok ? undefined : r.error.kind).toBe(want);
  });
});
