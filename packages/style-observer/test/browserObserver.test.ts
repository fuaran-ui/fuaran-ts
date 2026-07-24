// ============================================================================
//  BrowserStyleObserver tests — self-discovery via [data-fuaran-node-id], the
//  register → derive → debounce → emit pipeline, MutationObserver-driven
//  re-derivation, change detection, and the wall-clock debounce floor. Runs in
//  jsdom with an injected computed-style snapshot + a fake MutationObserver + a
//  deferred rAF (the TS analogue of mocking the F# tier's Emit-wrapped surface).
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BrowserStyleObserver,
  black,
  defaultStyleObserverOptions,
  white,
  type BrowserObserverDeps,
  type StyleInput,
  type StyleObservation,
} from '../src/index.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  constructor(readonly cb: () => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe(): void {}
  disconnect(): void {}
  trigger(): void {
    this.cb();
  }
}

const invisibleInput = (): StyleInput => ({
  foreground: white,
  backgroundLayers: [white],
  fontFamily: undefined,
  emittedTone: undefined,
});

const healthyInput = (): StyleInput => ({
  foreground: black,
  backgroundLayers: [white],
  fontFamily: undefined,
  emittedTone: undefined,
});

describe('BrowserStyleObserver', () => {
  let clock = 0;
  let pendingFrame: (() => void) | null;

  const runFrame = (): void => {
    const cb = pendingFrame;
    pendingFrame = null;
    cb?.();
  };

  const makeDeps = (snapshot: (el: Element) => StyleInput): BrowserObserverDeps => ({
    root: document.body,
    snapshot,
    now: () => clock,
    requestFrame: (cb) => {
      pendingFrame = cb;
      return 1;
    },
    cancelFrame: () => {
      pendingFrame = null;
    },
    MutationObserverCtor: FakeMutationObserver,
  });

  beforeEach(() => {
    clock = 0;
    pendingFrame = null;
    FakeMutationObserver.instances = [];
    document.body.innerHTML = '<div data-fuaran-node-id="card-1"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('self-discovers [data-fuaran-node-id] and emits a flag on a known-invisible fixture', () => {
    const observer = new BrowserStyleObserver(
      defaultStyleObserverOptions,
      makeDeps(invisibleInput),
    );
    const emissions: Array<[string, StyleObservation]> = [];
    observer.subscribe((nodeId, obs) => emissions.push([nodeId, obs]));

    runFrame(); // the scan-scheduled initial flush

    expect(emissions).toHaveLength(1);
    expect(emissions[0]![0]).toBe('card-1');
    expect(emissions[0]![1].flags.map((f) => f.kind)).toEqual(['InvisibleText']);
    observer.dispose();
  });

  it('observe() returns a fresh snapshot for a registered node', () => {
    const observer = new BrowserStyleObserver(
      defaultStyleObserverOptions,
      makeDeps(invisibleInput),
    );
    expect(observer.observe('card-1')?.flags.map((f) => f.kind)).toEqual(['InvisibleText']);
    expect(observer.observe('absent')).toBeUndefined();
    observer.dispose();
  });

  it('respects the wall-clock debounce floor between emissions', () => {
    let current = invisibleInput();
    const observer = new BrowserStyleObserver(
      defaultStyleObserverOptions,
      makeDeps(() => current),
    );
    let count = 0;
    observer.subscribe(() => (count += 1));

    runFrame(); // initial emission at clock 0
    expect(count).toBe(1);

    // A mutation within the 100ms floor whose flags changed is still rate-limited.
    current = healthyInput();
    clock = 50;
    FakeMutationObserver.instances[0]!.trigger();
    runFrame();
    expect(count).toBe(1);

    // Past the floor, the changed flag set emits.
    clock = 150;
    FakeMutationObserver.instances[0]!.trigger();
    runFrame();
    expect(count).toBe(2);
    observer.dispose();
  });

  it('suppresses an unchanged flag set past the debounce floor (change-only default)', () => {
    const observer = new BrowserStyleObserver(
      defaultStyleObserverOptions,
      makeDeps(invisibleInput),
    );
    let count = 0;
    observer.subscribe(() => (count += 1));
    runFrame(); // initial
    expect(count).toBe(1);

    clock = 500; // well past the floor, but flags are identical
    FakeMutationObserver.instances[0]!.trigger();
    runFrame();
    expect(count).toBe(1);
    observer.dispose();
  });

  it('observeTree includes the root and its [data-fuaran-node-id] descendants', () => {
    document.body.innerHTML =
      '<div data-fuaran-node-id="root"><div data-fuaran-node-id="child"></div></div>';
    const observer = new BrowserStyleObserver(defaultStyleObserverOptions, makeDeps(healthyInput));
    expect(observer.observeTree('root').map((o) => o.nodeId)).toEqual(['root', 'child']);
    observer.dispose();
  });
});
