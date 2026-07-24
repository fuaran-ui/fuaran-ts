import { describe, expect, it } from 'vitest';

import type { OpRecordSummary, StreamOverview } from '../src/protocol.js';
import { mergeTimelineRows, rowViews, scrubCapability } from '../src/panel/timelineModel.js';

const record = (
  streamId: string,
  sequence: number,
  timestampUnixSeconds: number,
  opKind = 'UpdateProp',
): OpRecordSummary => ({
  streamId,
  sequence,
  opKind,
  targetId: 'n1',
  actorKind: 'agent',
  actorId: 'claude',
  timestampUnixSeconds,
  resultKind: 'Success',
});

const streams: StreamOverview[] = [
  { streamId: 'app', latestSequence: 2, hasInitialTree: true },
  { streamId: 'guest-a', latestSequence: 2, hasInitialTree: true },
  { streamId: 'guest-b', latestSequence: 1, hasInitialTree: false },
];

const recordsByStream = new Map<string, readonly OpRecordSummary[]>([
  ['app', [record('app', 1, 10), record('app', 2, 40)]],
  ['guest-a', [record('guest-a', 1, 20), record('guest-a', 2, 30)]],
  ['guest-b', [record('guest-b', 1, 25)]],
]);

describe('mergeTimelineRows', () => {
  it("a guest selection shows that guest's records without the sibling's or the host's", () => {
    const rows = mergeTimelineRows(recordsByStream, { kind: 'guest', scopeId: 'a' }, streams);
    expect(rows.map((r) => `${r.streamId}#${r.sequence}`)).toEqual(['guest-a#1', 'guest-a#2']);
  });

  it('the rollup interleaves every stream by time', () => {
    const rows = mergeTimelineRows(recordsByStream, { kind: 'all' }, streams);
    expect(rows.map((r) => `${r.streamId}#${r.sequence}`)).toEqual([
      'app#1',
      'guest-a#1',
      'guest-b#1',
      'guest-a#2',
      'app#2',
    ]);
  });
});

describe('scrubCapability', () => {
  it('a single stream with an initial tree is scrubable to its latest sequence', () => {
    const capability = scrubCapability({ kind: 'guest', scopeId: 'a' }, streams);
    expect(capability).toEqual({ scrubable: true, streamId: 'guest-a', latestSequence: 2 });
  });

  it('the rollup is not scrubable (replay is per hash chain)', () => {
    expect(scrubCapability({ kind: 'all' }, streams).scrubable).toBe(false);
  });

  it('a stream without a host-supplied initial tree is not scrubable, with the wiring hint', () => {
    const capability = scrubCapability({ kind: 'guest', scopeId: 'b' }, streams);
    expect(capability.scrubable).toBe(false);
    expect(capability.reason).toContain('initial tree');
  });
});

describe('rowViews', () => {
  it('marks rows beyond the scrub position (same stream only)', () => {
    const rows = mergeTimelineRows(recordsByStream, { kind: 'guest', scopeId: 'a' }, streams);
    const views = rowViews(rows, { streamId: 'guest-a', sequence: 1 });
    expect(views.map((v) => v.beyondScrub)).toEqual([false, true]);
    expect(views[0]?.attribution).toBe('agent:claude');
  });
});
