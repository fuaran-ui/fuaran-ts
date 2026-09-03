// ============================================================================
//  DevTools relay conformance — the `devtools-relay/` fixture family, run
//  against this host's page peer.
//
//  The corpus is self-enumerated: `wire-format-fixtures/devtools-relay/` has
//  its own manifest and is deliberately absent from the corpus root manifest,
//  because a relay exchange is not a codec round-trip and every codec host's
//  runner dispatches on the root manifest's `kind`.
//
//  These are SHAPE fixtures, not byte-parity fixtures: revision tokens,
//  geometry numbers, resolved binding values and human-readable messages are
//  environment-specific and legitimately differ. The runner therefore asserts
//  structure + enumerated values, and a fixture's representative numbers are
//  compared by JSON type only — asserting byte-equality on them would test the
//  fixture author's choices rather than this implementation.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Node } from '@fuaran-ui/schema';
import { binding, column, fuaran, preEmitValidate } from '@fuaran-ui/ui';

import {
  type BindingSources,
  buildDebugGlobal,
  type ChangeHub,
  createChangeHub,
  createRelayPeer,
  FuaranRenderer,
  RELAY_PROFILE,
  type RelayEnvelope,
  type RelayPeer,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/renderer/test → workspace-root/wire-format-fixtures/devtools-relay
const fixturesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'devtools-relay');

interface ManifestEntry {
  readonly id: string;
  readonly kind: 'relay-exchange' | 'relay-refusal' | 'relay-event';
  readonly requestFile?: string;
  readonly responseFile?: string;
  readonly eventFile?: string;
  readonly expectedClass?: string;
}

const manifest = JSON.parse(readFileSync(join(fixturesDir, 'manifest.json'), 'utf8')) as {
  readonly profile: string;
  readonly fixtures: readonly ManifestEntry[];
};

const readFixture = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixturesDir, file), 'utf8')) as Record<string, unknown>;

// ─── the scenario tree the fixtures address ──────────────────────────────────

interface Channel {
  readonly name: string;
}

/**
 * A tree carrying every node the fixture family names: `metric-1` (a State
 * binding on `Value`, and NO `Trend` — the declared-but-absent slot the
 * `noOverride` fixture asks for), `metric-2`, `grid-1` with one column (the
 * `Columns[0].Label` edit's target), and `metric-9`, which is in the tree but
 * whose element the runner removes from the DOM to model "not currently
 * rendered".
 */
const makeTree = (): Node<unknown> =>
  fuaran.stack<unknown>({
    id: 'root',
    children: [
      fuaran.metric<unknown>({
        id: 'metric-1',
        label: 'Revenue',
        value: binding.state('revenue', 0),
      }),
      fuaran.metric<unknown>({ id: 'metric-2', label: 'Cost', value: 7 }),
      fuaran.heading<unknown>({ id: 'metric-9', text: 'Offscreen', level: 3 }),
      fuaran.grid<Channel, unknown>({
        id: 'grid-1',
        source: binding.query('channels', (raw: unknown) => raw as readonly Channel[]),
        rowKey: (row) => row.name,
        columns: [column.text<Channel, unknown>('Channel', (row) => row.name)],
      }),
    ],
  });

const sources: BindingSources = { state: { revenue: 42 } };

interface Harness {
  readonly peer: RelayPeer;
  readonly hub: ChangeHub;
  readonly emitted: RelayEnvelope[];
  currentTree(): Node<unknown>;
}

interface HarnessOptions {
  readonly optedIn?: boolean;
  readonly readOnly?: boolean;
  readonly denyPolicy?: boolean;
  /**
   * Make the surface unable to render a node in the wire vocabulary — the
   * `ENCODE_FAILED` world (§9.3).
   *
   * This host's own surface can never produce that outcome: the canonical
   * encoder is TOTAL over live trees, since a value the wire format cannot carry
   * becomes a sentinel string rather than a refusal. So the class is exercised at
   * the SEAM, which is the technique the corpus already uses for `DECODE_FAILED`
   * and `VALIDATOR_REJECT` (the apply handler is stubbed there, the node-json leg
   * here). What the fixture proves is the peer's mapping from that surface
   * outcome onto the refusal class — exactly what a future host with a wider
   * local vocabulary than the wire's would depend on.
   */
  readonly encodeFails?: boolean;
}

