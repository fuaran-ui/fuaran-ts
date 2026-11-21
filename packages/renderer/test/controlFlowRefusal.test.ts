// Phase 2107 — `Action.Choose` and `Action.Require` are the bounded program
// core's arms, and this renderer does not run on that loop yet (Phase 2105). So a
// gesture reaching either one is refused WHOLE: nothing in it runs, and the
// refusal is warned. Refusing only the arm would run the members after an
// unevaluated guard, which is the guard failing open.
import { describe, expect, it, vi } from 'vitest';

import type { Action } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/bindings.js';
import { reachesControlFlow, runAction, type RenderContext } from '../src/context.js';
import { denyNonLocalEgress } from '../src/egress.js';
import type { FuaranRuntime } from '../src/index.js';

const mkCtx = (runtime: FuaranRuntime, dispatch: (m: string) => void): RenderContext<string> => ({
  sources: { state: {} } as BindingSources,
  runtime,
  dispatch,
  fragments: new Map(),
  expandingFragments: new Set(),
  inErrorBoundary: false,
  egressPolicy: denyNonLocalEgress,
});

const guard: Action<string> = {
  kind: 'Require',
  condition: { kind: 'State', key: 'form.valid' },
} as Action<string>;

describe('Phase 2107 — the non-bounded interpreter refuses control flow whole', () => {
  it('runs nothing of a gesture carrying a Require, and warns', () => {
    const dispatch = vi.fn();
    const warn = vi.fn();
    const action: Action<string> = {
      kind: 'Chain',
      actions: [{ kind: 'Dispatch', msg: 'before' }, guard, { kind: 'Dispatch', msg: 'after' }],
    };
    runAction(mkCtx({ warn } as FuaranRuntime, dispatch), action);
    expect(dispatch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('bounded program loop');
  });

  it('finds a control arm inside a Confirm continuation and a Choose arm', () => {
    const choose: Action<string> = {
      kind: 'Choose',
      condition: { kind: 'State', key: 'flag' },
      whenTrue: { kind: 'Print' },
    } as Action<string>;
    expect(reachesControlFlow(choose)).toBe(true);
    expect(
      reachesControlFlow({
        kind: 'Confirm',
        prompt: { kind: 'Literal', value: 'Sure?' },
        onConfirm: { kind: 'Chain', actions: [guard] },
      }),
    ).toBe(true);
    expect(reachesControlFlow({ kind: 'Chain', actions: [{ kind: 'Print' }] })).toBe(false);
  });

  it('still runs a gesture with no control arm', () => {
    const dispatch = vi.fn();
    runAction(mkCtx({} as FuaranRuntime, dispatch), { kind: 'Dispatch', msg: 'hi' });
    expect(dispatch).toHaveBeenCalledWith('hi');
  });
});
