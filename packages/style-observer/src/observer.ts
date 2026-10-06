// ============================================================================
//  @fuaran-ui/style-observer — the observer implementations.
//
//  Ports Fuaran.UI.StyleObserver.{InMemoryStyleObserver,BrowserStyleObserver}.
//
//  The registry, subscribers, change detection, discovery and frame flush are
//  the shared observer scaffolding (`@fuaran-ui/observer-core`, workspace-
//  internal and bundled into this package); what is style's own is below —
//  the computed-style snapshot, the derivation, and attribute-mutation
//  discovery.
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

import {
  browserSurface,
  createInMemoryObserver,
  createObserver,
  type BrowserObserver,
  type InMemoryObserver,
} from '@fuaran-ui/observer-core';
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

/**
 * The style half of the shared scaffolding: resolved colours in, style flags
 * out. When a manifest is wired, the manifest-aware (Phase 146) per-node flags
 * are appended to each manifest-free observation; without one only the
 * manifest-free flags fire (graceful degradation).
 */
const styleDerivation = (options: StyleObserverOptions, manifest: ThemeManifest | undefined) => ({
  policy: options,
  flagsEqual,
  derive: (nodeId: string, input: StyleInput): StyleObservation => {
    const obs = toStyleObservation(options, nodeId, input);
    return manifest === undefined
      ? obs
      : { ...obs, flags: [...obs.flags, ...perNodeFlags(manifest, obs)] };
  },
});

// ─── InMemoryStyleObserver ─────────────────────────────────────────────────────

/**
 * Fixture-driven observer — port of F# `InMemoryStyleObserver`. Register a
 * `StyleInput` fixture, assert the derived flags or the subscriber emission
 * pattern. `observeTree` walks a parent-pointer graph (the browser observer's DOM
 * walk is the production path). A bare `register` records a baseline entry
 * (opaque-black text on the implicit white canvas) so a renderer mount hook does
 * not crash on it.
 */
export class InMemoryStyleObserver implements IStyleObserver {
  readonly #core: InMemoryObserver<StyleInput, StyleObservation>;

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
    this.#core = createInMemoryObserver<StyleInput, StyleObservation, StyleFlag>({
      ...styleDerivation(options, manifest),
      baseline: baselineStyleInput,
    });
  }

  /** Register or replace a fixture; fires an initial emission unconditionally. */
  registerFixture(nodeId: string, input: StyleInput, parent?: string): void {
    this.#core.registerFixture(nodeId, input, parent);
  }

  /** Replace a registered node's input; honours `emitOnFlagChangeOnly`. No-op if absent. */
  update(nodeId: string, input: StyleInput): void {
    this.#core.update(nodeId, input);
  }

  observe(nodeId: string): StyleObservation | undefined {
    return this.#core.observe(nodeId);
  }

  observeTree(rootNodeId: string): StyleObservation[] {
    return this.#core.observeTree(rootNodeId);
  }

  subscribe(handler: StyleSubscriber): () => void {
    return this.#core.subscribe(handler);
  }

  register(nodeId: string, element?: unknown): void {
    this.#core.register(nodeId, element);
  }

  unregister(nodeId: string): void {
    this.#core.unregister(nodeId);
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
 * (e.g. a theme toggle recolours the tree): every mutation is a cheap full
 * rescan that also reschedules each still-present node. Construct, `subscribe`,
 * and `dispose`.
 */
export class BrowserStyleObserver implements IStyleObserver {
  readonly #core: BrowserObserver<StyleObservation>;

  constructor(
    options: StyleObserverOptions = defaultStyleObserverOptions,
    deps: BrowserObserverDeps = {},
    manifest?: ThemeManifest,
  ) {
    this.#core = createObserver({
      ...styleDerivation(options, manifest),
      surface: browserSurface(deps),
      snapshot: deps.snapshot ?? domStyleSnapshot,
      discover: {
        mutationInit: {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'data-fuaran-tone'],
        },
        rescheduleOnMutation: true,
      },
    });
  }

  observe(nodeId: string): StyleObservation | undefined {
    return this.#core.observe(nodeId);
  }

  observeTree(rootNodeId: string): StyleObservation[] {
    return this.#core.observeTree(rootNodeId);
  }

  subscribe(handler: StyleSubscriber): () => void {
    return this.#core.subscribe(handler);
  }

  register(nodeId: string, element?: unknown): void {
    this.#core.register(nodeId, element);
  }

  unregister(nodeId: string): void {
    this.#core.unregister(nodeId);
  }

  /** Disconnect the MutationObserver + cancel any pending frame. */
  dispose(): void {
    this.#core.dispose();
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
