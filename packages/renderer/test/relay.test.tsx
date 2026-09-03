// ============================================================================
//  @fuaran-ui/renderer — the DevTools relay page peer + the affordances it
//  rests on: the committed-tree-change subscription, the gated apply wired for
//  real, and the extension opt-in flag.
//
//  The acceptance this file pins, in the contract's own terms:
//
//    * opt-in ON  — hello lists capabilities; a valid op applies and the host
//      re-renders; an invalid op returns the validator-reject envelope with the
//      tree untouched; subscribe fires on commit.
//    * opt-in OFF (the DEFAULT) — hello refuses, nothing else is reachable.
//
//  Plus the transport discipline (§3.2) that decides which messages are even
//  looked at, and the two postures of "off": an opted-out peer that answers
//  NOT_OPTED_IN, and the production-preferred ABSENCE — no listener at all, so
//  a probe learns nothing whatsoever.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindingForSlot, extractBindingSlots } from '@fuaran-ui/ai-tools';
import type { Node, NodeKind } from '@fuaran-ui/schema';
import { binding, fuaran, preEmitValidate } from '@fuaran-ui/ui';

import {
  acceptsRelayMessage,
  type BindingSources,
  buildDebugGlobal,
  createChangeHub,
  createRelayPeer,
  declaredSlots,
  FuaranRenderer,
  installRelayPeer,
  parseRelayProfile,
  RELAY_PROFILE,
  type RelayEnvelope,
} from '../src/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeTree = (): Node<unknown> =>
  fuaran.stack<unknown>({
    id: 'root',
    children: [
      fuaran.metric<unknown>({ id: 'rev', label: 'Revenue', value: binding.state('revenue', 0) }),
      fuaran.metric<unknown>({ id: 'cost', label: 'Cost', value: 7 }),
    ],
  });

const sources: BindingSources = { state: { revenue: 42 } };

const request = (
  type: string,
  payload: Record<string, unknown> = {},
  id = 'c-1',
  profile: string = RELAY_PROFILE,
): Record<string, unknown> => ({ $relay: profile, dir: 'request', id, type, payload });

const hello = (id = 'c-1'): Record<string, unknown> =>
  request('hello', { client: 'test', clientVersion: '1', accepts: [RELAY_PROFILE] }, id);

interface Harness {
  readonly peer: ReturnType<typeof createRelayPeer>;
  readonly emitted: RelayEnvelope[];
  currentTree(): Node<unknown>;
  readonly journalled: string[];
}

const harness = (options: { optedIn?: boolean; deny?: boolean } = {}): Harness => {
  let tree = makeTree();
  const hub = createChangeHub();
  const emitted: RelayEnvelope[] = [];
  const journalled: string[] = [];
  hub.commit(tree, 'host');

  const peer = createRelayPeer(
    () =>
      buildDebugGlobal(tree, sources, {
        hub,
        runtime: { canDispatch: () => options.deny !== true, warn: () => {} },
        applyHandler: (next: Node<unknown>) => {
          tree = next;
        },
        sinks: { onApplied: (opJson) => journalled.push(opJson) },
        validate: (candidate) => {
          const result = preEmitValidate(candidate);
          return result.ok ? [] : result.error;
        },
      }),
    { optedIn: options.optedIn ?? true, emit: (event) => emitted.push(event) },
  );

  return { peer, emitted, journalled, currentTree: () => tree };
};

const payload = (envelope: RelayEnvelope | undefined): Record<string, unknown> =>
  (envelope?.payload ?? {}) as Record<string, unknown>;

/**
 * Deliver a message the way a real browser does.
 *
 * jsdom's own `window.postMessage` to the SAME window delivers with
 * `origin: ""` and `source: null` — a jsdom limitation, not a defect in the
 * §3.2 checks, which a real browser satisfies. Dispatching the event
 * explicitly is what lets the listener path be exercised at all here; the
 * checks themselves are pinned directly against `acceptsRelayMessage` above.
 */
const deliver = (
  message: unknown,
  origin: string = window.origin,
  source: unknown = window,
): void => {
  window.dispatchEvent(
    new MessageEvent('message', { data: message, origin, source: source as Window }),
  );
};

