// ============================================================================
//  @fuaran-ui/renderer — canDispatch default-deny dispatch gate (Phase 159).
//
//  The TS mirror of the F# Phase 119 `IFuaranRuntime.CanDispatch` /
//  `applyDispatchGate` seam. `runAction` consults the optional `canDispatch`
//  gate BEFORE the gated effects (Call / Navigate / AiTool / ReadFileBody)
//  fire: an ABSENT gate allows (existing hosts unchanged); a gate returning
//  `false` denies — a diagnostic via `warn`, no effect. The non-gated cases
//  (Dispatch / SetState / Notify / CommitLocal / WriteToClipboard / Chain) are
//  never routed through the gate, matching the F# gated set.
//
//  This is the safety foundation for interactive in-browser-decode hydration:
//  a server-emitted tree, decoded + hydrated client-side, must not fire
//  Navigate / AiTool / Call unless the host's gate approves them.
// ============================================================================

import { describe, expect, it, vi } from 'vitest';

import { type Action, apiEndpoint } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/bindings.js';
import { runAction, type RenderContext } from '../src/context.js';
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
});

const navigate: Action<string> = { kind: 'Navigate', route: '/admin' };
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
const setState: Action<string> = { kind: 'SetState', key: 'showDetails', value: true };

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

  it('NON-gated actions bypass the gate entirely (a deny-all gate still lets SetState through)', () => {
    const setStateSpy = vi.fn();
    const ctx = mkCtx({ setState: setStateSpy, canDispatch: () => false });

    runAction(ctx, setState);

    // SetState is not in the gated set (parity with the F# ActionDescriptor cases).
    expect(setStateSpy).toHaveBeenCalledWith('showDetails', true);
  });

  it('describeActionDescriptor renders each gated case for diagnostics', () => {
    expect(describeActionDescriptor({ kind: 'Call', endpoint: '/x' })).toBe('Call(/x)');
    expect(describeActionDescriptor({ kind: 'Navigate', route: '/y' })).toBe('Navigate(/y)');
    expect(describeActionDescriptor({ kind: 'AiTool', toolName: 't' })).toBe('AiTool(t)');
    expect(describeActionDescriptor({ kind: 'ReadFileBody', fileId: 'f' })).toBe('ReadFileBody(f)');
  });
});
