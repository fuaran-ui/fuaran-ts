// ============================================================================
//  Phase 284 — Binding.Invoke / Action.Invoke resolve through a host capability
//  seam, mapped onto the existing StateBehaviour surface.
//
//  Parity with the F# reference renderer's `Binding.Invoke` resolver arm: the
//  host `CapabilityInvoker` resolves an invocation to a `Deferred`, and the
//  renderer maps `Pending` → `NotResolved` (the node's `onLoading` subtree),
//  `Ready` → `Resolved` (the value rendered), `Error` → `Errored` (its
//  `onError` subtree) — reusing the StateBehaviour states, no new node.
//
//  Runtime parity, NOT a wire fixture — the Invoke wire is already §11.1-green.
// ============================================================================

import type { Binding, CapabilityInvoker } from '@fuaran-ui/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  type CapabilitySignature,
  binding,
  createCapability,
  fuaran,
  makeCapabilityInvoker,
  node,
  registryOf,
} from '@fuaran-ui/ui';

import { emptySources, resolve } from '../src/bindings.js';
import { FuaranRenderer } from '../src/index.js';

// ─── The host capability + invoker ───────────────────────────────────────────

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

const registry = (() => {
  const r = registryOf([doubleCap]);
  if (!r.ok) throw new Error('registry build failed');
  return r.value;
})();

/** An invoker whose host body returns a fixed `Deferred` (validation still runs first). */
const invokerReturning = (value: number): CapabilityInvoker =>
  makeCapabilityInvoker(registry, () => ({ kind: 'Ready', value: value * 2 }));
const pendingInvoker: CapabilityInvoker = makeCapabilityInvoker(registry, () => ({
  kind: 'Pending',
}));
const erroringInvoker: CapabilityInvoker = makeCapabilityInvoker(registry, () => ({
  kind: 'Error',
  message: 'host body failed',
}));

// ─── resolve()-level mapping (Deferred → Resolution) ─────────────────────────

describe('resolve() maps the capability Deferred onto the binding Resolution', () => {
  const invokeBinding: Binding<number> = binding.invoke<number>('compute.double', [
    { addr: 'n', value: '21' },
  ]);

  it('Ready → Resolved (the realized value)', () => {
    expect(
      resolve({ ...emptySources, capabilityInvoker: invokerReturning(21) }, invokeBinding),
    ).toEqual({
      kind: 'Resolved',
      value: 42,
    });
  });

  it('Pending → NotResolved (the onLoading trigger)', () => {
    expect(resolve({ ...emptySources, capabilityInvoker: pendingInvoker }, invokeBinding)).toEqual({
      kind: 'NotResolved',
    });
  });

  it('Error → Errored (the onError trigger)', () => {
    expect(resolve({ ...emptySources, capabilityInvoker: erroringInvoker }, invokeBinding)).toEqual(
      {
        kind: 'Errored',
        message: 'host body failed',
      },
    );
  });

  it('an absent invoker behaves as Pending → NotResolved', () => {
    expect(resolve(emptySources, invokeBinding)).toEqual({ kind: 'NotResolved' });
  });

  it('an out-of-space arg is rejected by the seam before the body runs → Errored', () => {
    const badBinding: Binding<number> = binding.invoke<number>('compute.double', [
      { addr: 'n', value: '999' },
    ]);
    const r = resolve({ ...emptySources, capabilityInvoker: invokerReturning(1) }, badBinding);
    expect(r.kind).toBe('Errored');
    if (r.kind === 'Errored') expect(r.message).toContain('ArgOutOfSpace');
  });
});

// ─── Full render through StateBehaviour (Metric source = binding.invoke) ─────

// A Metric whose value resolves through the capability seam, with onLoading +
// onError subtrees carrying distinctive sentinels.
const metricTree = node.onError(
  (payload) => fuaran.heading({ id: 'err', text: `ERR:${payload.message}` }),
  node.onLoading(
    fuaran.heading({ id: 'load', text: 'LOADING-SENTINEL' }),
    fuaran.metric({
      id: 'm1',
      label: 'Doubled',
      value: binding.invoke<number>('compute.double', [{ addr: 'n', value: '21' }]),
    }),
  ),
);

const renderWith = (invoker?: CapabilityInvoker): string =>
  renderToStaticMarkup(
    <FuaranRenderer
      tree={metricTree}
      sources={invoker !== undefined ? { capabilityInvoker: invoker } : {}}
    />,
  );

describe('Binding.Invoke flows through StateBehaviour at render time', () => {
  it('Ready → the metric value is rendered (no loading/error subtree)', () => {
    const html = renderWith(invokerReturning(21));
    expect(html).toContain('fuaran-metric-value');
    expect(html).toContain('42');
    expect(html).not.toContain('LOADING-SENTINEL');
    expect(html).not.toContain('ERR:');
  });

  it('Pending → the onLoading subtree is rendered', () => {
    const html = renderWith(pendingInvoker);
    expect(html).toContain('LOADING-SENTINEL');
    expect(html).not.toContain('fuaran-metric-value');
  });

  it('Error → the onError subtree is rendered with the host message', () => {
    const html = renderWith(erroringInvoker);
    expect(html).toContain('ERR:host body failed');
    expect(html).not.toContain('fuaran-metric-value');
  });

  it('an absent invoker renders the onLoading subtree (Pending default)', () => {
    expect(renderWith()).toContain('LOADING-SENTINEL');
  });
});
