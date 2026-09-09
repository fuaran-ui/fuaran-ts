// ============================================================================
//  @fuaran-ui/ops — facet-refined 3-way tree merge (Phase 179, M2 — Leg B).
//
//  Symmetric port of the F# `Fuaran.UI.OpStream.Dag.Merge.TreeMerge.merge3Way`
//  (the author-agnostic entry point — both sides treated equally, no
//  human-pin primacy; that grading is an orchestration-tier concern). A node
//  decomposes into independent FACETS, each 3-way-merged on its own:
//
//    - "kind"          — the node's own kind-fields (children / style / state /
//                        accessibility / tooltip neutralised in the canonical
//                        probe).
//    - "style.{tone,weight,emphasis,role,voice,direction}" — the SemanticStyle
//                        sub-fields, merged INDEPENDENTLY (A's tone + B's voice
//                        auto-blend).
//    - "state"         — the StateBehaviour block.
//    - "accessibility" — the Accessibility block.
//    - "tooltip"       — the node-level tooltip trait.
//    - "children"      — the ordered child-id list (structural).
//
//  Two further facets are WHOLE-NODE rather than per-field, and neither is
//  visible from inside a single parent's fold:
//
//    - "node"          — one side removed a node the other had edited
//                        (`DeleteModify`), or the content half of a contended
//                        move.
//    - "move"          — a node relocated by one side and moved or edited by the
//                        other (`ConcurrentMove`); the value is the parent id
//                        each side holds it under.
//
//  Telling a DELETION apart from a MOVE needs a view of each input tree as a
//  whole, so the merge carries indexes of its three inputs (`MergeIndex`).
//  Without that distinction every relocation reads as a deletion of the node
//  from the parent it left. Both arms landed here in Phase 1652, which is when
//  this tier first read the corpus's `totalityFixtures` — until then the merge
//  reproduced the reference's ANSWER on every fixture it was given and
//  reproduced a silent LOSS on the two it was not.
//
//  `tooltip` and `style.direction` joined the decomposition in Phase 1652. Both
//  were on the wire and in neither list, so a one-branch edit to either was
//  DISCARDED in silence — and `tooltip`, being a top-level member the rebuild
//  spread from `base`, also varied the bytes of the kind / state / accessibility
//  probes, so a hint-only edit could be reported as a concurrent edit to the
//  node's kind. A member that reaches the wire and not this list is that bug
//  waiting to happen; add it here in the same change as the member.
//
//  When a facet changed on at most one side, take that side's value. When both
//  sides changed it to the SAME value, take the shared value — that is not a
//  conflict, it is agreement. When both changed it differently, it is a CONFLICT
//  (returned, not silently picked), surfaced as a TWO-SIDED envelope: `a` and
//  `b` carry each branch's value on every refusal, so swapping the branches
//  transposes them and changes nothing else.
//
//  The structural cases auto-merged across both sides are (a) disjoint pure
//  inserts into the same parent, ordered by NodeId code-unit (Ordinal) bytes —
//  the deterministic, wall-clock-free tie-break — and (b) two sides that reached
//  the SAME child-id list, whose shared new children must then also agree on
//  content: two branches inserting one id with different content is a refusal
//  naming that id, never an arrival-order-dependent pick.
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
  type TextSource,
} from '@fuaran-ui/schema';

import { encodeNode } from './encode.js';

type N = Node<unknown>;

/** Rebuild a node with controlled facets, OMITTING `accessibility` and
 * `tooltip` when absent (the wire's absent ⟺ default; `exactOptionalPropertyTypes`
 * forbids an explicit `undefined`). Other fields (`motion`, `extraAttributes`)
 * carry over from `base` — they are not merge facets and stay fixed across the
 * sides, matching the reference host's facet decomposition.
 *
 * `tooltip` is a CONTROLLED facet rather than a carried-over field, and the
 * difference is the whole of Phase 1652's merge fix. It is a top-level member of
 * `Node`, so a spread of `base` supplies it — which meant two distinct failures
 * at once: the isolation probes below varied with a hint they were supposed to
 * hold fixed, so a tooltip-only edit was reported as a concurrent edit to the
 * node's KIND; and the rebuild took the base node's hint unconditionally, so an
 * uncontested edit on either side was discarded in silence. */
