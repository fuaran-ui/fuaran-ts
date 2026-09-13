// ============================================================================
//  WIRE_FORMAT.md §24.8 — a bare `State` at an unwritten slot is UNRESOLVED
//  (Phase 1690).
//
//  §24.1 says a `Binding.State` carrying a `defaultValue` resolves to it until
//  the slot is first written. §24.8 says what one carrying NONE resolves to,
//  which the specification left open and which five hosts had answered four
//  different ways. THIS tier's answer was the worst of them: the `State` arm
//  returned `{ kind: 'Resolved', value: binding.defaultValue }` unconditionally,
//  and for a bare `State` that value is `undefined` — a RESOLVED nothing. At a
//  text slot the runtime then wrote the literal string `undefined` into the
//  markup, and at a numeric slot it read as a value rather than as absence.
//
//  Both tiers move together or SSR and hydration disagree, so the client
//  renderer is asserted here beside the server one rather than in its own file:
//  the claim is about the two agreeing, and a claim split across two suites can
//  half-hold.
//
//  No corpus vector reaches this tier — the render-text family that pins §24.8
//  has readers on the reference host, `fuaran-py` and `fuaran-go`, and neither
//  `@fuaran-ui` renderer has one — so the pin lives here.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { resolve as resolveClient } from '@fuaran-ui/renderer';

import { renderToHtml, resolve as resolveServer } from '../src/index.js';

/** A `Metric` whose value is a bare `State` — no declared default. */
const BARE = JSON.stringify({
  id: 'm',
  kind: { $type: 'Metric', label: 'Revenue', value: { $type: 'State', key: 'revenue' } },
});

/** The same `Metric` with a default the DOCUMENT declared. */
const DECLARED = JSON.stringify({
  id: 'm',
  kind: {
    $type: 'Metric',
    label: 'Revenue',
    value: { $type: 'State', defaultValue: 7, key: 'revenue' },
  },
});

const stateBinding = (doc: string): unknown => {
  const decoded = decodeNode(doc);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return (decoded.value.kind as unknown as { display: { spec: { value: unknown } } }).display.spec
    .value;
};

const html = (doc: string, state?: Readonly<Record<string, unknown>>): string => {
  const decoded = decodeNode(doc);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return renderToHtml(decoded.value, { sources: state === undefined ? {} : { state } });
};

describe('§24.8 — a bare State at an unwritten slot', () => {
  it('resolves to NOTHING on both tiers, never a value', () => {
    const binding = stateBinding(BARE) as never;
    expect(resolveServer({}, binding)).toEqual({ kind: 'NotResolved' });
    expect(resolveClient({}, binding)).toEqual({ kind: 'NotResolved' });
  });

  it('never puts the literal string `undefined` in the markup', () => {
    const markup = html(BARE);
    expect(markup).not.toContain('undefined');
    expect(markup).toContain('fuaran-metric-value');
  });

  it('still resolves a value the host WROTE — the ruling widened nothing', () => {
    const binding = stateBinding(BARE) as never;
    expect(resolveServer({ state: { revenue: 42 } }, binding)).toEqual({
      kind: 'Resolved',
      value: 42,
    });
    expect(resolveClient({ state: { revenue: 42 } }, binding)).toEqual({
      kind: 'Resolved',
      value: 42,
    });
    expect(html(BARE, { revenue: 42 })).toContain('42');
  });

  it('still resolves a default the DOCUMENT declared — §24.1 is untouched', () => {
    // The half this ruling is the other side of. An arm keyed on the presence of
    // `defaultValue` alone rather than on `defaultDeclared` passes every leg
    // above and fails here at a slot whose typed placeholder equals the
    // declaration: the decoder fills `defaultValue` in either way (Phase 1656),
    // which is why the two members exist.
    const binding = stateBinding(DECLARED) as never;
    expect(resolveServer({}, binding)).toEqual({ kind: 'Resolved', value: 7 });
    expect(resolveClient({}, binding)).toEqual({ kind: 'Resolved', value: 7 });
    expect(resolveServer({ state: { revenue: 42 } }, binding)).toEqual({
      kind: 'Resolved',
      value: 42,
    });
  });
});
