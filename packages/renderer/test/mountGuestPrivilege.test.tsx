// ============================================================================
//  Phase 1021 — the `NodeKind.Mount` guest-privilege contract, ported from the
//  reference host's Phase 783 hardening.
//
//  This host has no guest loader in production yet, which is exactly why the
//  contract lands FIRST: a loader added later without these guarantees would
//  reintroduce pre-783 semantics on a public tier, and it would do so silently,
//  because "the guest rendered" looks the same either way. So the renderer's
//  Mount arm owns the ONLY call to `loadGuest` and derives privilege from its
//  result in the same expression — a host supplies a loader and never a context.
//
//  Three properties, and the third is the one a stub could not have:
//
//    1. A mount with no loader stays INERT — byte-identical to the pre-1021
//       placeholder the string renderer also emits.
//    2. With no `guestSeam` wired the guest is UNPRIVILEGED: every capability
//       refused through the host's `warn`, `canDispatch` false, no registry in
//       any form, no nested guest loading.
//    3. `OutOnly` is CLAMPED before anything reads the channel; `TwoWay` is a
//       host grant with a WARNED downgrade, never a wire-declared property.
// ============================================================================

import type { GuestChannel, Node } from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createCustomRendererRegistry,
  deriveGuestPrivilege,
  FuaranRenderer,
  type FuaranRuntime,
  type GuestSeam,
  registerCustomRenderer,
  unprivilegedGuestRuntime,
} from '../src/index.js';

const mountNode = (channel: GuestChannel): Node<string> => ({
  id: nodeId('mount-1'),
  kind: {
    kind: 'Mount',
    spec: { scopeId: 'guest-sidebar', inputs: {}, channel, capabilities: ['notify'] },
  },
  state: {},
  style: defaults.style,
});

const guestTree: Node<unknown> = {
  id: nodeId('guest-root'),
  kind: {
    kind: 'Display',
    display: {
      kind: 'Callout',
      spec: {
        tone: 'Default',
        body: { kind: 'Literal', value: 'guest body' },
        dismissable: false,
      },
    },
  },
  state: {},
  style: defaults.style,
};

const outOnly: GuestChannel = { direction: 'OutOnly' };
const twoWay: GuestChannel = { direction: 'TwoWay' };

const declaration = (channel: GuestChannel) => ({
  scopeId: 'guest-sidebar',
  channel,
  capabilities: ['notify'],
});

// ─── 1. Inert without a loader ───────────────────────────────────────────────

describe('Mount — no loader stays inert (Phase 1021)', () => {
  it('renders the placeholder byte-identically when no loader is wired', () => {
    const html = renderToStaticMarkup(
      <FuaranRenderer<string> tree={mountNode(outOnly)} runtime={{ warn: vi.fn() }} />,
    );
    expect(html).toContain('fuaran-mount-placeholder');
    expect(html).toContain('guest loader not attached');
    expect(html).not.toContain('fuaran-mount-boundary');
  });

  it('a loader returning `undefined` for this scope is the same inert case', () => {
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={mountNode(outOnly)}
        runtime={{ loadGuest: () => undefined, warn: vi.fn() }}
      />,
    );
    expect(html).toContain('fuaran-mount-placeholder');
  });

  it('a wired loader renders the guest under the boundary', () => {
    // The control for every "the guest reached nothing" assertion below: if the
    // guest never rendered at all, those would pass for the wrong reason.
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={mountNode(outOnly)}
        runtime={{ loadGuest: () => guestTree, warn: vi.fn() }}
      />,
    );
    expect(html).toContain('fuaran-mount-boundary');
    expect(html).toContain('data-fuaran-mount-scope="guest-sidebar"');
    expect(html).toContain('guest body');
  });
});

// ─── 2. No seam means unprivileged ───────────────────────────────────────────

