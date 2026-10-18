// ============================================================================
//  The capability semantics raised to Core 0.39.0 (Phase 2001): the determinism
//  factor set and its one label per set, an address bound once, the invariant
//  argument readers and the canonical spelling the replay key hashes, and the
//  admission gate. The shared law vectors cover the first; these pin the rest,
//  whose refusals the vectors do not draw.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { CapabilitySigEntry, DeterminismFactor, HoleValueSpace } from '@fuaran-ui/schema';

import {
  admissionOf,
  coversDeterminism,
  createCapability,
  determinismOf,
  determinismTag,
  emptyRegistry,
  invocationKey,
  joinDeterminism,
  MAX_REPEAT_COUNT,
  register,
  tryDeterminismOfTag,
  validateArgs,
} from '../src/capability.js';

const FACTORS: readonly DeterminismFactor[] = ['ClockFactor', 'RandomFactor', 'NetworkFactor'];

const LABELS = [
  'deterministic',
  'clock',
  'random',
  'clock+random',
  'network',
  'clock+network',
  'random+network',
  'clock+random+network',
];

const setOfMask = (mask: number) => determinismOf(...FACTORS.filter((_, i) => (mask >> i) & 1));

describe('the determinism factor set (Core 0.33.0)', () => {
  it('the label is a bijection with the eight sets', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const tag = determinismTag(setOfMask(mask));
      expect(tag).toBe(LABELS[mask]);
      expect([...(tryDeterminismOfTag(tag) ?? ['unread'])].sort()).toEqual(
        [...setOfMask(mask)].sort(),
      );
    }
  });

  it('a set has one spelling', () => {
    for (const tag of [
      'random+clock',
      'clock+clock',
      'deterministic+clock',
      '',
      'clock+',
      'Clock',
    ]) {
      expect(tryDeterminismOfTag(tag), tag).toBeUndefined();
    }
  });

  it('join is union and covers is superset', () => {
    expect(
      determinismTag(joinDeterminism(determinismOf('ClockFactor'), determinismOf('RandomFactor'))),
    ).toBe('clock+random');
    expect(coversDeterminism(determinismOf('NetworkFactor'), determinismOf('ClockFactor'))).toBe(
      false,
    );
    expect(
      coversDeterminism(
        determinismOf('ClockFactor', 'NetworkFactor'),
        determinismOf('ClockFactor'),
      ),
    ).toBe(true);
  });
});

const valueHole = (addr: string, space: HoleValueSpace): CapabilitySigEntry => ({
  addr,
  name: addr,
  kind: 'value',
  space,
  required: true,
});

const capOf = (...holes: CapabilitySigEntry[]) =>
  createCapability(
    'cap',
    {
      name: 'cap',
      holes,
      effect: { hostEffect: 'Pure', determinism: determinismOf('ClockFactor') },
    },
    { kind: 'Server' },
  );

const verdict = (r: ReturnType<typeof validateArgs>) => (r.ok ? 'accept' : r.error.kind);

describe('argument validation (Core 0.34.0, 0.35.1)', () => {
  const ints = capOf(valueHole('a', { kind: 'IntRange', min: -10, max: 10 }));
  const floats = capOf(valueHole('a', { kind: 'FloatRange', min: -10, max: 10 }));

  it('a repeated address is refused first, before any value is read', () => {
    const r = validateArgs(ints, [
      { addr: 'a', value: '1' },
      { addr: 'a', value: '99' },
    ]);
    expect(r).toEqual({ ok: false, error: { kind: 'DuplicateArg', addr: 'a' } });
  });

  it('integers are read by the invariant reader', () => {
    for (const v of ['5', '-5', '05', '-0'])
      expect(verdict(validateArgs(ints, [{ addr: 'a', value: v }])), v).toBe('accept');
    for (const v of [' 5', '5 ', '+5', '5.0', '', '-', '−5'])
      expect(verdict(validateArgs(ints, [{ addr: 'a', value: v }])), v).toBe('ArgOutOfSpace');
  });

  it('numbers are read by the invariant reader', () => {
    for (const v of ['1.5', '1.50', '-2', '1e0', '1E+0'])
      expect(verdict(validateArgs(floats, [{ addr: 'a', value: v }])), v).toBe('accept');
    for (const v of ['.5', '1.', ' 1', '+1', 'Infinity', 'NaN', '1e999'])
      expect(verdict(validateArgs(floats, [{ addr: 'a', value: v }])), v).toBe('ArgOutOfSpace');
  });

  it('one value has one replay key', () => {
    expect(invocationKey(ints, [{ addr: 'a', value: '05' }])).toBe(
      invocationKey(ints, [{ addr: 'a', value: '5' }]),
    );
    expect(invocationKey(floats, [{ addr: 'a', value: '1.50' }])).toBe(
      invocationKey(floats, [{ addr: 'a', value: '1.5' }]),
    );
    // Out of its space, a value keys by its own spelling.
    expect(invocationKey(ints, [{ addr: 'a', value: '011' }])).not.toBe(
      invocationKey(ints, [{ addr: 'a', value: '11' }]),
    );
  });
});

describe('the admission gate (Core 0.35.1)', () => {
  const repeat = (space: HoleValueSpace): CapabilitySigEntry => ({
    addr: 'r',
    name: 'r',
    kind: 'repeat',
    space,
    required: false,
  });
  const refusal = (...holes: CapabilitySigEntry[]) => {
    const r = register(capOf(...holes), emptyRegistry);
    return r.ok ? undefined : r.error;
  };

  it('a repeat over no count space is not total', () => {
    for (const space of [
      { kind: 'AnyString' },
      { kind: 'IntRange', min: 0, max: MAX_REPEAT_COUNT + 1 },
      { kind: 'IntRange', min: -1, max: 3 },
      { kind: 'FloatRange', min: 0, max: 3 },
    ] as const)
      expect(refusal(repeat(space)), JSON.stringify(space)).toEqual({
        kind: 'NonTotalCapability',
        id: 'cap',
        addrs: ['r'],
      });
    expect(refusal(repeat({ kind: 'IntRange', min: 0, max: 5 }))).toBeUndefined();
  });

  it('an ill-formed signature names its first fault', () => {
    expect(refusal(valueHole('a', { kind: 'IntRange', min: 3, max: 2 }))).toEqual({
      kind: 'IllFormedCapability',
      id: 'cap',
      fault: { kind: 'EmptySpace', addr: 'a', space: { kind: 'IntRange', min: 3, max: 2 } },
    });
    expect(refusal(valueHole('a', { kind: 'Enum', choices: [] }))?.kind).toBe(
      'IllFormedCapability',
    );
    expect(refusal(valueHole('a', { kind: 'FloatRange', min: 0, max: Infinity }))).toEqual({
      kind: 'IllFormedCapability',
      id: 'cap',
      fault: { kind: 'NonFiniteBound', addr: 'a' },
    });
    expect(
      admissionOf('cap', {
        name: 'cap',
        holes: [valueHole('a', { kind: 'AnyString' }), valueHole('a', { kind: 'AnyString' })],
        effect: { hostEffect: 'Pure', determinism: determinismOf() },
      }),
    ).toEqual({
      kind: 'IllFormedCapability',
      id: 'cap',
      fault: { kind: 'DuplicateHoleAddr', addr: 'a' },
    });
  });
});