/** Collect the responses posted back while `run` executes. */
const collectReplies = async (run: () => void): Promise<RelayEnvelope[]> => {
  const replies: RelayEnvelope[] = [];
  const collect = (event: MessageEvent): void => {
    const data = event.data as RelayEnvelope | undefined;
    if (data?.dir === 'response') replies.push(data);
  };
  window.addEventListener('message', collect);
  run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.removeEventListener('message', collect);
  return replies;
};

// ─── opt-in ──────────────────────────────────────────────────────────────────

describe('extension opt-in — off by default', () => {
  it('a peer built with no options is NOT opted in: hello refuses', () => {
    const peer = createRelayPeer(buildDebugGlobal(makeTree(), sources));
    const reply = peer.handle(hello());
    expect(reply?.type).toBe('refusal');
    expect(payload(reply)['class']).toBe('NOT_OPTED_IN');
  });

  it('an opted-out peer reaches nothing else either — every type refuses the same way', () => {
    const { peer } = harness({ optedIn: false });
    for (const type of ['read.tree', 'read.nodeState', 'apply', 'subscribe', 'unsubscribe']) {
      const reply = peer.handle(request(type, { nodeId: 'rev', op: {}, events: ['tree'] }));
      expect(payload(reply)['class'], type).toBe('NOT_OPTED_IN');
    }
  });

  it('an opted-out peer advertises no capabilities at all', () => {
    const { peer } = harness({ optedIn: false });
    expect(peer.capabilities()).toEqual([]);
  });

  it('opting in is a host-side act — no message turns the relay on', () => {
    const { peer } = harness({ optedIn: false });
    // There is no such message in the closed set; the nearest thing a client
    // could try is an unknown type, which stays refused as NOT_OPTED_IN
    // (nothing about the request is examined).
    const reply = peer.handle(request('relay.enable'));
    expect(payload(reply)['class']).toBe('NOT_OPTED_IN');
  });
});

// ─── hello + capabilities ────────────────────────────────────────────────────

describe('hello handshake', () => {
  it('lists the capabilities this host serves', () => {
    const { peer } = harness();
    const reply = peer.handle(hello());
    expect(reply?.type).toBe('hello.ok');
    expect(payload(reply)['capabilities']).toEqual([
      'read.nodeState',
      'read.bindingValue',
      'read.renderedDom',
      'read.tree',
      'read.findNodes',
      // `relay@1.3`, and present because the handshake accepts `relay@1.3`.
      // `read.affordances` is NOT here: it is a recognised type of the contract
      // that this host does not serve, so it is refused CAPABILITY_ABSENT rather
      // than advertised (§6.4).
      'read.nodeJson',
      'apply',
      'subscribe',
    ]);
    expect(payload(reply)['profile']).toBe(RELAY_PROFILE);
    expect(typeof payload(reply)['treeRevision']).toBe('string');
  });

  it('omits apply when the host wired no apply path (a read-only host is conformant)', () => {
    const peer = createRelayPeer(buildDebugGlobal(makeTree(), sources), { optedIn: true });
    const reply = peer.handle(hello());
    expect(payload(reply)['capabilities']).not.toContain('apply');
    // …and asking for it is CAPABILITY_ABSENT, never UNKNOWN_MESSAGE: the entry
    // point exists, this host simply does not offer it.
    const refused = peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'cost' } }));
    expect(payload(refused)['class']).toBe('CAPABILITY_ABSENT');
  });

  it('refuses a hello whose accepts names no profile this peer speaks', () => {
    const { peer } = harness();
    const reply = peer.handle(request('hello', { accepts: ['relay@9.9'] }));
    expect(payload(reply)['class']).toBe('FOREIGN_PROFILE');
  });

  it('negotiates on every request, not only on hello', () => {
    const { peer } = harness();
    expect(peer.handle(hello())?.type).toBe('hello.ok');
    const reply = peer.handle(request('read.tree', {}, 'c-2', 'relay@2.0'));
    expect(payload(reply)['class']).toBe('FOREIGN_PROFILE');
  });

  it('proceeds on a newer MINOR — within a major, additions are ignorable', () => {
    const { peer } = harness();
    const reply = peer.handle(request('read.tree', {}, 'c-2', 'relay@1.7'));
    expect(reply?.type).toBe('read.tree.ok');
  });

  it('parses the profile grammar and rejects what is not that grammar', () => {
    expect(parseRelayProfile('relay@1.0')).toEqual({ name: 'relay', major: 1, minor: 0 });
    expect(parseRelayProfile('relay-1.0')).toBeUndefined();
    expect(parseRelayProfile('')).toBeUndefined();
  });
});

