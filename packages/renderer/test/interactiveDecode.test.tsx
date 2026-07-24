// ============================================================================
//  @fuaran-ui/renderer — interactive in-browser-decode hydration (Phase 159).
//
//  Proves the full client-decode interactivity loop end-to-end: author a tree
//  with @fuaran-ui/ui (buttons carrying wire-survivable actions), round-trip it
//  through the canonical wire (encode→decode — the "server emits, browser
//  decodes" path), render the DECODED tree with a wired runtime, and click.
//  The decoded Notify action fires through runtime.notify (it survived the
//  wire as data); the decoded Navigate action is BLOCKED by a canDispatch gate
//  that denies it (the safety seam) — proving a decoded tree cannot fire an
//  unapproved navigation. No server round-trip, no wire-format change.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import { action, fuaran } from '@fuaran-ui/ui';
import type { Node } from '@fuaran-ui/schema';

import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The authored tree: two buttons carrying wire-survivable actions. */
const authored = (): Node<unknown> =>
  fuaran.dashboard<unknown>({
    id: 'root',
    children: [
      fuaran.button<unknown>({
        id: 'notify-btn',
        label: 'Notify',
        onClick: action.notify<unknown>('toast', 'hi from a decoded action'),
      }),
      fuaran.button<unknown>({
        id: 'nav-btn',
        label: 'Navigate',
        onClick: action.navigate<unknown>('/admin'),
      }),
    ],
  });

/** Round-trip through the canonical wire — the actions arrive DECODED, exactly
 *  as the in-browser-decode hydration path receives them from the server. */
const throughTheWire = (tree: Node<unknown>): Node<unknown> => {
  const decoded = decodeNode(encodeNode(tree));
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.error.message}`);
  return decoded.value;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (runtime: FuaranRuntime): Promise<HTMLButtonElement[]> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={throughTheWire(authored())} runtime={runtime} />);
  });
  return [...container.querySelectorAll('button')] as HTMLButtonElement[];
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

const byLabel = (buttons: HTMLButtonElement[], label: string): HTMLButtonElement => {
  const b = buttons.find((el) => el.textContent?.includes(label));
  if (!b) throw new Error(`button "${label}" not found`);
  return b;
};

describe('interactive in-browser-decode hydration (Phase 159)', () => {
  it('a decoded Notify action fires through the wired runtime when clicked', async () => {
    const notify = vi.fn();
    const buttons = await mount({ notify });

    await act(async () => byLabel(buttons, 'Notify').click());

    expect(notify).toHaveBeenCalledWith('toast', 'hi from a decoded action');
  });

  it('a decoded Navigate action is BLOCKED by a canDispatch gate that denies it', async () => {
    const navigate = vi.fn();
    const warn = vi.fn();
    const buttons = await mount({
      navigate,
      warn,
      canDispatch: (d) => d.kind !== 'Navigate', // deny navigation, allow the rest
    });

    await act(async () => byLabel(buttons, 'Navigate').click());

    expect(navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/denied by policy gate.*Navigate\(\/admin\)/i);
  });

  it('the same gate still ALLOWS a non-denied decoded action (Notify)', async () => {
    const notify = vi.fn();
    const navigate = vi.fn();
    const buttons = await mount({
      notify,
      navigate,
      canDispatch: (d) => d.kind !== 'Navigate',
    });

    await act(async () => byLabel(buttons, 'Notify').click());

    expect(notify).toHaveBeenCalledOnce();
  });
});
