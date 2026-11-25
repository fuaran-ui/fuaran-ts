// ============================================================================
//  @fuaran-ui/renderer — a modal dismisses on its backdrop, not on a click
//  inside it (Phase 2572).
//
//  The overlay's light dismiss used to fire on EVERY click that reached it, and
//  every click inside the dialog bubbles to the overlay: the first click into a
//  modal form's field closed the modal. Earlier tests passed because they called
//  handlers or dispatched `submit`; nothing clicked inside a dialog. These tests
//  do, with real bubbling events dispatched at the target the user would hit
//  (pointerdown, mousedown, pointerup, mouseup, click — the sequence a pointer
//  click produces), so the propagation that caused the defect is exercised.
//
//  The tree is canonical wire JSON, decoded, so the same tree the browser leg in
//  the .NET tier mounts through the standalone bundle is the one asserted here.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { FuaranRenderer } from '../src/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** An open modal holding a one-field form; dismiss raises a `Notify`. */
const modalJson = (dismissable: boolean): string =>
  JSON.stringify({
    id: 'invite',
    kind: {
      $type: 'Modal',
      children: [
        {
          id: 'invite-form',
          kind: {
            $type: 'Form',
            fields: [
              {
                id: 'invite-email',
                kind: {
                  $type: 'Text',
                  onChange: '<closure>',
                  value: {
                    $type: 'Local',
                    flushOn: { $type: 'OnBlur' },
                    format: '<closure>',
                    initialFrom: { $type: 'State', defaultValue: '', key: 'email' },
                    onCommit: '<closure>',
                    parse: '<closure>',
                  },
                },
                label: 'Email',
              },
            ],
            onSubmit: { $type: 'Chain', ops: [] },
            submitLabel: 'Invite',
          },
        },
      ],
      dismissable,
      heading: 'Invite a member',
      onDismiss: { $type: 'Notify', channel: 'dismissed', payload: 'invite' },
      open: { $type: 'Static', value: true },
    },
  });

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (dismissable: boolean, notify: (c: string, p: unknown) => void) => {
  const decoded = decodeNode(modalJson(dismissable));
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.error.message}`);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={decoded.value} runtime={{ notify }} />);
  });
  const overlay = container.querySelector('.fuaran-modal-overlay') as HTMLElement;
  const input = container.querySelector('input.fuaran-form-input') as HTMLInputElement;
  expect(overlay).not.toBeNull();
  expect(input).not.toBeNull();
  return { overlay, input };
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

/** A pointer click at `el`: every event bubbles, as a real one does. */
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    el.click();
  });
};

/** Type into a field the way React observes it: the native value setter, then `input`. */
const type = async (input: HTMLInputElement, text: string): Promise<void> => {
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('a modal dismisses on its backdrop, not on a click inside it (Phase 2572)', () => {
  it('a click into a field inside a dismissable modal keeps it open and the text typed', async () => {
    const notify = vi.fn();
    const { overlay, input } = await mount(true, notify);

    await click(input);
    await type(input, 'ada@example.org');
    await click(overlay.querySelector('.fuaran-modal-dialog') as HTMLElement);

    expect(notify).not.toHaveBeenCalled();
    expect(overlay.hasAttribute('hidden')).toBe(false);
    expect(input.value).toBe('ada@example.org');
  });

  it('a click on the backdrop of a dismissable modal dismisses it', async () => {
    const notify = vi.fn();
    const { overlay } = await mount(true, notify);

    await click(overlay);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('dismissed', 'invite');
  });

  it('a non-dismissable modal ignores both the field click and the backdrop', async () => {
    const notify = vi.fn();
    const { overlay, input } = await mount(false, notify);

    await click(input);
    await type(input, 'ada@example.org');
    expect(input.value).toBe('ada@example.org');
    await click(overlay);

    expect(notify).not.toHaveBeenCalled();
    expect(overlay.hasAttribute('hidden')).toBe(false);
  });
});
