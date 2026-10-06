// ============================================================================
//  useFuaranLayoutObserver — the React wire-in for a rendered Fuaran tree.
//
//  The boundary-respecting analogue of "wire an onLayoutFlag prop into
//  <FuaranRenderer>": because the peer-dependency direction is
//  layout-observer → renderer (never the reverse), the renderer cannot import
//  this package's LayoutFlag type, so the wire-in lives here as a hook the
//  consumer attaches to a container wrapping <FuaranRenderer>. This mirrors the
//  F# architecture, where the browser observer self-discovers the rendered tree
//  via `[data-fuaran-node-id]` rather than the renderer holding a per-element
//  ref hook — the renderer stays lifecycle-agnostic.
//
//  Usage:
//    const ref = useFuaranLayoutObserver<HTMLDivElement>({
//      onFlag: (nodeId, flag) => console.warn(nodeId, flag.kind),
//    });
//    return <div ref={ref}><FuaranRenderer tree={tree} /></div>;
// ============================================================================

import type { RefObject } from 'react';

import { useObserver } from '@fuaran-ui/observer-core';

import {
  defaultLayoutObserverOptions,
  type LayoutFlag,
  type LayoutObservation,
  type LayoutObserverOptions,
} from './flags.js';
import { BrowserLayoutObserver, type BrowserObserverDeps } from './observer.js';

export interface UseLayoutObserverArgs {
  /** Per-flag callback — the `onLayoutFlag` analogue. Fired for every flag of every emitted observation. */
  readonly onFlag?: (nodeId: string, flag: LayoutFlag) => void;
  /** Full-observation callback — fired once per emitted observation (raw + flags). */
  readonly onObservation?: (nodeId: string, observation: LayoutObservation) => void;
  /** Observer policy. Defaults to `defaultLayoutObserverOptions`. */
  readonly options?: LayoutObserverOptions;
  /** Injectable browser-surface deps (minus `root`, which the ref supplies). */
  readonly deps?: Omit<BrowserObserverDeps, 'root'>;
  /** Set false to disable observation (e.g. in tests / SSR). Defaults to true. */
  readonly enabled?: boolean;
}

/** Observation needs a ResizeObserver — the global, or one the caller injected
 * via `deps` (the test / non-DOM-host path). */
const canObserve = (args: UseLayoutObserverArgs): boolean =>
  typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver !== 'undefined' ||
  args.deps?.ResizeObserverCtor !== undefined;

const create = (root: Element, args: UseLayoutObserverArgs): BrowserLayoutObserver =>
  new BrowserLayoutObserver(args.options ?? defaultLayoutObserverOptions, {
    root,
    ...args.deps,
  });

/**
 * Attach a `BrowserLayoutObserver` to the rendered subtree under the returned
 * ref. Set the ref on a container that wraps `<FuaranRenderer>`; the observer
 * self-discovers the rendered nodes via `[data-fuaran-node-id]` and reports
 * layout flags through `onFlag` / `onObservation`. Created once on mount (the
 * callbacks are read through a ref, so re-rendering does not thrash the
 * ResizeObserver). No-op (returns the ref unwired) when `ResizeObserver` is
 * unavailable — e.g. under SSR.
 */
export function useFuaranLayoutObserver<T extends Element = HTMLDivElement>(
  args: UseLayoutObserverArgs = {},
): RefObject<T | null> {
  return useObserver<T, LayoutFlag, LayoutObservation, UseLayoutObserverArgs>(
    args,
    canObserve,
    create,
  );
}
