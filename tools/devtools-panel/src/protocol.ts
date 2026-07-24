// ============================================================================
//  protocol — the page↔panel bridge contract.
//
//  Every hop of the bridge (panel → background → content script →
//  MAIN-world hook → back) speaks these envelopes. All payloads are
//  JSON-serialisable by construction: the hook does every operation that
//  touches live page objects (introspection, replay, geometry reads) in the
//  page itself and ships only plain data across, so nothing that could carry
//  a closure or a DOM node ever crosses a messaging boundary.
//
//  The panel is read-only by default. The single mutation method (`apply`)
//  forwards verbatim to the page's policy-gated `__fuaran.apply(opJson)` —
//  the default-deny gate decides in the page; the panel never applies an op
//  itself.
// ============================================================================

/** Marker distinguishing bridge traffic from unrelated postMessage noise. */
export const BRIDGE_SOURCE = 'fuaran-devtools' as const;

/** The methods the hook serves. */
export type BridgeMethod =
  | 'ping'
  | 'inspectTree'
  | 'getNodeState'
  | 'getBindingValue'
  | 'getRenderedDom'
  | 'highlight'
  | 'unhighlight'
  | 'opStreamOverview'
  | 'opStreamRecords'
  | 'opStreamTreeAt'
  | 'apply';

/** A request envelope (panel → page). */
export interface BridgeRequest {
  readonly source: typeof BRIDGE_SOURCE;
  readonly direction: 'request';
  readonly id: number;
  readonly method: BridgeMethod;
  readonly args?: Readonly<Record<string, unknown>>;
}

/** A response envelope (page → panel). `ok: false` carries a message only. */
export type BridgeResponse =
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly direction: 'response';
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly source: typeof BRIDGE_SOURCE;
      readonly direction: 'response';
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };

const isEnvelope = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (value as Record<string, unknown>)['source'] === BRIDGE_SOURCE;

/** Narrow arbitrary postMessage data to a bridge request. */
export const isBridgeRequest = (value: unknown): value is BridgeRequest =>
  isEnvelope(value) &&
  value['direction'] === 'request' &&
  typeof value['id'] === 'number' &&
  typeof value['method'] === 'string';

/** Narrow arbitrary postMessage data to a bridge response. */
export const isBridgeResponse = (value: unknown): value is BridgeResponse =>
  isEnvelope(value) &&
  value['direction'] === 'response' &&
  typeof value['id'] === 'number' &&
  typeof value['ok'] === 'boolean';

/** Build a request envelope. */
export const bridgeRequest = (
  id: number,
  method: BridgeMethod,
  args?: Readonly<Record<string, unknown>>,
): BridgeRequest =>
  args === undefined
    ? { source: BRIDGE_SOURCE, direction: 'request', id, method }
    : { source: BRIDGE_SOURCE, direction: 'request', id, method, args };

/** Build a success response for a request id. */
export const bridgeOk = (id: number, result: unknown): BridgeResponse => ({
  source: BRIDGE_SOURCE,
  direction: 'response',
  id,
  ok: true,
  result,
});

/** Build a failure response for a request id. */
export const bridgeErr = (id: number, error: string): BridgeResponse => ({
  source: BRIDGE_SOURCE,
  direction: 'response',
  id,
  ok: false,
  error,
});

// ─── Result payload shapes ──────────────────────────────────────────

/** `ping` — what the hook found on the page. */
export interface PingResult {
  /** `window.__fuaran` is present (a Fuaran app in debug mode). */
  readonly detected: boolean;
  /** The debug global's declared shape version, when detected. */
  readonly version?: string;
  /** `window.__fuaranOpStream` is present (the host opted the sink in). */
  readonly opStream: boolean;
}

/** One stream's worth of `opStreamOverview`. */
export interface StreamOverview {
  readonly streamId: string;
  readonly latestSequence: number;
  /** The host supplied an initial tree for this stream — scrub-replay available. */
  readonly hasInitialTree: boolean;
}

/** `opStreamOverview` — the sink's streams, ready for the guest selector. */
export interface OpStreamOverview {
  readonly streams: readonly StreamOverview[];
}

/**
 * One op record's JSON-safe projection for the timeline list. The op itself
 * stays in the page (it may carry closure-bearing nodes); the row carries the
 * classification the timeline renders.
 */
export interface OpRecordSummary {
  readonly streamId: string;
  readonly sequence: number;
  /** The op's wire discriminator (`UpdateProp`, `InsertChild`, …). */
  readonly opKind: string;
  /** The primary node the op targets, when it has a single target. */
  readonly targetId?: string;
  readonly actorKind: 'human' | 'agent';
  readonly actorId: string;
  readonly promptId?: string;
  readonly timestampUnixSeconds: number;
  readonly resultKind: string;
}

/** `opStreamRecords` — the timeline rows for one stream. */
export interface OpStreamRecordsResult {
  readonly streamId: string;
  readonly records: readonly OpRecordSummary[];
}