const mkNode = (
  base: N,
  kind: NodeKind<unknown>,
  style: SemanticStyle,
  state: StateBehaviour<unknown>,
  accessibility: Accessibility | undefined,
  tooltip: TextSource | undefined,
): N => {
  const { accessibility: _dropA, tooltip: _dropT, ...rest } = base;
  const withAcc =
    accessibility !== undefined
      ? { ...rest, kind, style, state, accessibility }
      : { ...rest, kind, style, state };
  return tooltip !== undefined ? { ...withAcc, tooltip } : withAcc;
};

/**
 * The class of a merge refusal. Mirrors the reference host's
 * `MergeConflictClass` spelling-for-spelling — these strings are the `class`
 * member of the committed refusal envelope, so they are wire, not prose.
 */
export type MergeConflictClass =
  | 'ConcurrentEdit'
  | 'ConcurrentMove'
  | 'DeleteModify'
  | 'KindSwapOrphansPin'
  | 'ReorderVsStructural'
  | 'CombinedCycle';

/**
 * One SIDE of a two-sided refusal: that branch's value for the contended cell,
 * plus the branch's own opaque provenance tag.
 *
 * The `value` is the contended cell's canonical encoding, EXCEPT for the
 * `style.*` sub-facets, whose value is the sub-field's canonical WIRE TOKEN.
 * On this tier those tokens are the values themselves, because every style
 * sub-field is enum-shaped and its TypeScript literal is its wire spelling. That
 * is not true of the reference host: `style.direction` is spelled `Auto` / `Ltr`
 * / `Rtl` there and lower-case here, and it is the token — not the case name —
 * that both hosts must put in the envelope. Do not generalise any of this to a
 * compound cell.
 */
export interface MergeSide {
  readonly value: string;
  readonly tag?: string;
}

/**
 * A `(nodeId, facet)` cell that could not be auto-merged, as a two-sided
 * recovery envelope.
 *
 * `a` and `b` are the SIDES view: the first- and second-argument branches'
 * values for the contended cell, populated on EVERY refusal. Swapping the
 * branches TRANSPOSES them and changes nothing else — which is what lets two
 * replicas that merged the same pair in opposite orders agree about what the
 * other side wanted. `base` is the LCA value (the empty string for a cell that
 * exists on neither side of the LCA, such as an `insert`).
 *
 * `primacyHeld` is the precedence view, and on this tier it is always `false`:
 * `merge3Way` is the author-agnostic entry point, so neither side is pinned.
 * The reference host's precedence slots (`primary` / `secondary` /
 * `secondaryTag`) are deliberately NOT mirrored here — they are populated
 * exactly when a pin is held, and this tier has no author classifier to hold one
 * with, so they could only ever be absent. They arrive with the entry point that
 * supplies an author, not before.
 *
 * The reference host's `choices` menu is not mirrored either, but for a
 * different reason, and the difference matters to whoever ports it. It is NOT
 * empty on this tier: every choice the reference offers names a slot the
 * envelope populated, so an unpinned refusal offers `KeepBase` / `KeepA` /
 * `KeepB` — all three well-defined here — rather than the `KeepSecondary` that
 * would name the empty precedence slot. The menu is left out because it is
 * derivable from the sides plus the pin, which is also why the shared refusal
 * corpus does not encode it; a port that wants it computes it, and must not
 * infer from the absence that this tier has no menu to offer.
 */
