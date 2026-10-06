// ============================================================================
//  @fuaran-ui/layout-observer — the observer implementations.
//
//  Ports Fuaran.UI.LayoutObserver.{InMemoryLayoutObserver,BrowserLayoutObserver}.
//
//  The registry, subscribers, change detection, discovery and frame flush are
//  the shared observer scaffolding (`@fuaran-ui/observer-core`, workspace-
//  internal and bundled into this package); what is layout's own is below —
//  the geometry snapshot, the derivation, and ResizeObserver discovery.
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
  browserSurface,
  createInMemoryObserver,
  createObserver,
  type BrowserObserver,
  type InMemoryObserver,
} from '@fuaran-ui/observer-core';

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

/** The layout half of the shared scaffolding: geometry in, layout flags out. */
const layoutDerivation = (options: LayoutObserverOptions) => ({
  policy: options,
  flagsEqual,
  derive: (nodeId: string, input: LayoutInput): LayoutObservation => ({
    nodeId,
    width: input.width,
    height: input.height,
    viewportX: input.elementRect[0],
    viewportY: input.elementRect[1],
    flags: deriveFlags(options, input),
  }),
});

// ─── InMemoryLayoutObserver ──────────────────────────────────────────────────

/**
 * Fixture-driven observer — port of F# `InMemoryLayoutObserver`. Register a
 * `LayoutInput` fixture, assert the derived flags or the subscriber emission
 * pattern. `observeTree` walks a parent-pointer graph (the browser observer's
 * DOM walk is the production path). A bare `register` records an empty 0×0
 * baseline so a renderer mount hook does not crash on it.
 */
export class InMemoryLayoutObserver implements ILayoutObserver {
  readonly #core: InMemoryObserver<LayoutInput, LayoutObservation>;

  constructor(options: LayoutObserverOptions = defaultLayoutObserverOptions) {
    this.#core = createInMemoryObserver<LayoutInput, LayoutObservation, LayoutFlag>({
      ...layoutDerivation(options),
      baseline: () => ({ width: 0, height: 0, elementRect: [0, 0, 0, 0] }),
    });
  }

  /** Register or replace a fixture; fires an initial emission unconditionally. */
  registerFixture(nodeId: string, input: LayoutInput, parent?: string): void {
    this.#core.registerFixture(nodeId, input, parent);
  }

  /** Replace a registered node's input; honours `emitOnFlagChangeOnly`. No-op if absent. */
  update(nodeId: string, input: LayoutInput): void {
    this.#core.update(nodeId, input);
  }

  observe(nodeId: string): LayoutObservation | undefined {
    return this.#core.observe(nodeId);
  }

  observeTree(rootNodeId: string): LayoutObservation[] {
    return this.#core.observeTree(rootNodeId);
  }

  subscribe(handler: LayoutSubscriber): () => void {
    return this.#core.subscribe(handler);
  }

  register(nodeId: string, element?: unknown): void {
    this.#core.register(nodeId, element);
  }

  unregister(nodeId: string): void {
    this.#core.unregister(nodeId);
  }
}

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
 * debounce + change-detection policy. A ResizeObserver on each registered
 * element re-reads it when its geometry changes; a MutationObserver on the root
 * discovers nodes as they mount and unmount. Construct, `subscribe`, and
 * `dispose`.
 */
export class BrowserLayoutObserver implements ILayoutObserver {
  readonly #core: BrowserObserver<LayoutObservation>;

  constructor(
    options: LayoutObserverOptions = defaultLayoutObserverOptions,
    deps: BrowserObserverDeps = {},
  ) {
    const RO =
      deps.ResizeObserverCtor ??
      (globalThis as { ResizeObserver?: BrowserObserverDeps['ResizeObserverCtor'] })
        .ResizeObserver!;
    this.#core = createObserver({
      ...layoutDerivation(options),
      surface: browserSurface(deps),
      snapshot: deps.snapshot ?? domSnapshot,
      discover: {
        mutationInit: { childList: true, subtree: true },
        rescheduleOnMutation: false,
        watch: (schedule) =>
          new RO((entries) => {
            for (const entry of entries) schedule(entry.target);
          }),
      },
    });
  }

  observe(nodeId: string): LayoutObservation | undefined {
    return this.#core.observe(nodeId);
  }

  observeTree(rootNodeId: string): LayoutObservation[] {
    return this.#core.observeTree(rootNodeId);
  }

  subscribe(handler: LayoutSubscriber): () => void {
    return this.#core.subscribe(handler);
  }

  register(nodeId: string, element?: unknown): void {
    this.#core.register(nodeId, element);
  }

  unregister(nodeId: string): void {
    this.#core.unregister(nodeId);
  }

  /** Disconnect both observers + cancel any pending frame. */
  dispose(): void {
    this.#core.dispose();
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
