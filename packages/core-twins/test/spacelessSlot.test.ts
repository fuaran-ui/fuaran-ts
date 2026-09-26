// ============================================================================
//  A slot hole with no declared space is invocable (Phase 1873, from
//  fuaran-core#229).
//
//  The reference writes a slot entry's space only when it disagrees with the
//  slot's constraint, so an ordinary slotted capability travels with NO
//  `space` on its slot entry, and the reference's decoder restores it as the
//  tree space constrained to the slot's kind. The signature below is that
//  ordinary shape: a slot constrained to "para" beside two value holes. The
//  reference admits a well-formed tree of the constrained kind, refuses a tree
//  of another kind as ArgOutOfSpace naming the slot's tree space, and refuses
//  anything that is no tree as UninvocableArg.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { Capability, CapabilitySignature, InvokeArg } from '@fuaran-ui/schema';

import { createCapability, validateArgs } from '../src/capability.js';

const signature: CapabilitySignature = {
  name: 'tpl',
  holes: [
    {
      addr: 'tpl/t',
      name: 'title',
      kind: 'value',
      space: { kind: 'StringLen', minLen: 1, maxLen: 20 },
      required: true,
    },
    {
      addr: 'tpl/c',
      name: 'count',
      kind: 'value',
      space: { kind: 'IntRange', min: 0, max: 10 },
      required: true,
    },
    { addr: 'tpl/s', name: 'body', kind: 'slot', slotKind: 'para', required: true },
  ],
  effect: { hostEffect: 'Pure', determinism: 'Deterministic' },
};

const cap: Capability = createCapability('tpl-cap', signature, { kind: 'Server' });

const args = (slot: string): InvokeArg[] => [
  { addr: 'tpl/t', value: 'Hello' },
  { addr: 'tpl/c', value: '5' },
  { addr: 'tpl/s', value: slot },
];

describe('a slot hole with no declared space (fuaran-core#229)', () => {
  it('the slot entry declares no space', () => {
    expect(signature.holes[2]?.space).toBeUndefined();
  });

  it('admits a well-formed tree of the constrained kind', () => {
    expect(validateArgs(cap, args('{"kind":"para","text":"hi"}'))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('refuses a tree of another kind as ArgOutOfSpace naming the slot tree space', () => {
    expect(validateArgs(cap, args('{"kind":"heading"}'))).toEqual({
      ok: false,
      error: {
        kind: 'ArgOutOfSpace',
        addr: 'tpl/s',
        space: { kind: 'SlotTree', slotKind: 'para' },
        got: '{"kind":"heading"}',
      },
    });
  });

  it.each([
    ['a string scalar', 'hi'],
    ['a number', '42'],
    ['an array', '[1,2]'],
    ['an object without a kind', '{"text":"no kind"}'],
    ['an object with a non-string kind', '{"kind":7}'],
    ['a malformed document', '{'],
  ])('refuses %s as UninvocableArg', (_, value) => {
    expect(validateArgs(cap, args(value))).toEqual({
      ok: false,
      error: { kind: 'UninvocableArg', addr: 'tpl/s' },
    });
  });

  it('with no constraint, takes a tree of any kind and still no scalar', () => {
    const any = createCapability(
      'any-cap',
      {
        name: 'any',
        holes: [{ addr: 's', name: 's', kind: 'slot', required: true }],
        effect: { hostEffect: 'Pure', determinism: 'Deterministic' },
      },
      { kind: 'Server' },
    );
    expect(validateArgs(any, [{ addr: 's', value: '{"kind":"anything"}' }]).ok).toBe(true);
    expect(validateArgs(any, [{ addr: 's', value: 'anything' }])).toEqual({
      ok: false,
      error: { kind: 'UninvocableArg', addr: 's' },
    });
  });
});
