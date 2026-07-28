// ============================================================================
//  window.__fuaran in-page introspection REPL — the pure builder + register
//  surface (Phase 90 TS half). The browser cross-host acceptance (the global
//  live under a running app) is verified separately in a browser session; this
//  pins the host-agnostic logic: payload shapes, slot resolution, geometry
//  read, error envelopes, and the window register/unregister lifecycle.
// ============================================================================

import type { Node } from '@fuaran-ui/schema';
import { fuaran, binding } from '@fuaran-ui/ui';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEBUG_GLOBAL_KEY,
  buildDebugGlobal,
  registerDebugGlobal,
  type DebugError,
} from '../src/index.js';

const tree = fuaran.stack<unknown>({
  id: 'root',
  children: [
    fuaran.heading<unknown>({ id: 'title', text: 'Hello', level: 2 }),
    fuaran.metric<unknown>({ id: 'rev', label: 'Revenue', value: 42 }),
    fuaran.metric<unknown>({ id: 'live', label: 'Live', value: binding.state('liveValue', 0) }),
  ],
});

const isError = (x: unknown): x is DebugError =>
  typeof x === 'object' && x !== null && 'error' in x;

describe('buildDebugGlobal — typed-layer introspection', () => {
  const dbg = buildDebugGlobal(tree, { state: { liveValue: 99 } });

  it('getNodeState returns the typed snapshot (kind + binding slots + child ids)', () => {
    const state = dbg.getNodeState('rev');
    expect(isError(state)).toBe(false);
    if (isError(state)) return;
    expect(state.id).toBe('rev');
    expect(state.kind).toBe('Metric');
    expect(state.bindings.map((b) => b.slot)).toContain('Value');
  });

  it('getNodeState on a missing id returns a structured error, not a throw', () => {
    const state = dbg.getNodeState('nope');
    expect(isError(state)).toBe(true);
    if (isError(state)) expect(state.error).toMatch(/not found/);
  });

  it('getBindingValue resolves a static slot value', () => {
    const r = dbg.getBindingValue('rev', 'Value');
    expect(r).toEqual({ kind: 'Resolved', value: 42 });
  });

  it('getBindingValue resolves a State slot against live sources', () => {
    const r = dbg.getBindingValue('live', 'Value');
    expect(r).toEqual({ kind: 'Resolved', value: 99 });
  });

  it('getBindingValue on a non-binding slot returns a structured error', () => {
    const r = dbg.getBindingValue('rev', 'Nope');
    expect(isError(r)).toBe(true);
    if (isError(r)) expect(r.error).toMatch(/not a binding slot/);
  });

  it('inspectTree returns the recursive structure', () => {
    const t = dbg.inspectTree();
    expect(t.id).toBe('root');
    // Phase 390 — the stack container reports as the unified 'Box' kind.
    expect(t.kind).toBe('Box');
    expect(t.children.map((c) => c.id)).toEqual(['title', 'rev', 'live']);
  });

  it('findNodes filters by kind discriminator', () => {
    expect(dbg.findNodes('Metric')).toEqual(['rev', 'live']);
    expect(dbg.findNodes('Heading')).toEqual(['title']);
    expect(dbg.findNodes('Nonexistent')).toEqual([]);
  });

  it('help returns the method reference text', () => {
    expect(dbg.help()).toMatch(/__fuaran/);
    expect(dbg.help()).toMatch(/getNodeState/);
  });

  it('version is exposed', () => {
    expect(typeof dbg.version).toBe('string');
  });
});

describe('getRenderedDom — live DOM geometry', () => {
  const dbg = buildDebugGlobal(tree, {});

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns an error when no element is rendered for the id', () => {
    const g = dbg.getRenderedDom('rev');
    expect(isError(g)).toBe(true);
  });

  it('reads geometry from the rendered [data-fuaran-node-id] element', () => {
    const el = document.createElement('div');
    el.setAttribute('data-fuaran-node-id', 'rev');
    document.body.appendChild(el);
    const g = dbg.getRenderedDom('rev');
    expect(isError(g)).toBe(false);
    if (isError(g)) return;
    expect(typeof g.width).toBe('number');
    expect(typeof g.overflowing).toBe('boolean');
    expect(typeof g.hidden).toBe('boolean');
  });
});

