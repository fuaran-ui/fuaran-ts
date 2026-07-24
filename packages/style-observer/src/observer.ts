// ============================================================================
//  @fuaran-ui/style-observer — the observer implementations.
//
//  Ports Fuaran.UI.StyleObserver.{InMemoryStyleObserver,BrowserStyleObserver}.
//
//   - InMemoryStyleObserver: fixture-driven, substrate-free. Drives tests +
//     non-browser hosts; walks a parent-pointer graph for observeTree.
//   - BrowserStyleObserver: getComputedStyle-backed self-discovery via
//     `[data-fuaran-node-id]` (the attribute the renderer emits on every node
//     wrapper) + MutationObserver reactive discovery (class / style /
//     data-fuaran-tone changes re-derive the affected node's flags), rAF-coalesced
//     + wall-clock debounced, change-detected. Browser API access is behind an
//     injectable deps object — the default reads the live DOM; tests supply a
//     stubbed `snapshot` + a fake MutationObserver + a deferred rAF (the TS
//     analogue of the F# tier's Emit-wrapped browser surface).
//
//  Unlike the layout observer there is no ResizeObserver: resolved style changes
//  on class / inline-style / tone-attribute mutations, which the MutationObserver
//  watches, not on geometry.
// ============================================================================

import type { ThemeManifest } from '@fuaran-ui/theme-manifest';

import {
  baselineStyleInput,
  defaultStyleObserverOptions,
  flagsEqual,
  rgb,
  rgba,
  toStyleObservation,
  transparent,
  type Rgba,
  type StyleFlag,
  type StyleInput,
  type StyleObservation,
  type StyleObserverOptions,
} from './flags.js';
import { perNodeFlags } from './manifestFlags.js';

/**
 * Append the manifest-aware (Phase 146) per-node flags to a manifest-free
 * observation when a manifest is wired; pass it through unchanged otherwise
 * (graceful degradation — only the manifest-free flags fire without a manifest).
 */
const withManifest = (
  manifest: ThemeManifest | undefined,
  obs: StyleObservation,
): StyleObservation =>
  manifest === undefined ? obs : { ...obs, flags: [...obs.flags, ...perNodeFlags(manifest, obs)] };

/** Handler signature for `subscribe` — receives `(nodeId, observation)`. */
export type StyleSubscriber = (nodeId: string, observation: StyleObservation) => void;

/**
 * The observer contract — three reads (single-node, tree, subscription) + two
 * registration calls. Port of F# `IStyleObserver`; `subscribe` returns an
 * unsubscribe thunk (the TS analogue of the F# `IDisposable`).
 */
export interface IStyleObserver {
  /** Snapshot the observation for a single registered node, or `undefined`. */
  observe(nodeId: string): StyleObservation | undefined;
  /** Snapshot every observation reachable from `rootNodeId`, including the root. */
  observeTree(rootNodeId: string): StyleObservation[];
  /** Subscribe to live deltas; returns an unsubscribe thunk. */
  subscribe(handler: StyleSubscriber): () => void;
  /** Register a node for observation. Idempotent. */
  register(nodeId: string, element?: unknown): void;
  /** Unregister a node. Idempotent. */
  unregister(nodeId: string): void;
}

const emitTo = (
  subscribers: readonly StyleSubscriber[],
  nodeId: string,
  obs: StyleObservation,
): void => {
  for (const subscriber of subscribers) {
    try {
      subscriber(nodeId, obs);
    } catch {
      // A subscriber throwing must not poison sibling subscribers.
    }
  }
};

// ─── InMemoryStyleObserver ─────────────────────────────────────────────────────

interface StyleFixture {
  readonly input: StyleInput;
  readonly parent?: string;
}

/**
 * Fixture-driven observer — port of F# `InMemoryStyleObserver`. Register a
 * `StyleInput` fixture, assert the derived flags or the subscriber emission
 * pattern. `observeTree` walks a parent-pointer graph (the browser observer's DOM
 * walk is the production path).
 */
