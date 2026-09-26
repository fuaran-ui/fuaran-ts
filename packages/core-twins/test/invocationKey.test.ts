// ============================================================================
//  The capability invocation key's canonical pre-image (Phase 1860, the
//  cross-host half of fuaran-core#225).
//
//  The key used to hash the addr-sorted `addr=value` pairs joined with no
//  separator, so the accepted argument sets [a="1b=2"] and [a="1"; b="2"]
//  shared one pre-image and one key. The reference now builds the pre-image as
//  a canonical field sequence — two fields per binding (addr, value), each
//  field escaped and terminated — which is injective over argument sets. Every
//  expected key below is the reference's own value for the same input, and the
//  other two hosts pin the same literals.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { Capability, InvokeArg } from '@fuaran-ui/schema';

import { canonicalFields, invocationKey } from '../src/capability.js';

const cap = (id: string): Capability => ({
  id,
  signature: { name: id, holes: [], effect: { hostEffect: 'Pure', determinism: 'Random' } },
  determinism: 'Random',
  placement: { kind: 'Server' },
});

const keyOf = (id: string, ...args: [string, string][]): string =>
  invocationKey(
    cap(id),
    args.map(([addr, value]): InvokeArg => ({ addr, value })),
  );

describe('invocationKey — the canonical pre-image, byte-identical to the reference', () => {
  it('keys the formerly colliding pair apart', () => {
    const one = keyOf('cap', ['a', '1b=2']);
    const two = keyOf('cap', ['a', '1'], ['b', '2']);
    expect(one).not.toBe(two);
    expect(one).toBe('cap#4ad0d41a');
    expect(two).toBe('cap#53c281a5');
  });

  it.each([
    // The published capability-laws vector capability-0-invocation-key.
    ['published vector', 'cap-0', [['h0', '13']], 'cap-0#70fcefc7'],
    // No arguments: the empty pre-image, so the key is the FNV-1a offset basis.
    ['no args', 'cap', [], 'cap#811c9dc5'],
    // A value carrying the terminator, and one carrying the escape: both are
    // escaped, so neither can end its field early.
    [
      'escaped value',
      'cap',
      [
        ['a', 'x\u0001y'],
        ['b', '\u0010'],
      ],
      'cap#3d801624',
    ],
    // The same characters moved into an address.
    [
      'escaped addr',
      'cap',
      [
        ['a', 'x'],
        ['\u0001y', '\u0010'],
      ],
      'cap#46a6fdda',
    ],
    // Addresses sort by UTF-16 code unit, as the reference compares strings.
    [
      'utf-16 order',
      'cap',
      [
        ['', '1'],
        ['\u{1F600}', '2'],
      ],
      'cap#e3651ae3',
    ],
    // A repeated address keeps its argument order (a stable sort).
    [
      'stable repeat',
      'cap',
      [
        ['a', '2'],
        ['a', '1'],
      ],
      'cap#1d4e4ee6',
    ],
    [
      'stable repeat, swapped',
      'cap',
      [
        ['a', '1'],
        ['a', '2'],
      ],
      'cap#c79fd87e',
    ],
  ] as [string, string, [string, string][], string][])('%s', (_name, id, args, want) => {
    expect(keyOf(id, ...args)).toBe(want);
  });

  it('is stable under argument reordering', () => {
    expect(keyOf('cap', ['b', '2'], ['a', '1'])).toBe(keyOf('cap', ['a', '1'], ['b', '2']));
  });

  it('escapes the escape before the terminator, and terminates every field', () => {
    expect(canonicalFields([])).toBe('');
    expect(canonicalFields(['a', ''])).toBe('a\u0001\u0001');
    expect(canonicalFields(['\u0010\u0001'])).toBe('\u0010\u0010\u0010\u0001\u0001');
  });
});
