// ============================================================================
//  hook — the MAIN-world half of the bridge.
//
//  Runs in the inspected page's own JS world, so it can reach the debug-only
//  globals a Fuaran host registers:
//
//    window.__fuaran         — the in-page introspection global the renderer
//                              registers under `<FuaranRenderer debug>`
//                              (read surface + the policy-gated `apply`).
//    window.__fuaranOpStream — OPT-IN host wiring for the timeline: the
//                              host's op-stream sink (and, per stream, the
//                              initial tree replay folds from). Absent ⇒ the
//                              timeline shows its wiring hint; everything
//                              else still works.
//
//  It serves protocol requests arriving via window.postMessage (relayed by
//  the isolated-world content script) and answers with JSON-safe payloads —
//  every operation over live page objects (introspection, geometry, replay)
//  happens HERE, so closure-bearing nodes and ops never cross a messaging
//  boundary. Replay is read-only: it folds a copy of the records into a
//  fresh tree for the structural snapshot and never touches the live app
//  (FGP 5 — a read projection of the canonical stream).
// ============================================================================

import { inspectTree } from '@fuaran-ui/ai-tools';
import { applyTo, type IOpStreamSink, type OpRecord } from '@fuaran-ui/op-stream';
import type { Node } from '@fuaran-ui/schema';

import {
  bridgeErr,
  bridgeOk,
  isBridgeRequest,
  type BridgeRequest,
  type BridgeResponse,
  type OpRecordSummary,
  type OpStreamOverview,
  type OpStreamRecordsResult,
  type PingResult,
  type StreamOverview,
} from './protocol.js';

// ─── The page globals (structural, DEBUG-only/unstable shapes) ──────
//
// Typed structurally rather than importing the renderer package: the debug
// global's shape is explicitly excluded from semver, and the hook must keep
// working (returning honest errors) against a page that registered an older
// or newer surface.

interface DebugGlobalLike {
  readonly version?: string;
  getNodeState?(nodeId: string): unknown;
  getBindingValue?(nodeId: string, slot: string): unknown;
  getRenderedDom?(nodeId: string): unknown;
  inspectTree?(): unknown;
  apply?(opJson: string): unknown;
}

/** The opt-in host wiring for the op-stream timeline. */
interface OpStreamHandleLike {
  readonly sink: IOpStreamSink<unknown>;
  /** Per-stream initial tree — what replay folds records into. */
  readonly initialTrees?: Readonly<Record<string, Node<unknown>>>;
}

const pageWindow = window as unknown as {
  __fuaran?: DebugGlobalLike;
  __fuaranOpStream?: OpStreamHandleLike;
};

// ─── Hover-highlight overlay ────────────────────────────────────────

const OVERLAY_ID = '__fuaran-devtools-highlight';

const escapeAttr = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');

const removeOverlay = (): void => {
  document.getElementById(OVERLAY_ID)?.remove();
};

/** Draw the inspect-element-style overlay over a node's rendered region. */
const showOverlay = (nodeId: string): boolean => {
  removeOverlay();
  const el = document.querySelector(`[data-fuaran-node-id="${escapeAttr(nodeId)}"]`);
  if (el === null) return false;
  const rect = el.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483646;' +
    'background:rgba(59,130,246,0.22);outline:1px solid rgba(59,130,246,0.9);' +
    `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;`;
  const label = document.createElement('span');
  label.textContent = nodeId;
  label.style.cssText =
    'position:absolute;left:0;top:-18px;font:11px/1.4 system-ui,sans-serif;' +
    'background:rgba(59,130,246,0.95);color:#fff;padding:0 4px;border-radius:2px;white-space:nowrap;';
  overlay.appendChild(label);
  document.body.appendChild(overlay);
  return true;
};

// ─── Op-stream projections ──────────────────────────────────────────

const summariseRecord = (record: OpRecord<unknown>): OpRecordSummary => {
  const op = record.op as { kind?: string; target?: unknown; parentId?: unknown };
  const target = op.target ?? op.parentId;
  const base = {
    streamId: record.streamId,
    sequence: record.sequence,
    opKind: typeof op.kind === 'string' ? op.kind : 'Op',
    actorKind: record.actor.kind,
    actorId: record.actor.id,
    timestampUnixSeconds: record.timestampUnixSeconds,
    resultKind: record.resultEnvelope.kind,
  };
  return {
    ...base,
    ...(typeof target === 'string' ? { targetId: target } : {}),
    ...(record.promptId !== undefined ? { promptId: record.promptId } : {}),
  };
};

