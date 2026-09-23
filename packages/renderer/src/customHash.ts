// ============================================================================
//  `NodeKind.Custom` content-hash verification policy (Phase 783 posture,
//  ported to this host by Phase 1021).
//
//  `ContentHash` is DRIFT DETECTION between a registered renderer and a
//  replayed tree. It is not, and cannot be, authentication of the tree: the
//  tree supplies its own hash record, so a hash that matches proves only that
//  whoever wrote the tree knew the registered renderer's hash. The
//  implementation on both hosts quietly assumed the stronger reading.
//
//  Two concrete bypasses followed from that assumption:
//
//    1. **Omit the hash.** An absent tree hash classified as `NoTreeHash`, which
//       shared a render branch with `Match` and rendered SILENTLY. The cheapest
//       way past verification was to skip it.
//    2. **Declare a lenient strictness.** Strictness was read from the TREE's own
//       `ContentHash` record, so an author who did declare a hash simply chose
//       `AdvisoryWarning` and got warn-then-render on a mismatch.
//
//  The fix is a HOST-CONFIGURED FLOOR that a tree may only tighten:
//
//    - the host declares a minimum strictness (`RenderContext.customHashFloor`,
//      surfaced as the `<FuaranRenderer customHashFloor>` prop);
//    - a tree's declared strictness raises it, never lowers it;
//    - under an ENFORCING floor, a hash that cannot be verified — because the
//      tree declared none, or the registry recorded none — is a REFUSAL rather
//      than a render.
//
//  The default floor stayed `AdvisoryWarning` at Phase 1021, i.e. the pre-1021
//  behaviour: a tree with no hash is the common legitimate case, and an
//  enforcing default would refuse most existing `Custom` nodes on upgrade. What
//  changed then is that a host CAN enforce, and that a tree cannot talk its way
//  underneath the host's choice.
//
//  ── THE DEFAULT FLIPS TO ENFORCED (Phase 1856, porting Phase 1550) ──────────
//
//  That paragraph is the posture the reference host held until Phase 1550, and
//  the argument that flipped it there applies here unchanged: the SHIPPED
//  DEFAULT is what an unconfigured host receives, so a default that allows is
//  the gate for exactly the hosts that never configured one. This renderer is
//  the one that runs in a browser, on the page a stranger's tree is replayed
//  into. `defaultCustomHashFloor` is now `Enforced`, and the permissive posture
//  is reached by name — `customHashFloor: 'AdvisoryWarning'` — so one grep for
//  that literal finds every host that opted back.
//
//  The upgrade objection above is answered rather than overruled, by separating
//  the two things the old default conflated — exactly as the reference host
//  does, so the two hosts decide the same document the same way:
//
//    - the floor governs MISMATCH. A tree that declares a hash which disagrees
//      with the registered renderer's is refused by an unconfigured host.
//    - the floor does NOT govern tree-side ABSENCE. A tree that declares no hash
//      renders exactly as it did, because there is nothing to mismatch. Only
//      `StrictReplay` — the floor whose NAME says the tree must replay exactly —
//      refuses it. Until this phase `Enforced` refused it here too; that was a
//      cross-host divergence (the reference host renders it), closed now.
//
//  Registry-side absence is untouched: a tree that DID declare a hash the
//  registry cannot verify has made a claim that cannot be checked, which is a
//  verification failure rather than an absence, and stays `Unverifiable` under
//  any enforcing floor.
//
//  The floor splits into a shipped DEFAULT (`defaultCustomHashFloor`) and a
//  host DECLARATION (`RenderContext.customHashFloor`, `HashStrictness |
//  undefined`), and they are different facts: an absent declaration resolves to
//  the default, and a present one REPLACES it — so `AdvisoryWarning` is
//  declarable rather than unreachable. Raise-only applies among DECLARATIONS:
//  a tree's own declared strictness may only tighten the host's, and a `Mount`
//  guest inherits its host's declaration and has no way to state its own.
//
//  **The floor is ambient on the RenderContext, not a module-global**, which is
//  the one deliberate mechanical difference from the reference host (where it is
//  a process-wide mutable installed by the host). This renderer's registries are
//  per-instance by construction and never module-global, and a policy held
//  process-wide in a browser bundle is shared by every unrelated surface on the
//  page. Same join, same outcomes, same default — a different carrier, for the
//  same reason the registry has one. (The reference host has TWO declaration
//  sites, a process floor and a per-render context floor, composed raise-only;
//  this host has the per-render one alone, so there is nothing to compose.)
// ============================================================================

import type { ContentHash, HashStrictness } from '@fuaran-ui/schema';

