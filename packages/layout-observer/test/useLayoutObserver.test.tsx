// ============================================================================
//  Acceptance — a wired-up <FuaranRenderer> emits at least one flag on a
//  known-overflowing fixture (Phase 80 acceptance criterion).
//
//  Renders a real Fuaran tree through <FuaranRenderer> inside a container the
//  useFuaranLayoutObserver hook observes. The observer self-discovers the
//  rendered nodes via [data-fuaran-node-id] (the attribute the renderer emits)
//  and, with an injected overflow geometry snapshot + fake ResizeObserver +
//  deferred rAF, reports an OverflowHorizontal flag through onFlag.
// ============================================================================

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FuaranRenderer } from '@fuaran-ui/renderer';
import type { Node, NodeId } from '@fuaran-ui/schema';

import {
  useFuaranLayoutObserver,
  type BrowserObserverDeps,
  type LayoutFlag,
  type LayoutInput,
} from '../src/index.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const nid = (s: string): NodeId => s as NodeId;

const tree: Node<unknown> = {
  id: nid('root'),
  kind: {
    kind: 'Layout',
    layout: {
      kind: 'Box',
      spec: {
        layout: { kind: 'Auto' },
        role: 'Dashboard',
        keepTogether: false,
        breakBefore: false,
        children: [
          {
            id: nid('card-1'),
            kind: {
              kind: 'Display',
              display: {
                kind: 'Markdown',
                spec: { text: { kind: 'Literal', value: 'wide content' } },
              },
            },
            state: {},
            style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
          },
        ],
      },
    },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
};

class FakeResizeObserver {
  constructor(readonly cb: (entries: { target: Element }[]) => void) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
class NoopMutationObserver {
  observe(): void {}
  disconnect(): void {}
}

const overflowInput = (): LayoutInput => ({
  width: 100,
  height: 50,
  scrollWidth: 300,
  clientWidth: 100,
  overflowX: 'hidden',
  elementRect: [0, 0, 100, 50],
});

function Harness(props: {
  onFlag: (nodeId: string, flag: LayoutFlag) => void;
  deps: BrowserObserverDeps;
}) {
  const ref = useFuaranLayoutObserver<HTMLDivElement>({ onFlag: props.onFlag, deps: props.deps });
  return (
    <div ref={ref}>
      <FuaranRenderer tree={tree} />
    </div>
  );
}

describe('useFuaranLayoutObserver — wired into a rendered FuaranRenderer subtree', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it('emits an OverflowHorizontal flag for a known-overflowing rendered node', async () => {
    const flags: Array<[string, string]> = [];
    let pendingFrame: (() => void) | null = null;
    const deps: Omit<BrowserObserverDeps, 'root'> = {
      snapshot: overflowInput,
      now: () => 0,
      requestFrame: (cb) => {
        pendingFrame = cb;
        return 1;
      },
      cancelFrame: () => {
        pendingFrame = null;
      },
      ResizeObserverCtor: FakeResizeObserver,
      MutationObserverCtor: NoopMutationObserver,
    };

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <Harness onFlag={(nodeId, flag) => flags.push([nodeId, flag.kind])} deps={deps} />,
      );
    });

    // The effect ran, the observer scanned the rendered [data-fuaran-node-id]
    // nodes and scheduled the initial flush. Drive it.
    await act(async () => {
      pendingFrame?.();
    });

    expect(flags.length).toBeGreaterThan(0);
    expect(flags.some(([, kind]) => kind === 'OverflowHorizontal')).toBe(true);
    expect(flags.some(([nodeId]) => nodeId === 'card-1')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