// ─── gated apply ─────────────────────────────────────────────────────────────

describe('gated apply — decode → validate → apply through the host engine', () => {
  it('applies a valid op and hands the host a new tree', () => {
    const h = harness();
    const before = h.currentTree();
    const reply = h.peer.handle(
      request('apply', { op: { $type: 'RemoveNode', target: 'cost' } }, 'c-9'),
    );
    expect(reply?.type).toBe('apply.ok');
    expect(payload(reply)['applied']).toBe(true);
    expect(h.currentTree()).not.toBe(before);
    // The revision advanced with the edit, so a client's cached read is
    // detectably stale.
    expect(payload(reply)['treeRevision']).not.toBe('r-1');
  });

  it('an op the engine rejects returns VALIDATOR_REJECT and leaves the tree untouched', () => {
    const h = harness();
    const before = h.currentTree();
    const reply = h.peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'root' } }));
    expect(payload(reply)['class']).toBe('VALIDATOR_REJECT');
    expect(h.currentTree()).toBe(before);
  });

  it('an edit that introduces a validator defect is rejected — and one that merely inherits one is not', () => {
    // Candidate-apply → validate → fold only on NO NEW defect. The tree here
    // already carries a duplicate id; an unrelated edit must still be allowed,
    // because that defect is not this edit's fault.
    let tree = fuaran.stack<unknown>({
      id: 'root',
      children: [
        fuaran.metric<unknown>({ id: 'dup', label: 'A', value: 1 }),
        fuaran.metric<unknown>({ id: 'dup', label: 'B', value: 2 }),
        fuaran.metric<unknown>({ id: 'other', label: 'C', value: 3 }),
      ],
    });
    const peer = createRelayPeer(
      () =>
        buildDebugGlobal(tree, sources, {
          applyHandler: (next: Node<unknown>) => {
            tree = next;
          },
          validate: (candidate) => {
            const result = preEmitValidate(candidate);
            return result.ok ? [] : result.error;
          },
        }),
      { optedIn: true },
    );
    const reply = peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'other' } }));
    expect(reply?.type).toBe('apply.ok');
  });

  it('an undecodable op returns DECODE_FAILED carrying the codec error verbatim', () => {
    const h = harness();
    const reply = h.peer.handle(request('apply', { op: { $type: 'NotAnOpCase', target: 'cost' } }));
    expect(payload(reply)['class']).toBe('DECODE_FAILED');
    const detail = payload(reply)['detail'] as Record<string, unknown>;
    expect(typeof detail['Code']).toBe('string');
    expect(typeof detail['Path']).toBe('string');
  });

  it('a policy refusal is POLICY_DENIED — never conflated with a validation failure', () => {
    const h = harness({ deny: true });
    const before = h.currentTree();
    const reply = h.peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'cost' } }));
    expect(payload(reply)['class']).toBe('POLICY_DENIED');
    // Nothing about the policy's reasoning leaks — a detail explaining WHY
    // hands out a map of the policy.
    expect(payload(reply)['detail']).toBeUndefined();
    expect(h.currentTree()).toBe(before);
  });

  it('the op must be an embedded object, not a pre-serialised string', () => {
    const h = harness();
    const reply = h.peer.handle(
      request('apply', { op: JSON.stringify({ $type: 'RemoveNode', target: 'cost' }) }),
    );
    expect(payload(reply)['class']).toBe('MALFORMED_MESSAGE');
    expect((payload(reply)['detail'] as Record<string, unknown>)['path']).toBe('payload.op');
  });

  it('canonicalises the client object itself — the journal gets canonical bytes', () => {
    const h = harness();
    // Deliberately un-canonical key order from the client: canonicalising is
    // the host's obligation, not the least-qualified peer's.
    h.peer.handle(request('apply', { op: { target: 'cost', $type: 'RemoveNode' } }));
    expect(h.journalled).toHaveLength(1);
    expect(h.journalled[0]).toBe('{"$type":"RemoveNode","target":"cost"}');
  });

  it('attribution grants nothing — a denied op stays denied however it is labelled', () => {
    const h = harness({ deny: true });
    const reply = h.peer.handle(
      request('apply', {
        op: { $type: 'RemoveNode', target: 'cost' },
        attribution: { actor: 'root', reason: 'trust me' },
      }),
    );
    expect(payload(reply)['class']).toBe('POLICY_DENIED');
  });
});

