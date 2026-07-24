import { describe, expect, it } from 'vitest';

import type { StreamOverview } from '../src/protocol.js';
import {
  classifyStreams,
  guestScopeOf,
  isGuestStream,
  selectStreamIds,
  selectionFromValue,
  selectionToValue,
} from '../src/panel/guestStreams.js';

const streams: StreamOverview[] = [
  { streamId: 'app', latestSequence: 9, hasInitialTree: true },
  { streamId: 'guest-regionB', latestSequence: 2, hasInitialTree: false },
  { streamId: 'guest-regionA', latestSequence: 4, hasInitialTree: true },
];

describe('guest stream keys', () => {
  it('classifies streams by the guest-<scopeId> key convention', () => {
    expect(isGuestStream('guest-regionA')).toBe(true);
    expect(isGuestStream('app')).toBe(false);
    expect(guestScopeOf('guest-regionA')).toBe('regionA');
    expect(guestScopeOf('app')).toBeUndefined();
  });

  it('derives the selector model from stream keys alone (sorted guests)', () => {
    const { hostStreams, guestScopes } = classifyStreams(streams);
    expect(hostStreams.map((s) => s.streamId)).toEqual(['app']);
    expect(guestScopes).toEqual(['regionA', 'regionB']);
  });
});

describe('selection', () => {
  it("selecting a guest admits exactly that guest's stream — no sibling, no host", () => {
    expect(selectStreamIds({ kind: 'guest', scopeId: 'regionA' }, streams)).toEqual([
      'guest-regionA',
    ]);
  });

  it('the host view excludes every guest stream; the rollup admits everything', () => {
    expect(selectStreamIds({ kind: 'host' }, streams)).toEqual(['app']);
    expect(selectStreamIds({ kind: 'all' }, streams)).toEqual([
      'app',
      'guest-regionB',
      'guest-regionA',
    ]);
  });

  it('selection values round-trip through the <select> encoding', () => {
    for (const selection of [
      { kind: 'host' } as const,
      { kind: 'all' } as const,
      { kind: 'guest', scopeId: 'regionA' } as const,
    ]) {
      expect(selectionFromValue(selectionToValue(selection))).toEqual(selection);
    }
  });
});
