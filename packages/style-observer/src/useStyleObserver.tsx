// ============================================================================
//  useFuaranStyleObserver — the React wire-in for a rendered Fuaran tree.
//
//  The boundary-respecting analogue of "wire an onStyleFlag prop into
//  <FuaranRenderer>": because the peer-dependency direction is
//  style-observer → renderer (never the reverse), the renderer cannot import this
//  package's StyleFlag type, so the wire-in lives here as a hook the consumer
//  attaches to a container wrapping <FuaranRenderer>. This mirrors the F#
//  architecture, where the browser observer self-discovers the rendered tree via
//  `[data-fuaran-node-id]` rather than the renderer holding a per-element ref hook
//  — the renderer stays lifecycle-agnostic.
//
//  Usage:
//    const ref = useFuaranStyleObserver<HTMLDivElement>({
//      onFlag: (nodeId, flag) => console.warn(nodeId, flag.kind),
//    });
//    return <div ref={ref}><FuaranRenderer tree={tree} /></div>;
// ============================================================================

import type { RefObject } from 'react';

import { useObserver } from '@fuaran-ui/observer-core';
import type { ThemeManifest } from '@fuaran-ui/theme-manifest';

import {
  defaultStyleObserverOptions,
  type StyleFlag,
  type StyleObservation,
  type StyleObserverOptions,
} from './flags.js';
import { BrowserStyleObserver, type BrowserObserverDeps } from './observer.js';

export interface UseStyleObserverArgs {
  /** Per-flag callback — the `onStyleFlag` analogue. Fired for every flag of every emitted observation. */
  readonly onFlag?: (nodeId: string, flag: StyleFlag) => void;
  /** Full-observation callback — fired once per emitted observation (resolved colours + flags). */
  readonly onObservation?: (nodeId: string, observation: StyleObservation) => void;
  /** Observer policy. Defaults to `defaultStyleObserverOptions`. */
  readonly options?: StyleObserverOptions;
  /**
   * Optional `ThemeManifest` — when supplied, the manifest-aware (Phase 146)
   * flags are appended to each observation (verifies resolved style against the
   * declared token contract). Omit for the manifest-free flags only.
   */
  readonly manifest?: ThemeManifest;
  /** Injectable browser-surface deps (minus `root`, which the ref supplies). */
  readonly deps?: Omit<BrowserObserverDeps, 'root'>;
  /** Set false to disable observation (e.g. in tests / SSR). Defaults to true. */
  readonly enabled?: boolean;
}

/** Observation needs a MutationObserver to drive discovery — the global, or one
 * the caller injected via `deps` (the test / non-DOM-host path). */
const canObserve = (args: UseStyleObserverArgs): boolean =>
  typeof (globalThis as { MutationObserver?: unknown }).MutationObserver !== 'undefined' ||
  args.deps?.MutationObserverCtor !== undefined;

const create = (root: Element, args: UseStyleObserverArgs): BrowserStyleObserver =>
  new BrowserStyleObserver(
    args.options ?? defaultStyleObserverOptions,
    { root, ...args.deps },
    args.manifest,
  );

/**
 * Attach a `BrowserStyleObserver` to the rendered subtree under the returned ref.
 * Set the ref on a container that wraps `<FuaranRenderer>`; the observer
 * self-discovers the rendered nodes via `[data-fuaran-node-id]` and reports
 * resolved-style flags through `onFlag` / `onObservation`. No-op (returns the ref
 * unwired) when `MutationObserver` is unavailable — e.g. under SSR.
 */
export function useFuaranStyleObserver<T extends Element = HTMLDivElement>(
  args: UseStyleObserverArgs = {},
): RefObject<T | null> {
  return useObserver<T, StyleFlag, StyleObservation, UseStyleObserverArgs>(
    args,
    canObserve,
    create,
  );
}
