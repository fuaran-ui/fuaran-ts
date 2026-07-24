// ============================================================================
//  Phase 284 — the Compute-layer capability runtime (TS parity with the F#
//  `Fuaran.Core.Function` capability surface + `Fuaran.UI.AiTools.Capabilities`).
//
//  Mirrors the intent of the F# `capabilityLaws` conformance: default-deny
//  arg-validation that names every refusal, byte-identical `invocationKey`
//  replay keying (FNV-1a), and stable id-ordered enumeration / discovery.
//  Runtime parity certified in-repo — NOT a wire-corpus fixture.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { Deferred, InvokeArg } from '../src/index.js';
import {
  type CapabilitySignature,
  createCapability,
  discover,
  emptyRegistry,
  enumerate,
  fnv1a,
  invocationKey,
  makeCapabilityInvoker,
  register,
  registryOf,
  validate,
  validateArgs,
} from '../src/index.js';

// A single-value-hole capability: `n` ∈ IntRange[0,100], required, ReadsHost/Random
// (non-deterministic — the invocationKey-keyed replay axis).
const doubleSig: CapabilitySignature = {
  name: 'double',
  holes: [
    {
      addr: 'n',
      name: 'n',
      kind: 'value',
      space: { kind: 'IntRange', min: 0, max: 100 },
      required: true,
    },
  ],
  effect: { hostEffect: 'ReadsHost', determinism: 'Random' },
};
const doubleCap = createCapability('compute.double', doubleSig, {
  kind: 'ClientIsland',
  island: 'js',
});

// A capability with a slot hole — its arg is not scalar-invocable (UninvocableArg).
const slotSig: CapabilitySignature = {
  name: 'wrap',
  holes: [{ addr: 'body', name: 'body', kind: 'slot', slotKind: 'Layout', required: true }],
  effect: { hostEffect: 'Pure', determinism: 'Deterministic' },
};
const slotCap = createCapability('compute.wrap', slotSig, { kind: 'Server' });

const reg = (() => {
  const r = registryOf([doubleCap, slotCap]);
  if (!r.ok) throw new Error('registry build failed');
  return r.value;
})();

