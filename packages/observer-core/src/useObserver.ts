// ============================================================================
//  useObserver — the React wire-in both observer hooks share (Phase 2075).
//
//  Attaches an observer to the rendered subtree under the returned ref, and
//  fans each emitted observation out to `onObservation` and, flag by flag, to
//  `onFlag`. The callbacks are read through a ref so the observer is created
//  once on mount: tearing it down on every render would thrash whatever the
//  observer watches with. What differs per package — whether the browser can
//  drive observation at all, and how the observer is built — is passed in.
// ============================================================================

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

import type { Flagged, ObservationSubscriber } from './observer.js';

/** The callback half of a hook's arguments — common to both packages. */
export interface ObserverHookArgs<Flag, Obs extends Flagged<Flag>> {
  readonly onFlag?: (nodeId: string, flag: Flag) => void;
  readonly onObservation?: (nodeId: string, observation: Obs) => void;
  readonly enabled?: boolean;
}

/** The slice of an observer the hook drives. */
export interface HookedObserver<Obs> {
  subscribe(handler: ObservationSubscriber<Obs>): () => void;
  dispose(): void;
}

/**
 * The shared hook body. `canObserve` answers whether the environment (or the
 * caller's injected deps) can drive observation — `false` leaves the ref
 * unwired, e.g. under SSR; `create` builds the observer over the ref's element.
 * Both read the LATEST args.
 */
export function useObserver<
  T extends Element,
  Flag,
  Obs extends Flagged<Flag>,
  A extends ObserverHookArgs<Flag, Obs>,
>(
  args: A,
  canObserve: (args: A) => boolean,
  create: (root: T, args: A) => HookedObserver<Obs>,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const latest = useRef(args);
  latest.current = args;

  const enabled = args.enabled !== false;

  useEffect(() => {
    if (!enabled) return;
    const root = ref.current;
    if (root === null) return;
    if (!canObserve(latest.current)) return;

    const observer = create(root, latest.current);
    const unsubscribe = observer.subscribe((nodeId, observation) => {
      latest.current.onObservation?.(nodeId, observation);
      const onFlag = latest.current.onFlag;
      if (onFlag) for (const flag of observation.flags) onFlag(nodeId, flag);
    });

    return () => {
      unsubscribe();
      observer.dispose();
    };
    // `canObserve` / `create` are module-level functions in both callers; the
    // observer is rebuilt only when observation is switched on or off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return ref;
}
