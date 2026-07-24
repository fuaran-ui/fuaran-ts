// ============================================================================
//  @fuaran-ui/renderer — the control write-back default (Phase 426).
//
//  Parity-locked behavioural cases shared with the F# renderer: a DECODED
//  handler-free control (the AI-authored shape — handlers omitted on the wire)
//  writes its typed change back to its own value binding's store slot through
//  the host seams (`runtime.setState` / `runtime.setFilter`), and a host that
//  re-renders with the updated sources sees the loop close (typing updates
//  state → bound readers re-render; a tab click writes `activeIndex`'s key →
//  the pane switches). A present (closure-authored) handler wins and never
//  touches a seam — on the decoded path the placeholder closure is inert, the
//  pre-426 dead behaviour, byte-for-byte.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import { formFieldKind, fuaran } from '@fuaran-ui/ui';
import type { Node } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/index.js';
import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Round-trip through the canonical wire — handlers arrive DECODED (omitted →
 *  absent → the write-back default; present → the inert placeholder). */
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
    root!.render(
      <FuaranRenderer tree={throughTheWire(tree)} runtime={runtime} sources={sources ?? {}} />,
    );
  });
  return container;
};

const rerender = async (
  tree: Node<unknown>,
  runtime: FuaranRuntime,
  sources: BindingSources,
): Promise<void> => {
  await act(async () => {
    root!.render(
      <FuaranRenderer tree={throughTheWire(tree)} runtime={runtime} sources={sources} />,
    );
  });
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

const setNativeValue = (el: HTMLInputElement, value: string): void => {
  // React overrides the value setter on controlled inputs; drive the native
  // one so the change event carries the typed value.
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('control write-back default (Phase 426)', () => {
  it('typing in a decoded handler-free State-bound text field writes runtime.setState', async () => {
    const setState = vi.fn();
    const tree = fuaran.form<unknown>({
      id: 'frm',
      onSubmit: { kind: 'Chain', actions: [] },
      fields: [
        {
          id: 'profile-name',
          label: { kind: 'Literal', value: 'Name' },
          kind: formFieldKind.textDeclarative({
            kind: 'State',
            key: 'profileName',
            defaultValue: '',
          }),
          required: false,
        },
      ],
    });
    const el = await mount(tree, { setState });

    const input = el.querySelector<HTMLInputElement>('input.fuaran-form-input');
    expect(input).not.toBeNull();
    await act(async () => setNativeValue(input!, 'Ada'));

    expect(setState).toHaveBeenCalledWith('profileName', 'Ada');
  });

  it('Phase 596: an omitted-value form field auto-binds $state.<field id> end-to-end', async () => {
    // The wire carries NO value key at all — decode synthesises
    // State(field id, ''), the write-back default routes typing to it.
    const setState = vi.fn();
    const wire =
      '{"id":"frm596","kind":{"$type":"Form","fields":[{"id":"guest-name","kind":{"$type":"Text"},"label":"Name","required":true}],"onSubmit":{"$type":"Chain","ops":[]},"submitLabel":"Book"}}';
    const decoded = decodeNode(wire);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    // The synthesis round-trips: re-encode omits the value key again.
    expect(encodeNode(decoded.value)).toBe(wire);

    const el = await mount(decoded.value, { setState });
    const input = el.querySelector<HTMLInputElement>('input.fuaran-form-input');
    expect(input).not.toBeNull();
    await act(async () => setNativeValue(input!, 'Grace'));

    expect(setState).toHaveBeenCalledWith('guest-name', 'Grace');
  });

  it('a decoded handler-free Filter-bound field writes runtime.setFilter, not setState', async () => {
    const setState = vi.fn();
    const setFilter = vi.fn();
    const tree = fuaran.form<unknown>({
      id: 'frm',
      onSubmit: { kind: 'Chain', actions: [] },
      fields: [
        {
          id: 'q',
          label: { kind: 'Literal', value: 'Search' },
          kind: formFieldKind.textDeclarative({ kind: 'Filter', name: 'q' }),
          required: false,
        },
      ],
    });
    const el = await mount(tree, { setState, setFilter });

    const input = el.querySelector<HTMLInputElement>('input.fuaran-form-input');
    await act(async () => setNativeValue(input!, 'widgets'));

    expect(setFilter).toHaveBeenCalledWith('q', 'widgets');
    expect(setState).not.toHaveBeenCalled();
  });

  it('a decoded closure-authored field never touches a seam (the placeholder wins, inert)', async () => {
    const setState = vi.fn();
    const tree = fuaran.form<unknown>({
      id: 'frm',
      onSubmit: { kind: 'Chain', actions: [] },
      fields: [
        {
          id: 'profile-name',
          label: { kind: 'Literal', value: 'Name' },
          kind: {
            kind: 'Text',
            value: { kind: 'State', key: 'profileName', defaultValue: '' },
            onChange: () => ({ kind: 'Chain', actions: [] }),
          },
          required: false,
        },
      ],
    });
    const el = await mount(tree, { setState });

    const input = el.querySelector<HTMLInputElement>('input.fuaran-form-input');
    await act(async () => setNativeValue(input!, 'Ada'));

    expect(setState).not.toHaveBeenCalled();
  });

  it('a decoded handler-free tab click writes the index and the pane switches on re-render', async () => {
    const store: Record<string, unknown> = { activePane: 0 };
    const setState = vi.fn((key: string, value: unknown) => {
      store[key] = value;
    });
    const tree = fuaran.tabs<unknown>({
      id: 'panes',
      activeIndex: { kind: 'State', key: 'activePane', defaultValue: 0 },
      children: [
        fuaran.markdown<unknown>('overview', 'Overview pane'),
        fuaran.markdown<unknown>('detail', 'Detail pane'),
      ],
    });
    const runtime: FuaranRuntime = { setState };
    const el = await mount(tree, runtime, { state: { ...store } });

    expect(el.textContent).toContain('Overview pane');

    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.length).toBe(2);
    await act(async () => tabs[1]!.click());

    expect(setState).toHaveBeenCalledWith('activePane', 1);

    // The host re-renders with the updated state bag — the pane switches.
    await rerender(tree, runtime, { state: { ...store } });
    expect(el.textContent).toContain('Detail pane');
    expect(el.textContent).not.toContain('Overview pane');
  });

  it('dismissing a decoded handler-free modal writes false to its open slot', async () => {
    const setState = vi.fn();
    const tree = fuaran.modal<unknown>({
      id: 'confirm',
      dismissable: true,
      open: { kind: 'State', key: 'modalOpen', defaultValue: false },
      children: [fuaran.markdown<unknown>('body', 'Sure?')],
    });
    const el = await mount(tree, { setState }, { state: { modalOpen: true } });

    const dismiss = el.querySelector<HTMLButtonElement>('button.fuaran-modal-dismiss');
    expect(dismiss).not.toBeNull();
    await act(async () => dismiss!.click());

    expect(setState).toHaveBeenCalledWith('modalOpen', false);
  });

  it('clearing a decoded handler-free choice clears the slot (null on the state seam)', async () => {
    const setState = vi.fn();
    const tree = fuaran.form<unknown>({
      id: 'frm',
      onSubmit: { kind: 'Chain', actions: [] },
      fields: [
        {
          id: 'tier',
          label: { kind: 'Literal', value: 'Tier' },
          kind: formFieldKind.choiceDeclarative(
            {
              kind: 'Static',
              value: [{ value: 'basic', label: { kind: 'Literal', value: 'Basic' } }],
            },
            { kind: 'State', key: 'tier', defaultValue: undefined },
          ),
          required: false,
        },
      ],
    });
    const el = await mount(tree, { setState }, { state: { tier: 'basic' } });

    const select = el.querySelector<HTMLSelectElement>('select.fuaran-form-select');
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = '';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(setState).toHaveBeenCalledWith('tier', null);
  });
});