describe('registerDebugGlobal — window lifecycle', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[DEBUG_GLOBAL_KEY];
  });

  it('registers under window.__fuaran and the unregister removes it', () => {
    const g = buildDebugGlobal(tree, {});
    const unregister = registerDebugGlobal(g);
    expect((window as unknown as Record<string, unknown>)[DEBUG_GLOBAL_KEY]).toBe(g);
    unregister();
    expect((window as unknown as Record<string, unknown>)[DEBUG_GLOBAL_KEY]).toBeUndefined();
  });

  it('unregister only removes the global if it still points at this instance', () => {
    const g1 = buildDebugGlobal(tree, {});
    const unregister1 = registerDebugGlobal(g1);
    const g2 = buildDebugGlobal(tree, {});
    registerDebugGlobal(g2);
    unregister1(); // g2 is now installed; g1's cleanup must not clobber it
    expect((window as unknown as Record<string, unknown>)[DEBUG_GLOBAL_KEY]).toBe(g2);
  });
});

describe('apply — policy-gated TreeOp mutation (Phase 190)', () => {
  // Canonical-JSON UpdateProp op retargeted at the test tree's 'rev' metric.
  // A Metric's Label is a TextSource, whose canonical Literal wire shape is the
  // discriminated object `{"$type":"Literal","text":...}` (not a bare string).
  const updateLabelOp =
    '{"$type":"UpdateProp","path":"Label","target":"rev","value":{"$type":"Literal","text":"Updated revenue"}}';

  it('unwired host (no applyHandler) returns the unwired envelope', () => {
    const r = buildDebugGlobal(tree, {}).apply(updateLabelOp);
    expect(r).toEqual({
      ok: false,
      status: 'unwired',
      error: expect.stringContaining('not wired'),
    });
  });

  it('permits + applies when the gate allows, handing the new tree to applyHandler', () => {
    let applied: Node<unknown> | undefined;
    const dbg = buildDebugGlobal(tree, {}, { applyHandler: (t) => (applied = t) });
    const r = dbg.apply(updateLabelOp);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('applied');
    // The applied envelope also names the revision the edit produced, so a
    // caller can tell a cached read has gone stale (Phase 735).
    expect(r.ok && typeof r.treeRevision).toBe('string');
    expect(applied).toBeDefined();
    // The mutation took effect: the new tree carries the updated label.
    expect(JSON.stringify(applied)).toContain('Updated revenue');
  });

  it('denies via the gate (FGP 3) — deny envelope, applyHandler NOT called, warn routed', () => {
    let called = false;
    const warnings: string[] = [];
    const dbg = buildDebugGlobal(
      tree,
      {},
      {
        applyHandler: () => {
          called = true;
        },
        runtime: { canDispatch: () => false, warn: (m) => warnings.push(m) },
      },
    );
    const r = dbg.apply(updateLabelOp);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('denied');
    if (r.status === 'denied') expect(r.denied).toBe(true);
    expect(called).toBe(false);
    expect(warnings.some((w) => w.includes('denied by policy gate'))).toBe(true);
  });

  it('gate is consulted BEFORE decode — a denying gate short-circuits malformed JSON', () => {
    let called = false;
    const dbg = buildDebugGlobal(
      tree,
      {},
      {
        applyHandler: () => {
          called = true;
        },
        runtime: { canDispatch: () => false },
      },
    );
    const r = dbg.apply('{ not valid json');
    expect(r.status).toBe('denied'); // decodeFailed would mean decode ran first
    expect(called).toBe(false);
  });

  it('decodeFailed envelope on malformed op JSON', () => {
    const r = buildDebugGlobal(tree, {}, { applyHandler: () => {} }).apply('{ not valid json');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('decodeFailed');
  });

  it('rejected envelope when the op targets a missing node (applyHandler NOT called)', () => {
    let called = false;
    const dbg = buildDebugGlobal(
      tree,
      {},
      {
        applyHandler: () => {
          called = true;
        },
      },
    );
    const r = dbg.apply('{"$type":"UpdateProp","path":"Label","target":"ghost","value":"x"}');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('rejected');
    expect(called).toBe(false);
  });

  it('absent gate allows (parity with every other dispatch path)', () => {
    const r = buildDebugGlobal(tree, {}, { applyHandler: () => {} }).apply(updateLabelOp);
    expect(r.status).toBe('applied');
  });

  it('help() advertises apply, and the affordances layered on it', () => {
    const help = buildDebugGlobal(tree, {}).help();
    expect(help).toMatch(/apply\(op\)/);
    expect(help).toMatch(/subscribe\(cb\)/);
    expect(help).toMatch(/treeRevision\(\)/);
  });
});
