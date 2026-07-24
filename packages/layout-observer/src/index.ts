// @fuaran-ui/layout-observer — browser-default layout-flag observer for the
// Fuaran UI typed Node tree.
//
// Canonical import:
//   import { BrowserLayoutObserver, useFuaranLayoutObserver } from '@fuaran-ui/layout-observer';
//   import type { LayoutFlag, LayoutObservation } from '@fuaran-ui/layout-observer';
//
// The TypeScript port of Fuaran.UI.LayoutObserver.{Abstractions,Default}. A
// rendered Fuaran tree's geometry is watched via ResizeObserver; the observer
// derives a small fixed vocabulary of layout flags (overflow, zero-dimension,
// squeezed-to-min, clipped-by-ancestor, aspect-ratio-off) the semantic-state
// channel is blind to, for a TS host's dev tooling (truncation / overflow /
// accessibility hints) — or an orchestrator-feedback loop where one exists.
// The flag JSON shape is byte-identical to the F# tier for the same value.

export {
  type LayoutFlag,
  type LayoutObservation,
  type LayoutInput,
  type LayoutObserverOptions,
  defaultLayoutObserverOptions,
  emptyLayoutInput,
  deriveFlags,
  flagsEqual,
  flagKind,
  encodeFlag,
  encodeObservation,
  overflowHorizontal,
  overflowVertical,
  zeroDimension,
  squeezedToMin,
  childClippedByAncestor,
  aspectRatioWildlyOff,
} from './flags.js';

export {
  type ILayoutObserver,
  type LayoutSubscriber,
  type BrowserObserverDeps,
  type ResizeObserverLike,
  type MutationObserverLike,
  InMemoryLayoutObserver,
  BrowserLayoutObserver,
  domSnapshot,
} from './observer.js';

export { useFuaranLayoutObserver, type UseLayoutObserverArgs } from './useLayoutObserver.js';
