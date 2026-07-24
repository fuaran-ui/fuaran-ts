// ============================================================================
//  @fuaran-ui/layout-observer — the observer implementations.
//
//  Ports Fuaran.UI.LayoutObserver.{InMemoryLayoutObserver,BrowserLayoutObserver}.
//
//   - InMemoryLayoutObserver: fixture-driven, substrate-free. Drives tests +
//     non-browser hosts; walks a parent-pointer graph for ObserveTree.
//   - BrowserLayoutObserver: ResizeObserver-backed self-discovery via
//     `[data-fuaran-node-id]` (the attribute the renderer emits on every node
//     wrapper) + MutationObserver reactive discovery, rAF-coalesced + wall-clock
//     debounced, change-detected. Browser API access is behind an injectable
//     deps object — the default reads the live DOM; tests supply a fake
//     ResizeObserver + a stubbed geometry snapshot (the TS analogue of the F#
//     tier's Emit-wrapped browser surface).
// ============================================================================

import {
  deriveFlags,
  flagsEqual,
  type LayoutFlag,
  type LayoutInput,
  type LayoutObservation,
  type LayoutObserverOptions,
  defaultLayoutObserverOptions,
} from './flags.js';

/** Handler signature for `subscribe` — receives `(nodeId, observation)`. */
export type LayoutSubscriber = (nodeId: string, observation: LayoutObservation) => void;

/**
 * The observer contract — three reads (single-node, tree, subscription) + two
 * registration calls. Port of F# `ILayoutObserver`; `subscribe` returns an
 * unsubscribe thunk (the TS analogue of the F# `IDisposable`).
 */
export interface ILayoutObserver {
  /** Snapshot the observation for a single registered node, or `undefined`. */
  observe(nodeId: string): LayoutObservation | undefined;
  /** Snapshot every observation reachable from `rootNodeId`, including the root. */
  observeTree(rootNodeId: string): LayoutObservation[];
  /** Subscribe to live deltas; returns an unsubscribe thunk. */
  subscribe(handler: LayoutSubscriber): () => void;
  /** Register a node for observation. Idempotent. */
  register(nodeId: string, element?: unknown): void;
  /** Unregister a node. Idempotent. */
  unregister(nodeId: string): void;
}

const observationOf = (
  nodeId: string,
  options: LayoutObserverOptions,
  input: LayoutInput,
): LayoutObservation => ({
  nodeId,
  width: input.width,
  height: input.height,
  viewportX: input.elementRect[0],
  viewportY: input.elementRect[1],
  flags: deriveFlags(options, input),
});

const emitTo = (
  subscribers: readonly LayoutSubscriber[],
  nodeId: string,
  obs: LayoutObservation,
): void => {
  for (const subscriber of subscribers) {
    try {
      subscriber(nodeId, obs);
    } catch {
      // A subscriber throwing must not poison sibling subscribers.
    }
  }
};

// ─── InMemoryLayoutObserver ──────────────────────────────────────────────────

interface LayoutFixture {
  readonly input: LayoutInput;
  readonly parent?: string;
}

/**
 * Fixture-driven observer — port of F# `InMemoryLayoutObserver`. Register a
 * `LayoutInput` fixture, assert the derived flags or the subscriber emission
 * pattern. `observeTree` walks a parent-pointer graph (the browser observer's
 * DOM walk is the production path).
 */
export class InMemoryLayoutObserver implements ILayoutObserver {
  readonly #options: LayoutObserverOptions;
  readonly #registry = new Map<string, LayoutFixture>();
  readonly #lastFlags = new Map<string, readonly LayoutFlag[]>();
  readonly #subscribers: LayoutSubscriber[] = [];

  constructor(options: LayoutObserverOptions = defaultLayoutObserverOptions) {
    this.#options = options;
  }

