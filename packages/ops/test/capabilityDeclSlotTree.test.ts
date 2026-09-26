// ============================================================================
//  The explicit "slotTree" value space (Phase 1860, from fuaran-core#229).
//
//  The reference's capability codec writes an explicit "slotTree" space only
//  when a slot's space disagrees with its constraint (or a non-slot hole ranges
//  over trees); an ordinary slotted signature stays byte-identical. This host
//  must DECODE that encoding — not refuse it as an unknown space — re-encode it
//  to the same bytes, and validate arguments against it as the reference does.
//  The declaration below is the reference's own canonical encoding of the same
//  capability; the other two hosts pin the same bytes.
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
    expect(body?.space).toEqual({ kind: 'SlotTree' });
    expect(chart?.space).toEqual({ kind: 'SlotTree', slotKind: 'Chart' });
  });

  it('round-trips byte-identically', () => {
    expect(encodeCapabilityDeclaration(decoded())).toBe(SLOT_TREE_DECL);
  });

  it.each([
    ['any kind fills the unconstrained space', [['body', '{"kind":"Text"}']], undefined],
    ['a scalar is no tree', [['body', '13']], 'UninvocableArg'],
    [
      'the constrained kind is accepted',
      [
        ['body', '{"kind":"Text"}'],
        ['chart', '{"kind":"Chart"}'],
      ],
      undefined,
    ],
    [
      'another kind is out of the space',
      [
        ['body', '{"kind":"Text"}'],
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