export interface MergeConflict {
  readonly nodeId: string;
  readonly facet: string;
  readonly class: MergeConflictClass;
  readonly base: string;
  readonly a: MergeSide;
  readonly b: MergeSide;
  readonly primacyHeld: boolean;
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

/** Kind-own canonical (children + style + state + accessibility + tooltip
 * neutralised). */
const kindCanonical = (n: N): string =>
  encodeNode(mkNode(n, childlessKind(n.kind), defaults.style, neutralState, undefined, undefined));

/** State canonical (kind→shell, style + accessibility neutralised). */
const stateCanonical = (shell: NodeKind<unknown>, n: N): string =>
  encodeNode(mkNode(n, shell, defaults.style, n.state, undefined, undefined));

/** Accessibility canonical (kind→shell, style + state neutralised). */
const accessibilityCanonical = (shell: NodeKind<unknown>, n: N): string =>
  encodeNode(mkNode(n, shell, defaults.style, neutralState, n.accessibility, undefined));

/** Tooltip canonical (kind→shell, style + state + accessibility neutralised).
 *
 * Isolating it is not bookkeeping — see the note on `mkNode`. Without a probe of
 * its own, a tooltip-only edit varies the bytes of the KIND probe, so two
 * branches that changed nothing but the hint are reported as a concurrent edit
 * to the node's kind. */
const tooltipCanonical = (shell: NodeKind<unknown>, n: N): string =>
  encodeNode(mkNode(n, shell, defaults.style, neutralState, undefined, n.tooltip));

// ─── whole-tree indexes ──────────────────────────────────────────────────────
//
// `merge3` recurses one PARENT at a time, so its whole view of a node is
// "present in this parent's child list, or not". Two completely different
// histories look identical from there: a node one side DELETED, and a node one
// side MOVED to a different parent. The first loses the other side's edit
// permanently; the second is an ordinary relocation that must not be reported as
// anything at all. Telling them apart needs a view of each tree as a WHOLE,
// which is what these indexes are — built once at the entry point, threaded down
// the recursion, never rebuilt per node.

/** One input tree indexed by node id: the node itself, and the id of its parent
 * (absent for the root). */
interface SideIndex {
  readonly nodes: Map<string, N>;
  readonly parents: Map<string, string | undefined>;
}

/** The three input trees, indexed. */
interface MergeIndex {
  readonly baseSide: SideIndex;
  readonly aSide: SideIndex;
  readonly bSide: SideIndex;
}

const indexTree = (root: N): SideIndex => {
  const nodes = new Map<string, N>();
  const parents = new Map<string, string | undefined>();
  const walk = (parent: string | undefined, n: N): void => {
    const id = rawId(n);
    nodes.set(id, n);
    parents.set(id, parent);
    for (const c of childrenOf(n)) walk(id, c);
  };
  walk(undefined, root);
  return { nodes, parents };
};

/** The parent id a side holds `nodeId` under, or `undefined` when that side does
 * not hold it at all. The ROOT's parent is also `undefined` — the two are told
 * apart by `nodes` membership, never by this. */
const parentIn = (side: SideIndex, nodeId: string): string | undefined => side.parents.get(nodeId);

const alreadyRecorded = (
  conflicts: readonly MergeConflict[],
  nodeId: string,
  facet: string,
): boolean => conflicts.some((c) => c.nodeId === nodeId && c.facet === facet);

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

/** A two-sided refusal envelope with no primacy pin — the only shape this
 * author-agnostic entry point can produce. */
const refusal = (
  nodeId: string,
  facet: string,
  cls: MergeConflictClass,
  base: string,
  aValue: string,
  bValue: string,
): MergeConflict => ({
  nodeId,
  facet,
  class: cls,
  base,
  a: { value: aValue },
  b: { value: bValue },
  primacyHeld: false,
});

/** Merge one SemanticStyle sub-field; push a conflict on a genuine divergence.
 * `dflt` renders an absent field for the envelope — absent ⟺ default on the
 * wire, so a side that omitted the field wanted the default, and an envelope
 * saying `undefined` would name a value the language does not have. */
const pickField = <T extends string>(
  conflicts: MergeConflict[],
  nodeId: string,
  facet: string,
  dflt: T,
  baseV: T | undefined,
  aV: T | undefined,
  bV: T | undefined,
): T | undefined => {
  const aCh = !eqOpt(aV, baseV);
  const bCh = !eqOpt(bV, baseV);
  if (aCh && bCh && !eqOpt(aV, bV)) {
    conflicts.push(refusal(nodeId, facet, 'ConcurrentEdit', baseV ?? dflt, aV ?? dflt, bV ?? dflt));
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
    conflicts.push(refusal(nodeId, facet, 'ConcurrentEdit', baseC, aC, bC));
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
  const d = defaults.style;
  const tone = pickField(conflicts, id, 'style.tone', d.tone, bs.tone, as_.tone, bsB.tone)!;
  const weight = pickField(
    conflicts,
    id,
    'style.weight',
    d.weight,
    bs.weight,
    as_.weight,
    bsB.weight,
  )!;
  const emphasis = pickField(
    conflicts,
    id,
    'style.emphasis',
    d.emphasis,
    bs.emphasis,
    as_.emphasis,
    bsB.emphasis,
  )!;
  const role = pickField(conflicts, id, 'style.role', d.role!, bs.role, as_.role, bsB.role);
  const voice = pickField(conflicts, id, 'style.voice', d.voice!, bs.voice, as_.voice, bsB.voice);
  // `direction` merges as an independent sub-field like every other style slot:
  // two lanes declaring different directions for one value is a genuine
  // concurrent edit, not a mergeable pair.
  //
  // The refusal envelope carries the canonical WIRE token, and on this tier the
  // token IS the value — `TextDirection` is `'auto' | 'ltr' | 'rtl'`, spelled
  // lower-case in the type. That is worth stating because it is exactly where a
  // hand-written mirror goes wrong: the reference host's case names are `Auto` /
  // `Ltr` / `Rtl` and it needs an explicit lower-casing token function, so a
  // reader porting from it may "fix" this to match the case names and silently
  // change what the envelope says. Every other style facet's F# case name and
  // wire token coincide; this one does not.
  //
  // The three values are DEFAULTED before comparison, unlike the optional slots
  // above. `TextDirection` on the reference host is a total value whose default
  // case IS `Auto`, so "absent" is not representable there and an explicitly
  // declared `auto` is indistinguishable from silence. Comparing this tier's
  // `undefined` against a declared `'auto'` would make the two hosts disagree
  // about whether a cell changed at all — a refusal on one and a clean merge on
  // the other, from the same three inputs.
  const direction = pickField(
    conflicts,
    id,
    'style.direction',
    'auto',
    bs.direction ?? 'auto',
    as_.direction ?? 'auto',
    bsB.direction ?? 'auto',
  );
  // Only attach optional fields when present, so the merged style encodes
  // byte-identically (absent ⟺ default; `encodeNode` omits defaults).
  const style: SemanticStyle = { tone, weight, emphasis };
  return {
    ...style,
    ...(role !== undefined ? { role } : {}),
    ...(voice !== undefined ? { voice } : {}),
    // Re-omit the identity so the merged style encodes byte-identically to a
    // document that never declared a direction.
    ...(direction !== undefined && direction !== 'auto' ? { direction } : {}),
  };
};

const merge3 = (
  conflicts: MergeConflict[],
  idx: MergeIndex,
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

  // tooltip facet — a node-level trait, merged on its own like every other facet
  const tooltipPick = pickCanonical(
    conflicts,
    id,
    'tooltip',
    tooltipCanonical(shell, base),
    tooltipCanonical(shell, a),
    tooltipCanonical(shell, b),
  );
  const mergedTooltip =
    tooltipPick === 1 ? a.tooltip : tooltipPick === 2 ? b.tooltip : base.tooltip;

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

  // ── the two WHOLE-NODE classes, invisible from inside one parent's fold ────
  //
  // Both are declared facets that nothing constructed on this tier until Phase
  // 1652, which is the shape worth naming: the merge reproduced the reference's
  // ANSWER on every fixture it was given and reproduced a silent LOSS on the two
  // it was not. Neither can be seen without the whole-tree indexes above.

  /** One side REMOVED `cid` from this parent and dropped it from its tree
   * entirely, while the other side had EDITED it — anywhere in its subtree, since
   * a deep child edit is lost along with the subtree that carried it.
   *
   * Emitted BEFORE the surviving side's child list is rebuilt: after that
   * rebuild the edited node is simply gone and there is nothing left to name. */
  const noteDeleteModify = (removedByA: boolean, survivingIds: readonly string[]): void => {
    const removingSide = removedByA ? idx.aSide : idx.bSide;
    const editingMap = removedByA ? bMap : aMap;
    const surviving = new Set(survivingIds);

    for (const cid of baseIds) {
      if (surviving.has(cid) || removingSide.nodes.has(cid)) continue;
      const baseChild = baseMap.get(cid);
      const editedChild = editingMap.get(cid);
      if (baseChild === undefined || editedChild === undefined) continue;

      const baseC = encodeNode(baseChild);
      const editedC = encodeNode(editedChild);
      if (editedC === baseC || alreadyRecorded(conflicts, cid, 'node')) continue;

      // The removing side holds NO value for the cell, so its side is the EMPTY
      // STRING — which no node canonical-encodes to, and which `base` already
      // uses for a same-id insert. The edited side's subtree is the surviving
      // choice a resolver keeps.
      const aValue = removedByA ? '' : editedC;
      const bValue = removedByA ? editedC : '';
      conflicts.push(refusal(cid, 'node', 'DeleteModify', baseC, aValue, bValue));
    }
  };

  /** `cid` reached this parent with no base entry HERE. Two histories do that:
   * an INSERT (the id is new to the whole tree) and a MOVE (the id existed
   * elsewhere in the base). Only the move can silently discard the other side's
   * work — the mover's subtree is adopted wholesale while the other side still
   * holds its own copy where the base left it.
   *
   * Both POSITIONS and both CELLS reach the envelope, as TWO entries on the same
   * node: `move` carries the parent id each side holds the node under, `node`
   * carries each side's subtree. Deliberately not one entry with a compound
   * value — a side's `value` is not a compound cell anywhere else, and inventing
   * one here would be the first place it was. */
  const noteConcurrentMove = (cid: string): void => {
    const baseChild = idx.baseSide.nodes.get(cid);
    const aNode = idx.aSide.nodes.get(cid);
    const bNode = idx.bSide.nodes.get(cid);
    // The id is new to the whole tree (a genuine insert), or one side dropped it
    // outright — that second shape is the delete/modify axis, named at the
    // parent that lost it.
    if (baseChild === undefined || aNode === undefined || bNode === undefined) return;

    const basePos = parentIn(idx.baseSide, cid) ?? '';
    const aPos = parentIn(idx.aSide, cid) ?? '';
    const bPos = parentIn(idx.bSide, cid) ?? '';
    const baseC = encodeNode(baseChild);
    const aC = encodeNode(aNode);
    const bC = encodeNode(bNode);
    const aMoved = aPos !== basePos;
    const bMoved = bPos !== basePos;

    // A one-sided move with no edit on the other side is an ORDINARY
    // RELOCATION and merges clean — this guard is what keeps the arm from
    // reporting every move.
    const contended = (aMoved && bMoved) || (aMoved && bC !== baseC) || (bMoved && aC !== baseC);
    if (!contended || alreadyRecorded(conflicts, cid, 'move')) return;

    conflicts.push(refusal(cid, 'move', 'ConcurrentMove', basePos, aPos, bPos));
    conflicts.push(refusal(cid, 'node', 'ConcurrentMove', baseC, aC, bC));
  };

  const recurseChild = (cid: string): N => {
    const bc = baseMap.get(cid);
    if (bc !== undefined) return merge3(conflicts, idx, bc, aMap.get(cid), bMap.get(cid));
    const ac = aMap.get(cid);
    const bb = bMap.get(cid);
    if (ac !== undefined && bb !== undefined) {
      // BOTH branches introduced this id. There is no base to merge against, so
      // agreement is the only clean outcome: identical content is the shared
      // value, and DIFFERENT content is a refusal naming the id. Taking the A
      // side unconditionally is a silent, arrival-order-dependent pick.
      const acC = encodeNode(ac);
      const bcC = encodeNode(bb);
      if (acC === bcC) return ac;
      // The id exists on neither side of the LCA, so it has no base value — the
      // empty string, not an encoding of some node that was never there.
      conflicts.push(refusal(cid, 'insert', 'ConcurrentEdit', '', acC, bcC));
      // The merge has already refused, so this value reaches no caller — but it
      // must not depend on which branch arrived first either. Same doctrine as
      // the insert tie-break: order by canonical bytes.
      return ordinal(acC, bcC) <= 0 ? ac : bb;
    }
    if (ac !== undefined) {
      noteConcurrentMove(cid);
      return ac;
    }
    if (bb !== undefined) {
      noteConcurrentMove(cid);
      return bb;
    }
    throw new Error(`merge3: child id ${cid} vanished`);
  };

  let mergedChildren: readonly N[];
  if (!aStruct && !bStruct) {
    mergedChildren = baseIds.map(recurseChild);
  } else if (aStruct && !bStruct) {
    noteDeleteModify(true, aIds);
    mergedChildren = aIds.map(recurseChild);
  } else if (!aStruct && bStruct) {
    noteDeleteModify(false, bIds);
    mergedChildren = bIds.map(recurseChild);
  } else if (JSON.stringify(aIds) === JSON.stringify(bIds)) {
    // Both sides changed the children to the SAME id list — agreement, not a
    // conflict, and the guard every other facet already has. Its absence here is
    // what made `merge3Way(base, a, a)` refuse for any branch that touched
    // children at all. The shared ids' CONTENTS are checked by `recurseChild`
    // above, which refuses a same-id-different-content insert rather than
    // defaulting to a side.
    mergedChildren = aIds.map(recurseChild);
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
      // Both sides structurally changed the same parent differently.
      conflicts.push(
        refusal(
          id,
          'children',
          'ReorderVsStructural',
          baseIds.join(','),
          aIds.join(','),
          bIds.join(','),
        ),
      );
      mergedChildren = baseIds.map(recurseChild);
    }
  }

  const mergedKind = withKindChildren(childlessKind(kindSource.kind), mergedChildren);
  return mkNode(base, mergedKind, mergedStyle, mergedState, mergedAcc, mergedTooltip);
};

/**
 * Author-agnostic facet 3-way merge of `a` and `b` over their common `base`
 * (all three share the root id). Returns the merged tree on full auto-merge, or
 * the conflicting cells. Deterministic + host-reproducible (NodeId-byte
 * tie-break, no wall-clock) — byte-identical to the F# `TreeMerge.merge3Way`.
 */
export const merge3Way = (base: N, a: N, b: N): MergeResult => {
  const conflicts: MergeConflict[] = [];
  // Indexed once at the entry point and threaded down — see the note on
  // `SideIndex`. Rebuilding per node would be quadratic and would answer the
  // same question every time.
  const merged = merge3(
    conflicts,
    { baseSide: indexTree(base), aSide: indexTree(a), bSide: indexTree(b) },
    base,
    a,
    b,
  );
  return conflicts.length === 0 ? { ok: true, tree: merged } : { ok: false, conflicts };
};

// ─── the refusal envelope as a cross-host artefact ───────────────────────────

/**
 * Order a refusal set deterministically. `(nodeId, facet)` is unique within one
 * merge — a facet of a node is merged once — so this totally orders an envelope
 * regardless of the fold's internal emission order.
 */
export const sortConflictsCanonical = (
  conflicts: readonly MergeConflict[],
): readonly MergeConflict[] =>
  [...conflicts].sort((x, y) => ordinal(x.nodeId, y.nodeId) || ordinal(x.facet, y.facet));

/** Mirror of the canonical-JSON string escape, kept local for the same reason
 * the reference host keeps its own: the merge surface takes no dependency on a
 * codec for one escape. */
const escapeJson = (s: string): string => {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch < ' ') out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
};

