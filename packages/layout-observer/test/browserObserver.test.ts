// ============================================================================
//  BrowserLayoutObserver tests — self-discovery via [data-fuaran-node-id],
//  the register → derive → debounce → emit pipeline, change detection, and the
//  wall-clock debounce floor. Runs in jsdom with an injected geometry snapshot
//  + a fake ResizeObserver + a deferred rAF (the TS analogue of mocking the F#
//  tier's Emit-wrapped browser surface).
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BrowserLayoutObserver,
  defaultLayoutObserverOptions,
  type BrowserObserverDeps,
  type LayoutInput,
  type LayoutObservation,
} from '../src/index.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly cb: (entries: { target: Element }[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(t: Element): void {
    this.targets.add(t);
  }
  unobserve(t: Element): void {
    this.targets.delete(t);
  }
  disconnect(): void {
    this.targets.clear();
  }
  trigger(t: Element): void {
    this.cb([{ target: t }]);
  }
}

class NoopMutationObserver {
  observe(): void {}
  disconnect(): void {}
}

const overflowInput = (): LayoutInput => ({
  width: 100,
  height: 50,
  scrollWidth: 300,
  clientWidth: 100,
  overflowX: 'hidden',
  elementRect: [0, 0, 100, 50],
});

const healthyInput = (): LayoutInput => ({ width: 100, height: 50, elementRect: [0, 0, 100, 50] });

describe('BrowserLayoutObserver', () => {
  let clock = 0;
  let pendingFrame: (() => void) | null;

  const runFrame = (): void => {
    const cb = pendingFrame;
    pendingFrame = null;
    cb?.();
  };

  const makeDeps = (snapshot: (el: Element) => LayoutInput): BrowserObserverDeps => ({
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
    ResizeObserverCtor: FakeResizeObserver,
    MutationObserverCtor: NoopMutationObserver,
  });

  beforeEach(() => {
    clock = 0;
    pendingFrame = null;
    FakeResizeObserver.instances = [];
    document.body.innerHTML = '<div data-fuaran-node-id="card-1"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('self-discovers [data-fuaran-node-id] and emits a flag on a known-overflowing fixture', () => {
    const observer = new BrowserLayoutObserver(
      defaultLayoutObserverOptions,
      makeDeps(overflowInput),
    );
    const emissions: Array<[string, LayoutObservation]> = [];
    observer.subscribe((nodeId, obs) => emissions.push([nodeId, obs]));

    runFrame(); // the scan-scheduled initial flush

    expect(emissions).toHaveLength(1);
    expect(emissions[0]![0]).toBe('card-1');
    expect(emissions[0]![1].flags.map((f) => f.kind)).toEqual(['OverflowHorizontal']);
    observer.dispose();
  });

  it('observe() returns a fresh snapshot for a registered node', () => {
    const observer = new BrowserLayoutObserver(
      defaultLayoutObserverOptions,
      makeDeps(overflowInput),
    );
    expect(observer.observe('card-1')?.flags.map((f) => f.kind)).toEqual(['OverflowHorizontal']);
    expect(observer.observe('absent')).toBeUndefined();
    observer.dispose();
  });

  it('respects the wall-clock debounce floor between emissions', () => {
    let current = overflowInput();
    const observer = new BrowserLayoutObserver(
      defaultLayoutObserverOptions,
      makeDeps(() => current),
    );
    let count = 0;
    observer.subscribe(() => (count += 1));

    runFrame(); // initial emission at clock 0
    expect(count).toBe(1);

    // A resize within the 100ms floor whose flags changed is still rate-limited.
    current = healthyInput();
    clock = 50;
    FakeResizeObserver.instances[0]!.trigger(document.querySelector('[data-fuaran-node-id]')!);
    runFrame();
    expect(count).toBe(1);

    // Past the floor, the changed flag set emits.
    clock = 150;
    FakeResizeObserver.instances[0]!.trigger(document.querySelector('[data-fuaran-node-id]')!);
    runFrame();
    expect(count).toBe(2);
    observer.dispose();
  });

  it('suppresses an unchanged flag set past the debounce floor (change-only default)', () => {
    const observer = new BrowserLayoutObserver(
      defaultLayoutObserverOptions,
      makeDeps(overflowInput),
    );
    let count = 0;
    observer.subscribe(() => (count += 1));
    runFrame(); // initial
    expect(count).toBe(1);

    clock = 500; // well past the floor, but flags are identical
    FakeResizeObserver.instances[0]!.trigger(document.querySelector('[data-fuaran-node-id]')!);
    runFrame();
    expect(count).toBe(1);
    observer.dispose();
  });

  it('observeTree includes the root and its [data-fuaran-node-id] descendants', () => {
    document.body.innerHTML =
      '<div data-fuaran-node-id="root"><div data-fuaran-node-id="child"></div></div>';
    const observer = new BrowserLayoutObserver(
      defaultLayoutObserverOptions,
      makeDeps(healthyInput),
    );
    expect(observer.observeTree('root').map((o) => o.nodeId)).toEqual(['root', 'child']);
    observer.dispose();
  });
});
