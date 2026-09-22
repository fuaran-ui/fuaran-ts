// ============================================================================
//  @fuaran-ui/theme-manifest/encode — ThemeManifest → canonical JSON.
//
//  The inverse of ./decode.ts, and the half this package shipped without: the
//  projectors and `merge` could DERIVE a manifest in the browser and had no way
//  to hand one back, so a brand override merged client-side could not be sent to
//  a server or persisted, and the tier could not prove a decoded manifest
//  re-encodes to its bytes.
//
//  Port of the Rust `fuaran_rs::theme::manifest::{to_json, encode}` at
//  fuaran-rs@62b40d4bbe597160cc6245e192afbd703e6eb629 (Phase 1725), which is the
//  portable byte ORACLE for every host: its literals in `fuaran-rs/tests/
//  manifest.rs` are copied verbatim into ./test/encode.test.ts rather than
//  recorded from a run here. Read a disagreement as a wire-format question for
//  every host at once, never as a fixture refresh.
//
//  Canonical in the tier's one sense — `renderAstCanonical` from
//  @fuaran-ui/ops, the same renderer the op-stream and wire codecs emit through:
//  Ordinal-sorted object keys, no whitespace, the WIRE_FORMAT.md §2 rule-5
//  number layout and rule-6 escapes. This module deliberately does NOT carry a
//  canonical renderer of its own; a second one in the tier is drift by
//  construction, and it is what the `encodeEmitsCanonicalJson` pin holds.
// ============================================================================

import { type JsonAst, renderAstCanonical } from '@fuaran-ui/ops';

import {
  DEFAULT_WEIGHT,
  type Invariant,
  type ManifestMeta,
  type ManifestRole,
  type ManifestToken,
  type RoleBinding,
  type ThemeManifest,
} from './manifest.js';

// ─── JsonAst construction ─────────────────────────────────────────────────────

const jStr = (value: string): JsonAst => ({ kind: 'JString', value });
const jNum = (value: number): JsonAst => ({ kind: 'JNumber', value });
const jObj = (fields: ReadonlyMap<string, JsonAst>): JsonAst => ({ kind: 'JObject', fields });
const jArr = (items: readonly JsonAst[]): JsonAst => ({ kind: 'JArray', items });

type Fields = Map<string, JsonAst>;

/** Set a string member only when it is non-empty — the decoder reads an absent one as `''`. */
const putStr = (fields: Fields, key: string, value: string): void => {
  if (value !== '') fields.set(key, jStr(value));
};

/** Set a numeric member only when it differs from what the decoder supplies in its absence. */
const putNum = (fields: Fields, key: string, value: number, fallback: number): void => {
  if (value !== fallback) fields.set(key, jNum(value));
};

// ─── Tokens — the flat dotted names back into a DTCG group tree ───────────────

/**
 * One DTCG token node. `$value` is the leaf discriminator `walkTokens` stops on,
 * so it is emitted unconditionally — an empty value included.
 */
const tokenLeaf = (t: ManifestToken): JsonAst => {
  const fields: Fields = new Map();
  putStr(fields, '$type', t.type);
  fields.set('$value', jStr(t.value));
  if (t.description !== undefined) fields.set('$description', jStr(t.description));
  if (t.role !== undefined) {
    fields.set('$extensions', jObj(new Map([['fuaran', jObj(new Map([['role', jStr(t.role)]]))]])));
  }
  return jObj(fields);
};

/**
 * The tree under construction: a node is either a placed token LEAF or a GROUP
 * whose children are still open. Keeping the two apart is what lets `insertAt`
 * tell "descend into a group" from "overwrite a leaf" without inspecting an
 * emitted node — the distinction `is_leaf` makes on the Rust side.
 */
type TreeNode = { readonly leaf: JsonAst } | { readonly group: Map<string, TreeNode> };

/**
 * Place one token at its dotted path, replacing whatever occupies that path.
 *
 * A DTCG path addresses a group **or** a token, never both, so two tokens whose
 * names collide (equal, or one a strict prefix of the other) are not jointly
 * representable. The later write wins — the precedence `dedupeTokens` and
 * `merge` already apply throughout this package — which is why descending past a
 * leaf CLEARS it: leaving its `$value` in place would hide every descendant from
 * the decoder and make the *earlier* token win instead.
 */
const insertAt = (
  tree: Map<string, TreeNode>,
  segments: readonly string[],
  leaf: JsonAst,
): void => {
  const head = segments[0];
  if (head === undefined) return;
  if (segments.length === 1) {
    tree.set(head, { leaf });
    return;
  }
  const existing = tree.get(head);
  let group: Map<string, TreeNode>;
  if (existing !== undefined && 'group' in existing) {
    group = existing.group;
  } else {
    group = new Map();
    tree.set(head, { group });
  }
  insertAt(group, segments.slice(1), leaf);
};

const treeToAst = (tree: ReadonlyMap<string, TreeNode>): JsonAst =>
  jObj(new Map([...tree].map(([k, n]) => [k, 'leaf' in n ? n.leaf : treeToAst(n.group)] as const)));

const tokensTree = (tokens: readonly ManifestToken[]): JsonAst => {
  const root = new Map<string, TreeNode>();
  for (const t of tokens) insertAt(root, t.name.split('.'), tokenLeaf(t));
  return treeToAst(root);
};

