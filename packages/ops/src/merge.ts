// ============================================================================
//  @fuaran-ui/ops — facet-refined 3-way tree merge (Phase 179, M2 — Leg B).
//
//  Symmetric port of the F# `Fuaran.UI.OpStream.Dag.Merge.TreeMerge.merge3Way`
//  (the author-agnostic entry point — both sides treated equally, no
//  human-pin primacy; that grading is an orchestration-tier concern). A node
//  decomposes into independent FACETS, each 3-way-merged on its own:
//
//    - "kind"          — the node's own kind-fields (children / style / state /
//                        accessibility neutralised in the canonical probe).
//    - "style.{tone,weight,emphasis,role,voice}" — the SemanticStyle sub-fields,
//                        merged INDEPENDENTLY (A's tone + B's voice auto-blend).
//    - "state"         — the StateBehaviour block.
//    - "accessibility" — the Accessibility block.
//    - "children"      — the ordered child-id list (structural).
//
//  When a facet changed on at most one side, take that side's value; when both
//  changed it differently, it is a CONFLICT (returned, not silently picked).
//  The one structural case auto-merged across both sides is disjoint pure
//  inserts into the same parent, ordered by NodeId code-unit (Ordinal) bytes —
//  the deterministic, wall-clock-free tie-break.
//
//  Facet equality is `encodeNode` canonical-JSON bytes (the same oracle the
//  merge-conformance corpus commits to), except the closure-free SemanticStyle
//  sub-fields, compared directly. Verified byte-identical to the F# host over
//  the workspace `wire-format-fixtures/merge-conformance/` corpus by
//  test/merge.test.ts — the cross-implementation determinism gate (F# Leg A ==
//  TS Leg B, same merged tree + same sha256 outcome hash).
// ============================================================================

import {
  defaults,
  type Accessibility,
  type LayoutKind,
  type Node,
  type NodeKind,
  type SemanticStyle,
  type StateBehaviour,
} from '@fuaran-ui/schema';

import { encodeNode } from './encode.js';

type N = Node<unknown>;

/** Rebuild a node with controlled facets, OMITTING `accessibility` when absent
 * (the wire's absent ⟺ default; `exactOptionalPropertyTypes` forbids an
 * explicit `undefined`). Other fields (`motion`, `extraAttributes`) carry over
 * from `base` — they are not merge facets and stay fixed across the sides. */
const mkNode = (
  base: N,
  kind: NodeKind<unknown>,
  style: SemanticStyle,
  state: StateBehaviour<unknown>,
  accessibility: Accessibility | undefined,
): N => {
  const { accessibility: _drop, ...rest } = base;
  return accessibility !== undefined
    ? { ...rest, kind, style, state, accessibility }
    : { ...rest, kind, style, state };
};

/** A `(nodeId, facet)` cell that could not be auto-merged. */
export interface MergeConflict {
  readonly nodeId: string;
  readonly facet: string;
}

/** Outcome of a 3-way merge: the merged tree, or the conflicting cells. */
export type MergeResult =
  | { readonly ok: true; readonly tree: N }
  | { readonly ok: false; readonly conflicts: readonly MergeConflict[] };

const rawId = (n: N): string => n.id as unknown as string;

// ─── child traversal (Layout children only — the structural facet) ───────────

const childrenOf = (n: N): readonly N[] =>
  n.kind.kind === 'Layout' ? n.kind.layout.spec.children : [];

/** The kind with its (layout) children replaced — for the childless-kind probe
 * and for rebuilding after the children facet merges. Non-layout kinds carry no
 * structural children, so they are returned unchanged. */
const withKindChildren = (k: NodeKind<unknown>, children: readonly N[]): NodeKind<unknown> =>
  k.kind === 'Layout'
    ? {
        kind: 'Layout',
        // The per-layout spec is a discriminated union; the children-bearing
        // shape is uniform across members, so the cast is sound (mirrors
        // apply.ts `withLayoutChildren`).
        layout: { ...k.layout, spec: { ...k.layout.spec, children } } as LayoutKind<unknown>,
      }
    : k;

const childlessKind = (k: NodeKind<unknown>): NodeKind<unknown> => withKindChildren(k, []);

