// ============================================================================
//  guestStreams — the guest selector over op-stream keys.
//
//  A host that mounts isolated guest regions journals each guest under the
//  `guest-<scopeId>` stream key (the wire-level convention shared with the
//  F# tier's `GuestStream`). The selector derives the guest list from the
//  STREAM KEYS themselves — the op stream is the source of truth; there is
//  no parallel registry to consult. Selecting a guest scopes the timeline to
//  that region's records only; `all` is the opt-in everything-at-once
//  rollup. Pure and DOM-free.
// ============================================================================

import type { StreamOverview } from '../protocol.js';

/** The `guest-<scopeId>` stream-key prefix (parity with the F# tier). */
export const GUEST_STREAM_PREFIX = 'guest-' as const;

/** Whether a stream id is a mounted guest's stream. */
export const isGuestStream = (streamId: string): boolean =>
  streamId.startsWith(GUEST_STREAM_PREFIX);

/** The guest scope id a stream key carries, or `undefined` for a host stream. */
export const guestScopeOf = (streamId: string): string | undefined =>
  isGuestStream(streamId) ? streamId.slice(GUEST_STREAM_PREFIX.length) : undefined;

/** Which slice of the stream set the timeline renders. */
export type StreamSelection =
  | { readonly kind: 'host' }
  | { readonly kind: 'guest'; readonly scopeId: string }
  | { readonly kind: 'all' };

/** The classified stream set backing the selector UI. */
export interface StreamClassification {
  /** Non-guest streams (typically one — the host's own). */
  readonly hostStreams: readonly StreamOverview[];
  /** Guest scope ids present, sorted, derived from the stream keys. */
  readonly guestScopes: readonly string[];
}

/** Classify an overview's streams into host streams + guest scopes. */
export const classifyStreams = (streams: readonly StreamOverview[]): StreamClassification => ({
  hostStreams: streams.filter((s) => !isGuestStream(s.streamId)),
  guestScopes: streams
    .map((s) => guestScopeOf(s.streamId))
    .filter((scope): scope is string => scope !== undefined)
    .sort(),
});

/** The stream ids a selection admits, in overview order. */
export const selectStreamIds = (
  selection: StreamSelection,
  streams: readonly StreamOverview[],
): readonly string[] => {
  switch (selection.kind) {
    case 'host':
      return streams.filter((s) => !isGuestStream(s.streamId)).map((s) => s.streamId);
    case 'guest': {
      const wanted = `${GUEST_STREAM_PREFIX}${selection.scopeId}`;
      return streams.filter((s) => s.streamId === wanted).map((s) => s.streamId);
    }
    case 'all':
      return streams.map((s) => s.streamId);
  }
};

/** The selector's stable option value for a selection (and back). */
export const selectionToValue = (selection: StreamSelection): string => {
  switch (selection.kind) {
    case 'host':
      return 'host';
    case 'all':
      return 'all';
    case 'guest':
      return `${GUEST_STREAM_PREFIX}${selection.scopeId}`;
  }
};

/** Parse a selector option value back to a selection (default: host). */
export const selectionFromValue = (value: string): StreamSelection => {
  if (value === 'all') return { kind: 'all' };
  const scopeId = guestScopeOf(value);
  return scopeId === undefined ? { kind: 'host' } : { kind: 'guest', scopeId };
};