// ─── Roles + invariants ───────────────────────────────────────────────────────

const roleJson = (r: ManifestRole): JsonAst =>
  r.kind === 'Tone'
    ? jObj(new Map([['tone', jStr(r.tone)]]))
    : jObj(new Map([['named', jStr(r.name)]]));

const roleBindingJson = (b: RoleBinding): JsonAst => {
  // `token` is required — `parseRoleBinding` drops a binding without it.
  const fields: Fields = new Map([['token', jStr(b.tokenName)]]);
  // An absent `role` decodes to `{ kind: 'Named', name: '' }`, so that one value
  // is omitted.
  if (!(b.role.kind === 'Named' && b.role.name === '')) fields.set('role', roleJson(b.role));
  return jObj(fields);
};

const invariantJson = (inv: Invariant): JsonAst => {
  // `kind` is the discriminator — an unrecognised or absent one drops the
  // invariant at decode, so it is never omitted.
  const fields: Fields = new Map([['kind', jStr(inv.kind.kind)]]);
  switch (inv.kind.kind) {
    case 'ContrastFloor':
      putStr(fields, 'role', inv.kind.role);
      putNum(fields, 'minRatio', inv.kind.minRatio, 0);
      break;
    case 'UsageBudget':
      putStr(fields, 'token', inv.kind.token);
      putNum(fields, 'targetPct', inv.kind.targetPct, 0);
      putNum(fields, 'tolerancePct', inv.kind.tolerancePct, 0);
      break;
    case 'MotionVoice':
      putNum(fields, 'maxDurationMs', inv.kind.budget.maxDurationMs, 0);
      if (inv.kind.budget.easing !== undefined) fields.set('easing', jStr(inv.kind.budget.easing));
      break;
  }
  putNum(fields, 'weight', inv.weight, DEFAULT_WEIGHT);
  return jObj(fields);
};

const metaJson = (meta: ManifestMeta): JsonAst | undefined => {
  if (meta.name === '' && meta.version === '' && meta.description === undefined) return undefined;
  const fields: Fields = new Map();
  putStr(fields, 'name', meta.name);
  putStr(fields, 'version', meta.version);
  if (meta.description !== undefined) fields.set('description', jStr(meta.description));
  return jObj(fields);
};

// ─── Top-level ────────────────────────────────────────────────────────────────

/**
 * Build the JSON value for a manifest — the inverse of `manifestFromJson`, for a
 * host embedding a manifest in a larger document rather than emitting it alone.
 *
 * Always the Fuaran wrapper shape, never a bare DTCG tree: a top-level `tokens`
 * key is what selects the wrapper branch in `manifestFromJson`, so omitting it at
 * empty would decode the document as vanilla DTCG and silently discard meta,
 * roles and invariants.
 *
 * Module-internal: exposing it would put `@fuaran-ui/ops`'s `JsonAst` in this
 * package's public type surface for the one caller that is `encodeManifest`.
 */
const manifestToAst = (m: ThemeManifest): JsonAst => {
  const fields: Fields = new Map();
  const meta = metaJson(m.meta);
  if (meta !== undefined) fields.set('meta', meta);
  fields.set('tokens', tokensTree(m.tokens));
  if (m.roles.length > 0) fields.set('roles', jArr(m.roles.map(roleBindingJson)));
  if (m.invariants.length > 0) fields.set('invariants', jArr(m.invariants.map(invariantJson)));
  return jObj(fields);
};

/**
 * Encode a manifest as canonical JSON — the round trip the projectors and
 * `merge` had no way to emit, so a host that merged a brand override over a base
 * can hand the result back over the wire.
 *
 * Every member the decoder tolerates the absence of is omitted at its default, so
 * a projected manifest does not carry a page of empty strings.
 *
 * **The round trip, stated precisely.** `encodeManifest(decodeManifest(bytes))
 * === bytes` for canonical bytes already in this shape, and
 * `decodeManifest(encodeManifest(m))` deep-equals `m` for any manifest whose
 * tokens are in the wire's own order — every manifest `decodeManifest` produces
 * is one. A projector or `merge` result carries tokens in first-appearance order
 * instead, and the wire's order is sorted, so the round trip there preserves the
 * token *set* and normalises the order; the total statement that covers every
 * manifest is that `encodeManifest` is a fixpoint through it —
 * `encodeManifest(decodeManifest(encodeManifest(m))) === encodeManifest(m)`.
 *
 * **Three model states the wire cannot carry**, recorded rather than hidden
 * because each is reachable only by hand-building a `ThemeManifest` — no decoder
 * or projector in this package produces one. Two token names that collide (equal,
 * or one a strict prefix of the other) resolve last-write-wins, per `insertAt`. A
 * name whose first segment starts with `$` is emitted but is unreachable to the
 * decoder, which skips `$`-prefixed keys as DTCG metadata. A `Tone` role holding
 * a string outside the canonical palette decodes back as `Named`, since
 * `parseRole` validates the tone — unreachable here without a cast, because
 * `ToneVariant` is a closed union in this tier where it is a bare `String` in
 * Rust. Widening any of these is a wire-format question for every host at once,
 * not a change this tier makes alone.
 */
export const encodeManifest = (m: ThemeManifest): string => renderAstCanonical(manifestToAst(m));
