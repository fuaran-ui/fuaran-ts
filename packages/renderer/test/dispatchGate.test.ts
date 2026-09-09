// ============================================================================
//  @fuaran-ui/renderer — canDispatch default-deny dispatch gate (Phase 159).
//
//  The TS mirror of the F# Phase 119 `IFuaranRuntime.CanDispatch` /
//  `applyDispatchGate` seam. `runAction` consults the optional `canDispatch`
//  gate BEFORE the gated effects (Call / Navigate / AiTool / ReadFileBody)
//  fire: an ABSENT gate allows (existing hosts unchanged); a gate returning
//  `false` denies — a diagnostic via `warn`, no effect.
//
//  Phase 1652 widened the gated set to match the reference client's: `Notify`,
//  `SetState`, `WriteToClipboard`, `CommitLocal` and `Print` join it, so one
//  `canDispatch` policy means the same thing on both tiers. `Dispatch` and
//  `Chain` remain ungated, because neither is an effect.
//
//  This is the safety foundation for interactive in-browser-decode hydration:
//  a server-emitted tree, decoded + hydrated client-side, must not fire
//  Navigate / AiTool / Call unless the host's gate approves them.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

import { type Action, apiEndpoint } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/bindings.js';
import { runAction, type RenderContext } from '../src/context.js';
import { denyNonLocalEgress } from '../src/egress.js';
import {
  type ActionDescriptor,
  describeActionDescriptor,
  type FuaranRuntime,
} from '../src/index.js';

const mkCtx = (
  runtime: FuaranRuntime,
  dispatch: (m: string) => void = () => {},
): RenderContext<string> => ({
  sources: { state: {} } as BindingSources,
  runtime,
  dispatch,
  fragments: new Map(),
  expandingFragments: new Set(),
  inErrorBoundary: false,
  // Phase 1037 — the honest default. Every `Navigate` route in this file is
  // same-origin, which `denyNonLocalEgress` permits (`allowLocal: true`), so
  // the egress check is transparent here and the dispatch gate is what these
  // assertions measure. Egress-specific navigation refusal is pinned in
  // `egressAmbient.test.tsx`.
  egressPolicy: denyNonLocalEgress,
});

const navigate: Action<string> = {
  kind: 'Navigate',
  route: { kind: 'Literal', value: '/admin' },
  target: 'Self',
};
const aiTool: Action<string> = { kind: 'AiTool', toolName: 'delete_account', args: null };
const call: Action<string> = {
  kind: 'Call',
  endpoint: apiEndpoint('/api/charge'),
  onResult: () => 'done',
};
const readFile: Action<string> = {
  kind: 'ReadFileBody',
  file: { id: 'f1' },
  encoding: 'Text',
  onRead: () => 'read',
};
const setState_: Action<string> = { kind: 'SetState', key: 'showDetails', value: true };

describe('canDispatch dispatch gate (Phase 159)', () => {
  it('an ABSENT gate allows the gated effects (existing hosts unchanged)', () => {
    const navSpy = vi.fn();
    const toolSpy = vi.fn();
    const callSpy = vi.fn();
    const ctx = mkCtx({ navigate: navSpy, invokeAiTool: toolSpy, call: callSpy });

    runAction(ctx, navigate);
    runAction(ctx, aiTool);
    runAction(ctx, call);

    expect(navSpy).toHaveBeenCalledWith('/admin');
    expect(toolSpy).toHaveBeenCalledWith('delete_account', null);
    expect(callSpy).toHaveBeenCalledOnce();
  });

  it('a gate returning false DENIES the effect and warns', () => {
    const navSpy = vi.fn();
    const warnSpy = vi.fn();
    const ctx = mkCtx({ navigate: navSpy, canDispatch: () => false, warn: warnSpy });

    runAction(ctx, navigate);

    expect(navSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/denied by policy gate/i);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Navigate(/admin)');
  });

  it('a gate returning true ALLOWS the effect', () => {
    const navSpy = vi.fn();
    const ctx = mkCtx({ navigate: navSpy, canDispatch: () => true });

    runAction(ctx, navigate);

    expect(navSpy).toHaveBeenCalledWith('/admin');
  });

  it('consults the gate with the correct descriptor per gated action', () => {
    const seen: ActionDescriptor[] = [];
    const ctx = mkCtx({
      navigate: () => {},
      invokeAiTool: () => {},
      call: () => {},
      readFileBody: () => {},
      canDispatch: (d) => {
        seen.push(d);
        return true;
      },
    });

    runAction(ctx, navigate);
    runAction(ctx, aiTool);
    runAction(ctx, call);
    runAction(ctx, readFile);

    expect(seen).toEqual([
      { kind: 'Navigate', route: '/admin' },
      { kind: 'AiTool', toolName: 'delete_account' },
      { kind: 'Call', endpoint: '/api/charge' },
      { kind: 'ReadFileBody', fileId: 'f1' },
    ]);
  });

  it('a denied ReadFileBody runs neither the runtime port nor the FileReader fallback', () => {
    const readSpy = vi.fn();
    const ctx = mkCtx({ readFileBody: readSpy, canDispatch: () => false, warn: () => {} });

    runAction(ctx, readFile);

    expect(readSpy).not.toHaveBeenCalled();
  });

  it('Dispatch and Chain are NOT gated — neither is an effect', () => {
    // A dispatch hands a message to the host's own update loop, and a chain
    // performs its members, each of which meets its own descriptor. Gating
    // either would refuse the host's own message plumbing.
    const seen: string[] = [];
    const ctx = mkCtx({ canDispatch: () => false }, (m) => seen.push(m));

    runAction(ctx, { kind: 'Dispatch', msg: 'one' });
    runAction(ctx, {
      kind: 'Chain',
      actions: [
        { kind: 'Dispatch', msg: 'two' },
        { kind: 'Dispatch', msg: 'three' },
      ],
    });

    expect(seen).toEqual(['one', 'two', 'three']);
  });

  it('describeActionDescriptor renders each gated case for diagnostics', () => {
    expect(describeActionDescriptor({ kind: 'Call', endpoint: '/x' })).toBe('Call(/x)');
    expect(describeActionDescriptor({ kind: 'Navigate', route: '/y' })).toBe('Navigate(/y)');
    expect(describeActionDescriptor({ kind: 'AiTool', toolName: 't' })).toBe('AiTool(t)');
    expect(describeActionDescriptor({ kind: 'ReadFileBody', fileId: 'f' })).toBe('ReadFileBody(f)');
    expect(describeActionDescriptor({ kind: 'Notify', channel: 'c' })).toBe('Notify(c)');
    expect(describeActionDescriptor({ kind: 'SetState', key: 'k' })).toBe('SetState(k)');
    expect(describeActionDescriptor({ kind: 'CommitLocal', nodeId: 'n' })).toBe('CommitLocal(n)');
    // Payload-free in the type and payload-free in the label, for the same
    // reason: this string can reach a durable denial record.
    expect(describeActionDescriptor({ kind: 'WriteToClipboard' })).toBe('WriteToClipboard');
    expect(describeActionDescriptor({ kind: 'Print' })).toBe('Print');
  });
});

