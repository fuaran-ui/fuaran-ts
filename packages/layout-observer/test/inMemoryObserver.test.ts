// ============================================================================
//  InMemoryLayoutObserver tests — fixture registration, update + change-only
//  emission, observe / observeTree (parent-pointer walk), subscribe lifecycle,
//  and the burst-coalescing emission discipline (10 updates → 10 emissions when
//  flags change each time). Mirrors Fuaran.UI.LayoutObserver.Tests.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  InMemoryLayoutObserver,
  defaultLayoutObserverOptions,
  emptyLayoutInput,
  type LayoutObservation,
} from '../src/index.js';

describe('InMemoryLayoutObserver', () => {
  it('observes the derived flags for a registered fixture', () => {
    const obs = new InMemoryLayoutObserver();
    obs.registerFixture('a', { ...emptyLayoutInput(0, 0) });
    expect(obs.observe('a')?.flags.map((f) => f.kind)).toEqual(['ZeroDimension', 'ZeroDimension']);
    expect(obs.observe('missing')).toBeUndefined();
  });

  it('fires an initial emission on registerFixture regardless of change-only', () => {
    const obs = new InMemoryLayoutObserver();
    const seen: string[] = [];
    obs.subscribe((nodeId) => seen.push(nodeId));
    obs.registerFixture('a', emptyLayoutInput(100, 50));
    expect(seen).toEqual(['a']);
  });

  it('emits on update only when the flag set changes (change-only default)', () => {
    const obs = new InMemoryLayoutObserver();
    obs.registerFixture('a', emptyLayoutInput(100, 50)); // healthy: no flags
    const emissions: LayoutObservation[] = [];
    obs.subscribe((_nodeId, observation) => emissions.push(observation));

    obs.update('a', emptyLayoutInput(100, 50)); // still no flags → suppressed
    expect(emissions).toHaveLength(0);

    obs.update('a', emptyLayoutInput(0, 0)); // now two ZeroDimension flags → emit
    expect(emissions).toHaveLength(1);

    obs.update('a', emptyLayoutInput(0, 0)); // same flags → suppressed
    expect(emissions).toHaveLength(1);
  });

  it('emits on every update when emitOnFlagChangeOnly is false', () => {
    const obs = new InMemoryLayoutObserver({
      ...defaultLayoutObserverOptions,
      emitOnFlagChangeOnly: false,
    });
    obs.registerFixture('a', emptyLayoutInput(100, 50));
    let count = 0;
    obs.subscribe(() => (count += 1));
    obs.update('a', emptyLayoutInput(100, 50));
    obs.update('a', emptyLayoutInput(100, 50));
    expect(count).toBe(2);
  });

  it('coalesces a burst into exactly one emission per changed update', () => {
    const obs = new InMemoryLayoutObserver();
    obs.registerFixture('a', emptyLayoutInput(100, 50));
    let count = 0;
    obs.subscribe(() => (count += 1));
    // 10 alternating updates: healthy ↔ collapsed → flags change each time → 10 emissions.
    for (let i = 0; i < 10; i += 1) {
      obs.update('a', i % 2 === 0 ? emptyLayoutInput(0, 0) : emptyLayoutInput(100, 50));
    }
    expect(count).toBe(10);
  });

  it('walks observeTree via parent pointers in BFS order', () => {
    const obs = new InMemoryLayoutObserver();
    obs.registerFixture('root', emptyLayoutInput(100, 50));
    obs.registerFixture('a', emptyLayoutInput(100, 50), 'root');
    obs.registerFixture('b', emptyLayoutInput(100, 50), 'root');
    obs.registerFixture('a1', emptyLayoutInput(100, 50), 'a');
    expect(obs.observeTree('root').map((o) => o.nodeId)).toEqual(['root', 'a', 'b', 'a1']);
    expect(obs.observeTree('unknown')).toEqual([]);
  });

  it('unsubscribe stops further emissions', () => {
    const obs = new InMemoryLayoutObserver();
    let count = 0;
    const unsub = obs.subscribe(() => (count += 1));
    obs.registerFixture('a', emptyLayoutInput(0, 0));
    unsub();
    obs.update('a', emptyLayoutInput(100, 50));
    expect(count).toBe(1);
  });

  it('register creates a 0×0 baseline; unregister removes it', () => {
    const obs = new InMemoryLayoutObserver();
    obs.register('a');
    expect(obs.observe('a')?.width).toBe(0);
    obs.unregister('a');
    expect(obs.observe('a')).toBeUndefined();
  });

  it('isolates a throwing subscriber from siblings', () => {
    const obs = new InMemoryLayoutObserver();
    let reached = false;
    obs.subscribe(() => {
      throw new Error('boom');
    });
    obs.subscribe(() => (reached = true));
    obs.registerFixture('a', emptyLayoutInput(0, 0));
    expect(reached).toBe(true);
  });
});
