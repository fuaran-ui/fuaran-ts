// ============================================================================
//  @fuaran-ui/renderer/relay — the page peer of the DevTools relay contract.
//
//  A `postMessage` envelope that carries this host's already-shipped in-page
//  introspection surface (`window.__fuaran`, see debugGlobal.ts) across the
//  page/extension boundary, so a browser extension — or any other same-page
//  script — can inspect, and where the host permits edit, a live Fuaran UI.
//
//  The contract is specified language-neutrally in the wire-format
//  specification repository (`DEVTOOLS_RELAY.md`, profile `relay@1.3`) with an
//  executable fixture family beside it; this module is written to that document
//  and pinned against those fixtures in `test/relayCorpus.test.tsx`. Section
//  references in the comments below are to that document.
//
//  Three properties are load-bearing and easy to lose in a refactor:
//
//  * OFF BY DEFAULT (§11.1). `createRelayPeer` is not opted in unless told to
//    be, and the renderer installs no listener at all unless a host asks for
//    one. The preferred production posture is ABSENCE — no listener, so a probe
//    gets no answer whatsoever; the opted-out peer, which answers NOT_OPTED_IN,
//    is the honest-client posture for a development build.
//  * NO SIDE DOOR (§11.3). Every mutation crosses the host's own decode →
//    validate → policy path, in the page. This module contributes no apply
//    engine, no validator, and no policy of its own — it maps outcomes onto
//    refusal classes and nothing more.
//  * SILENCE FOR UNVERIFIED PEERS (§3.2, §11.4). A message failing the origin
//    checks gets no reply — not even a refusal, which would itself disclose
//    that a Fuaran host is here.
// ============================================================================

import type { TreeIntrospection } from '@fuaran-ui/ai-tools';

import type {
  ApplyEnvelope,
  BindingState,
  FuaranDebugGlobal,
  NodeGeometry,
  NodeJsonError,
  TreeOpJson,
} from './debugGlobal.js';

/**
 * The relay profile this peer speaks — the HIGHEST it can serve. A client that
 * accepts only an earlier minor of the same major is answered at that minor
 * (§6.3, and see `selectProfile`), so advancing this is additive for every
 * existing client.
 */
export const RELAY_PROFILE = 'relay@1.3';

/** The envelope field whose presence marks a message as a relay message (§3.2, §4). */
export const RELAY_KEY = '$relay';

/** The version of the underlying in-page surface shape, reported in `hello.ok`. */
const SURFACE_VERSION = '0.2.0';

/** The host implementation identifier, reported in `hello.ok`. Opaque to clients. */
const HOST_NAME = 'fuaran-ts';

export type RelayDirection = 'request' | 'response' | 'event';

/**
 * The closed capability set (§4.2) — each named for the request type it gates.
 *
 * The set is the CONTRACT's, not this host's: `read.affordances` is listed
 * because the contract defines it, and this peer must therefore refuse it with
 * `CAPABILITY_ABSENT` (the entry point exists, this host does not offer it)
 * rather than `UNKNOWN_MESSAGE` (which would tell the client, falsely, that no
 * such entry point exists). §6.4 makes a peer that offers only some of these
 * fully conformant.
 */
export type RelayCapability =
  | 'read.nodeState'
  | 'read.bindingValue'
  | 'read.renderedDom'
  | 'read.tree'
  | 'read.findNodes'
  | 'read.affordances'
  | 'read.nodeJson'
  | 'apply'
  | 'subscribe';

/** The closed refusal-class set (§9.3). A client branches on this, never on `message`. */
export type RelayRefusalClass =
  | 'NOT_OPTED_IN'
  | 'FOREIGN_PROFILE'
  | 'UNKNOWN_MESSAGE'
  | 'MALFORMED_MESSAGE'
  | 'CAPABILITY_ABSENT'
  | 'NODE_NOT_FOUND'
  | 'SLOT_NOT_DECLARED'
  | 'DECODE_FAILED'
  | 'VALIDATOR_REJECT'
  | 'POLICY_DENIED'
  | 'ENCODE_FAILED';