describe('validateArgs — default-deny by shape, every refusal named', () => {
  it('accepts an in-space required arg', () => {
    expect(validateArgs(doubleCap, [{ addr: 'n', value: '42' }])).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it('rejects an out-of-space arg as ArgOutOfSpace', () => {
    const r = validateArgs(doubleCap, [{ addr: 'n', value: '101' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('ArgOutOfSpace');
  });

  it('rejects a non-integer for an IntRange hole', () => {
    const r = validateArgs(doubleCap, [{ addr: 'n', value: '4.5' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('ArgOutOfSpace');
  });

  it('rejects an arg that addresses no declared hole as UnknownArg', () => {
    const r = validateArgs(doubleCap, [{ addr: 'nope', value: '1' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('UnknownArg');
      if (r.error.kind === 'UnknownArg') expect(r.error.declared).toEqual(['n']);
    }
  });

  it('rejects an unbound required hole as RequiredArgsUnbound', () => {
    const r = validateArgs(doubleCap, []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('RequiredArgsUnbound');
      if (r.error.kind === 'RequiredArgsUnbound') expect(r.error.addrs).toEqual(['n']);
    }
  });

  it('rejects a scalar arg against a slot hole as UninvocableArg', () => {
    const r = validateArgs(slotCap, [{ addr: 'body', value: 'x' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('UninvocableArg');
  });
});

describe('validate — registry-level, default-deny on the id', () => {
  it('resolves a registered id with valid args to the capability', () => {
    const r = validate(reg, 'compute.double', [{ addr: 'n', value: '7' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe('compute.double');
  });

  it('rejects an unregistered id as NoSuchCapability, naming the known ids', () => {
    const r = validate(reg, 'compute.missing', []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('NoSuchCapability');
      // enumerated alternatives, id-sorted.
      if (r.error.kind === 'NoSuchCapability')
        expect(r.error.known).toEqual(['compute.double', 'compute.wrap']);
    }
  });
});

describe('register — additive, no silent overwrite', () => {
  it('a duplicate id is a named DuplicateCapability', () => {
    const r = register(doubleCap, reg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('DuplicateCapability');
  });

  it('the empty registry enumerates to nothing', () => {
    expect(enumerate(emptyRegistry)).toEqual([]);
  });
});

describe('enumerate / discover — stable id order', () => {
  it('enumerate sorts by id regardless of insertion order', () => {
    const r = registryOf([slotCap, doubleCap]); // inserted wrap-first
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(enumerate(r.value).map((c) => c.id)).toEqual(['compute.double', 'compute.wrap']);
  });

  it('discover enumerates id-sorted, each with its signature JSON-Schema', () => {
    const d = discover(reg);
    expect(d.map(([id]) => id)).toEqual(['compute.double', 'compute.wrap']);
    const [, doubleSchema] = d[0]!;
    expect(doubleSchema['type']).toBe('object');
    expect(doubleSchema['title']).toBe('double');
    expect(doubleSchema['required']).toEqual(['n']);
    // value hole projects its space as standard JSON-Schema keywords.
    const props = doubleSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['n']).toEqual({ type: 'integer', minimum: 0, maximum: 100 });
    // two-axis effect travels alongside, OUTSIDE the parameter properties.
    expect(doubleSchema['x-effect']).toEqual({ host: 'readsHost', determinism: 'random' });
    // a slot hole projects an object carrying its kind-constraint.
    const [, wrapSchema] = d[1]!;
    const wrapProps = wrapSchema['properties'] as Record<string, Record<string, unknown>>;
    expect(wrapProps['body']).toEqual({ type: 'object', description: 'slot of kind: Layout' });
  });
});

describe('invocationKey — FNV-1a replay keying, byte-identical to the F# arithmetic', () => {
  it('fnv1a matches the canonical 32-bit FNV-1a test vectors', () => {
    // The standard FNV-1a-32 vectors — the same arithmetic the F# `fnv1a` emits.
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });

  it('keys on the id + a hash of the addr-sorted "addr=value" arg string', () => {
    expect(invocationKey(doubleCap, [])).toBe(`compute.double#${fnv1a('')}`);
    expect(invocationKey(doubleCap, [{ addr: 'n', value: '7' }])).toBe(
      `compute.double#${fnv1a('n=7')}`,
    );
  });

  it('is stable under arg reordering and distinct for distinct args', () => {
    const a: InvokeArg[] = [
      { addr: 'b', value: '2' },
      { addr: 'a', value: '1' },
    ];
    const b: InvokeArg[] = [
      { addr: 'a', value: '1' },
      { addr: 'b', value: '2' },
    ];
    // a multi-arg capability to key against.
    const multiSig: CapabilitySignature = {
      name: 'm',
      holes: [
        { addr: 'a', name: 'a', kind: 'value', space: { kind: 'AnyString' }, required: true },
        { addr: 'b', name: 'b', kind: 'value', space: { kind: 'AnyString' }, required: true },
      ],
      effect: { hostEffect: 'Pure', determinism: 'Deterministic' },
    };
    const multi = createCapability('m', multiSig, { kind: 'ClientDeclarative' });
    expect(invocationKey(multi, a)).toBe(invocationKey(multi, b));
    expect(invocationKey(multi, a)).not.toBe(
      invocationKey(multi, [
        { addr: 'a', value: '9' },
        { addr: 'b', value: '2' },
      ]),
    );
  });
});

describe('makeCapabilityInvoker — validate → host body → Deferred', () => {
  const body = (): Deferred<unknown> => ({ kind: 'Ready', value: 84 });
  const invoker = makeCapabilityInvoker(reg, body);

  it('runs the host body for a valid invocation', () => {
    expect(invoker('compute.double', [{ addr: 'n', value: '42' }])).toEqual({
      kind: 'Ready',
      value: 84,
    });
  });

  it('a rejected invocation short-circuits to a named Deferred.Error (body never runs)', () => {
    const d = invoker('compute.double', [{ addr: 'n', value: '999' }]);
    expect(d.kind).toBe('Error');
    if (d.kind === 'Error') expect(d.message).toContain('ArgOutOfSpace');
  });

  it('an unknown id is a Deferred.Error naming NoSuchCapability', () => {
    const d = invoker('compute.missing', []);
    expect(d.kind).toBe('Error');
    if (d.kind === 'Error') expect(d.message).toContain('NoSuchCapability');
  });

  it('a genuinely-async body surfaces Pending', () => {
    const pendingInvoker = makeCapabilityInvoker(
      reg,
      (): Deferred<unknown> => ({ kind: 'Pending' }),
    );
    expect(pendingInvoker('compute.double', [{ addr: 'n', value: '1' }])).toEqual({
      kind: 'Pending',
    });
  });
});
