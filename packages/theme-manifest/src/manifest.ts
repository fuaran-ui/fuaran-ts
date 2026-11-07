// ============================================================================
//  @fuaran-ui/theme-manifest/manifest — the declared token contract.
//
//  TypeScript port of Fuaran.UI.ThemeManifest's `Manifest` + `Invariant`
//  modules. A machine-readable theme contract the AI can reason against and the
//  computed-style observer (@fuaran-ui/style-observer) can verify resolved style
//  against. DTCG-compatible (a vanilla DTCG file decodes cleanly) extended with
//  the two things DTCG lacks:
//
//    1. A per-token role → ToneVariant mapping (`RoleBinding`), so `Tone.Brand`
//       is known to resolve to the manifest's brand token.
//    2. An invariant block — contrast floors, colour-usage budgets, motion voice
//       — soft-weighted (each invariant carries a `weight`).
//
//  The manifest is a host/theme artefact, NOT part of the Node tree; it travels
//  alongside the tree. Depends only on @fuaran-ui/schema (for ToneVariant).
// ============================================================================

import type { ToneVariant } from '@fuaran-ui/schema';

/** Manifest metadata — the `meta` block. */
export interface ManifestMeta {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

/** A minimal metadata block — for a vanilla DTCG file carrying no `meta`. */
export const anonymousMeta: ManifestMeta = { name: '', version: '' };

/**
 * One token entry — DTCG-compatible (`type`/`value`/`description` round-trip the
 * DTCG `$type`/`$value`/`$description`) plus the SPEC dual-field `role` semantic
 * tag. `name` is the token's dotted path (`"color.brand.base"`), the flattened
 * DTCG group tree. `value` stays a string so any DTCG value kind round-trips.
 */
export interface ManifestToken {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly description?: string;
  readonly role?: string;
}

/**
 * The role a `RoleBinding` binds. `Tone` covers the canonical `ToneVariant`
 * palette; `Named` covers the broader semantic-role vocabulary (body text,
 * divider, …). Port of F# `ManifestRole`.
 */
export type ManifestRole =
  | { readonly kind: 'Tone'; readonly tone: ToneVariant }
  | { readonly kind: 'Named'; readonly name: string };

const TONES: readonly ToneVariant[] = [
  'Default',
  'Subdued',
  'Brand',
  'Success',
  'Warning',
  'Critical',
  'Info',
];

/** Stable wire string for a `ToneVariant` — PascalCase, matching the typed surface. */
export const toneToString = (tone: ToneVariant): string => tone;

/** Parse a wire string back to a `ToneVariant`, or `undefined` for an unrecognised token. */
export const toneOfString = (s: string): ToneVariant | undefined =>
  (TONES as readonly string[]).includes(s) ? (s as ToneVariant) : undefined;

/** Binds a role onto a manifest token by name. */
export interface RoleBinding {
  readonly role: ManifestRole;
  readonly tokenName: string;
}

// ─── Invariants ───────────────────────────────────────────────────────────────

/** The motion-voice budget — the payload of `MotionVoice`. */
export interface MotionBudget {
  readonly maxDurationMs: number;
  readonly easing?: string;
}

/**
 * The bounded, additive-only invariant vocabulary. Port of F# `InvariantKind`.
 *  - `ContrastFloor`: a named role's resolved contrast must be ≥ `minRatio`
 *    (stricter than the manifest-free WCAG AA default).
 *  - `UsageBudget`: a token's share of visible surface must stay within
 *    `targetPct ± tolerancePct` (the 60-30-10 formalisation).
 *  - `MotionVoice`: the theme's motion must stay within the `MotionBudget`.
 *  - `Unknown` (Phase 2133): an invariant whose wire kind this host does not
 *    know. It is KEPT — `name` is the wire kind as written, `members` its other
 *    members except `weight`, as parsed — so it round-trips through decode and
 *    encode, and `validateManifest` reports it as `INVARIANT_KIND_UNKNOWN`:
 *    declared, and enforced by nothing here.
 */
export type InvariantKind =
  | { readonly kind: 'ContrastFloor'; readonly role: string; readonly minRatio: number }
  | {
      readonly kind: 'UsageBudget';
      readonly token: string;
      readonly targetPct: number;
      readonly tolerancePct: number;
    }
  | { readonly kind: 'MotionVoice'; readonly budget: MotionBudget }
  | {
      readonly kind: 'Unknown';
      readonly name: string;
      readonly members: Readonly<Record<string, unknown>>;
    };

/** One declared invariant + its soft weight. `weight` defaults to 1.0. */
export interface Invariant {
  readonly kind: InvariantKind;
  readonly weight: number;
}

/** The default invariant weight — equal importance. */
export const DEFAULT_WEIGHT = 1.0;

/** Construct an invariant with the default weight. */
export const invariant = (kind: InvariantKind): Invariant => ({ kind, weight: DEFAULT_WEIGHT });

/** Construct an invariant with an explicit weight. */
export const weightedInvariant = (weight: number, kind: InvariantKind): Invariant => ({
  kind,
  weight,
});

/** Stable string discriminator for an invariant — the wire kind, as written, for an unknown one. */
export const invariantKindName = (inv: Invariant): string =>
  inv.kind.kind === 'Unknown' ? inv.kind.name : inv.kind.kind;

// ─── ThemeManifest ──────────────────────────────────────────────────────────────

/** The declared theme contract: metadata + tokens + role bindings + invariants. */
export interface ThemeManifest {
  readonly meta: ManifestMeta;
  readonly tokens: readonly ManifestToken[];
  readonly roles: readonly RoleBinding[];
  readonly invariants: readonly Invariant[];
}

/** The empty manifest — no tokens, roles, or invariants. */
export const emptyManifest: ThemeManifest = {
  meta: anonymousMeta,
  tokens: [],
  roles: [],
  invariants: [],
};

/** Look up a token by its dotted name. */
export const tryGetToken = (name: string, manifest: ThemeManifest): ManifestToken | undefined =>
  manifest.tokens.find((t) => t.name === name);

/**
 * Resolve a `ToneVariant` to its declared manifest token — the lookup the
 * observer's manifest-aware pass consumes. `undefined` when no role binding
 * exists for the tone, or the bound token is absent (a dangling binding).
 */
export const resolveRole = (
  tone: ToneVariant,
  manifest: ThemeManifest,
): ManifestToken | undefined => {
  for (const b of manifest.roles) {
    if (b.role.kind === 'Tone' && b.role.tone === tone) return tryGetToken(b.tokenName, manifest);
  }
  return undefined;
};

/** Resolve a named (non-tone) role to its declared manifest token. */
export const resolveNamedRole = (
  role: string,
  manifest: ThemeManifest,
): ManifestToken | undefined => {
  for (const b of manifest.roles) {
    if (b.role.kind === 'Named' && b.role.name === role) return tryGetToken(b.tokenName, manifest);
  }
  return undefined;
};

/** Every colour value declared in the palette — the membership set for the off-palette check. */
export const paletteColours = (manifest: ThemeManifest): ReadonlySet<string> =>
  new Set(manifest.tokens.filter((t) => t.type === 'color').map((t) => t.value));

// ─── Validation — what the decoded values MEAN (Phase 2133) ────────────────────

/**
 * The shared validation defect codes — the table in the corpus's WIRE_FORMAT
 * §13 (the style-observer family's `manifest-validation` tier), identical on
 * every manifest host:
 *  - `CONTRAST_FLOOR_OUT_OF_RANGE`: a `ContrastFloor`'s `minRatio` lies outside
 *    [1, 21] (an omitted one is 0); `subject` is the role.
 *  - `CONTRAST_FLOOR_ROLE_EMPTY`: its `role` is empty; `subject` is `''`.
 *  - `CONTRAST_FLOOR_ROLE_UNBOUND`: no role binding binds its non-empty role.
 *  - `USAGE_BUDGET_TOKEN_UNDECLARED`: a `UsageBudget`'s token names no declared
 *    token; `subject` is the token.
 *  - `INVARIANT_KIND_UNKNOWN`: the kind is outside this host's vocabulary — kept,
 *    and enforced by nothing; `subject` is the kind.
 */
export type ManifestDefectCode =
  | 'CONTRAST_FLOOR_OUT_OF_RANGE'
  | 'CONTRAST_FLOOR_ROLE_EMPTY'
  | 'CONTRAST_FLOOR_ROLE_UNBOUND'
  | 'USAGE_BUDGET_TOKEN_UNDECLARED'
  | 'INVARIANT_KIND_UNKNOWN';

/** One validation finding: which rule, which invariant (its position in the decoded list), and what it names. */
export interface ManifestDefect {
  readonly code: ManifestDefectCode;
  readonly index: number;
  readonly subject: string;
}

/** The range WCAG's contrast formula produces: below it every pair passes, above it none can. */
const MIN_CONTRAST_RATIO = 1;
const MAX_CONTRAST_RATIO = 21;

/** Does any role binding bind `role`? A tone binding binds its tone's wire name, a named one its name. */
const binds = (role: string, manifest: ThemeManifest): boolean =>
  manifest.roles.some((b) => (b.role.kind === 'Tone' ? b.role.tone : b.role.name) === role);

/**
 * The validation pass, run after the tolerant decode (Phase 2133): every
 * declared invariant that cannot mean what it says, as one shared code.
 * Invariant by invariant in list order, and within one in the table's order.
 * Never refuses and never repairs; a host decides what a defect costs it.
 */
export const validateManifest = (manifest: ThemeManifest): readonly ManifestDefect[] => {
  const out: ManifestDefect[] = [];
  manifest.invariants.forEach((inv, index) => {
    const k = inv.kind;
    switch (k.kind) {
      case 'ContrastFloor':
        if (!(k.minRatio >= MIN_CONTRAST_RATIO && k.minRatio <= MAX_CONTRAST_RATIO))
          out.push({ code: 'CONTRAST_FLOOR_OUT_OF_RANGE', index, subject: k.role });
        if (k.role === '') out.push({ code: 'CONTRAST_FLOOR_ROLE_EMPTY', index, subject: '' });
        else if (!binds(k.role, manifest))
          out.push({ code: 'CONTRAST_FLOOR_ROLE_UNBOUND', index, subject: k.role });
        break;
      case 'UsageBudget':
        if (tryGetToken(k.token, manifest) === undefined)
          out.push({ code: 'USAGE_BUDGET_TOKEN_UNDECLARED', index, subject: k.token });
        break;
      case 'Unknown':
        out.push({ code: 'INVARIANT_KIND_UNKNOWN', index, subject: k.name });
        break;
      case 'MotionVoice':
        break;
    }
  });
  return out;
};