// ─── facet-isolation canonical probes (closure-safe bytes) ───────────────────
//
// Each probe holds every OTHER facet fixed so only the named facet varies,
// letting a closure-bearing facet be compared by canonical JSON.

const neutralState = defaults.stateBehaviour<unknown>();

/** Kind-own canonical (children + style + state + accessibility neutralised). */
const kindCanonical = (n: N): string =>
  encodeNode(mkNode(n, childlessKind(n.kind), defaults.style, neutralState, undefined));

/** State canonical (kind→shell, style + accessibility neutralised). */
const stateCanonical = (shell: NodeKind<unknown>, n: N): string =>
  encodeNode(mkNode(n, shell, defaults.style, n.state, undefined));

/** Accessibility canonical (kind→shell, style + state neutralised). */
const accessibilityCanonical = (shell: NodeKind<unknown>, n: N): string =>
  encodeNode(mkNode(n, shell, defaults.style, neutralState, n.accessibility));

// ─── facet pickers ───────────────────────────────────────────────────────────

const ordinal = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** `true` when `head` is `base` with zero removals and zero reorders. */
const isPureAddition = (baseIds: readonly string[], headIds: readonly string[]): boolean => {
  const headSet = new Set(headIds);
  const survive = baseIds.filter((i) => headSet.has(i));
  const headKept = headIds.filter((i) => baseIds.includes(i));
  return (
    survive.length === baseIds.length &&
    survive.every((v, i) => v === baseIds[i]) &&
    headKept.length === baseIds.length &&
    headKept.every((v, i) => v === baseIds[i])
  );
};

// Optional-aware equality: an absent field equals an absent field (both the
// canonical default), so an explicit-default vs absent never reads as changed.
const eqOpt = <T>(x: T | undefined, y: T | undefined): boolean => (x ?? null) === (y ?? null);

/** Merge one SemanticStyle sub-field; push a conflict on a genuine divergence. */
const pickField = <T>(
  conflicts: MergeConflict[],
  nodeId: string,
  facet: string,
  baseV: T | undefined,
  aV: T | undefined,
  bV: T | undefined,
): T | undefined => {
  const aCh = !eqOpt(aV, baseV);
  const bCh = !eqOpt(bV, baseV);
  if (aCh && bCh && !eqOpt(aV, bV)) {
    conflicts.push({ nodeId, facet });
    return baseV;
  }
  if (aCh) return aV;
  if (bCh) return bV;
  return baseV;
};

/** Merge a canonical-compared facet; returns 0=base, 1=a, 2=b. */
const pickCanonical = (
  conflicts: MergeConflict[],
  nodeId: string,
  facet: string,
  baseC: string,
  aC: string,
  bC: string,
): 0 | 1 | 2 => {
  const aCh = aC !== baseC;
  const bCh = bC !== baseC;
  if (aCh && bCh && aC !== bC) {
    conflicts.push({ nodeId, facet });
    return 0;
  }
  if (aCh) return 1;
  if (bCh) return 2;
  return 0;
};

const mergeStyle = (conflicts: MergeConflict[], id: string, base: N, a: N, b: N): SemanticStyle => {
  const bs = base.style;
  const as_ = a.style;
  const bsB = b.style;
  const tone = pickField(conflicts, id, 'style.tone', bs.tone, as_.tone, bsB.tone)!;
  const weight = pickField(conflicts, id, 'style.weight', bs.weight, as_.weight, bsB.weight)!;
  const emphasis = pickField(
    conflicts,
    id,
    'style.emphasis',
    bs.emphasis,
    as_.emphasis,
    bsB.emphasis,
  )!;
  const role = pickField(conflicts, id, 'style.role', bs.role, as_.role, bsB.role);
  const voice = pickField(conflicts, id, 'style.voice', bs.voice, as_.voice, bsB.voice);
  // Only attach optional fields when present, so the merged style encodes
  // byte-identically (absent ⟺ default; `encodeNode` omits defaults).
  const style: SemanticStyle = { tone, weight, emphasis };
  return {
    ...style,
    ...(role !== undefined ? { role } : {}),
    ...(voice !== undefined ? { voice } : {}),
  };
};

