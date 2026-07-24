// @fuaran-ui/theme-manifest — the machine-readable theme contract for Fuaran UI.
//
// Canonical import:
//   import { decodeManifest, resolveRole, type ThemeManifest } from '@fuaran-ui/theme-manifest';
//
// The TypeScript twin of Fuaran.UI.ThemeManifest: a DTCG-compatible token model
// extended with semantic role bindings (which token a Tone resolves to) and
// quantified invariants (per-role contrast floors, 60-30-10 colour-usage budgets,
// motion voice). It is the contract the computed-style observer
// (@fuaran-ui/style-observer) verifies resolved style against.

export {
  type ManifestMeta,
  type ManifestToken,
  type ManifestRole,
  type RoleBinding,
  type MotionBudget,
  type InvariantKind,
  type Invariant,
  type ThemeManifest,
  anonymousMeta,
  emptyManifest,
  DEFAULT_WEIGHT,
  invariant,
  weightedInvariant,
  invariantKindName,
  toneToString,
  toneOfString,
  tryGetToken,
  resolveRole,
  resolveNamedRole,
  paletteColours,
} from './manifest.js';

export { type DecodeManifestResult, manifestFromJson, decodeManifest } from './decode.js';

export {
  type CssBlock,
  scanCssBlocks,
  projectFromFuaranToneVars,
  projectFromCssCustomProperties,
  projectFromDtcg,
  merge,
} from './project.js';
