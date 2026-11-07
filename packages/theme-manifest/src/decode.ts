// ============================================================================
//  @fuaran-ui/theme-manifest/decode — JSON → ThemeManifest.
//
//  Port of Fuaran.UI.ThemeManifest.Decode (using native JSON.parse rather than a
//  hand-rolled parser). Two top-level shapes are accepted:
//    1. A Fuaran manifest wrapper — { meta, tokens, roles, invariants }.
//    2. A vanilla DTCG file — the token group tree at top level, no wrapper
//       (decodes to a manifest with tokens populated, empty roles/invariants).
//  Detection: presence of a top-level `tokens` key selects shape (1).
//
//  A missing invariant / role-binding member decodes to its default (`0`, `''`,
//  `Named('')`), and an invariant kind this host does not know is KEPT as an
//  `Unknown` invariant. Decoding stays tolerant and total (Phase 2077 measured
//  why): the cross-host manifest byte law omits a member at its default, so
//  `{"kind":"ContrastFloor","role":"x"}` IS the canonical encoding of a ratio-0
//  floor on every host. What the decoded values MEAN — a floor outside [1, 21],
//  an empty or unbound role, an undeclared budget token, an unknown kind — is
//  checked after decode by `validateManifest` (Phase 2133).
// ============================================================================

import {
  DEFAULT_WEIGHT,
  type Invariant,
  type ManifestMeta,
  type ManifestRole,
  type ManifestToken,
  type RoleBinding,
  type ThemeManifest,
  anonymousMeta,
  emptyManifest,
  toneOfString,
} from './manifest.js';

type JsonObject = Record<string, unknown>;

const asObject = (v: unknown): JsonObject | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined;
const asArray = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? v : undefined);
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

// ─── DTCG token-tree walk ─────────────────────────────────────────────────────

/**
 * Walk a DTCG group/leaf node, accumulating flat dotted-name tokens. A node is a
 * leaf when it carries a `$value`; otherwise it is a group whose non-`$`-prefixed
 * children are recursed (prefixing names).
 */
const walkTokens = (prefix: string, node: unknown): ManifestToken[] => {
  const obj = asObject(node);
  if (obj === undefined) return [];
  if ('$value' in obj) {
    const role = asObject(asObject(obj['$extensions'])?.['fuaran'])?.['role'];
    const token: ManifestToken = {
      name: prefix,
      type: asString(obj['$type']) ?? '',
      value: asString(obj['$value']) ?? '',
      ...(asString(obj['$description']) !== undefined
        ? { description: asString(obj['$description'])! }
        : {}),
      ...(asString(role) !== undefined ? { role: asString(role)! } : {}),
    };
    return [token];
  }
  const out: ManifestToken[] = [];
  for (const [k, child] of Object.entries(obj)) {
    if (k.startsWith('$')) continue;
    out.push(...walkTokens(prefix === '' ? k : `${prefix}.${k}`, child));
  }
  return out;
};

// ─── roles + invariants ─────────────────────────────────────────────────────

const parseRole = (j: unknown): ManifestRole => {
  const obj = asObject(j);
  if (obj === undefined) return { kind: 'Named', name: '' };
  const tone = asString(obj['tone']);
  if (tone !== undefined) {
    const t = toneOfString(tone);
    return t !== undefined ? { kind: 'Tone', tone: t } : { kind: 'Named', name: tone };
  }
  return { kind: 'Named', name: asString(obj['named']) ?? '' };
};

const parseRoleBinding = (j: unknown): RoleBinding | undefined => {
  const obj = asObject(j);
  if (obj === undefined) return undefined;
  const token = asString(obj['token']);
  if (token === undefined) return undefined;
  return {
    role: 'role' in obj ? parseRole(obj['role']) : { kind: 'Named', name: '' },
    tokenName: token,
  };
};

const parseInvariant = (j: unknown): Invariant | undefined => {
  const obj = asObject(j);
  if (obj === undefined) return undefined;
  const weight = asNumber(obj['weight']) ?? DEFAULT_WEIGHT;
  const str = (name: string): string | undefined => asString(obj[name]);
  const num = (name: string): number | undefined => asNumber(obj[name]);
  const kind = str('kind');
  // An object with no non-empty string `kind` is not an invariant of any kind.
  if (kind === undefined || kind === '') return undefined;
  switch (kind) {
    case 'ContrastFloor':
      return {
        kind: { kind: 'ContrastFloor', role: str('role') ?? '', minRatio: num('minRatio') ?? 0 },
        weight,
      };
    case 'UsageBudget':
      return {
        kind: {
          kind: 'UsageBudget',
          token: str('token') ?? '',
          targetPct: num('targetPct') ?? 0,
          tolerancePct: num('tolerancePct') ?? 0,
        },
        weight,
      };
    case 'MotionVoice':
      return {
        kind: {
          kind: 'MotionVoice',
          budget: {
            maxDurationMs: Math.trunc(num('maxDurationMs') ?? 0),
            ...(str('easing') !== undefined ? { easing: str('easing')! } : {}),
          },
        },
        weight,
      };
    default: {
      // Phase 2133 — kept with its members, never dropped: validateManifest
      // reports it unenforced.
      const members = Object.fromEntries(
        Object.entries(obj).filter(([k]) => k !== 'kind' && k !== 'weight'),
      );
      return { kind: { kind: 'Unknown', name: kind, members }, weight };
    }
  }
};

const parseMeta = (obj: JsonObject): ManifestMeta => ({
  name: asString(obj['name']) ?? '',
  version: asString(obj['version']) ?? '',
  ...(asString(obj['description']) !== undefined
    ? { description: asString(obj['description'])! }
    : {}),
});

// ─── Top-level ────────────────────────────────────────────────────────────────

/** Build a manifest from a parsed JSON value (exposed for tests / tooling). */
export const manifestFromJson = (root: unknown): ThemeManifest => {
  const obj = asObject(root);
  if (obj === undefined) return emptyManifest;
  if ('tokens' in obj) {
    const metaObj = asObject(obj['meta']);
    return {
      meta: metaObj !== undefined ? parseMeta(metaObj) : anonymousMeta,
      tokens: walkTokens('', obj['tokens']),
      roles: (asArray(obj['roles']) ?? [])
        .map(parseRoleBinding)
        .filter((b): b is RoleBinding => b !== undefined),
      invariants: (asArray(obj['invariants']) ?? [])
        .map(parseInvariant)
        .filter((i): i is Invariant => i !== undefined),
    };
  }
  return { ...emptyManifest, tokens: walkTokens('', root) };
};

/** Decode result — `ok` carries the manifest, otherwise `error` the parse message. */
export type DecodeManifestResult =
  | { readonly ok: true; readonly value: ThemeManifest }
  | { readonly ok: false; readonly error: string };

/** Decode a manifest from JSON. Never throws; a parse failure returns `{ ok: false }`. */
export const decodeManifest = (json: string): DecodeManifestResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (ex) {
    return { ok: false, error: ex instanceof Error ? ex.message : String(ex) };
  }
  return { ok: true, value: manifestFromJson(parsed) };
};