const merge3 = (
  conflicts: MergeConflict[],
  base: N,
  aOpt: N | undefined,
  bOpt: N | undefined,
): N => {
  const a = aOpt ?? base;
  const b = bOpt ?? base;
  const id = rawId(base);
  const shell = childlessKind(base.kind);

  // kind facet
  const kindPick = pickCanonical(
    conflicts,
    id,
    'kind',
    kindCanonical(base),
    kindCanonical(a),
    kindCanonical(b),
  );
  const kindSource = kindPick === 1 ? a : kindPick === 2 ? b : base;

  // style sub-fields (independent)
  const mergedStyle = mergeStyle(conflicts, id, base, a, b);

  // state facet
  const statePick = pickCanonical(
    conflicts,
    id,
    'state',
    stateCanonical(shell, base),
    stateCanonical(shell, a),
    stateCanonical(shell, b),
  );
  const mergedState = statePick === 1 ? a.state : statePick === 2 ? b.state : base.state;

  // accessibility facet
  const accPick = pickCanonical(
    conflicts,
    id,
    'accessibility',
    accessibilityCanonical(shell, base),
    accessibilityCanonical(shell, a),
    accessibilityCanonical(shell, b),
  );
  const mergedAcc =
    accPick === 1 ? a.accessibility : accPick === 2 ? b.accessibility : base.accessibility;

  // children facet (structural)
  const baseKids = childrenOf(base);
  const aKids = childrenOf(a);
  const bKids = childrenOf(b);
  const baseIds = baseKids.map(rawId);
  const aIds = aKids.map(rawId);
  const bIds = bKids.map(rawId);
  const aStruct = JSON.stringify(aIds) !== JSON.stringify(baseIds);
  const bStruct = JSON.stringify(bIds) !== JSON.stringify(baseIds);
  const baseMap = new Map(baseKids.map((c) => [rawId(c), c]));
  const aMap = new Map(aKids.map((c) => [rawId(c), c]));
  const bMap = new Map(bKids.map((c) => [rawId(c), c]));

  const recurseChild = (cid: string): N => {
    const bc = baseMap.get(cid);
    if (bc !== undefined) return merge3(conflicts, bc, aMap.get(cid), bMap.get(cid));
    const ac = aMap.get(cid);
    if (ac !== undefined) return ac;
    const bb = bMap.get(cid);
    if (bb !== undefined) return bb;
    throw new Error(`merge3: child id ${cid} vanished`);
  };

  let mergedChildren: readonly N[];
  if (!aStruct && !bStruct) {
    mergedChildren = baseIds.map(recurseChild);
  } else if (aStruct && !bStruct) {
    mergedChildren = aIds.map(recurseChild);
  } else if (!aStruct && bStruct) {
    mergedChildren = bIds.map(recurseChild);
  } else {
    const baseSet = new Set(baseIds);
    const aNew = aIds.filter((i) => !baseSet.has(i));
    const bNew = bIds.filter((i) => !baseSet.has(i));
    const aNewSet = new Set(aNew);
    const disjoint =
      isPureAddition(baseIds, aIds) &&
      isPureAddition(baseIds, bIds) &&
      !bNew.some((i) => aNewSet.has(i));
    if (disjoint) {
      const survivors = baseIds.map(recurseChild);
      const newIds = [...new Set([...aNew, ...bNew])].sort(ordinal);
      mergedChildren = [...survivors, ...newIds.map(recurseChild)];
    } else {
      conflicts.push({ nodeId: id, facet: 'children' });
      mergedChildren = baseIds.map(recurseChild);
    }
  }

  const mergedKind = withKindChildren(childlessKind(kindSource.kind), mergedChildren);
  return mkNode(base, mergedKind, mergedStyle, mergedState, mergedAcc);
};

/**
 * Author-agnostic facet 3-way merge of `a` and `b` over their common `base`
 * (all three share the root id). Returns the merged tree on full auto-merge, or
 * the conflicting cells. Deterministic + host-reproducible (NodeId-byte
 * tie-break, no wall-clock) — byte-identical to the F# `TreeMerge.merge3Way`.
 */
export const merge3Way = (base: N, a: N, b: N): MergeResult => {
  const conflicts: MergeConflict[] = [];
  const merged = merge3(conflicts, base, a, b);
  return conflicts.length === 0 ? { ok: true, tree: merged } : { ok: false, conflicts };
};
