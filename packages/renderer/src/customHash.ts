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
//  The default floor stays `AdvisoryWarning`, i.e. the pre-1021 behaviour: a
//  tree with no hash is the common legitimate case, and an enforcing default
//  would refuse most existing `Custom` nodes on upgrade. What changes is that a
//  host CAN enforce, and that a tree cannot talk its way underneath the host's
//  choice.
//
//  **The floor is ambient on the RenderContext, not a module-global**, which is
//  the one deliberate mechanical difference from the reference host (where it is
//  a process-wide mutable installed by the host). This renderer's registries are
//  per-instance by construction and never module-global, and a policy held
//  process-wide in a browser bundle is shared by every unrelated surface on the
//  page. Same join, same outcomes, same defaults — a different carrier, for the
//  same reason the registry has one.
// ============================================================================

import type { ContentHash, HashStrictness } from '@fuaran-ui/schema';

/** The verdict for one `Custom` node's hash position. */
export type CustomHashOutcome =
  /** The tree declared no hash and the floor is not enforcing — render. */
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
  /** Verification could not be performed at all AND the floor is enforcing —
   *  refuse. Covers both "the tree declared no hash" and "the registry recorded
   *  none": under enforcement an unverifiable render is a failure, not a
   *  default. */
  | 'Unverifiable';

/**
 * The floor a host that declares nothing gets — the pre-1021 behaviour, and the
 * same default the reference host's uninstalled floor carries.
 */
export const defaultCustomHashFloor: HashStrictness = 'AdvisoryWarning';

const strictnessRank = (s: HashStrictness): number => {
  switch (s) {
    case 'AdvisoryWarning':
      return 0;
    // `Enforced` is primarily a build-time gate (validator FUARAN062); reaching
    // a renderer it is as strict as `StrictReplay`.
    case 'StrictReplay':
    case 'Enforced':
      return 1;
  }
};

/** True when `s` refuses rather than warns. */
export const isEnforcingHashStrictness = (s: HashStrictness): boolean => strictnessRank(s) > 0;

/**
 * Classify a `Custom` node's hash position under an explicit floor. Total and
 * pure, so every combination is pinnable in tests without a render.
 */
export const classifyCustomHashUnder = (
  hostFloor: HashStrictness,
  treeHash: ContentHash | undefined,
  registryHash: ContentHash | undefined,
): CustomHashOutcome => {
  if (treeHash === undefined)
    return isEnforcingHashStrictness(hostFloor) ? 'Unverifiable' : 'NoTreeHash';
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
 * reads as {@link defaultCustomHashFloor} — the lenient, behaviour-preserving
 * floor, so "forgot to declare" and "declared the default" are the same posture
 * here (the opposite of `egressPolicy`, where forgetting must not be safe and
 * the field is therefore required).
 */
export const customHashFloorOf = (ctx: {
  readonly customHashFloor?: HashStrictness;
}): HashStrictness => ctx.customHashFloor ?? defaultCustomHashFloor;