export class InMemoryStyleObserver implements IStyleObserver {
  readonly #options: StyleObserverOptions;
  readonly #manifest: ThemeManifest | undefined;
  readonly #registry = new Map<string, StyleFixture>();
  readonly #lastFlags = new Map<string, readonly StyleFlag[]>();
  readonly #subscribers: StyleSubscriber[] = [];

  /**
   * @param options observer policy (defaults to v1)
   * @param manifest optional `ThemeManifest` — when wired, the per-node
   *   manifest-aware (Phase 146) flags are appended to each observation. Without
   *   it only the manifest-free flags fire (graceful degradation).
   */
  constructor(
    options: StyleObserverOptions = defaultStyleObserverOptions,
    manifest?: ThemeManifest,
  ) {
    this.#options = options;
    this.#manifest = manifest;
  }

  #toObs(nodeId: string, input: StyleInput): StyleObservation {
    return withManifest(this.#manifest, toStyleObservation(this.#options, nodeId, input));
  }

  /** Register or replace a fixture; fires an initial emission unconditionally. */
  registerFixture(nodeId: string, input: StyleInput, parent?: string): void {
    const fixture: StyleFixture = parent !== undefined ? { input, parent } : { input };
    this.#registry.set(nodeId, fixture);
    const obs = this.#toObs(nodeId, input);
    this.#lastFlags.set(nodeId, obs.flags);
    emitTo(this.#subscribers, nodeId, obs);
  }

  /** Replace a registered node's input; honours `emitOnFlagChangeOnly`. No-op if absent. */
  update(nodeId: string, input: StyleInput): void {
    const existing = this.#registry.get(nodeId);
    if (existing === undefined) return;
    const next: StyleFixture =
      existing.parent !== undefined ? { input, parent: existing.parent } : { input };
    this.#registry.set(nodeId, next);
    const obs = this.#toObs(nodeId, input);
    const previous = this.#lastFlags.get(nodeId) ?? [];
    this.#lastFlags.set(nodeId, obs.flags);
    const shouldEmit = this.#options.emitOnFlagChangeOnly ? !flagsEqual(obs.flags, previous) : true;
    if (shouldEmit) emitTo(this.#subscribers, nodeId, obs);
  }

  observe(nodeId: string): StyleObservation | undefined {
    const fixture = this.#registry.get(nodeId);
    return fixture === undefined ? undefined : this.#toObs(nodeId, fixture.input);
  }

  observeTree(rootNodeId: string): StyleObservation[] {
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
    const acc: StyleObservation[] = [];
    const queue: string[] = [rootNodeId];
    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const fixture = this.#registry.get(nodeId);
      if (fixture !== undefined) acc.push(this.#toObs(nodeId, fixture.input));
      queue.push(...(children.get(nodeId) ?? []));
    }
    return acc;
  }

  subscribe(handler: StyleSubscriber): () => void {
    this.#subscribers.push(handler);
    return () => {
      const i = this.#subscribers.indexOf(handler);
      if (i >= 0) this.#subscribers.splice(i, 1);
    };
  }

  register(nodeId: string, _element?: unknown): void {
    // Bare register with no fixture creates a baseline entry (opaque-black text on
    // the implicit white canvas) so calls from a renderer mount hook don't crash.
    if (!this.#registry.has(nodeId)) this.registerFixture(nodeId, baselineStyleInput());
  }

  unregister(nodeId: string): void {
    this.#registry.delete(nodeId);
    this.#lastFlags.delete(nodeId);
  }
}

// ─── BrowserStyleObserver ──────────────────────────────────────────────────────

/** A MutationObserver-shaped constructor (the slice this observer uses). */
export interface MutationObserverLike {
  observe(
    target: Node,
    options: {
      childList?: boolean;
      subtree?: boolean;
      attributes?: boolean;
      attributeFilter?: string[];
    },
  ): void;
  disconnect(): void;
}

/**
 * Injectable browser-surface dependencies. Every field defaults to the live
 * browser global; tests override them (a stubbed `snapshot` + a fake
 * MutationObserver + a deferred rAF) — the TS analogue of the F# tier's
 * Emit-wrapped browser API.
 */
export interface BrowserObserverDeps {
  /** The subtree to scan + watch. Default `document.body`. */
  readonly root?: Element;
  /** Read a `StyleInput` from a registered element. Default reads the live computed style. */
  readonly snapshot?: (element: Element) => StyleInput;
  /** Monotonic clock in ms. Default `performance.now`. */
  readonly now?: () => number;
  /** Schedule a callback for the next frame; returns a cancel handle. Default `requestAnimationFrame`. */
  readonly requestFrame?: (cb: () => void) => number;
  /** Cancel a scheduled frame. Default `cancelAnimationFrame`. */
  readonly cancelFrame?: (handle: number) => void;
  /** MutationObserver constructor. Default the global. */
  readonly MutationObserverCtor?: new (cb: () => void) => MutationObserverLike;
}

/**
 * getComputedStyle-backed observer — port of F# `BrowserStyleObserver`. Discovers
 * addressable elements via `[data-fuaran-node-id]` (the attribute the renderer
 * emits), reads the resolved styles on the rAF tick, derives flags, and emits per
 * the debounce + change-detection policy. A MutationObserver watching class /
 * style / data-fuaran-tone re-derives a node's flags when its styling mutates
 * (e.g. a theme toggle recolours the tree). Construct, `subscribe`, and `dispose`.
 */
export class BrowserStyleObserver implements IStyleObserver {
  readonly #options: StyleObserverOptions;
  readonly #manifest: ThemeManifest | undefined;
  readonly #root: Element;
  readonly #snapshot: (element: Element) => StyleInput;
  readonly #now: () => number;
  readonly #requestFrame: (cb: () => void) => number;
  readonly #cancelFrame: (handle: number) => void;

  readonly #registry = new Map<string, Element>();
  readonly #lastFlags = new Map<string, readonly StyleFlag[]>();
  readonly #lastEmitAt = new Map<string, number>();
  readonly #lastObservation = new Map<string, StyleObservation>();
  readonly #subscribers: StyleSubscriber[] = [];
  readonly #pending = new Set<string>();
  #rafHandle: number | undefined = undefined;
  #disposed = false;

  readonly #mutationObserver: MutationObserverLike;

  constructor(
    options: StyleObserverOptions = defaultStyleObserverOptions,
    deps: BrowserObserverDeps = {},
    manifest?: ThemeManifest,
  ) {
    this.#options = options;
    this.#manifest = manifest;
    this.#root = deps.root ?? (globalThis as { document?: { body: Element } }).document!.body;
    this.#snapshot = deps.snapshot ?? domStyleSnapshot;
    this.#now = deps.now ?? (() => performance.now());
    this.#requestFrame = deps.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.#cancelFrame = deps.cancelFrame ?? ((h) => cancelAnimationFrame(h));

    const MO =
      deps.MutationObserverCtor ??
      (globalThis as { MutationObserver?: BrowserObserverDeps['MutationObserverCtor'] })
        .MutationObserver!;
    this.#mutationObserver = new MO(() => this.#rescan());

    this.#scanInitial();
    this.#mutationObserver.observe(this.#root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-fuaran-tone'],
    });
  }

  #buildObservation(nodeId: string, element: Element): StyleObservation {
    return withManifest(
      this.#manifest,
      toStyleObservation(this.#options, nodeId, this.#snapshot(element)),
    );
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
      this.#scheduleFlush(nodeId);
    }
  }

