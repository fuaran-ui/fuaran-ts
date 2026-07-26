import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { mount, BUNDLE_VERSION, WIRE_PROFILE, type MountHandle } from '../src/standalone.js';

// The standalone bundle's mount API — what a .NET host with no Node toolchain
// drives through a single <script> tag. These pin the contract the embedded
// asset exposes; the bundle itself is additionally smoke-verified in a real
// browser (it renders, and its interaction handlers fire).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const treeJson = JSON.stringify({
  id: 'root',
  kind: {
    $type: 'Box',
    heading: 'Insights',
    role: 'Card',
    layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
    children: [
      {
        id: 'metric-1',
        kind: {
          $type: 'Metric',
          format: { $type: 'Currency', code: 'GBP' },
          label: 'Revenue',
          tone: 'Brand',
          value: { $type: 'Static', value: 1234.5 },
        },
      },
    ],
  },
});

let handle: MountHandle | undefined;
let el: HTMLDivElement | undefined;

function mountInto(json: string, options?: Parameters<typeof mount>[2]): HTMLDivElement {
  el = document.createElement('div');
  document.body.appendChild(el);
  act(() => {
    handle = mount(el!, json, options);
  });
  return el;
}

afterEach(() => {
  act(() => handle?.unmount());
  el?.remove();
  handle = undefined;
  el = undefined;
});

describe('mount — the embedded bundle entry point', () => {
  it('renders canonical wire JSON, formatting included', () => {
    const container = mountInto(treeJson);
    expect(container.textContent).toContain('Revenue');
    // The currency format is applied by the renderer, not the host.
    expect(container.textContent).toContain('1234.50');
  });

  it('exposes the mounted tree and a stamp for the drift guard', () => {
    mountInto(treeJson);
    expect(handle!.current()).toBeDefined();
    expect(BUNDLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(WIRE_PROFILE).toBe('1');
  });

  it('update() re-renders from new wire JSON', () => {
    const container = mountInto(treeJson);
    const next = treeJson.replace('"Revenue"', '"Bookings"');
    act(() => handle!.update(next));
    expect(container.textContent).toContain('Bookings');
    expect(container.textContent).not.toContain('Revenue');
  });

  it('applyOps() applies a canonical TreeOp — the cheap-diff path', () => {
    const container = mountInto(treeJson);
    expect(container.textContent).toContain('Revenue');

    act(() => handle!.applyOps(JSON.stringify({ $type: 'RemoveNode', target: 'metric-1' })));
    expect(container.textContent).not.toContain('Revenue');
  });

  it('a rejected op leaves the mounted tree untouched — never half-applied', () => {
    const errors: string[] = [];
    const container = mountInto(treeJson, { onError: (m) => errors.push(m) });

    act(() =>
      handle!.applyOps(
        JSON.stringify([
          { $type: 'RemoveNode', target: 'metric-1' },
          { $type: 'RemoveNode', target: 'no-such-node' },
        ]),
      ),
    );

    // The batch stopped on the bad op, so the good one did not land either.
    expect(container.textContent).toContain('Revenue');
    expect(errors).toHaveLength(1);
  });

  it('a malformed tree surfaces a decode diagnostic instead of throwing', () => {
    const errors: string[] = [];
    mountInto('{"id":"x"}', { onError: (m) => errors.push(m) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('MISSING_FIELD');
  });

  it('with no onError, the decode diagnostic lands in the DOM rather than silently', () => {
    const container = mountInto('not json{{');
    expect(container.textContent).toContain('Fuaran:');
  });
});

describe('onNotify — the untyped half of typed cross-host messaging', () => {
  it('delivers the channel and the data payload a typed host lowered onto', () => {
    // The F# side authors `dispatchTyped contract (SetYear 2024)`, which lowers
    // to this exact Notify. An untyped host receives the pair and routes it:
    // same functionality, without the typing TypeScript cannot express here.
    const received: Array<{ channel: string; payload: unknown }> = [];

    const withNotify = JSON.stringify({
      id: 'set-year',
      kind: {
        $type: 'Button',
        label: 'Set year',
        variant: 'Primary',
        onClick: { $type: 'Notify', channel: 'app.setYear', payload: { year: 2024 } },
      },
    });

    const container = mountInto(withNotify, {
      onNotify: (channel, payload) => received.push({ channel, payload }),
    });

    act(() => container.querySelector('button')!.click());

    expect(received).toHaveLength(1);
    expect(received[0]!.channel).toBe('app.setYear');
    // The payload is real data — this is what a typed host lifts back to
    // `SetYear 2024`, and what the closure sentinel could never carry.
    expect(received[0]!.payload).toEqual({ year: 2024 });
  });

  it('does not displace a host that wired its own runtime.notify', () => {
    const viaRuntime: string[] = [];
    const viaOption: string[] = [];

    const withNotify = JSON.stringify({
      id: 'b',
      kind: {
        $type: 'Button',
        label: 'Go',
        variant: 'Primary',
        onClick: { $type: 'Notify', channel: 'c', payload: {} },
      },
    });

    const container = mountInto(withNotify, {
      runtime: { notify: (channel: string) => viaRuntime.push(channel) },
      onNotify: (channel) => viaOption.push(channel),
    });

    act(() => container.querySelector('button')!.click());

    expect(viaRuntime).toEqual(['c']);
    expect(viaOption).toEqual(['c']);
  });
});

describe('the wire boundary on Dispatch (a constraint, not a bug)', () => {
  it('a wire-decoded Dispatch carries the closure sentinel, not a typed message', () => {
    // `Dispatch of 'Msg` holds a HOST CLOSURE, which cannot cross the wire — the
    // canonical decoder replaces it with the `<closure>` sentinel. So an embedded
    // renderer fed wire JSON can observe THAT an interaction happened, but cannot
    // receive a typed host message. Wire-representable interactivity is the
    // declarative kind (state-bound controls, op chains, Call endpoints).
    //
    // Pinned here so the constraint is explicit and cannot change silently.
    const dispatched: unknown[] = [];
    const withButton = JSON.stringify({
      id: 'btn-1',
      kind: {
        $type: 'Button',
        label: 'Notify',
        variant: 'Primary',
        onClick: { $type: 'Chain', ops: [{ $type: 'Dispatch' }] },
      },
    });

    const container = mountInto(withButton, { dispatch: (m) => dispatched.push(m) });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();

    act(() => button!.click());

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toBe('<closure>');
  });
});