const encodeSide = (side: MergeSide): string =>
  `{"tag":${side.tag === undefined ? 'null' : escapeJson(side.tag)},"value":${escapeJson(side.value)}}`;

/**
 * Canonical JSON of a REFUSAL envelope: the conflict set as a sorted array of
 * `{a,b,base,class,facet,nodeId,primacyHeld}` objects (object keys alphabetical,
 * array entries in `(nodeId, facet)` order). Byte-stable across hosts, so a
 * sha256 over it is the cross-host refusal hash — the determinism artefact for a
 * REFUSED structural merge, the analogue of the outcome hash for an auto-merge.
 *
 * The precedence view is deliberately projected as `primacyHeld` alone: the
 * pinned winner and loser are derivable from the sides plus the pin, and a
 * corpus that committed both would pin the same value twice and go red on a host
 * that agreed about the merge.
 */
export const encodeMergeEnvelope = (conflicts: readonly MergeConflict[]): string =>
  '[' +
  sortConflictsCanonical(conflicts)
    .map(
      (c) =>
        `{"a":${encodeSide(c.a)},"b":${encodeSide(c.b)},"base":${escapeJson(c.base)},` +
        `"class":${escapeJson(c.class)},"facet":${escapeJson(c.facet)},` +
        `"nodeId":${escapeJson(c.nodeId)},"primacyHeld":${c.primacyHeld ? 'true' : 'false'}}`,
    )
    .join(',') +
  ']';
