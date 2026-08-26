// Host-declared kind admission policy (WIRE_FORMAT.md §23).
//
// An application closes the algebra BY DECLARATION rather than by omission. A
// host that registers no custom renderers and installs no guest seam is
// *functionally* closed — but a tree carrying `Custom` / `Mount` still decodes,
// costs the work, renders a placeholder, and silently stops being inert the day
// an unrelated registration lands. A declared policy makes the closure monotone
// and auditable: the refusal is an attributable event carrying the kind and the
// policy that refused it.
//
// THE DEFAULT IS UNCHANGED, and that is the load-bearing property. With no
// policy supplied, every valid document decodes exactly as the specification
// says it must (§22: a tree carrying a hostile payload is a valid wire document
// and a decoder MUST NOT reject it). A policy is a HOST-SIDE NARROWING the
// specification permits a deployment to apply; it is not a wire narrowing, and
// conformance is measured with no policy declared.
//
// Placement. This lives in `@fuaran-ui/schema` rather than beside the decoder in
// `@fuaran-ui/ops` because `ops` and `ui` are PEERS that both depend on this
// package: the decoder enforces a policy and the pre-emit author surface can
// lint against one, and neither may depend on the other. It is also where
// `NODE_KIND_NAMES` already lives, and a named profile is only meaningful
// against a vocabulary. The reference host makes the identical placement
// argument for the identical reason.

import { NODE_KIND_NAMES } from './types.js';

/**
 * What a policy admits.
 *
 * Deliberately an ALLOW-LIST with no deny-list case, and the asymmetry is the
 * decision rather than an omission. A deny-list of today's hatch kinds silently
 * admits tomorrow's — which is the precise failure this mechanism exists to
 * refuse. A host that wants to think in exclusions builds the admitted set from
 * a vocabulary it names, at the moment it declares the policy, with
 * `excludingFrom`.
 */
export type Admission =
  | { readonly kind: 'AdmitAll' }
  | { readonly kind: 'AdmitOnly'; readonly admitted: ReadonlySet<string> };

/**
 * A host's declared decode-time kind admission policy.
 *
 * `identity` is a short, stable name for the policy — it is reported in the
 * refusal, so a log line says WHICH declaration refused rather than merely that
 * something did. Two deployments running different profiles produce
 * distinguishable evidence; a policy whose refusals are anonymous is one nobody
 * can audit.
 */
export interface DecodePolicy {
  readonly identity: string;
  readonly admission: Admission;
}

/**
 * The shipped default: admit every recognised kind. Passing this is
 * indistinguishable from passing nothing at all.
 */
export const admitAll: DecodePolicy = {
  identity: 'admit-all',
  admission: { kind: 'AdmitAll' },
};

/** Admit exactly `kinds`, named by their WIRE discriminators (`kind.$type`). */
export const admitting = (identity: string, kinds: Iterable<string>): DecodePolicy => ({
  identity,
  admission: { kind: 'AdmitOnly', admitted: new Set(kinds) },
});

/**
 * Admit everything in `vocabulary` except `excluded` — the exclusion form,
 * resolved to an allow-list AT CONSTRUCTION against the vocabulary the caller
 * names. So a kind added to the language later is NOT admitted by a policy
 * declared today, which is the whole point of the allow-list shape.
 *
 * A name in `excluded` that is not in `vocabulary` is a no-op — the set
 * difference cannot report it. A caller shipping a named profile should pin its
 * exclusions against the vocabulary with a test rather than trusting the
 * spelling; `CLOSED_PROFILE` below does exactly that.
 */
export const excludingFrom = (
  identity: string,
  vocabulary: Iterable<string>,
  excluded: Iterable<string>,
): DecodePolicy => {
  const drop = new Set(excluded);
  const admitted = new Set<string>();
  for (const k of vocabulary) if (!drop.has(k)) admitted.add(k);
  return { identity, admission: { kind: 'AdmitOnly', admitted } };
};

/** Does `policy` admit the wire discriminator `kind`? */
export const admits = (policy: DecodePolicy, kind: string): boolean =>
  policy.admission.kind === 'AdmitAll' || policy.admission.admitted.has(kind);

/**
 * Is this policy a narrowing at all? `false` for the shipped default, so a
 * caller can skip the check entirely rather than test admission per node.
 */
export const narrows = (policy: DecodePolicy): boolean => policy.admission.kind !== 'AdmitAll';

/**
 * The admitted vocabulary as a hint string, sorted and `|`-joined — the
 * `expectedShape` a refusal carries. PROJECTED from the policy rather than
 * written beside it, on the same discipline (and for the same reason) as
 * `WRONG_NODE_KIND_HINT`: a hint that names a set the gate does not enforce is
 * worse than no hint. Byte-identical to the reference host's for the same
 * policy — both sort ordinally, and the kind vocabulary is ASCII.
 */
export const policyHint = (policy: DecodePolicy): string =>
  policy.admission.kind === 'AdmitAll'
    ? 'any recognised node kind (this policy admits all)'
    : [...policy.admission.admitted].sort().join(' | ');

/**
 * The kinds through which host-supplied behaviour enters a rendered tree — the
 * guest boundary, and the only part of that boundary a KIND gate can reach.
 *
 * `Custom` selects a host-registered renderer by a name taken off the wire;
 * `Mount` composes a guest tree under its own scope through a host-side loader.
 * Neither carries the behaviour itself — wire decoding constructs no closures —
 * which is exactly why omission alone does not close them: the tree still
 * SELECTS, and the selection becomes live the moment something registers.
 *
 * Declared beside the vocabulary it is a subset of, so that classifying a new
 * kind as a hatch and adding it to the wire vocabulary happen in one file. A
 * test pins it as a subset of `NODE_KIND_NAMES` — a misspelt entry is a set
 * difference that removes nothing, and so would silently admit the very kind it
 * names — and a second pins the resulting profile against the corpus.
 */
export const HATCH_NODE_KINDS: readonly string[] = ['Custom', 'Mount'];

/**
 * The recommended profile for an application that uses no escape hatches: every
 * recognised kind except `Custom` and `Mount`.
 *
 * **What it closes, precisely.** The guest boundary, and nothing else. A decoded
 * tree under this profile cannot name a host-registered renderer and cannot
 * compose a guest. The other seams through which host-supplied behaviour reaches
 * a deployment are out of a kind gate's reach BY CONSTRUCTION and this profile
 * must not be read as touching them — the action vocabulary a tree can name is
 * reached by actions rather than kinds, a declared field rule is a slot on
 * `Form` / `Filters` (which this profile admits), and a renderer's own output is
 * the renderer's. Closing those is a different mechanism at a different seam;
 * WIRE_FORMAT §23.5 states the limit at length.
 */
export const CLOSED_PROFILE: DecodePolicy = excludingFrom(
  'closed-no-escape-hatches',
  NODE_KIND_NAMES,
  HATCH_NODE_KINDS,
);

/**
 * Admit everything the decoder recognises EXCEPT the named kinds. The exclusion
 * is resolved against `NODE_KIND_NAMES` at construction, so a kind added to the
 * language later is not admitted by a policy declared today.
 */
export const excluding = (identity: string, kinds: Iterable<string>): DecodePolicy =>
  excludingFrom(identity, NODE_KIND_NAMES, kinds);