  /** Register or replace a fixture; fires an initial emission unconditionally. */
  registerFixture(nodeId: string, input: LayoutInput, parent?: string): void {
    const fixture: LayoutFixture = parent !== undefined ? { input, parent } : { input };
    this.#registry.set(nodeId, fixture);
    const obs = observationOf(nodeId, this.#options, input);
    this.#lastFlags.set(nodeId, obs.flags);
    emitTo(this.#subscribers, nodeId, obs);
  }

  /** Replace a registered node's input; honours `emitOnFlagChangeOnly`. No-op if absent. */
  update(nodeId: string, input: LayoutInput): void {
    const existing = this.#registry.get(nodeId);
    if (existing === undefined) return;
    const next: LayoutFixture =
      existing.parent !== undefined ? { input, parent: existing.parent } : { input };
    this.#registry.set(nodeId, next);
    const obs = observationOf(nodeId, this.#options, input);
    const previous = this.#lastFlags.get(nodeId) ?? [];
    this.#lastFlags.set(nodeId, obs.flags);
    const shouldEmit = this.#options.emitOnFlagChangeOnly ? !flagsEqual(obs.flags, previous) : true;
    if (shouldEmit) emitTo(this.#subscribers, nodeId, obs);
  }

  observe(nodeId: string): LayoutObservation | undefined {
    const fixture = this.#registry.get(nodeId);
    return fixture === undefined ? undefined : observationOf(nodeId, this.#options, fixture.input);
  }

  observeTree(rootNodeId: string): LayoutObservation[] {
    if (!this.#registry.has(rootNodeId)) return [];
    const children = new Map<string, string[]>();
    for (const [nodeId, fixture] of this.#registry) {
      if (fixture.parent !== undefined) {
        const bucket = children.get(fixture.parent) ?? [];
        bucket.push(nodeId);
        children.set(fixture.parent, bucket);
      }
    }
    // BFS so the result is deterministic by tree level then insertion order.
    const acc: LayoutObservation[] = [];
    const queue: string[] = [rootNodeId];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const fixture = this.#registry.get(nodeId);
      if (fixture !== undefined) acc.push(observationOf(nodeId, this.#options, fixture.input));
      queue.push(...(children.get(nodeId) ?? []));
    }
    return acc;
  }

  subscribe(handler: LayoutSubscriber): () => void {
    this.#subscribers.push(handler);
    return () => {
      const i = this.#subscribers.indexOf(handler);
      if (i >= 0) this.#subscribers.splice(i, 1);
    };
  }

  register(nodeId: string, _element?: unknown): void {
    // Bare register with no fixture creates an empty 0×0 baseline so calls from
    // a renderer mount hook don't crash on the in-memory observer.
    if (!this.#registry.has(nodeId)) this.registerFixture(nodeId, emptyBaseline());
  }

  unregister(nodeId: string): void {
    this.#registry.delete(nodeId);
    this.#lastFlags.delete(nodeId);
  }
}

const emptyBaseline = (): LayoutInput => ({ width: 0, height: 0, elementRect: [0, 0, 0, 0] });

// ─── BrowserLayoutObserver ───────────────────────────────────────────────────

/** A ResizeObserver-shaped constructor (the slice this observer uses). */
export interface ResizeObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}
/** A MutationObserver-shaped constructor (the slice this observer uses). */
export interface MutationObserverLike {
  observe(target: Node, options: { childList: boolean; subtree: boolean }): void;
  disconnect(): void;
}

/**
 * Injectable browser-surface dependencies. Every field defaults to the live
 * browser global; tests override them (a fake ResizeObserver + a stubbed
 * `snapshot`) — the TS analogue of the F# tier's Emit-wrapped browser API.
 */
export interface BrowserObserverDeps {
  /** The subtree to scan + watch. Default `document.body`. */
  readonly root?: Element;
  /** Read a `LayoutInput` from a registered element. Default reads the live DOM. */
  readonly snapshot?: (element: Element) => LayoutInput;
  /** Monotonic clock in ms. Default `performance.now`. */
  readonly now?: () => number;
  /** Schedule a callback for the next frame; returns a cancel handle. Default `requestAnimationFrame`. */
  readonly requestFrame?: (cb: () => void) => number;
  /** Cancel a scheduled frame. Default `cancelAnimationFrame`. */
  readonly cancelFrame?: (handle: number) => void;
  /** ResizeObserver constructor. Default the global. */
  readonly ResizeObserverCtor?: new (
    cb: (entries: { target: Element }[]) => void,
  ) => ResizeObserverLike;
  /** MutationObserver constructor. Default the global. */
  readonly MutationObserverCtor?: new (cb: () => void) => MutationObserverLike;
}

/**
 * ResizeObserver-backed observer — port of F# `BrowserLayoutObserver`. Discovers
 * addressable elements via `[data-fuaran-node-id]` (the attribute the renderer
 * emits), reads geometry on the rAF tick, derives flags, and emits per the
 * debounce + change-detection policy. Construct, `subscribe`, and `dispose`.
 */
export class BrowserLayoutObserver implements ILayoutObserver {
  readonly #options: LayoutObserverOptions;
  readonly #root: Element;
  readonly #snapshot: (element: Element) => LayoutInput;
  readonly #now: () => number;
  readonly #requestFrame: (cb: () => void) => number;
  readonly #cancelFrame: (handle: number) => void;

  readonly #registry = new Map<string, Element>();
  readonly #lastFlags = new Map<string, readonly LayoutFlag[]>();
  readonly #lastEmitAt = new Map<string, number>();
  readonly #lastObservation = new Map<string, LayoutObservation>();
  readonly #subscribers: LayoutSubscriber[] = [];
  readonly #pending = new Set<string>();
  #rafHandle: number | undefined = undefined;
  #disposed = false;

  readonly #resizeObserver: ResizeObserverLike;
  readonly #mutationObserver: MutationObserverLike;

  constructor(
    options: LayoutObserverOptions = defaultLayoutObserverOptions,
    deps: BrowserObserverDeps = {},
  ) {
    this.#options = options;
    this.#root = deps.root ?? (globalThis as { document?: { body: Element } }).document!.body;
    this.#snapshot = deps.snapshot ?? domSnapshot;
    this.#now = deps.now ?? (() => performance.now());
    this.#requestFrame = deps.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.#cancelFrame = deps.cancelFrame ?? ((h) => cancelAnimationFrame(h));

    const RO =
      deps.ResizeObserverCtor ??
      (globalThis as { ResizeObserver?: BrowserObserverDeps['ResizeObserverCtor'] })
        .ResizeObserver!;
    const MO =
      deps.MutationObserverCtor ??
      (globalThis as { MutationObserver?: BrowserObserverDeps['MutationObserverCtor'] })
        .MutationObserver!;

    this.#resizeObserver = new RO((entries) => {
      for (const entry of entries) {
        for (const [nodeId, element] of this.#registry) {
          if (element === entry.target) {
            this.#scheduleFlush(nodeId);
            break;
          }
        }
      }
    });
    this.#mutationObserver = new MO(() => this.#rescan());

    this.#scanInitial();
    this.#mutationObserver.observe(this.#root, { childList: true, subtree: true });
  }

  #buildObservation(nodeId: string, element: Element): LayoutObservation {
    return observationOf(nodeId, this.#options, this.#snapshot(element));
  }

  #flush = (): void => {
    this.#rafHandle = undefined;
    const nowMs = this.#now();
    const pending = [...this.#pending];
    this.#pending.clear();

    for (const nodeId of pending) {
      const element = this.#registry.get(nodeId);
      if (element === undefined) continue;
      const obs = this.#buildObservation(nodeId, element);
      const previousFlags = this.#lastFlags.get(nodeId) ?? [];
      const previousEmitAt = this.#lastEmitAt.get(nodeId) ?? -1;
      const initial = previousEmitAt < 0;
      const respectsDebounce = initial || nowMs - previousEmitAt >= this.#options.debounceMs;
      const flagsChanged = !flagsEqual(obs.flags, previousFlags);
      const shouldEmit =
        respectsDebounce && (initial || (this.#options.emitOnFlagChangeOnly ? flagsChanged : true));

      this.#lastObservation.set(nodeId, obs);
      if (shouldEmit) {
        this.#lastFlags.set(nodeId, obs.flags);
        this.#lastEmitAt.set(nodeId, nowMs);
        emitTo(this.#subscribers, nodeId, obs);
      }
    }
  };

  #scheduleFlush(nodeId: string): void {
    this.#pending.add(nodeId);
    if (this.#rafHandle === undefined) this.#rafHandle = this.#requestFrame(this.#flush);
  }

  #registerElement(nodeId: string, element: Element): void {
    if (!this.#registry.has(nodeId)) {
      this.#registry.set(nodeId, element);
      this.#resizeObserver.observe(element);
      this.#scheduleFlush(nodeId);
    }
  }

  #unregisterElement(nodeId: string): void {
    const element = this.#registry.get(nodeId);
    if (element === undefined) return;
    this.#resizeObserver.unobserve(element);
    this.#registry.delete(nodeId);
    this.#lastFlags.delete(nodeId);
    this.#lastEmitAt.delete(nodeId);
    this.#lastObservation.delete(nodeId);
  }

  #scanInitial(): void {
    for (const element of this.#root.querySelectorAll('[data-fuaran-node-id]')) {
      const nodeId = element.getAttribute('data-fuaran-node-id');
      if (nodeId) this.#registerElement(nodeId, element);
    }
  }

  #rescan(): void {
    const seen = new Set<string>();
    for (const element of this.#root.querySelectorAll('[data-fuaran-node-id]')) {
      const nodeId = element.getAttribute('data-fuaran-node-id');
      if (nodeId) {
        seen.add(nodeId);
        this.#registerElement(nodeId, element);
      }
    }
    for (const nodeId of [...this.#registry.keys()]) {
      if (!seen.has(nodeId)) this.#unregisterElement(nodeId);
    }
  }

  observe(nodeId: string): LayoutObservation | undefined {
    const element = this.#registry.get(nodeId);
    if (element !== undefined) return this.#buildObservation(nodeId, element);
    return this.#lastObservation.get(nodeId);
  }

  observeTree(rootNodeId: string): LayoutObservation[] {
    const rootEl = this.#registry.get(rootNodeId);
    if (rootEl === undefined) return [];
    const result = [this.#buildObservation(rootNodeId, rootEl)];
    for (const element of rootEl.querySelectorAll('[data-fuaran-node-id]')) {
      const nodeId = element.getAttribute('data-fuaran-node-id');
      if (nodeId) result.push(this.#buildObservation(nodeId, element));
    }
    return result;
  }

  subscribe(handler: LayoutSubscriber): () => void {
    this.#subscribers.push(handler);
    return () => {
      const i = this.#subscribers.indexOf(handler);
      if (i >= 0) this.#subscribers.splice(i, 1);
    };
  }

  register(nodeId: string, element?: unknown): void {
    if (element instanceof Element) this.#registerElement(nodeId, element);
  }

  unregister(nodeId: string): void {
    this.#unregisterElement(nodeId);
  }

  /** Disconnect both observers + cancel any pending frame. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resizeObserver.disconnect();
    this.#mutationObserver.disconnect();
    if (this.#rafHandle !== undefined) this.#cancelFrame(this.#rafHandle);
  }
}

// ─── Default DOM geometry snapshot ───────────────────────────────────────────

const parsePx = (raw: string | null): number | undefined => {
  if (raw === null || raw === '' || raw === 'none') return undefined;
  const trimmed = raw.endsWith('px') ? raw.slice(0, -2) : raw;
  const parsed = Number.parseFloat(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const parseAspectRatio = (raw: string | null): number | undefined => {
  if (raw === null || raw === '' || raw === 'auto') return undefined;
  const slash = raw.indexOf('/');
  if (slash >= 0) {
    const num = Number.parseFloat(raw.slice(0, slash).trim());
    const den = Number.parseFloat(raw.slice(slash + 1).trim());
    return !Number.isNaN(num) && !Number.isNaN(den) && den > 0 ? num / den : undefined;
  }
  const parsed = Number.parseFloat(raw);
  return !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined;
};

const nearestClippingAncestorRect = (
  element: Element,
): readonly [number, number, number, number] | undefined => {
  let node = element.parentElement;
  const html = element.ownerDocument.documentElement;
  while (node !== null && node !== html) {
    const s = getComputedStyle(node);
    if (
      s.overflowX !== 'visible' ||
      s.overflowY !== 'visible' ||
      (s.overflow !== '' && s.overflow !== 'visible')
    ) {
      const r = node.getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom];
    }
    node = node.parentElement;
  }
  return undefined;
};

/** Read a `LayoutInput` from a live DOM element — port of F# `snapshotInput`. */
export const domSnapshot = (element: Element): LayoutInput => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const el = element as Element & {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  const clip = nearestClippingAncestorRect(element);
  const base: LayoutInput = {
    width: rect.width,
    height: rect.height,
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    elementRect: [rect.left, rect.top, rect.right, rect.bottom],
  };
  const minWidth = parsePx(style.minWidth);
  const minHeight = parsePx(style.minHeight);
  const aspect = parseAspectRatio(style.aspectRatio);
  return {
    ...base,
    ...(minWidth !== undefined ? { minWidth } : {}),
    ...(minHeight !== undefined ? { minHeight } : {}),
    ...(clip !== undefined ? { clippingAncestorRect: clip } : {}),
    ...(aspect !== undefined ? { expectedAspectRatio: aspect } : {}),
  };
};
