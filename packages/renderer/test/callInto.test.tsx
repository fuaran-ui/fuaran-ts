// ============================================================================
//  @fuaran-ui/renderer — Action.Call's declarative result target (Phase 428).
//
//  Parity-locked behavioural cases shared with the F# renderer: a DECODED
//  button whose `Call` carries `into` writes the endpoint response to the host
//  state / query seam on completion (a re-render with the updated sources
//  shows the bound reader updated); a present `onResult` closure wins and
//  never touches a seam; a fire-and-forget `Call` (neither) still calls the
//  endpoint and writes nothing.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import { action, fuaran } from '@fuaran-ui/ui';
import type { Node } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/index.js';
import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const throughTheWire = (tree: Node<unknown>): Node<unknown> => {
  const decoded = decodeNode(encodeNode(tree));
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.error.message}`);
  return decoded.value;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (
  tree: Node<unknown>,
  runtime: FuaranRuntime,
  sources?: BindingSources,
): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={tree} runtime={runtime} sources={sources ?? {}} />);
  });
  return container;
};

const rerender = async (
  tree: Node<unknown>,
  runtime: FuaranRuntime,
  sources: BindingSources,
): Promise<void> => {
  await act(async () => {
    root!.render(<FuaranRenderer tree={tree} runtime={runtime} sources={sources} />);
  });
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('Action.Call declarative result target (Phase 428)', () => {
  it('a decoded Call into State writes the response to runtime.setState and a bound Metric updates', async () => {
    const store: Record<string, unknown> = {};
    const setState = vi.fn((key: string, value: unknown) => {
      store[key] = value;
    });
    // The host endpoint: responds synchronously with 42.
    const call = vi.fn((_endpoint: string, onResult: (raw: unknown) => void) => onResult(42));
    const runtime: FuaranRuntime = { setState, call: call as NonNullable<FuaranRuntime['call']> };

    const tree = throughTheWire(
      fuaran.stack<unknown>({
        id: 'root',
        children: [
          fuaran.button<unknown>({
            id: 'fetch',
            label: 'Fetch total',
            onClick: action.callIntoState<unknown>('/api/total', 'total'),
          }),
          fuaran.metric<unknown>({
            id: 'total-metric',
            label: 'Total',
            value: { kind: 'State', key: 'total', defaultValue: 0 },
          }),
        ],
      }),
    );
    const el = await mount(tree, runtime);

    expect(el.textContent).toContain('0');
    const button = el.querySelector<HTMLButtonElement>('button.fuaran-button');
    await act(async () => button!.click());

    expect(call).toHaveBeenCalledOnce();
    expect(setState).toHaveBeenCalledWith('total', 42);

    // The host re-renders with the updated state bag — the reader updates.
    await rerender(tree, runtime, { state: { ...store } });
    expect(el.textContent).toContain('42');
  });

  it('a decoded Call into Query writes the response to runtime.setQueryResult', async () => {
    const setQueryResult = vi.fn();
    const call = vi.fn((_e: string, onResult: (raw: unknown) => void) =>
      onResult([{ id: 1 }, { id: 2 }]),
    );
    const tree = throughTheWire(
      fuaran.button<unknown>({
        id: 'fetch',
        label: 'Fetch orders',
        onClick: action.callIntoQuery<unknown>('/api/orders', 'orders'),
      }),
    );
    const el = await mount(tree, {
      call: call as NonNullable<FuaranRuntime['call']>,
      setQueryResult,
    });

    await act(async () => el.querySelector('button')!.click());

    expect(setQueryResult).toHaveBeenCalledWith('orders', [{ id: 1 }, { id: 2 }]);
  });

  it('a decoded closure-authored Call never touches a seam (the placeholder wins, inert)', async () => {
    const setState = vi.fn();
    const setQueryResult = vi.fn();
    const call = vi.fn((_e: string, onResult: (raw: unknown) => void) => onResult(7));
    const tree = throughTheWire(
      fuaran.button<unknown>({
        id: 'fetch',
        label: 'Refresh',
        onClick: action.call<number, unknown>('/api/refresh', (n) => `got ${n}`),
      }),
    );
    const el = await mount(tree, {
      call: call as NonNullable<FuaranRuntime['call']>,
      setState,
      setQueryResult,
    });

    await act(async () => el.querySelector('button')!.click());

    expect(call).toHaveBeenCalledOnce();
    expect(setState).not.toHaveBeenCalled();
    expect(setQueryResult).not.toHaveBeenCalled();
  });
});
