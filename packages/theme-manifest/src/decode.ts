// ============================================================================
//  @fuaran-ui/theme-manifest/decode — JSON → ThemeManifest.
//
//  Port of Fuaran.UI.ThemeManifest.Decode. Two top-level shapes are accepted:
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
//
//  The read is BOUNDED by WIRE_FORMAT §21.1's syntactic limits (Phase 2653):
//  JSON depth 256, strings 1,048,576 code points, arrays and objects 100,000,
//  the document 33,554,432 UTF-8 bytes — the values every host reads a manifest
//  string under, so the hosts refuse the same manifests. The text goes through
//  the tier's one bounded reader, `parse` from @fuaran-ui/ops, which counts depth
//  on the way DOWN and checks each string, array, object and the document where
//  it meets them; a breach is refused as `LIMIT_EXCEEDED` by name with the limit.
//  A bare `JSON.parse` bounded nothing: V8 parses a depth bomb iteratively, and
//  the token walk below then recursed into a `RangeError` this function threw.
// ============================================================================

import { type JsonAst, parse } from '@fuaran-ui/ops';

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

/**
 * The parsed AST as the plain value `manifestFromJson` reads. The recursion is
 * bounded: `parse` has already refused any document deeper than §21.1's 256.
 */
const valueOfAst = (ast: JsonAst): unknown => {
  switch (ast.kind) {
    case 'JNull':
      return null;
    case 'JBool':
    case 'JNumber':
    case 'JString':
      return ast.value;
    case 'JArray':
      return ast.items.map(valueOfAst);
    case 'JObject':
      return Object.fromEntries([...ast.fields].map(([k, v]) => [k, valueOfAst(v)]));
  }
};

/**
 * Decode a manifest from JSON under WIRE_FORMAT §21.1's syntactic limits. Never
 * throws: malformed text is refused as `INVALID_JSON`, and a document past a
 * bound as `LIMIT_EXCEEDED`, naming the bound and its value.
 */
export const decodeManifest = (json: string): DecodeManifestResult => {
  const parsed = parse(json);
  if (!parsed.ok) {
    const e = parsed.error;
    return {
      ok: false,
      error: e.limit
        ? `LIMIT_EXCEEDED at ${e.path ?? '$'}: ${e.message}`
        : `INVALID_JSON at $: ${e.message} (offset ${e.offset})`,
    };
  }
  return { ok: true, value: manifestFromJson(valueOfAst(parsed.value)) };
};