/**
 * A miniature host: a mutable current tree, a surface REBUILT per request (as
 * the renderer rebuilds it per tree change), and a hub that outlives both — so
 * a subscription established through the peer survives the edits it reports.
 */
const harness = (options: HarnessOptions = {}): Harness => {
  let tree = makeTree();
  const hub = createChangeHub();
  const emitted: RelayEnvelope[] = [];
  hub.commit(tree, 'host');

  const baseSurface = () =>
    buildDebugGlobal(tree, sources, {
      hub,
      runtime: { canDispatch: () => options.denyPolicy !== true, warn: () => {} },
      validate: (candidate) => {
        const result = preEmitValidate(candidate);
        return result.ok ? [] : result.error;
      },
      ...(options.readOnly === true
        ? {}
        : {
            applyHandler: (next: Node<unknown>) => {
              tree = next;
            },
          }),
    });

  const surface = () =>
    options.encodeFails === true
      ? {
          ...baseSurface(),
          getNodeJson: (nodeId: string) => ({
            error: `Node '${nodeId}' has no canonical wire encoding on this host.`,
            reason: 'encodeFailed' as const,
            nodeId,
          }),
        }
      : baseSurface();

  const peer = createRelayPeer(surface, {
    optedIn: options.optedIn ?? true,
    hostVersion: '0.2.0',
    ...(options.readOnly === true ? { offerSubscribe: false } : {}),
    emit: (event) => emitted.push(event),
  });

  return { peer, hub, emitted, currentTree: () => tree };
};

/** Which harness each fixture needs — the default is an opted-in, apply-capable host. */
const harnessFor = (id: string): Harness => {
  switch (id) {
    // A read-only host is fully conformant: five reads, no apply, no subscribe.
    case 'hello-read-only':
    case 'refusal-capability-absent':
      return harness({ readOnly: true });
    case 'refusal-not-opted-in':
      return harness({ optedIn: false });
    case 'refusal-policy-denied':
      return harness({ denyPolicy: true });
    case 'refusal-encode-failed':
      return harness({ encodeFails: true });
    default:
      return harness();
  }
};

// ─── shape assertion ─────────────────────────────────────────────────────────

/** `ExpectedShape` is optional in the DecodeError envelope; op-side rejects omit it. */
const OPTIONAL_KEYS = new Set(['ExpectedShape']);

/**
 * Assert `actual` carries every field `expected` declares, with the same JSON
 * type. Values are NOT compared — the per-fixture assertions below pin the ones
 * that carry meaning (enumerated values, echoes of the request).
 */
const assertShape = (expected: unknown, actual: unknown, path: string): void => {
  if (expected === null) return;
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
    const actualArray = actual as unknown[];
    expected.forEach((item, i) => {
      if (i < actualArray.length) assertShape(item, actualArray[i], `${path}[${i}]`);
    });
    return;
  }
  if (typeof expected === 'object') {
    expect(typeof actual, `${path} should be an object`).toBe('object');
    expect(actual, `${path} should not be null`).not.toBeNull();
    const actualObject = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (OPTIONAL_KEYS.has(key) && !(key in actualObject)) continue;
      expect(key in actualObject, `${path}.${key} should be present`).toBe(true);
      assertShape(value, actualObject[key], `${path}.${key}`);
    }
    return;
  }
  expect(typeof actual, `${path} should be a ${typeof expected}`).toBe(typeof expected);
};

const payloadOf = (envelope: RelayEnvelope): Record<string, unknown> =>
  envelope.payload as Record<string, unknown>;

/**
 * The value assertions the fixtures genuinely pin: enumerated values, echoes of
 * the request, and the capability sets. Everything else is shape.
 */