  #unregisterElement(nodeId: string): void {
    if (!this.#registry.has(nodeId)) return;
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
    // Cheap full rescan — re-walk on any mutation. New elements get observed;
    // departed elements are unregistered; every still-present node is rescheduled
    // so a class / style / tone mutation re-derives its flags (a theme toggle
    // recolours the whole tree).
    const seen = new Set<string>();
    for (const element of this.#root.querySelectorAll('[data-fuaran-node-id]')) {
      const nodeId = element.getAttribute('data-fuaran-node-id');
      if (nodeId) {
        seen.add(nodeId);
        this.#registerElement(nodeId, element);
        this.#scheduleFlush(nodeId);
      }
    }
    for (const nodeId of [...this.#registry.keys()]) {
      if (!seen.has(nodeId)) this.#unregisterElement(nodeId);
    }
  }

  observe(nodeId: string): StyleObservation | undefined {
    const element = this.#registry.get(nodeId);
    if (element !== undefined) return this.#buildObservation(nodeId, element);
    return this.#lastObservation.get(nodeId);
  }

  observeTree(rootNodeId: string): StyleObservation[] {
    const rootEl = this.#registry.get(rootNodeId);
    if (rootEl === undefined) return [];
    const result = [this.#buildObservation(rootNodeId, rootEl)];
    for (const element of rootEl.querySelectorAll('[data-fuaran-node-id]')) {
      const nodeId = element.getAttribute('data-fuaran-node-id');
      if (nodeId) result.push(this.#buildObservation(nodeId, element));
    }
    return result;
  }

  subscribe(handler: StyleSubscriber): () => void {
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

  /** Disconnect the MutationObserver + cancel any pending frame. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#mutationObserver.disconnect();
    if (this.#rafHandle !== undefined) this.#cancelFrame(this.#rafHandle);
  }
}

// ─── Default DOM computed-style snapshot ───────────────────────────────────────

/**
 * Parse a computed `color` / `background-color` string to an `Rgba`. Computed
 * values always come back as `rgb(r, g, b)` / `rgba(r, g, b, a)` (or `transparent`
 * / `rgba(0, 0, 0, 0)`). Anything unrecognised becomes transparent so the layer
 * is skipped by the composite walk. Port of F# `parseCssColor`.
 */
export const parseCssColor = (raw: string | null): Rgba => {
  if (raw === null || raw === '' || raw === 'transparent' || raw === 'none') return transparent;
  const lower = raw.trim().toLowerCase();
  let body: string | undefined;
  if (lower.startsWith('rgba(')) body = lower.slice(5).replace(/\)$/, '');
  else if (lower.startsWith('rgb(')) body = lower.slice(4).replace(/\)$/, '');
  else return transparent;
  const parts = body.split(',').map((p) => Number.parseFloat(p.trim()));
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    return rgb(parts[0]!, parts[1]!, parts[2]!);
  }
  if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
    return rgba(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
  }
  return transparent;
};

/**
 * Collect an element's own `background-color` followed by each ancestor's,
 * element-first, up to and including the document element. The effective-background
 * composite walk (`effectiveBackground`) folds these down to the first opaque
 * layer. Port of F# `backgroundColorStack`.
 */
const backgroundColorStack = (element: Element): Rgba[] => {
  const layers: Rgba[] = [];
  const html = element.ownerDocument.documentElement;
  let node: Element | null = element;
  while (node !== null && node !== html) {
    layers.push(parseCssColor(getComputedStyle(node).backgroundColor));
    node = node.parentElement;
  }
  if (node !== null) layers.push(parseCssColor(getComputedStyle(node).backgroundColor));
  return layers;
};

/** Read a `StyleInput` from a live DOM element — port of F# `snapshotInput`. */
export const domStyleSnapshot = (element: Element): StyleInput => {
  const style = getComputedStyle(element);
  const foreground = parseCssColor(style.color);
  const backgroundLayers = backgroundColorStack(element);
  const family = style.fontFamily;
  const fontFamily = family === null || family === '' ? undefined : family;
  const toneAttr = element.getAttribute('data-fuaran-tone');
  const emittedTone = toneAttr === null || toneAttr === '' ? undefined : toneAttr;
  return { foreground, backgroundLayers, fontFamily, emittedTone };
};
