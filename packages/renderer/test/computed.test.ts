// ============================================================================
//  Phase 137 — Binding.Computed reads live state via BindingContext.
//
//  Parity with the F# reference renderer's BindingResolver tests: a Computed
//  closure projects a `Binding.State` slot into a derived value, reading it
//  through the `ctx.tryGetState` accessor the resolver populates from the live
//  `state` bag.
// ============================================================================

import type { Binding } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { emptySources, makeBindingContext, resolve } from '../src/bindings.js';

describe('Binding.Computed reads live state (Phase 137)', () => {
  const busyLabel: Binding<string> = {
    kind: 'Computed',
    compute: (ctx) => (ctx.tryGetState<boolean>('busy') === true ? 'Working…' : 'Ready'),
  };

  it('reads a state slot through ctx.tryGetState (busy = true)', () => {
    expect(resolve({ ...emptySources, state: { busy: true } }, busyLabel)).toEqual({
      kind: 'Resolved',
      value: 'Working…',
    });
  });

  it('takes the default branch when the key is absent (undefined, no throw)', () => {
    expect(resolve(emptySources, busyLabel)).toEqual({ kind: 'Resolved', value: 'Ready' });
  });

  it('projects the live state bag into the context the closure receives', () => {
    const countLabel: Binding<string> = {
      kind: 'Computed',
      compute: (ctx) => {
        const n = ctx.tryGetState<number>('count');
        return n === undefined ? 'count=?' : `count=${n}`;
      },
    };
    expect(resolve({ ...emptySources, state: { count: 7 } }, countLabel)).toEqual({
      kind: 'Resolved',
      value: 'count=7',
    });
  });
});

describe('makeBindingContext', () => {
  it('returns undefined for a missing key and the stored value otherwise', () => {
    const ctx = makeBindingContext({ busy: true });
    expect(ctx.tryGetState<boolean>('busy')).toBe(true);
    expect(ctx.tryGetState<boolean>('missing')).toBeUndefined();
  });
});
