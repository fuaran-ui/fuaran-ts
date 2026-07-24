// ============================================================================
//  InMemoryStyleObserver tests — fixture registration, update + change-only
//  emission, observe / observeTree (parent-pointer walk), subscribe lifecycle,
//  and the burst emission discipline. Mirrors Fuaran.UI.StyleObserver.Tests.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  InMemoryStyleObserver,
  baselineStyleInput,
  black,
  defaultStyleObserverOptions,
  white,
  type StyleInput,
  type StyleObservation,
} from '../src/index.js';

const input = (over: Partial<StyleInput> = {}): StyleInput => ({
  ...baselineStyleInput(),
  ...over,
});
const invisible = (): StyleInput => input({ foreground: white, backgroundLayers: [white] });
const legible = (): StyleInput => input({ foreground: black, backgroundLayers: [white] });

describe('InMemoryStyleObserver', () => {
  it('observes the derived flags for a registered fixture', () => {
    const obs = new InMemoryStyleObserver();
    obs.registerFixture('a', invisible());
    expect(obs.observe('a')?.flags.map((f) => f.kind)).toEqual(['InvisibleText']);
    expect(obs.observe('missing')).toBeUndefined();
  });

  it('fires an initial emission on registerFixture regardless of change-only', () => {
    const obs = new InMemoryStyleObserver();
    const seen: string[] = [];
    obs.subscribe((nodeId) => seen.push(nodeId));
    obs.registerFixture('a', legible());
    expect(seen).toEqual(['a']);
  });

  it('emits on update only when the flag set changes (change-only default)', () => {
    const obs = new InMemoryStyleObserver();
    obs.registerFixture('a', legible()); // no flags
    const emissions: StyleObservation[] = [];
    obs.subscribe((_nodeId, observation) => emissions.push(observation));

    obs.update('a', legible()); // still no flags → suppressed
    expect(emissions).toHaveLength(0);

    obs.update('a', invisible()); // now InvisibleText → emit
    expect(emissions).toHaveLength(1);

    obs.update('a', invisible()); // same flags → suppressed
    expect(emissions).toHaveLength(1);
  });

  it('emits on every update when emitOnFlagChangeOnly is false', () => {
    const obs = new InMemoryStyleObserver({
      ...defaultStyleObserverOptions,
      emitOnFlagChangeOnly: false,
    });
    obs.registerFixture('a', legible());
    let count = 0;
    obs.subscribe(() => (count += 1));
    obs.update('a', legible());
    obs.update('a', legible());
    expect(count).toBe(2);
  });

  it('coalesces a burst into exactly one emission per changed update', () => {
    const obs = new InMemoryStyleObserver();
    obs.registerFixture('a', legible());
    let count = 0;
    obs.subscribe(() => (count += 1));
    // 10 alternating updates: legible ↔ invisible → flags change each time.
    for (let i = 0; i < 10; i += 1) obs.update('a', i % 2 === 0 ? invisible() : legible());
    expect(count).toBe(10);
  });

  it('walks observeTree via parent pointers in BFS order', () => {
    const obs = new InMemoryStyleObserver();
    obs.registerFixture('root', legible());
    obs.registerFixture('a', legible(), 'root');
    obs.registerFixture('b', legible(), 'root');
    obs.registerFixture('a1', legible(), 'a');
    expect(obs.observeTree('root').map((o) => o.nodeId)).toEqual(['root', 'a', 'b', 'a1']);
    expect(obs.observeTree('unknown')).toEqual([]);
  });

  it('unsubscribe stops further emissions', () => {
    const obs = new InMemoryStyleObserver();
    let count = 0;
    const unsub = obs.subscribe(() => (count += 1));
    obs.registerFixture('a', invisible());
    unsub();
    obs.update('a', legible());
    expect(count).toBe(1);
  });

  it('register creates a baseline (legible, no flags); unregister removes it', () => {
    const obs = new InMemoryStyleObserver();
    obs.register('a');
    const baseline = obs.observe('a');
    expect(baseline?.flags).toEqual([]);
    expect(baseline?.contrastRatio).toBeCloseTo(21);
    expect(baseline?.fontRole).toBe('Unknown');
    obs.unregister('a');
    expect(obs.observe('a')).toBeUndefined();
  });

  it('isolates a throwing subscriber from siblings', () => {
    const obs = new InMemoryStyleObserver();
    let reached = false;
    obs.subscribe(() => {
      throw new Error('boom');
    });
    obs.subscribe(() => (reached = true));
    obs.registerFixture('a', invisible());
    expect(reached).toBe(true);
  });
});