// ─── Phase 1652 — the five that were gated in F# and ungated here ────────────
//
// A host wires ONE `canDispatch` policy and expects it to mean one thing. It did
// not: `Notify`, `SetState`, `WriteToClipboard`, `CommitLocal` and `Print` were
// gated on the F# client and ungated on this one, so the same policy gave a
// weaker default-deny in TypeScript. Each case below is one of those five
// refusing, and the point of each is the EFFECT not happening — a gate that is
// consulted and then proceeds is worse than no gate, because it reads as one.
describe('canDispatch — the reference gated set (Phase 1652)', () => {
  const denyAll = (): boolean => false;

  it('a denied Notify never reaches runtime.notify', () => {
    const notify = vi.fn();
    runAction(mkCtx({ notify, canDispatch: denyAll }), {
      kind: 'Notify',
      channel: 'billing',
      payload: null,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('a denied SetState never writes', () => {
    const setState = vi.fn();
    runAction(mkCtx({ setState, canDispatch: denyAll }), setState_);
    expect(setState).not.toHaveBeenCalled();
  });

  it('an ALLOWED SetState still writes — the gate is a gate, not a wall', () => {
    const setState = vi.fn();
    runAction(mkCtx({ setState, canDispatch: () => true }), setState_);
    expect(setState).toHaveBeenCalledWith('showDetails', true);
  });

  it('a denied WriteToClipboard never reaches the runtime port', () => {
    const writeToClipboard = vi.fn();
    runAction(mkCtx({ writeToClipboard, canDispatch: denyAll }), {
      kind: 'WriteToClipboard',
      text: { kind: 'Literal', value: 'secret' },
    });
    expect(writeToClipboard).not.toHaveBeenCalled();
  });

  it('the SetState descriptor carries the KEY, so a policy can be per-key', () => {
    const seen: ActionDescriptor[] = [];
    const setState = vi.fn();
    runAction(
      mkCtx({
        setState,
        canDispatch: (d) => {
          seen.push(d);
          return d.kind === 'SetState' && d.key === 'allowed';
        },
      }),
      { kind: 'SetState', key: 'allowed', value: 1 },
    );
    expect(seen).toEqual([{ kind: 'SetState', key: 'allowed' }]);
    expect(setState).toHaveBeenCalledWith('allowed', 1);
  });

  it('the WriteToClipboard descriptor carries NO payload', () => {
    // The reader's own data must not reach a policy gate that may log it. This
    // asserts the absence, which is the whole of the privacy claim.
    const seen: ActionDescriptor[] = [];
    runAction(
      mkCtx({
        writeToClipboard: vi.fn(),
        canDispatch: (d) => {
          seen.push(d);
          return true;
        },
      }),
      { kind: 'WriteToClipboard', text: { kind: 'Literal', value: 'the reader data' } },
    );
    expect(seen).toEqual([{ kind: 'WriteToClipboard' }]);
    expect(JSON.stringify(seen)).not.toContain('the reader data');
  });

  it('a denied SetState is warned about, naming the key', () => {
    const warn = vi.fn();
    runAction(mkCtx({ setState: vi.fn(), warn, canDispatch: denyAll }), setState_);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SetState(showDetails)'));
  });
});