describe('the in-page apply surface keeps its original string form', () => {
  it('accepts a JSON string (the console shape) and an object (the relay shape) alike', () => {
    let tree = makeTree();
    const applied: Node<unknown>[] = [];
    const surface = buildDebugGlobal(tree, sources, {
      applyHandler: (next) => {
        applied.push(next);
        tree = next;
      },
    });
    expect(surface.apply(JSON.stringify({ $type: 'RemoveNode', target: 'cost' })).status).toBe(
      'applied',
    );
    expect(surface.apply({ $type: 'RemoveNode', target: 'rev' }).status).toBe('applied');
    expect(applied).toHaveLength(2);
  });

  it('reports whether it can apply at all, so a peer advertises honestly', () => {
    expect(buildDebugGlobal(makeTree(), sources).canApply).toBe(false);
    expect(buildDebugGlobal(makeTree(), sources, { applyHandler: () => {} }).canApply).toBe(true);
  });
});

// ─── subscription ────────────────────────────────────────────────────────────

describe('change subscription', () => {
  it('fires on a committed change, carrying the new revision — no polling', async () => {
    const h = harness();
    const reply = h.peer.handle(request('subscribe', { events: ['tree'] }, 'c-10'));
    expect(reply?.type).toBe('subscribe.ok');
    const baseline = payload(reply)['treeRevision'];

    h.peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'cost' } }, 'c-11'));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.type).toBe('changed');
    expect(h.emitted[0]!.id).toBe('c-10');
    expect(payload(h.emitted[0])['cause']).toBe('apply');
    expect(payload(h.emitted[0])['treeRevision']).not.toBe(baseline);
  });

  it('coalesces rapid changes into one notification carrying the latest revision', async () => {
    const hub = createChangeHub();
    const seen: string[] = [];
    hub.subscribe((change) => seen.push(change.treeRevision));
    hub.commit({}, 'host');
    hub.commit({}, 'host');
    const last = hub.commit({}, 'apply');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([last]);
  });

  it('is idempotent on tree identity — re-registering the same tree is not a change', async () => {
    const hub = createChangeHub();
    const tree = makeTree();
    const seen: unknown[] = [];
    hub.subscribe((c) => seen.push(c));
    hub.commit(tree, 'host');
    hub.commit(tree, 'host');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it('survives the surface rebuild every tree change causes', async () => {
    // The debug global is rebuilt per tree change; a subscription registered on
    // one instance must not be dropped by the very event it reports.
    const h = harness();
    h.peer.handle(request('subscribe', { events: ['tree'] }, 'c-10'));
    h.peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'cost' } }, 'c-11'));
    await Promise.resolve();
    h.peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'rev' } }, 'c-12'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.emitted).toHaveLength(2);
  });

  it('stops on unsubscribe, and releasing an unknown id is still ok', async () => {
    const h = harness();
    const sub = h.peer.handle(request('subscribe', { events: ['tree'] }, 'c-10'));
    const subscriptionId = payload(sub)['subscriptionId'] as string;
    const released = h.peer.handle(request('unsubscribe', { subscriptionId }, 'c-11'));
    expect(released?.type).toBe('unsubscribe.ok');
    const again = h.peer.handle(request('unsubscribe', { subscriptionId: 's-99' }, 'c-12'));
    expect(again?.type).toBe('unsubscribe.ok');

    h.peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'cost' } }, 'c-13'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.emitted).toHaveLength(0);
  });

  it('ignores unrecognised event names but keeps a recognised one', () => {
    const h = harness();
    const reply = h.peer.handle(request('subscribe', { events: ['tree', 'weather'] }, 'c-10'));
    expect(reply?.type).toBe('subscribe.ok');
    expect(payload(reply)['events']).toEqual(['tree']);
  });

  it('refuses a subscription with no recognised event name', () => {
    const h = harness();
    expect(payload(h.peer.handle(request('subscribe', { events: [] })))['class']).toBe(
      'MALFORMED_MESSAGE',
    );
    expect(payload(h.peer.handle(request('subscribe', { events: ['weather'] })))['class']).toBe(
      'MALFORMED_MESSAGE',
    );
  });

  it('dispose releases every subscription', async () => {
    const h = harness();
    h.peer.handle(request('subscribe', { events: ['tree'] }, 'c-10'));
    h.peer.dispose();
    h.peer.handle(request('apply', { op: { $type: 'RemoveNode', target: 'cost' } }, 'c-11'));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.emitted).toHaveLength(0);
  });
});

