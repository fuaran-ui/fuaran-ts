// ============================================================================
//  timelineModel — pure model of the scrubable op-stream timeline.
//
//  The timeline lists a selection's records (host / one guest / the rollup)
//  and tracks a scrub position over ONE stream at a time — replay is
//  per-stream (a hash-chained sequence), so scrubbing is enabled exactly when
//  the selection resolves to a single stream whose host supplied an initial
//  tree. The replayed snapshot itself is computed in the page by the hook
//  (`opStreamTreeAt`) — this model only decides what is scrubable and how the
//  rows read. Read-only throughout (FGP 5).
// ============================================================================

import type { OpRecordSummary, StreamOverview } from '../protocol.js';
import { selectStreamIds, type StreamSelection } from './guestStreams.js';

/** The rows the timeline renders, merged across the selected streams. */
export const mergeTimelineRows = (
  recordsByStream: ReadonlyMap<string, readonly OpRecordSummary[]>,
  selection: StreamSelection,
  streams: readonly StreamOverview[],
): readonly OpRecordSummary[] => {
  const rows: OpRecordSummary[] = [];
  for (const streamId of selectStreamIds(selection, streams)) {
    rows.push(...(recordsByStream.get(streamId) ?? []));
  }
  // The rollup interleaves by time (ties broken by stream then sequence so the
  // order is total + stable); a single stream stays in sequence order.
  return rows.sort(
    (a, b) =>
      a.timestampUnixSeconds - b.timestampUnixSeconds ||
      (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0) ||
      a.sequence - b.sequence,
  );
};

/** Scrub capability for the current selection. */
export interface ScrubCapability {
  readonly scrubable: boolean;
  /** The single stream scrubbing replays, when scrubable. */
  readonly streamId?: string;
  /** The scrubber's max position (the stream's latest sequence). */
  readonly latestSequence?: number;
  /** Why scrubbing is unavailable, when it is. */
  readonly reason?: string;
}

/**
 * Scrubbing needs exactly one selected stream (replay is per hash chain) with
 * a host-supplied initial tree.
 */
export const scrubCapability = (
  selection: StreamSelection,
  streams: readonly StreamOverview[],
): ScrubCapability => {
  const ids = selectStreamIds(selection, streams);
  if (ids.length !== 1) {
    return {
      scrubable: false,
      reason:
        ids.length === 0
          ? 'No stream in this selection.'
          : 'Scrubbing replays one hash-chained stream — pick the host or a single guest.',
    };
  }
  const streamId = ids[0] as string;
  const stream = streams.find((s) => s.streamId === streamId);
  if (stream === undefined || !stream.hasInitialTree) {
    return {
      scrubable: false,
      streamId,
      reason: `No initial tree for '${streamId}' — the host's __fuaranOpStream.initialTrees must carry one for scrub-replay.`,
    };
  }
  return { scrubable: true, streamId, latestSequence: stream.latestSequence };
};

/** A row's one-line rendering fields. */
export interface TimelineRowView {
  readonly key: string;
  readonly sequence: number;
  readonly opKind: string;
  readonly target: string;
  readonly attribution: string;
  readonly streamId: string;
  /** Past the current scrub position — rendered dimmed. */
  readonly beyondScrub: boolean;
}

/** Project rows for rendering against a scrub position (`undefined` = live). */
export const rowViews = (
  rows: readonly OpRecordSummary[],
  scrub: { readonly streamId: string; readonly sequence: number } | undefined,
): readonly TimelineRowView[] =>
  rows.map((row) => ({
    key: `${row.streamId}#${row.sequence}`,
    sequence: row.sequence,
    opKind: row.opKind,
    target: row.targetId ?? '—',
    attribution: `${row.actorKind}:${row.actorId}${row.promptId !== undefined ? ` (${row.promptId})` : ''}`,
    streamId: row.streamId,
    beyondScrub:
      scrub !== undefined && row.streamId === scrub.streamId && row.sequence > scrub.sequence,
  }));
