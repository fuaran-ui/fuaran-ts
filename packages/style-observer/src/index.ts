// @fuaran-ui/style-observer — browser-default computed-style observer for the
// Fuaran UI typed Node tree.
//
// Canonical import:
//   import { BrowserStyleObserver, useFuaranStyleObserver } from '@fuaran-ui/style-observer';
//   import type { StyleFlag, StyleObservation } from '@fuaran-ui/style-observer';
//
// The TypeScript port of Fuaran.UI.StyleObserver.{Abstractions,Default}. A
// rendered Fuaran tree's resolved styles are read back via getComputedStyle + an
// effective-background composite walk; the observer derives a small fixed
// vocabulary of resolved-style flags (contrast-below-AA, invisible-text,
// accent-indistinct) the semantic-state channel is blind to, as small typed facts
// rather than a screenshot, for a TS host's dev tooling — or an
// orchestrator-feedback loop where one exists. The flag + observation JSON shape
// is byte-identical to the F# tier for the same value.

export {
  // Colour primitive + helpers
  type Rgba,
  black,
  white,
  transparent,
  rgb,
  rgba,
  isOpaque,
  sameRgb,
  tryParseHex,
  encodeRgba,
  // Font + flag + observation types
  type FontRole,
  type StyleFlag,
  type StyleObservation,
  type StyleInput,
  type StyleObserverOptions,
  defaultStyleObserverOptions,
  baselineStyleInput,
  flagKind,
  encodeStyleFlag,
  encodeStyleObservation,
  flagsEqual,
  // Compositing + WCAG contrast
  composite,
  effectiveBackground,
  relativeLuminance,
  contrastRatio,
  resolvedBackground,
  resolvedForeground,
  contrast,
  fontRole,
  // Per-flag predicates + combined derivation
  invisibleText,
  contrastBelowAA,
  accentIndistinct,
  deriveStyleFlags,
  toStyleObservation,
} from './flags.js';

export {
  type IStyleObserver,
  type StyleSubscriber,
  type BrowserObserverDeps,
  type MutationObserverLike,
  InMemoryStyleObserver,
  BrowserStyleObserver,
  parseCssColor,
  domStyleSnapshot,
} from './observer.js';

// Manifest-aware (Phase 146) flag derivation — verifies resolved style against a
// declared @fuaran-ui/theme-manifest. `perNodeFlags` is appended per observation
// by an observer constructed with a manifest; `verifyUsageBudgets` is the
// tree-level area-weighted 60-30-10 check (join with @fuaran-ui/layout-observer
// areas).
export { perNodeFlags, verifyUsageBudgets } from './manifestFlags.js';

export { useFuaranStyleObserver, type UseStyleObserverArgs } from './useStyleObserver.js';