const opStreamHandle = (): OpStreamHandleLike => {
  const handle = pageWindow.__fuaranOpStream;
  if (handle === undefined || typeof handle.sink?.streams !== 'function') {
    throw new Error(
      'No op-stream wired: the host has not exposed `window.__fuaranOpStream = { sink, initialTrees }` (DEBUG-only opt-in).',
    );
  }
  return handle;
};

const overview = async (): Promise<OpStreamOverview> => {
  const handle = opStreamHandle();
  const streamIds = await handle.sink.streams();
  const streams: StreamOverview[] = [];
  for (const streamId of [...streamIds].sort()) {
    streams.push({
      streamId,
      latestSequence: await handle.sink.latestSequence(streamId),
      hasInitialTree: handle.initialTrees?.[streamId] !== undefined,
    });
  }
  return { streams };
};

const recordsFor = async (streamId: string): Promise<OpStreamRecordsResult> => {
  const handle = opStreamHandle();
  const latest = await handle.sink.latestSequence(streamId);
  const records = latest > 0 ? await handle.sink.replay(streamId, 1, latest) : [];
  return { streamId, records: records.map(summariseRecord) };
};

/**
 * Read-only scrub-replay: fold the stream's records up to `sequence` into the
 * host-supplied initial tree and return the structural snapshot. Never touches
 * the live tree.
 */
const treeAt = async (streamId: string, sequence: number): Promise<unknown> => {
  const handle = opStreamHandle();
  const initial = handle.initialTrees?.[streamId];
  if (initial === undefined) {
    throw new Error(
      `No initial tree for stream '${streamId}' — the host's __fuaranOpStream.initialTrees must carry one for scrub-replay.`,
    );
  }
  const records = sequence > 0 ? await handle.sink.replay(streamId, 1, sequence) : [];
  const replayed = applyTo(initial, records);
  if (!replayed.ok) {
    throw new Error(
      `Replay failed at sequence ${replayed.error.sequence}: ${replayed.error.applyError.message ?? replayed.error.applyError.code ?? 'apply error'}`,
    );
  }
  return inspectTree(replayed.value);
};

// ─── Request dispatch ───────────────────────────────────────────────

const requireGlobal = (): DebugGlobalLike => {
  const g = pageWindow.__fuaran;
  if (g === undefined)
    throw new Error('No Fuaran app detected (window.__fuaran is not registered).');
  return g;
};

const requireString = (request: BridgeRequest, key: string): string => {
  const value = request.args?.[key];
  if (typeof value !== 'string')
    throw new Error(`Bridge request '${request.method}' needs a string '${key}'.`);
  return value;
};

const handle = async (request: BridgeRequest): Promise<unknown> => {
  switch (request.method) {
    case 'ping': {
      const g = pageWindow.__fuaran;
      const ping: PingResult = {
        detected: g !== undefined,
        ...(g?.version !== undefined ? { version: g.version } : {}),
        opStream: typeof pageWindow.__fuaranOpStream?.sink?.streams === 'function',
      };
      return ping;
    }
    case 'inspectTree':
      return requireGlobal().inspectTree?.();
    case 'getNodeState':
      return requireGlobal().getNodeState?.(requireString(request, 'nodeId'));
    case 'getBindingValue':
      return requireGlobal().getBindingValue?.(
        requireString(request, 'nodeId'),
        requireString(request, 'slot'),
      );
    case 'getRenderedDom':
      return requireGlobal().getRenderedDom?.(requireString(request, 'nodeId'));
    case 'highlight':
      return { shown: showOverlay(requireString(request, 'nodeId')) };
    case 'unhighlight':
      removeOverlay();
      return { shown: false };
    case 'opStreamOverview':
      return overview();
    case 'opStreamRecords':
      return recordsFor(requireString(request, 'streamId'));
    case 'opStreamTreeAt': {
      const sequence = Number(request.args?.['sequence']);
      if (!Number.isInteger(sequence) || sequence < 0)
        throw new Error("Bridge request 'opStreamTreeAt' needs a non-negative integer 'sequence'.");
      return treeAt(requireString(request, 'streamId'), sequence);
    }
    case 'apply': {
      const g = requireGlobal();
      if (typeof g.apply !== 'function')
        throw new Error(
          'This page’s __fuaran global has no apply entry (older debug-global shape).',
        );
      // The page's own policy gate decides (default-deny, FGP 3) — the panel
      // never applies an op itself; the envelope goes back verbatim.
      return g.apply(requireString(request, 'opJson'));
    }
  }
};

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || !isBridgeRequest(event.data)) return;
  const request = event.data;
  void (async (): Promise<BridgeResponse> => {
    try {
      return bridgeOk(request.id, await handle(request));
    } catch (error) {
      return bridgeErr(request.id, error instanceof Error ? error.message : String(error));
    }
  })().then((response) => window.postMessage(response, '*'));
});