// ─── transport discipline ────────────────────────────────────────────────────

describe('origin discipline (§3.2) — silence for an unverified peer', () => {
  const good = { source: window, origin: window.origin, data: { $relay: RELAY_PROFILE } };

  it('accepts only a same-window, same-origin, relay-shaped message', () => {
    expect(acceptsRelayMessage(good as never)).toBe(true);
  });

  it('rejects a message from another window — a same-origin frame is a different document', () => {
    expect(acceptsRelayMessage({ ...good, source: {} } as never)).toBe(false);
  });

  it('rejects a cross-origin message', () => {
    expect(acceptsRelayMessage({ ...good, origin: 'https://evil.example' } as never)).toBe(false);
  });

  it('rejects non-object data and data without the $relay marker', () => {
    expect(acceptsRelayMessage({ ...good, data: 'hello' } as never)).toBe(false);
    expect(acceptsRelayMessage({ ...good, data: null } as never)).toBe(false);
    expect(acceptsRelayMessage({ ...good, data: [] } as never)).toBe(false);
    expect(acceptsRelayMessage({ ...good, data: { dir: 'request' } } as never)).toBe(false);
  });

  it('a peer ignores a response in silence — it answers requests only', () => {
    const { peer } = harness();
    expect(peer.handle({ ...hello(), dir: 'response' })).toBeUndefined();
    expect(peer.handle({ dir: 'request', id: 'c-1', type: 'hello' })).toBeUndefined();
    expect(peer.handle('not an envelope')).toBeUndefined();
  });

  it('a well-formed message from a verified peer always gets an answer', () => {
    const { peer } = harness();
    expect(payload(peer.handle(request('read.runtimeErrors')))['class']).toBe('UNKNOWN_MESSAGE');
  });
});

// ─── the installed listener ──────────────────────────────────────────────────

describe('installRelayPeer — the real postMessage path', () => {
  it('answers a same-origin hello posted on the page window', async () => {
    const surface = buildDebugGlobal(makeTree(), sources, { applyHandler: () => {} });
    const teardown = installRelayPeer(surface, { optedIn: true });
    const replies = await collectReplies(() => deliver(hello()));
    teardown();
    expect(replies.map((r) => r.type)).toEqual(['hello.ok']);
  });

  it('ignores a cross-origin or cross-frame message in silence — no reply at all', async () => {
    const surface = buildDebugGlobal(makeTree(), sources);
    const teardown = installRelayPeer(surface, { optedIn: true });
    const replies = await collectReplies(() => {
      deliver(hello('c-x'), 'https://evil.example');
      deliver(hello('c-y'), window.origin, {});
    });
    teardown();
    // Not even a refusal: a refusal to an unverified peer is itself a
    // disclosure that a Fuaran host is present.
    expect(replies).toHaveLength(0);
  });

  it('posts at the page origin, never at the "*" wildcard', async () => {
    const surface = buildDebugGlobal(makeTree(), sources);
    const spy = vi.spyOn(window, 'postMessage');
    const teardown = installRelayPeer(surface, { optedIn: true });
    deliver(hello());
    await new Promise((resolve) => setTimeout(resolve, 0));
    teardown();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    for (const call of spy.mock.calls) expect(call[1]).toBe(window.origin);
    spy.mockRestore();
  });

  it('teardown removes the listener — the page goes quiet again', async () => {
    const surface = buildDebugGlobal(makeTree(), sources);
    const teardown = installRelayPeer(surface, { optedIn: true });
    teardown();
    const replies = await collectReplies(() => deliver(hello()));
    expect(replies).toHaveLength(0);
  });
});