/** The verdict for one `Custom` node's hash position. */
export type CustomHashOutcome =
  /** The tree declared no hash and the floor does not refuse an absence (every
   *  floor but `StrictReplay`) — render. */
  | 'NoTreeHash'
  /** Declared and registered hashes agree — render. */
  | 'Match'
  /** The tree declared a hash, the registry recorded none, and the floor is not
   *  enforcing — warn, then render. */
  | 'RegistryNoHash'
  /** Mismatch under a non-enforcing effective strictness — warn, then render. */
  | 'MismatchAdvisory'
  /** Mismatch under an enforcing effective strictness — refuse. */
  | 'MismatchStrict'
  /** Verification could not be performed — refuse. Two cases, answering to two
   *  predicates: the registry recorded no hash for a tree that declared one,
   *  under any enforcing floor; or the tree declared none, under `StrictReplay`
   *  only (Phase 1856, mirroring the reference host's Phase 1550). */
  | 'Unverifiable';

// The order of the raise-only lattice: a floor may be replaced only by one that
// refuses at least as much.
//
// `Enforced` and `StrictReplay` shared rank 1 until Phase 1856 (the reference
// host re-ordered them at Phase 1550), on the reading that `Enforced` is
// primarily a build-time gate (validator FUARAN062) and that reaching a
// renderer the two were equally strict. That stopped being true when the
// floor's job narrowed to MISMATCH: `StrictReplay` refuses a strict SUPERSET —
// every mismatch `Enforced` refuses, plus the tree that declares no hash at
// all — so the two are ordered.
const strictnessRank = (s: HashStrictness): number => {
  switch (s) {
    case 'AdvisoryWarning':
      return 0;
    case 'Enforced':
      return 1;
    case 'StrictReplay':
      return 2;
  }
};

/** True when `s` refuses a MISMATCH rather than warning — both enforcing floors. */
export const isEnforcingHashStrictness = (s: HashStrictness): boolean => strictnessRank(s) > 0;

/**
 * True when `s` refuses a `Custom` node whose hash cannot be verified because
 * THE TREE DECLARED NONE — as distinct from refusing a mismatch (Phase 1856,
 * the reference host's `refusesUnverifiable`).
 *
 * Only `StrictReplay` does. The distinction is the whole of what makes an
 * enforcing default shippable: a tree with no hash is the common legitimate
 * case, so a default that refused it would refuse most existing `Custom` nodes
 * the moment a host upgraded, and the floor's job is to catch a hash that
 * DISAGREES. `StrictReplay` keeps the stronger reading because its name is the
 * stronger claim — a tree that must replay exactly cannot do so carrying no
 * hash. {@link isEnforcingHashStrictness} answers "does this floor refuse a
 * MISMATCH"; this answers "does it also refuse an ABSENCE".
 */
export const refusesUnverifiableHashStrictness = (s: HashStrictness): boolean =>
  s === 'StrictReplay';

/**
 * The floor a host that declares nothing gets (Phase 1856, the reference
 * host's `DefaultCustomHashFloor` since Phase 1550): **enforcing**. A mismatch
 * between a tree's declared hash and the registered renderer's is refused with
 * no host configuration at all; a tree carrying no hash renders as it always
 * did (see {@link refusesUnverifiableHashStrictness}). The permissive posture is
 * the named declaration `customHashFloor: 'AdvisoryWarning'`.
 */
export const defaultCustomHashFloor: HashStrictness = 'Enforced';

/**
 * Classify a `Custom` node's hash position under an explicit floor. Total and
 * pure, so every combination is pinnable in tests without a render.
 */
export const classifyCustomHashUnder = (
  hostFloor: HashStrictness,
  treeHash: ContentHash | undefined,
  registryHash: ContentHash | undefined,
): CustomHashOutcome => {
  // TREE-SIDE ABSENCE. Refused only under `StrictReplay` — the floor governs
  // mismatch, and a tree that declares no hash has nothing to mismatch.
  if (treeHash === undefined)
    return refusesUnverifiableHashStrictness(hostFloor) ? 'Unverifiable' : 'NoTreeHash';
  // REGISTRY-SIDE ABSENCE, and deliberately not the same question. The tree made
  // a CLAIM the registry cannot check — a verification failure, not an absence —
  // so any enforcing floor still refuses it.
  if (registryHash === undefined)
    return isEnforcingHashStrictness(hostFloor) ? 'Unverifiable' : 'RegistryNoHash';
  if (treeHash.algorithm === registryHash.algorithm && treeHash.hash === registryHash.hash)
    return 'Match';
  // TIGHTEN-ONLY: the stricter of the host floor and the tree's own declaration
  // wins. The tree's record is consulted, but it can no longer be the thing that
  // LOWERS the verdict — which is the whole of the second bypass.
  const effective =
    strictnessRank(treeHash.strictness) >= strictnessRank(hostFloor)
      ? treeHash.strictness
      : hostFloor;
  return isEnforcingHashStrictness(effective) ? 'MismatchStrict' : 'MismatchAdvisory';
};

/**
 * The floor in force for a render, read through ONE accessor so no call site can
 * reach the raw optional field and forget the default. An absent declaration
 * reads as {@link defaultCustomHashFloor} — the ENFORCING floor since Phase
 * 1856, so "forgot to declare" is the strict posture, and the permissive one is
 * a declaration a host makes by name.
 */
export const customHashFloorOf = (ctx: {
  readonly customHashFloor?: HashStrictness;
}): HashStrictness => ctx.customHashFloor ?? defaultCustomHashFloor;
