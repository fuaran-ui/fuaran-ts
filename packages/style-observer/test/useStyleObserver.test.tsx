// ============================================================================
//  Acceptance — a wired-up <FuaranRenderer> emits at least one resolved-style
//  flag on a known-illegible fixture.
//
//  Renders a real Fuaran tree through <FuaranRenderer> inside a container the
//  useFuaranStyleObserver hook observes. The observer self-discovers the rendered
//  nodes via [data-fuaran-node-id] (the attribute the renderer emits) and, with
//  an injected white-on-white computed-style snapshot + fake MutationObserver +
//  deferred rAF, reports an InvisibleText flag through onFlag.
// ============================================================================

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FuaranRenderer } from '@fuaran-ui/renderer';
import type { Node, NodeId } from '@fuaran-ui/schema';

import {
  useFuaranStyleObserver,
  white,
  type BrowserObserverDeps,
  type StyleFlag,
  type StyleInput,
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
        children: [
          {
            id: nid('card-1'),
            kind: {
              kind: 'Display',
              display: {
                kind: 'Markdown',
                spec: { text: { kind: 'Literal', value: 'low-contrast content' } },
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

class FakeMutationObserver {
  constructor(readonly cb: () => void) {}
  observe(): void {}
  disconnect(): void {}
}

const invisibleInput = (): StyleInput => ({
  foreground: white,
  backgroundLayers: [white],
  fontFamily: undefined,
  emittedTone: undefined,
});

function Harness(props: {
  onFlag: (nodeId: string, flag: StyleFlag) => void;
  deps: Omit<BrowserObserverDeps, 'root'>;
}) {
  const ref = useFuaranStyleObserver<HTMLDivElement>({ onFlag: props.onFlag, deps: props.deps });
  return (
    <div ref={ref}>
      <FuaranRenderer tree={tree} />
    </div>
  );
}

describe('useFuaranStyleObserver — wired into a rendered FuaranRenderer subtree', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it('emits an InvisibleText flag for a known-illegible rendered node', async () => {
    const flags: Array<[string, string]> = [];
    let pendingFrame: (() => void) | null = null;
    const deps: Omit<BrowserObserverDeps, 'root'> = {
      snapshot: invisibleInput,
      now: () => 0,
      requestFrame: (cb) => {
        pendingFrame = cb;
        return 1;
      },
      cancelFrame: () => {
        pendingFrame = null;
      },
      MutationObserverCtor: FakeMutationObserver,
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
    expect(flags.some(([, kind]) => kind === 'InvisibleText')).toBe(true);
    expect(flags.some(([nodeId]) => nodeId === 'card-1')).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