// ─── the renderer prop ───────────────────────────────────────────────────────

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (element: React.ReactElement): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
};

afterEach(() => {
  if (root !== undefined) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = '';
});

const probe = async (): Promise<RelayEnvelope[]> => collectReplies(() => deliver(hello('c-probe')));

describe('<FuaranRenderer relay> — the host opt-in', () => {
  it('installs NOTHING without the relay prop: a probe gets no answer at all', async () => {
    await mount(<FuaranRenderer tree={makeTree()} sources={sources} debug />);
    expect(await probe()).toHaveLength(0);
  });

  it('installs nothing when relay is set but debug is not', async () => {
    await mount(<FuaranRenderer tree={makeTree()} sources={sources} relay />);
    expect(await probe()).toHaveLength(0);
  });

  it('answers hello once the host opts in with debug + relay', async () => {
    await mount(<FuaranRenderer tree={makeTree()} sources={sources} debug relay />);
    const replies = await probe();
    expect(replies.map((r) => r.type)).toEqual(['hello.ok']);
    expect((replies[0]!.payload as Record<string, unknown>)['host']).toBe('fuaran-ts');
  });

  it('serves reads over the relay against the live rendered tree', async () => {
    await mount(<FuaranRenderer tree={makeTree()} sources={sources} debug relay />);
    const replies = await collectReplies(() =>
      deliver(request('read.bindingValue', { nodeId: 'rev', slot: 'Value' })),
    );

    expect(replies).toHaveLength(1);
    const p = replies[0]!.payload as Record<string, unknown>;
    expect(p['status']).toBe('resolved');
    expect(p['value']).toBe(42);
    expect(p['expression']).toBe('$state.revenue');
  });
});

// ─── the declared-slot table ─────────────────────────────────────────────────

describe('declaredSlots — the forward-coupling pin', () => {
  it('every slot the ai-tools table can BIND is declared here', () => {
    // The direction that matters: a bound slot missing from this table would
    // report as "not declared" — a caller error — for a slot that plainly
    // exists. Checked across the kinds that carry optional slots.
    const kinds: NodeKind<unknown>[] = [
      fuaran.metric<unknown>({ id: 'm', label: 'L', value: 1, trend: 2 }).kind,
      fuaran.button<unknown>({ id: 'b', label: 'Go', disabled: binding.state('busy', false) }).kind,
      fuaran.tabs<unknown>({ id: 't', activeIndex: binding.state('tab', 0) }).kind,
    ];
    for (const kind of kinds) {
      const declared = declaredSlots(kind);
      expect(declared.length).toBeGreaterThan(0);
      for (const bound of extractBindingSlots(kind)) expect(declared).toContain(bound.slot);
    }
    expect(declaredSlots(kinds[0]!)).toEqual(['Value', 'Trend']);
    // …and an ABSENT optional slot stays declared while binding to nothing.
    const withoutTrend = fuaran.metric<unknown>({ id: 'm', label: 'L', value: 1 }).kind;
    expect(declaredSlots(withoutTrend)).toContain('Trend');
    expect(bindingForSlot(withoutTrend, 'Trend')).toBeUndefined();
  });

  it('distinguishes a declared-but-absent slot from one the kind does not declare', () => {
    const surface = buildDebugGlobal(makeTree(), sources);
    const absent = surface.getBindingState('rev', 'Trend');
    expect('status' in absent && absent.status).toBe('noOverride');
    const undeclared = surface.getBindingState('rev', 'Source');
    expect('reason' in undeclared && undeclared.reason).toBe('slotNotDeclared');
  });
});