const assertMeaning = (id: string, envelope: RelayEnvelope): void => {
  const p = payloadOf(envelope);
  switch (id) {
    case 'hello-read-only':
      expect(p['capabilities']).toEqual([
        'read.nodeState',
        'read.bindingValue',
        'read.renderedDom',
        'read.tree',
        'read.findNodes',
      ]);
      expect(p['profile']).toBe('relay@1.0');
      break;
    case 'hello-apply-capable':
      expect(p['capabilities']).toContain('apply');
      expect(p['capabilities']).toContain('subscribe');
      expect(p['profile']).toBe('relay@1.0');
      // A `relay@1.0` session must NOT be told about a `relay@1.3` entry point:
      // the type does not exist in the profile this client speaks, so naming it
      // would advertise something that client's own contract says is not there
      // (§6.3). This is the backward-compatibility evidence the unchanged 1.0
      // fixtures exist to carry.
      expect(p['capabilities']).not.toContain('read.nodeJson');
      break;
    case 'hello-node-json':
      // …and a `relay@1.3` session IS told about it.
      expect(p['profile']).toBe('relay@1.3');
      expect(p['capabilities']).toContain('read.nodeJson');
      break;
    case 'read-node-json':
      // The node's own wire JSON, embedded as an object (§7.7 rule 1).
      expect((p['node'] as Record<string, unknown>)['id']).toBe('grid-1');
      expect(typeof (p['node'] as Record<string, unknown>)['kind']).toBe('object');
      expect(typeof p['treeRevision']).toBe('string');
      break;
    case 'read-node-json-subtree':
      expect((p['node'] as Record<string, unknown>)['id']).toBe('root');
      // Rule 3 — the WHOLE subtree, never elided. An elided encoding is
      // well-formed wire JSON for a DIFFERENT node, which is precisely the
      // silent-discard class this entry point exists to close, so a check that
      // only looked at well-formedness would pass the thing being guarded
      // against. Every child this host reports for the node must be inside the
      // encoding it returned for it.
      for (const childId of ['metric-1', 'metric-2', 'metric-9', 'grid-1'])
        expect(JSON.stringify(p['node']), `child ${childId} elided`).toContain(`"${childId}"`);
      break;
    case 'read-node-state':
      expect(p['id']).toBe('metric-1');
      expect(p['kind']).toBe('Metric');
      expect((p['bindings'] as { slot: string; source: string }[])[0]).toEqual({
        slot: 'Value',
        expression: '$state.revenue',
        source: 'State',
      });
      break;
    case 'read-tree':
      expect(p['id']).toBe('root');
      expect(p['childIds']).toContain('grid-1');
      expect((p['children'] as unknown[]).length).toBe((p['childIds'] as unknown[]).length);
      break;
    case 'read-binding-value-resolved':
      expect(p['status']).toBe('resolved');
      expect(p['expression']).toBe('$state.revenue');
      expect(p['source']).toBe('State');
      expect(p['value']).toBe(42);
      break;
    case 'read-binding-value-no-override':
      // The slot is declared on Metric and holds nothing — a STATE, distinct
      // from the SLOT_NOT_DECLARED refusal.
      expect(p['status']).toBe('noOverride');
      expect(p['expression']).toBe('$none');
      break;
    case 'read-find-nodes':
      expect(p['nodeIds']).toEqual(['metric-1', 'metric-2']);
      break;
    case 'read-find-nodes-empty':
      expect(p['nodeIds']).toEqual([]);
      break;
    case 'apply-accepted':
      expect(p['applied']).toBe(true);
      break;
    case 'subscribe':
      expect(p['subscriptionId']).toBe('s-1');
      expect(p['events']).toEqual(['tree']);
      break;
    case 'unsubscribe':
      // Releasing an unknown subscription is `ok`, not a refusal.
      expect(p['subscriptionId']).toBe('s-1');
      break;
    case 'refusal-capability-absent':
      expect((p['detail'] as Record<string, unknown>)['capability']).toBe('apply');
      break;
    case 'refusal-unknown-message':
      expect(p['requestType']).toBe('read.runtimeErrors');
      expect((p['detail'] as Record<string, unknown>)['received']).toBe('read.runtimeErrors');
      break;
    case 'refusal-foreign-profile':
      expect((p['detail'] as Record<string, unknown>)['received']).toBe('relay@2.0');
      // `supported` is the PEER's own list, not the fixture's (§12.1): comparing
      // it against the fixture asserts the fixture author's version rather than
      // this implementation's conformance, and fails every peer that ever
      // advances a minor.
      expect((p['detail'] as Record<string, unknown>)['supported']).toEqual([RELAY_PROFILE]);
      break;
    case 'refusal-malformed-message':
      expect((p['detail'] as Record<string, unknown>)['path']).toBe('payload.events');
      break;
    case 'refusal-node-not-found':
      expect((p['detail'] as Record<string, unknown>)['nodeId']).toBe('metric-9');
      expect((p['detail'] as Record<string, unknown>)['reason']).toBe('not-rendered');
      break;
    case 'refusal-slot-not-declared':
      expect(p['detail']).toEqual({ nodeId: 'metric-1', slot: 'Source', kind: 'Metric' });
      break;
    default:
      break;
  }
};