describe('Mount — no seam means UNPRIVILEGED (Phase 1021)', () => {
  it('the derived guest runtime is the deny-all one, not the host runtime', () => {
    const hostRuntime: FuaranRuntime = { navigate: vi.fn(), warn: vi.fn() };
    const privilege = deriveGuestPrivilege(declaration(outOnly), hostRuntime, () => {}, undefined);
    expect(privilege.runtime).not.toBe(hostRuntime);
    expect(privilege.runtime.canDispatch?.({ kind: 'Call', endpoint: '/api/x' })).toBe(false);
    expect(privilege.runtime.registry).toBeUndefined();
    expect(privilege.runtime.loadGuest).toBeUndefined();
  });

  it('an unprivileged guest reaches no registered renderer, and refuses audibly', () => {
    const invoked: string[] = [];
    const registry = createCustomRendererRegistry();
    registerCustomRenderer(registry, 'admin', 'danger', () => {
      invoked.push('admin-only');
      return <span />;
    });

    const warn = vi.fn();
    const host: FuaranRuntime = { registry, navigate: vi.fn(), warn };
    const guest = unprivilegedGuestRuntime(host, 'guest-sidebar');

    expect(guest.registry).toBeUndefined();
    expect(invoked).toEqual([]);

    guest.navigate?.('/admin');
    expect(host.navigate).not.toHaveBeenCalled();
    // The refusal is RECORDED. Refusing to say anything would make an unwired
    // mount silently inert, which is how this defect survived on the reference
    // host in the first place.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('guest-sidebar'));
  });

  it('THROUGH THE RENDER: a guest tree cannot reach a renderer the HOST registered', () => {
    // The confused-deputy shape, asserted where it would actually happen rather
    // than only on the derivation. The guest names a `Custom` node the host has
    // a renderer for; with no seam wired it must reach the placeholder, not the
    // host's component.
    const invoked: string[] = [];
    const registry = createCustomRendererRegistry();
    registerCustomRenderer(registry, 'admin', 'danger', () => {
      invoked.push('admin-only');
      return <span className="host-owned-renderer" />;
    });

    const hostileGuest: Node<unknown> = {
      id: nodeId('guest-root'),
      kind: {
        kind: 'Custom',
        moduleId: 'admin',
        componentId: 'danger',
        props: {},
        exposedNodeIds: [],
      },
      state: {},
      style: defaults.style,
    };

    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={mountNode(outOnly)}
        runtime={{ registry, loadGuest: () => hostileGuest, warn: vi.fn() }}
      />,
    );

    expect(html).toContain('fuaran-mount-boundary'); // the guest DID render…
    expect(invoked).toEqual([]); // …and reached nothing.
    expect(html).not.toContain('host-owned-renderer');
    expect(html).toContain('fuaran-custom-placeholder');
  });

  it('a seam that returns the host runtime grants it — deliberately, and by name', () => {
    // The identity policy is a legitimate host choice. What the phase forbids is
    // it being what you get by FORGETTING to write a policy.
    const hostRuntime: FuaranRuntime = { navigate: vi.fn(), warn: vi.fn() };
    const identitySeam: GuestSeam = {
      wrapRuntime: (_ctx, host) => host,
      gateBubble: (_ctx, raw) => raw,
      grantTwoWay: () => false,
    };
    const privilege = deriveGuestPrivilege(
      declaration(outOnly),
      hostRuntime,
      () => {},
      identitySeam,
    );
    expect(privilege.runtime).toBe(hostRuntime);
  });
});

// ─── 3. The OutOnly clamp ────────────────────────────────────────────────────

describe('Mount — the OutOnly clamp (Phase 1021)', () => {
  it('a wire-declared TwoWay channel is clamped to OutOnly with no seam', () => {
    const warn = vi.fn();
    const privilege = deriveGuestPrivilege(declaration(twoWay), { warn }, () => {}, undefined);
    expect(privilege.channel.direction).toBe('OutOnly');
    expect(privilege.twoWayGranted).toBe(false);
    // Recorded, not dropped: a silent clamp is indistinguishable from a guest
    // that simply never pushed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('downgraded to OutOnly'));
  });

  it('the seam sees the CLAMPED channel and what the tree asked for', () => {
    // Order is the contract: a seam that read the channel before the clamp would
    // be reading the tree's claim, which is the thing being defended against.
    const seen: { channel: string; declared: string }[] = [];
    const seam: GuestSeam = {
      wrapRuntime: (_ctx, host) => host,
      gateBubble: (_ctx, raw) => raw,
      grantTwoWay: (ctx) => {
        seen.push({ channel: ctx.channel.direction, declared: ctx.declaredDirection });
        return false;
      },
    };
    deriveGuestPrivilege(declaration(twoWay), { warn: vi.fn() }, () => {}, seam);
    expect(seen).toEqual([{ channel: 'OutOnly', declared: 'TwoWay' }]);
  });

  it('TwoWay is reachable ONLY as an explicit host grant, and is then not warned', () => {
    const warn = vi.fn();
    const granting: GuestSeam = {
      wrapRuntime: (_ctx, host) => host,
      gateBubble: (_ctx, raw) => raw,
      grantTwoWay: () => true,
    };
    const privilege = deriveGuestPrivilege(declaration(twoWay), { warn }, () => {}, granting);
    expect(privilege.channel.direction).toBe('TwoWay');
    expect(privilege.twoWayGranted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an OutOnly tree under a granting seam is NOT silently upgraded past its own declaration', () => {
    // `grantTwoWay` answers "may this mount have the upgrade it asked for". A
    // tree that asked for nothing gets a grant it never requested only if the
    // host's policy says yes — which is the host's call, and is recorded here so
    // a future change to that reading is visible rather than incidental.
    const granting: GuestSeam = {
      wrapRuntime: (_ctx, host) => host,
      gateBubble: (_ctx, raw) => raw,
      grantTwoWay: (ctx) => ctx.declaredDirection === 'TwoWay',
    };
    const privilege = deriveGuestPrivilege(
      declaration(outOnly),
      { warn: vi.fn() },
      () => {},
      granting,
    );
    expect(privilege.channel.direction).toBe('OutOnly');
  });

  it('a guest dispatch reaches the host only through the scope-tagged bubble', () => {
    const bubbled: [string, unknown][] = [];
    const privilege = deriveGuestPrivilege(
      declaration(outOnly),
      { warn: vi.fn() },
      (action) => bubbled.push(['guest-sidebar', action]),
      undefined,
    );
    privilege.dispatch('guest-said-hello');
    expect(bubbled).toEqual([['guest-sidebar', 'guest-said-hello']]);
  });

  it('a seam may gate the bubble — a dropped dispatch never reaches the host', () => {
    const bubbled: unknown[] = [];
    const dropping: GuestSeam = {
      wrapRuntime: (_ctx, host) => host,
      gateBubble: () => () => {},
      grantTwoWay: () => false,
    };
    const privilege = deriveGuestPrivilege(
      declaration(outOnly),
      { warn: vi.fn() },
      (action) => bubbled.push(action),
      dropping,
    );
    privilege.dispatch('dropped');
    expect(bubbled).toEqual([]);
  });
});