/** Every relay message — request, response, and event alike (§4). */
export interface RelayEnvelope {
  readonly $relay: string;
  readonly dir: RelayDirection;
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Where a peer's surface comes from: a fixed surface, or a lookup evaluated per request. */
export type RelaySurfaceSource = FuaranDebugGlobal | (() => FuaranDebugGlobal | undefined);

export interface RelayPeerOptions {
  /**
   * Whether the host has opted into relay exposure. **Defaults to `false`** —
   * an opted-out peer answers every request, including `hello`, with
   * `NOT_OPTED_IN` and reaches the surface for nothing (§11.1).
   */
  readonly optedIn?: boolean;
  /** Advertise (and serve) `apply`. Defaults to whether the surface wired an apply path. */
  readonly offerApply?: boolean;
  /** Advertise (and serve) `subscribe` / `unsubscribe`. Defaults to `true` when opted in. */
  readonly offerSubscribe?: boolean;
  /** The `hostVersion` reported in `hello.ok`. Informational. */
  readonly hostVersion?: string;
  /** Where `changed` events go. Defaults to `window.postMessage` at the page's own origin. */
  readonly emit?: (event: RelayEnvelope) => void;
}

/** The page peer: a message handler plus the subscriptions it owns. */
export interface RelayPeer {
  /**
   * Handle one inbound message. Returns the response envelope to post back, or
   * `undefined` when the message must be ignored **in silence** (§3.2) — not a
   * relay message, not a request, or uncorrelatable.
   */
  handle(message: unknown): RelayEnvelope | undefined;
  /** The capabilities this peer currently advertises (§6.3). */
  capabilities(): readonly RelayCapability[];
  /** Release every subscription. Called on page unload by `installRelayPeer` (§8.5). */
  dispose(): void;
}

// ─── envelope helpers ────────────────────────────────────────────────────────

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const response = (
  id: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): RelayEnvelope => ({ $relay: RELAY_PROFILE, dir: 'response', id, type, payload });

const refusal = (
  id: string,
  requestType: string,
  refusalClass: RelayRefusalClass,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): RelayEnvelope =>
  response(id, 'refusal', {
    class: refusalClass,
    requestType,
    message,
    ...(detail === undefined ? {} : { detail }),
  });

// ─── profile negotiation (§5) ────────────────────────────────────────────────

interface ParsedProfile {
  readonly name: string;
  readonly major: number;
  readonly minor: number;
}

/** Parse `<name>@<major>.<minor>`; `undefined` when the token is not that grammar. */
export const parseRelayProfile = (token: string): ParsedProfile | undefined => {
  const match = /^([A-Za-z][A-Za-z0-9-]*)@(\d+)\.(\d+)$/.exec(token);
  if (match === null) return undefined;
  return { name: match[1]!, major: Number(match[2]), minor: Number(match[3]) };
};

const OWN_PROFILE = parseRelayProfile(RELAY_PROFILE)!;

/**
 * §6.3 — the profile named in `hello.ok` MUST be one the client listed in
 * `accepts`. This picks the HIGHEST profile that is both acceptable to the
 * client and speakable by this peer (same name + major, minor ≤ ours);
 * `undefined` when the client accepts nothing we can speak, which is the
 * `FOREIGN_PROFILE` case.
 *
 * **This is what makes a minor bump additive rather than breaking.** Answering
 * only with `RELAY_PROFILE` — or, equivalently, testing `accepts.includes` —
 * refuses every client whose `accepts` predates our newest minor, which is the
 * entire population a backward-compatible bump exists to keep serving. §5.3
 * says additive change is a minor bump BECAUSE an older peer can ignore what a
 * newer one adds; the same reasoning obliges a newer peer to keep speaking to
 * an older client.
 */
const selectProfile = (accepts: readonly unknown[]): string | undefined => {
  let best: { readonly minor: number; readonly token: string } | undefined;
  for (const token of accepts) {
    if (typeof token !== 'string') continue;
    const parsed = parseRelayProfile(token);
    if (parsed === undefined) continue;
    if (parsed.name !== OWN_PROFILE.name || parsed.major !== OWN_PROFILE.major) continue;
    if (parsed.minor > OWN_PROFILE.minor) continue;
    if (best === undefined || parsed.minor > best.minor) best = { minor: parsed.minor, token };
  }
  return best?.token;
};

/**
 * The minor a peer should answer a message at: the sender's, clamped to this
 * peer's own. A `Behind` sender (a newer minor than ours) is served at ours,
 * which is exactly what "proceed" means in §5.2 — we cannot serve what we do
 * not implement, and the sender is obliged to tolerate the absence (§10.2).
 */
const effectiveMinor = (token: string): number => {
  const parsed = parseRelayProfile(token);
  return parsed === undefined ? 0 : Math.min(parsed.minor, OWN_PROFILE.minor);
};

/**
 * `Current` / `Behind` proceed; `Foreign` — a different name or major — refuses.
 * A newer minor is safe to proceed on because within a major, everything added
 * is something an older peer may ignore (§5.2, §5.3, §10.2).
 */
const isForeign = (token: string): boolean => {
  const parsed = parseRelayProfile(token);
  return (
    parsed === undefined || parsed.name !== OWN_PROFILE.name || parsed.major !== OWN_PROFILE.major
  );
};

// ─── the closed request-type set (§4.2) ──────────────────────────────────────

/** The `relay@1.0` read set — every one of them served by this host. */
const READ_TYPES = [
  'read.nodeState',
  'read.bindingValue',
  'read.renderedDom',
  'read.tree',
  'read.findNodes',
] as const;

/**
 * Reads added after `relay@1.0`, paired with the minor that introduced each and
 * with whether THIS host serves it. Keeping the minor beside the name is what
 * lets `capabilitiesFor` answer a client at the profile it negotiated instead of
 * advertising entry points that do not exist in the profile it speaks.
 *
 * `read.affordances` is listed and NOT served: it must be a recognised type (so
 * the refusal is `CAPABILITY_ABSENT` rather than `UNKNOWN_MESSAGE` — see
 * `RelayCapability`) while remaining an entry point this host does not offer.
 * `relay@1.2` added no request type at all; it added the optional
 * `attribution.actorClass` field (§8.2.1), which this peer reads for nothing
 * (§8.2) and so needs no entry here — which is why the minors skip 2.
 */
const VERSIONED_READ_TYPES = [
  { type: 'read.affordances', since: 1, served: false },
  { type: 'read.nodeJson', since: 3, served: true },
] as const;

const REQUEST_TYPES = new Set<string>([
  ...READ_TYPES,
  ...VERSIONED_READ_TYPES.map((r) => r.type),
  'hello',
  'apply',
  'subscribe',
  'unsubscribe',
]);

/**
 * The capability gating a request type. Every gated type is NAMED for its
 * capability, so authorisation is a set-membership test rather than a lookup
 * table that can drift from its entry points — the one exception being
 * `unsubscribe`, which is governed by `subscribe` (releasing what you
 * established needs no separate permission).
 */
const capabilityFor = (type: string): RelayCapability | undefined =>
  type === 'unsubscribe' ? 'subscribe' : (type as RelayCapability);

// ─── surface-result narrowing ────────────────────────────────────────────────

const isSurfaceError = (x: unknown): x is { readonly error: string } =>
  isObject(x) && typeof x['error'] === 'string';

/**
 * `getNodeJson` returns either the node's wire JSON or a tagged error, and the
 * wire JSON is itself an object — so the discriminator has to be the `reason`
 * tag, not the presence of `error`. A wire node has no `reason` member: the
 * canonical encoding's members are the node's own (`id`, `kind`, …), and `kind`
 * is the discriminated object every wire node carries.
 */
const isNodeJsonError = (x: unknown): x is NodeJsonError =>
  isObject(x) &&
  typeof x['error'] === 'string' &&
  (x['reason'] === 'nodeNotFound' || x['reason'] === 'encodeFailed');

/** The wire form of the codec's decode error (§9.3 carries it verbatim). */
const wireDecodeError = (
  envelope: Extract<ApplyEnvelope, { status: 'decodeFailed' }>,
): Readonly<Record<string, unknown>> | undefined => {
  const e = envelope.decodeError;
  if (e === undefined) return undefined;
  return {
    Code: e.code,
    Path: e.path,
    Message: e.message,
    ...(e.expectedShape === undefined ? {} : { ExpectedShape: e.expectedShape }),
  };
};

// ─── the peer ────────────────────────────────────────────────────────────────

interface Subscription {
  readonly subscriptionId: string;
  readonly requestId: string;
  readonly events: readonly string[];
  readonly release: () => void;
}

/** The event names `relay@1.0` defines (§8.5). Unknown names are ignored, not refused. */
const KNOWN_EVENTS = new Set(['tree']);

const defaultEmit = (event: RelayEnvelope): void => {
  if (typeof window === 'undefined') return;
  window.postMessage(event, window.origin);
};

/**
 * Build a relay page peer over an in-page introspection surface.
 *
 * The peer is **not opted in by default** (§11.1): opting in is a host-side
 * act, and there is no message in the contract that turns the relay on —
 * otherwise the opt-in would be reachable by exactly the peer it protects
 * against.
 */
export const createRelayPeer = (
  surfaceSource: RelaySurfaceSource,
  options: RelayPeerOptions = {},
): RelayPeer => {
  const optedIn = options.optedIn === true;
  const emit = options.emit ?? defaultEmit;
  const subscriptions = new Map<string, Subscription>();
  let subscriptionCounter = 0;

  const surface = (): FuaranDebugGlobal | undefined =>
    typeof surfaceSource === 'function' ? surfaceSource() : surfaceSource;

  /**
   * The capabilities this peer offers AT a given profile minor. A capability
   * introduced after the negotiated minor is not advertised and not served: its
   * request type does not exist in the profile the client speaks, so advertising
   * it would name an entry point the client's own contract says is not there. A
   * client that wants it re-handshakes at the higher minor (§6.3).
   */
  const capabilitiesFor = (minor: number): readonly RelayCapability[] => {
    if (!optedIn) return [];
    const s = surface();
    if (s === undefined) return [];
    const offerApply = options.offerApply ?? s.canApply;
    const offerSubscribe = options.offerSubscribe ?? true;
    return [
      ...READ_TYPES,
      ...VERSIONED_READ_TYPES.filter((r) => r.served && r.since <= minor).map(
        (r) => r.type as RelayCapability,
      ),
      ...(offerApply ? (['apply'] as const) : []),
      ...(offerSubscribe ? (['subscribe'] as const) : []),
    ];
  };

  /**
   * Everything this peer can serve, at its own highest profile — what
   * {@link RelayPeer.capabilities} reports to a host inspecting its own wiring.
   */
  const capabilities = (): readonly RelayCapability[] => capabilitiesFor(OWN_PROFILE.minor);

  const revisionOf = (s: FuaranDebugGlobal): string => s.treeRevision();

  // ── read entry points (§7) ─────────────────────────────────────────────────

  const readNodeState = (
    s: FuaranDebugGlobal,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const nodeId = payload['nodeId'];
    if (typeof nodeId !== 'string')
      return refusal(id, type, 'MALFORMED_MESSAGE', 'nodeId must be a string.', {
        path: 'payload.nodeId',
      });
    const state = s.getNodeState(nodeId);
    if (isSurfaceError(state)) return refusal(id, type, 'NODE_NOT_FOUND', state.error, { nodeId });
    return response(id, `${type}.ok`, {
      id: state.id,
      kind: state.kind,
      bindings: state.bindings.map((b) => ({
        slot: b.slot,
        expression: b.expression,
        source: b.source,
      })),
      childIds: [...state.childIds],
    });
  };

  const readBindingValue = (
    s: FuaranDebugGlobal,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const nodeId = payload['nodeId'];
    const slot = payload['slot'];
    if (typeof nodeId !== 'string')
      return refusal(id, type, 'MALFORMED_MESSAGE', 'nodeId must be a string.', {
        path: 'payload.nodeId',
      });
    if (typeof slot !== 'string')
      return refusal(id, type, 'MALFORMED_MESSAGE', 'slot must be a string.', {
        path: 'payload.slot',
      });

    const state = s.getBindingState(nodeId, slot);
    if ('reason' in state) {
      if (state.reason === 'nodeNotFound')
        return refusal(id, type, 'NODE_NOT_FOUND', state.error, { nodeId });
      return refusal(id, type, 'SLOT_NOT_DECLARED', state.error, {
        nodeId: state.nodeId,
        slot: state.slot,
        kind: state.kind,
      });
    }
    return response(id, `${type}.ok`, bindingStatePayload(state));
  };

  const readRenderedDom = (
    s: FuaranDebugGlobal,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const nodeId = payload['nodeId'];
    if (typeof nodeId !== 'string')
      return refusal(id, type, 'MALFORMED_MESSAGE', 'nodeId must be a string.', {
        path: 'payload.nodeId',
      });
    const geometry = s.getRenderedDom(nodeId);
    if (isSurfaceError(geometry)) {
      // "In the tree but not on screen" and "no such node" are both
      // NODE_NOT_FOUND, distinguished by `reason` so a client can say which
      // (§7.4). The tree is the arbiter, not the DOM.
      const inTree = !isSurfaceError(s.getNodeState(nodeId));
      return refusal(id, type, 'NODE_NOT_FOUND', geometry.error, {
        nodeId,
        ...(inTree ? { reason: 'not-rendered' } : {}),
      });
    }
    const g: NodeGeometry = geometry;
    return response(id, `${type}.ok`, {
      x: g.x,
      y: g.y,
      width: g.width,
      height: g.height,
      overflowing: g.overflowing,
      hidden: g.hidden,
    });
  };

  const readFindNodes = (
    s: FuaranDebugGlobal,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const kind = payload['kind'];
    if (typeof kind !== 'string')
      return refusal(id, type, 'MALFORMED_MESSAGE', 'kind must be a string.', {
        path: 'payload.kind',
      });
    // An unmatched (or unrecognised) kind is `[]`, never a refusal: "which
    // nodes have this kind" has the honest answer "none" (§7.5).
    return response(id, `${type}.ok`, { nodeIds: [...s.findNodes(kind)] });
  };

  /**
   * §7.7 — the addressed node's own canonical wire JSON, plus the revision it
   * was taken at, so a client deriving an edit from this read can tell at commit
   * time whether the tree moved underneath it.
   *
   * The revision is read AFTER the encoding, from the same surface instance the
   * encoding came from, so the pair is a consistent observation rather than two
   * observations of possibly-different trees.
   */
  const readNodeJson = (
    s: FuaranDebugGlobal,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const nodeId = payload['nodeId'];
    if (typeof nodeId !== 'string')
      return refusal(id, type, 'MALFORMED_MESSAGE', 'nodeId must be a string.', {
        path: 'payload.nodeId',
      });

    const node = s.getNodeJson(nodeId);
    if (isNodeJsonError(node))
      // The node exists and this host cannot render it in the wire vocabulary is
      // a DIFFERENT answer from "no such node", and the contract keeps them
      // apart: refusing NODE_NOT_FOUND about a node that is there would send the
      // client looking somewhere else, which is the one remedy that cannot work.
      return refusal(
        id,
        type,
        node.reason === 'encodeFailed' ? 'ENCODE_FAILED' : 'NODE_NOT_FOUND',
        node.error,
        { nodeId },
      );

    return response(id, `${type}.ok`, { node, treeRevision: revisionOf(s) });
  };

  // ── apply (§8) ─────────────────────────────────────────────────────────────

  const applyOp = (
    s: FuaranDebugGlobal,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const op = payload['op'];
    if (!isObject(op))
      return refusal(id, type, 'MALFORMED_MESSAGE', 'op must be an embedded JSON object.', {
        path: 'payload.op',
      });

    // `attribution` is advisory and UNTRUSTED (§8.2): it is read for nothing,
    // grants nothing, and influences no decision below.
    const envelope = s.apply(op as TreeOpJson);
    switch (envelope.status) {
      case 'applied':
        return response(id, `${type}.ok`, {
          applied: true,
          treeRevision: envelope.treeRevision ?? revisionOf(s),
        });
      case 'denied':
        // `detail` stays empty by design — explaining WHY policy refused hands
        // out a map of the policy (§11.5).
        return refusal(id, type, 'POLICY_DENIED', "The host's policy layer refused this mutation.");
      case 'decodeFailed':
        return refusal(
          id,
          type,
          'DECODE_FAILED',
          'The op is not a recognised TreeOp.',
          wireDecodeError(envelope),
        );
      case 'rejected':
        return refusal(
          id,
          type,
          'VALIDATOR_REJECT',
          envelope.error,
          envelope.code === undefined ? undefined : { code: envelope.code },
        );
      case 'unwired':
        // Unreachable while `apply` is advertised only when it is wired; kept
        // so a mis-declared capability still refuses honestly rather than
        // claiming the op was illegal.
        return refusal(id, type, 'CAPABILITY_ABSENT', envelope.error, { capability: 'apply' });
    }
  };

  // ── subscribe / unsubscribe (§8.5) ─────────────────────────────────────────

  const subscribe = (
    s: FuaranDebugGlobal,
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const events = payload['events'];
    if (!Array.isArray(events) || events.length === 0)
      return refusal(id, type, 'MALFORMED_MESSAGE', 'events must be a non-empty array.', {
        path: 'payload.events',
      });
    // Unknown event names are IGNORED, not refused, provided at least one is
    // recognised — that is what makes "additive is a minor bump" safe (§10.2).
    const accepted = events.filter(
      (e): e is string => typeof e === 'string' && KNOWN_EVENTS.has(e),
    );
    if (accepted.length === 0)
      return refusal(id, type, 'MALFORMED_MESSAGE', 'No recognised event name in events.', {
        path: 'payload.events',
      });

    subscriptionCounter += 1;
    const subscriptionId = `s-${subscriptionCounter}`;
    const release = s.subscribe((change) => {
      emit({
        $relay: RELAY_PROFILE,
        dir: 'event',
        // The event carries the id of the `subscribe` request that established
        // it, so a client routes it without holding extra state (§4.1).
        id,
        type: 'changed',
        payload: {
          subscriptionId,
          event: 'tree',
          treeRevision: change.treeRevision,
          cause: change.cause,
        },
      });
    });
    subscriptions.set(subscriptionId, { subscriptionId, requestId: id, events: accepted, release });

    return response(id, `${type}.ok`, {
      subscriptionId,
      events: accepted,
      treeRevision: revisionOf(s),
    });
  };

  const unsubscribe = (
    id: string,
    type: string,
    payload: Record<string, unknown>,
  ): RelayEnvelope => {
    const subscriptionId = payload['subscriptionId'];
    if (typeof subscriptionId !== 'string')
      return refusal(id, type, 'MALFORMED_MESSAGE', 'subscriptionId must be a string.', {
        path: 'payload.subscriptionId',
      });
    // Releasing an unknown or already-released subscription is `ok`, not a
    // refusal — the caller's desired end state is reached either way (§8.5).
    subscriptions.get(subscriptionId)?.release();
    subscriptions.delete(subscriptionId);
    return response(id, `${type}.ok`, { subscriptionId });
  };

  // ── dispatch ───────────────────────────────────────────────────────────────

  const handle = (message: unknown): RelayEnvelope | undefined => {
    if (!isObject(message)) return undefined;
    if (typeof message[RELAY_KEY] !== 'string') return undefined;
    // A peer ignores a direction it does not handle: a page peer serves
    // requests and ignores responses and events (§4, §10.4).
    if (message['dir'] !== 'request') return undefined;

    const id = message['id'];
    const type = message['type'];
    // Without a correlatable id or a type token there is nothing to answer TO;
    // a reply could not be routed, so silence is the only honest outcome.
    if (typeof id !== 'string' || typeof type !== 'string') return undefined;

    // Negotiation runs on EVERY request, not only on `hello` — a client cannot
    // be assumed to keep its profile constant, and the check is a string
    // comparison (§5.2).
    const clientProfile = message[RELAY_KEY] as string;
    if (isForeign(clientProfile))
      return refusal(id, type, 'FOREIGN_PROFILE', 'Incompatible relay profile.', {
        received: clientProfile,
        supported: [RELAY_PROFILE],
      });

    // Opt-out short-circuits everything, including `hello`, and reaches the
    // surface for nothing (§9.3). Nothing about the request is examined.
    if (!optedIn)
      return refusal(id, type, 'NOT_OPTED_IN', 'The relay is not enabled on this host.');

    const payload = message['payload'];
    if (!isObject(payload))
      return refusal(id, type, 'MALFORMED_MESSAGE', 'payload must be an object.', {
        path: 'payload',
      });

    const s = surface();
    if (s === undefined)
      return refusal(id, type, 'NOT_OPTED_IN', 'The relay is not enabled on this host.');

    if (type === 'hello') {
      const accepts = payload['accepts'];
      if (!Array.isArray(accepts) || accepts.length === 0)
        return refusal(id, type, 'MALFORMED_MESSAGE', 'accepts must be a non-empty array.', {
          path: 'payload.accepts',
        });
      // The profile named in `hello.ok` MUST be one the client listed, and the
      // HIGHEST such profile this peer can speak, so a client that predates our
      // newest minor is served rather than refused (§6.3, `selectProfile`).
      const negotiated = selectProfile(accepts);
      if (negotiated === undefined)
        return refusal(id, type, 'FOREIGN_PROFILE', 'Incompatible relay profile.', {
          received: clientProfile,
          supported: [RELAY_PROFILE],
        });
      return response(id, 'hello.ok', {
        host: HOST_NAME,
        hostVersion: options.hostVersion ?? '0.0.0',
        surfaceVersion: SURFACE_VERSION,
        profile: negotiated,
        // Advertised at the NEGOTIATED profile, not ours: naming an entry point
        // the client's own profile does not define tells it something it cannot
        // use.
        capabilities: [...capabilitiesFor(effectiveMinor(negotiated))],
        treeRevision: revisionOf(s),
      });
    }

    // A type outside the closed set is UNKNOWN_MESSAGE; a type INSIDE it whose
    // capability was not advertised is CAPABILITY_ABSENT. Reporting the wrong
    // one tells the client something false — either that a real entry point
    // does not exist, or that a non-existent one is merely switched off (§10.1).
    if (!REQUEST_TYPES.has(type))
      return refusal(id, type, 'UNKNOWN_MESSAGE', 'Unrecognised message type.', { received: type });

    const capability = capabilityFor(type);
    // Re-checked per request: capability advertisement is discovery, not a
    // security boundary, and a client is not a trusted component (§11.3).
    // Checked at the minor the REQUEST declares, so a 1.0 envelope asking for a
    // 1.3 entry point is refused with the same CAPABILITY_ABSENT a genuine 1.0
    // peer would give it — the answer does not depend on which peer happened to
    // receive it (§6.3).
    if (
      capability === undefined ||
      !capabilitiesFor(effectiveMinor(clientProfile)).includes(capability)
    )
      return refusal(
        id,
        type,
        'CAPABILITY_ABSENT',
        `This host does not offer the ${capability ?? type} capability.`,
        { capability: capability ?? type },
      );

    switch (type) {
      case 'read.nodeState':
        return readNodeState(s, id, type, payload);
      case 'read.tree':
        return response(id, `${type}.ok`, treePayload(s));
      case 'read.bindingValue':
        return readBindingValue(s, id, type, payload);
      case 'read.renderedDom':
        return readRenderedDom(s, id, type, payload);
      case 'read.findNodes':
        return readFindNodes(s, id, type, payload);
      case 'read.nodeJson':
        return readNodeJson(s, id, type, payload);
      case 'apply':
        return applyOp(s, id, type, payload);
      case 'subscribe':
        return subscribe(s, id, type, payload);
      case 'unsubscribe':
        return unsubscribe(id, type, payload);
      default:
        return refusal(id, type, 'UNKNOWN_MESSAGE', 'Unrecognised message type.', {
          received: type,
        });
    }
  };

  return {
    handle,
    capabilities,
    dispose: () => {
      for (const sub of subscriptions.values()) sub.release();
      subscriptions.clear();
    },
  };
};

// ─── payload projections ─────────────────────────────────────────────────────

/** The tagged binding-resolution payload (§7.3) — identity present on every status. */
const bindingStatePayload = (state: BindingState): Readonly<Record<string, unknown>> => ({
  status: state.status,
  ...(state.status === 'resolved' ? { value: state.value ?? null } : {}),
  ...(state.message === undefined ? {} : { message: state.message }),
  ...(state.key === undefined ? {} : { key: state.key }),
  expression: state.expression,
  source: state.source,
});

// A type alias rather than an interface: only an alias gets the implicit index
// signature that lets it stand as an envelope `payload`.
type TreeSnapshot = {
  readonly id: string;
  readonly kind: string;
  readonly bindings: readonly { slot: string; expression: string; source: string }[];
  readonly childIds: readonly string[];
  readonly children: readonly TreeSnapshot[];
};

const projectTree = (node: TreeIntrospection): TreeSnapshot => ({
  id: node.id,
  kind: node.kind,
  bindings: node.bindings.map((b) => ({
    slot: b.slot,
    expression: b.expression,
    source: b.source,
  })),
  childIds: [...node.childIds],
  children: node.children.map(projectTree),
});

/** The recursive structural snapshot (§7.2) — §7.1's shape plus `children`. */
const treePayload = (s: FuaranDebugGlobal): TreeSnapshot => projectTree(s.inspectTree());

// ─── transport (§3) ──────────────────────────────────────────────────────────

/**
 * The mandatory receive-side checks (§3.2), in order. **All four must pass**;
 * a failing message is ignored in silence.
 *
 * The `source === window` check is not redundant with the origin check: a
 * SAME-ORIGIN frame passes the origin check and is still a different document
 * with a different trust story (§11.2).
 */
export const acceptsRelayMessage = (
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  win: Window = window,
): boolean =>
  event.source === win &&
  event.origin === win.origin &&
  isObject(event.data) &&
  typeof (event.data as Record<string, unknown>)[RELAY_KEY] === 'string';

export interface InstallRelayPeerOptions extends RelayPeerOptions {
  /** The window to listen on. Defaults to the ambient `window`. */
  readonly target?: Window;
}

/**
 * Install a relay page peer on the page's own window: a `message` listener
 * applying §3.2's checks, and the reply posted at `window.origin` (never `"*"`,
 * which is readable by any document that can obtain a reference to this window
 * — a real disclosure of application state on a page with embedded frames).
 *
 * Returns a teardown handle that removes the listener and releases every
 * subscription. Subscriptions are also released on page unload (§8.5).
 * A no-op (returning an inert handle) where there is no `window`.
 */
export const installRelayPeer = (
  surfaceSource: RelaySurfaceSource,
  options: InstallRelayPeerOptions = {},
): (() => void) => {
  const win = options.target ?? (typeof window === 'undefined' ? undefined : window);
  if (win === undefined) return () => {};

  const peer = createRelayPeer(surfaceSource, {
    ...options,
    emit: options.emit ?? ((event) => win.postMessage(event, win.origin)),
  });

  const listener = (event: MessageEvent): void => {
    if (!acceptsRelayMessage(event, win)) return;
    const reply = peer.handle(event.data);
    if (reply !== undefined) win.postMessage(reply, win.origin);
  };

  const onUnload = (): void => peer.dispose();

  win.addEventListener('message', listener);
  win.addEventListener('pagehide', onUnload);
  return () => {
    win.removeEventListener('message', listener);
    win.removeEventListener('pagehide', onUnload);
    peer.dispose();
  };
};