// ─── the run ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  // A real render, so `read.renderedDom` reads a real element…
  document.body.innerHTML = renderToStaticMarkup(<FuaranRenderer tree={makeTree()} />);
  // …and `metric-9` is in the tree but not on screen (a collapsed branch, a
  // virtualised row) — the case whose refusal carries `reason: "not-rendered"`.
  document.querySelector('[data-fuaran-node-id="metric-9"]')?.remove();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe(`devtools-relay corpus (${manifest.profile})`, () => {
  it('enumerates the whole family', () => {
    expect(manifest.profile).toBe('relay@1.3');
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(28);
  });

  const exchanges = manifest.fixtures.filter((f) => f.kind !== 'relay-event');

  for (const fixture of exchanges) {
    it(`${fixture.kind} — ${fixture.id}`, () => {
      const request = readFixture(fixture.requestFile!);
      const expected = readFixture(fixture.responseFile!);
      const { peer } = harnessFor(fixture.id);

      const actual = peer.handle(request);
      expect(
        actual,
        'a well-formed request from a verified peer always gets an answer',
      ).toBeDefined();
      if (actual === undefined) return;

      // The regular protocol: success is the request type + '.ok'; refusal is
      // always 'refusal'. There is no third outcome.
      // `$relay` on a response is the RESPONDING PEER's own profile id (§4), not
      // the fixture's. A `relay@1.0` fixture answered by a `relay@1.3` peer
      // carries two different ids by construction and both are correct.
      expect(actual.$relay).toBe(RELAY_PROFILE);
      expect(actual.dir).toBe('response');
      expect(actual.id).toBe(request['id']);
      expect(actual.type).toBe(expected['type']);
      if (fixture.kind === 'relay-refusal') {
        expect(actual.type).toBe('refusal');
        expect(payloadOf(actual)['class']).toBe(fixture.expectedClass);
        expect(payloadOf(actual)['requestType']).toBe(request['type']);
      } else {
        expect(actual.type).toBe(`${String(request['type'])}.ok`);
      }

      assertShape(expected['payload'], actual.payload, `${fixture.id}.payload`);
      assertMeaning(fixture.id, actual);
    });
  }

  // ── relay-event fixtures — produced, not merely accepted ───────────────────
  //
  // The corpus frames these as envelopes a CLIENT must accept. A page peer can
  // do better than accept them: it can be made to emit them, which is the only
  // evidence that `subscribe` actually fires on a committed change.

  const eventFixtures = manifest.fixtures.filter((f) => f.kind === 'relay-event');

  for (const fixture of eventFixtures) {
    it(`relay-event — ${fixture.id}`, async () => {
      const expected = readFixture(fixture.eventFile!);
      const { peer, hub, emitted } = harness();

      const subscribed = peer.handle({
        $relay: 'relay@1.0',
        dir: 'request',
        id: 'c-10',
        type: 'subscribe',
        payload: { events: ['tree'] },
      });
      expect(subscribed?.type).toBe('subscribe.ok');

      if (fixture.id === 'changed-apply') {
        const applied = peer.handle({
          $relay: 'relay@1.0',
          dir: 'request',
          id: 'c-9',
          type: 'apply',
          payload: { op: { $type: 'RemoveNode', target: 'metric-2' } },
        });
        expect(applied?.type).toBe('apply.ok');
      } else {
        // A change the host made itself.
        hub.commit(makeTree(), 'host');
      }

      // Notification coalesces onto the microtask queue.
      await Promise.resolve();
      await Promise.resolve();

      expect(emitted.length).toBe(1);
      const event = emitted[0]!;
      expect(event.dir).toBe('event');
      expect(event.type).toBe('changed');
      // The event carries the id of the subscribe request that established it.
      expect(event.id).toBe('c-10');
      assertShape(expected['payload'], event.payload, `${fixture.id}.payload`);
      expect(payloadOf(event)['cause']).toBe(
        (expected['payload'] as Record<string, unknown>)['cause'],
      );
      expect(payloadOf(event)['event']).toBe('tree');
      expect(payloadOf(event)['subscriptionId']).toBe('s-1');
    });
  }
});
