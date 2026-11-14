// ============================================================================
//  @fuaran-ui/ops — merge by fold: the reconciliation policy over Core's
//  conflict report (WIRE_FORMAT.md §34, Phase 2641).
//
//  A merge of two branches is a DERIVATION: both branches' op deltas are
//  folded from their common base, and the merge records only what the fold
//  cannot decide on its own — a script. Which op pairs interfere is Core's
//  report over the base-aware footprint (`conflictsIn`, footprint.ts). Each
//  reported pair is exactly one of:
//
//   1. An AGREEMENT — the two ops' canonical encodings are byte-identical, so
//      the fold already holds the effect when it reaches the second. Admitted.
//   2. An INTERLEAVE — an `InsertPositionClash` at parent `p` where each op
//      appends a node to `p` (an `InsertChild` under it, or a `MoveNode` to it)
//      and the two appended ids differ. Admitted, ordered by the child-order
//      rule below.
//   3. A REBASE (fuaran#2671) — one op is a `ReorderChildren(p, order)` and the
//      other changes `p`'s child list: an `InsertChild` under `p`, a `MoveNode`
//      to `p`, or a `RemoveNode` or `MoveNode` of a child `order` lists. Neither
//      may be a `Batch`. Admitted: the fold applies the reorder REBASED to the
//      children `p` holds when it is reached (the listed children still there,
//      in the declared order, then the rest in held order).
//   4. A REFUSAL — anything else. `DeleteModify` when exactly one of the two ops
//      removes (a `RemoveNode`, or a `Batch` holding one), `Conflict` otherwise.
//      Two reorders of one parent that differ stay refused.
//
//  THE YIELD RULE (§34.3, Phase 2724), before Core is asked: a top-level
//  `ReorderChildren` that leaves its parent's order as it was on its own branch
//  carries no intent, so beside the other branch's top-level REAL reorder of the
//  same parent it is dropped from its delta, the real order survives, and the
//  script records it for that parent. Nothing else yields: an unchanged reorder
//  beside an append or a removal in its parent, beside another unchanged
//  reorder, or beside a reorder inside a `Batch` is judged as before.
//
//  THE CHILD-ORDER RULE (§34.4). Under an interleaved or rebased parent the
//  children neither branch appended keep the fold's order (the rebased
//  reorder's, where a branch reordered the parent) and the appended ones
//  follow: each branch's run of appends in its own order, the two runs merged
//  by comparing heads ordinally by NodeId, the smaller first, and a node both
//  runs hold (two agreeing moves of it) listed once, where the merge first
//  reaches it. An append a later reorder of the same parent on the same branch
//  lists is settled by that reorder and leaves the run. The merge records
//  `ReorderChildren(p, order)` for EVERY interleaved or rebased parent
//  (fuaran#2645): a merge node is replayed by Core's closure fold in its own
//  drain order, so the script — not the order a reconcile checked — fixes it.
//
//  CHECKED, not assumed: the admitted classes lie outside Core's independence
//  theorem, so the fold runs in both orders, each followed by the script, and
//  two trees that differ refuse the merge as `OrderSensitive`.
//
//  The reference is fuaran-dotnet's `DagReconcile`; the `foldFixtures` family
//  of the merge-conformance corpus certifies every host against the same bytes.
//  Since fuaran#2645 this is the op DAG's ONLY merge: the three-way tree merge
//  retired with its merge-conformance keys (fuaran#2646).
// ============================================================================

import type { Node, NodeId } from '@fuaran-ui/schema';

import { apply, type ApplyError } from './apply.js';
import { children, Reach } from './children.js';
import { encodeNode, encodeOp, str } from './encode.js';
import { conflictsIn, ordinal, type OpConflict } from './footprint.js';
import type { TreeOp } from './treeOp.js';

type N = Node<unknown>;
type Op = TreeOp<unknown>;

/** Which branch of a two-branch reconcile an op or a fault belongs to. */
export type FoldSide = 'A' | 'B';

/** How the policy classes a pair it refuses. */
export type FoldRefusalClass = 'DeleteModify' | 'Conflict';

/** One refused pair: Core's report entry with the policy's class. */
export interface FoldRefusal<TMsg> {
  readonly conflict: OpConflict<TMsg>;
  readonly class: FoldRefusalClass;
}

/** Why a reconcile refused. `D` is the validator gate's defect type. */
export type FoldFault<TMsg, D = never> =
  /** A branch's own delta does not apply from the base: the first failing op. */
  | {
      readonly fault: 'DeltaDoesNotApply';
      readonly side: FoldSide;
      readonly index: number;
      readonly error: ApplyError;
    }
  /** Core reported pairs the policy does not admit, in canonical order. */
  | { readonly fault: 'Refused'; readonly refusals: readonly FoldRefusal<TMsg>[] }
  /** Every pair was admitted and the two fold orders reached different trees. */
  | { readonly fault: 'OrderSensitive'; readonly aThenB: string; readonly bThenA: string }
  /** Every pair was admitted and the fold faulted applying an op. */
  | { readonly fault: 'FoldFaulted'; readonly error: ApplyError }
  /** The derived tree carries defects neither branch head had. */
  | { readonly fault: 'IntroducedDefects'; readonly defects: readonly D[] };

/** A derived merge: the tree, the script the merge records (one `ReorderChildren`
 * per interleaved or rebased parent, parents in ordinal order), how many distinct
 * agreeing ops the fold applied as no change, and how many parents it interleaved
 * or rebased. */
export interface FoldReconciled<TMsg> {
  readonly tree: Node<TMsg>;
  readonly script: readonly TreeOp<TMsg>[];
  readonly agreements: number;
  readonly interleaves: number;
}

export type FoldResult<TMsg, D = never> =
  | { readonly ok: true; readonly value: FoldReconciled<TMsg> }
  | { readonly ok: false; readonly error: FoldFault<TMsg, D> };

type Applied =
  | { readonly ok: true; readonly tree: N }
  | { readonly ok: false; readonly error: ApplyError };

const idOf = (n: N): string => n.id as string;

const structural = (n: N): readonly N[] => children(n, Reach.structural);

const findStructural = (n: N, id: string): N | undefined => {
  if (idOf(n) === id) return n;
  for (const c of structural(n)) {
    const r = findStructural(c, id);
    if (r !== undefined) return r;
  }
  return undefined;
};

/** Is the effect of `op` already held by `tree`? The two cases where re-applying
 * an identical op FAILS; every other op is idempotent under `apply`. */
const held = (op: Op, tree: N): boolean => {
  switch (op.kind) {
    case 'RemoveNode':
      return findStructural(tree, op.target as string) === undefined;
    case 'InsertChild': {
      const p = findStructural(tree, op.parentId as string);
      if (p === undefined) return false;
      const want = encodeNode(op.child);
      return structural(p).some((c) => idOf(c) === idOf(op.child) && encodeNode(c) === want);
    }
    default:
      return false;
  }
};

const applyOne = (op: Op, tree: N): Applied => {
  const r = apply(tree, op);
  return r.ok ? { ok: true, tree: r.value.newTree } : { ok: false, error: r.error };
};

/**
 * `apply`, with an op whose effect `tree` already holds applied as no change —
 * the fold's reading of an agreement. A `Batch` is applied member by member
 * under the same rule; the first member that fails and is not held fails it.
 */
export const applyHeld = <TMsg>(
  op: TreeOp<TMsg>,
  tree: Node<TMsg>,
):
  | { readonly ok: true; readonly tree: Node<TMsg> }
  | { readonly ok: false; readonly error: ApplyError } => {
  const go = (o: Op, t: N): Applied => {
    if (o.kind === 'Batch') return foldOps(o.ops, t, go);
    const r = applyOne(o, t);
    return r.ok || !held(o, t) ? r : { ok: true, tree: t };
  };
  return go(op as Op, tree as N) as ReturnType<typeof applyHeld<TMsg>>;
};

const foldOps = (ops: readonly Op[], start: N, step: (o: Op, t: N) => Applied): Applied => {
  let acc: Applied = { ok: true, tree: start };
  for (const o of ops) {
    if (!acc.ok) return acc;
    acc = step(o, acc.tree);
  }
  return acc;
};

/**
 * A reorder rebased to the children its parent holds in `tree`: the listed
 * children still there, in the declared order, then the others in held order.
 * `op` itself where the parent is not in the tree.
 */
const rebased = (tree: N, op: Extract<Op, { kind: 'ReorderChildren' }>): Op => {
  const p = findStructural(tree, op.parentId as string);
  if (p === undefined) return op;
  const kids = structural(p).map(idOf);
  const listed = [...new Set(op.newOrder.map(String).filter((c) => kids.includes(c)))];
  const order = [...listed, ...kids.filter((k) => !listed.includes(k))];
  return { kind: 'ReorderChildren', parentId: op.parentId, newOrder: order as NodeId[] };
};

/**
 * The fold: `applyHeld` op by op, with a reorder of a parent in `rebase`
 * applied rebased to the children the parent holds when the fold reaches it.
 */
const foldHeld = (ops: readonly Op[], start: N, rebase: ReadonlySet<string> = new Set()): Applied =>
  foldOps(ops, start, (o, t) => {
    const step =
      o.kind === 'ReorderChildren' && rebase.has(o.parentId as string) ? rebased(t, o) : o;
    const r = applyHeld(step, t);
    return r.ok ? { ok: true, tree: r.tree } : r;
  });

const firstFailure = (
  delta: readonly Op[],
  base: N,
): { readonly index: number; readonly error: ApplyError } | undefined => {
  let t = base;
  for (let i = 0; i < delta.length; i += 1) {
    const r = applyOne(delta[i]!, t);
    if (!r.ok) return { index: i, error: r.error };
    t = r.tree;
  }
  return undefined;
};

const removes = (op: Op): boolean =>
  op.kind === 'RemoveNode' || (op.kind === 'Batch' && op.ops.some(removes));

/** The node `op` appends to `parent`, when it is an append there. */
const appendInto = (parent: string, op: Op): string | undefined => {
  if (op.kind === 'InsertChild' && (op.parentId as string) === parent) return idOf(op.child);
  if (op.kind === 'MoveNode' && (op.newParentId as string) === parent) return op.target as string;
  return undefined;
};

/**
 * The parent whose child list `reorder` and `other` both change, when `reorder`
 * is a `ReorderChildren` and `other` an append to its parent or a removal or
 * move of a child it lists.
 */
const rebaseOf = (reorder: Op, other: Op): string | undefined => {
  if (reorder.kind !== 'ReorderChildren') return undefined;
  const p = reorder.parentId as string;
  const listed = (c: string): boolean => reorder.newOrder.map(String).includes(c);
  switch (other.kind) {
    case 'InsertChild':
      return (other.parentId as string) === p ? p : undefined;
    case 'MoveNode':
      return (other.newParentId as string) === p || listed(other.target as string) ? p : undefined;
    case 'RemoveNode':
      return listed(other.target as string) ? p : undefined;
    default:
      return undefined;
  }
};

type Verdict =
  | { readonly v: 'Agreement' }
  | { readonly v: 'Interleave'; readonly parent: string }
  | { readonly v: 'Rebase'; readonly parent: string }
  | { readonly v: 'Refuse'; readonly class: FoldRefusalClass };

const judge = (c: OpConflict<unknown>): Verdict => {
  if (encodeOp(c.left) === encodeOp(c.right)) return { v: 'Agreement' };
  const l = appendInto(c.address, c.left);
  const r = appendInto(c.address, c.right);
  if (c.shape.shape === 'InsertPositionClash' && l !== undefined && r !== undefined && l !== r)
    return { v: 'Interleave', parent: c.address };
  const rebase = rebaseOf(c.left, c.right) ?? rebaseOf(c.right, c.left);
  if (rebase !== undefined) return { v: 'Rebase', parent: rebase };
  return { v: 'Refuse', class: removes(c.left) !== removes(c.right) ? 'DeleteModify' : 'Conflict' };
};

const slotOf = (c: OpConflict<unknown>): string =>
  c.shape.shape === 'SlotClash' ? c.shape.slot : '';

const orderKey = (r: FoldRefusal<unknown>): readonly string[] => [
  r.conflict.address,
  r.conflict.shape.shape,
  slotOf(r.conflict),
  encodeOp(r.conflict.left),
  encodeOp(r.conflict.right),
];

/**
 * Refusals in the canonical order — address, shape, slot, left op bytes, right
 * op bytes, each ordinal — with exact duplicates removed (§34.5).
 */
export const sortFoldRefusals = <TMsg>(
  refusals: readonly FoldRefusal<TMsg>[],
): FoldRefusal<TMsg>[] => {
  const seen = new Map<string, readonly [readonly string[], FoldRefusal<TMsg>]>();
  for (const r of refusals) {
    const k = orderKey(r as FoldRefusal<unknown>);
    const id = JSON.stringify(k);
    if (!seen.has(id)) seen.set(id, [k, r]);
  }
  return [...seen.values()]
    .sort(([a], [b]) => a.reduce((acc, x, i) => acc || ordinal(x, b[i]!), 0))
    .map(([, r]) => r);
};

/**
 * The child-order rule's run-merge: each run in its own order, heads compared
 * ordinally. An id both runs hold appears twice; `reorderFor` keeps its first
 * occurrence.
 */
const interleave = (a: readonly string[], b: readonly string[]): string[] => {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(ordinal(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  return [...out, ...a.slice(i), ...b.slice(j)];
};

/**
 * The `ReorderChildren` the rule asks of `parent`, or none when the parent is not
 * in the tree. Recorded even where the fold already gives the rule's order
 * (fuaran#2645): a merge node's replay applies the branches in Core's drain
 * order, so the script has to fix the order.
 */
const reorderFor = (
  tree: N,
  parent: string,
  runA: readonly string[],
  runB: readonly string[],
): Op[] => {
  const p = findStructural(tree, parent);
  if (p === undefined) return [];
  const kids = structural(p).map(idOf);
  const present = new Set(kids);
  const appended = new Set([...runA, ...runB]);
  const keep = (run: readonly string[]): string[] => [
    ...new Set(run.filter((x) => present.has(x))),
  ];
  // A node both runs hold (two agreeing moves of it) is listed once, where the
  // merge first reaches it — the same whichever run is named first.
  const order = [
    ...kids.filter((k) => !appended.has(k)),
    ...new Set(interleave(keep(runA), keep(runB))),
  ];
  return [{ kind: 'ReorderChildren', parentId: parent as NodeId, newOrder: order as NodeId[] }];
};

/**
 * The parent a top-level `ReorderChildren` reorders, with whether its list is the
 * parent's child order in `tree` — the same ids, in the same order, of the same
 * length. Undefined for any other op, a `Batch` included, and for a reorder of a
 * parent `tree` does not hold.
 */
const reorderIn = (
  tree: N,
  op: Op,
): { readonly parent: string; readonly unchanged: boolean } | undefined => {
  if (op.kind !== 'ReorderChildren') return undefined;
  const p = findStructural(tree, op.parentId as string);
  if (p === undefined) return undefined;
  const kids = structural(p).map(idOf);
  const order = op.newOrder.map(String);
  return {
    parent: op.parentId as string,
    unchanged: kids.length === order.length && kids.every((k, i) => k === order[i]),
  };
};

/**
 * THE YIELD RULE (§34.3, Phase 2724): drop from each delta every top-level
 * `ReorderChildren` that is unchanged in the tree its own branch applies it to,
 * where the other delta holds a top-level reorder of the same parent that
 * changes the order on its own branch. The dropped op is no change on its own
 * branch, so every later tree of that branch is as it was. Returns the two
 * deltas without the yielded reorders and the yielded parents (distinct,
 * ordinal), whose surviving order the script records.
 */
const yieldUnchangedReorders = (
  base: N,
  deltaA: readonly Op[],
  deltaB: readonly Op[],
): { readonly a: Op[]; readonly b: Op[]; readonly yielded: string[] } => {
  // Each op with the reorder reading of it in the tree its own branch applies it
  // to. Both deltas were checked to apply from the base before this runs.
  const threaded = (delta: readonly Op[]) => {
    let t = base;
    return delta.map((op) => {
      const reading = reorderIn(t, op);
      const r = applyOne(op, t);
      if (r.ok) t = r.tree;
      return { op, reading };
    });
  };
  const ta = threaded(deltaA);
  const tb = threaded(deltaB);
  const realParents = (ops: ReturnType<typeof threaded>): Set<string> =>
    new Set(ops.flatMap(({ reading }) => (reading && !reading.unchanged ? [reading.parent] : [])));
  const yields = (otherReal: Set<string>, reading: ReturnType<typeof reorderIn>): boolean =>
    reading !== undefined && reading.unchanged && otherReal.has(reading.parent);
  const realA = realParents(ta);
  const realB = realParents(tb);
  const yielded = new Set<string>();
  const split = (ops: ReturnType<typeof threaded>, otherReal: Set<string>): Op[] =>
    ops.flatMap(({ op, reading }) => {
      if (!yields(otherReal, reading)) return [op];
      yielded.add(reading!.parent);
      return [];
    });
  const a = split(ta, realB);
  const b = split(tb, realA);
  return { a, b, yielded: [...yielded].sort(ordinal) };
};

/**
 * Reconcile two branch deltas from their common base under the §34 policy: the
 * derived tree and the script a merge records, or a typed refusal. Both deltas
 * apply from `base`, op by op, as recorded on their branches.
 */
export const reconcileFold = <TMsg>(
  base: Node<TMsg>,
  deltaA: readonly TreeOp<TMsg>[],
  deltaB: readonly TreeOp<TMsg>[],
): FoldResult<TMsg> => {
  const b0 = base as N;
  const failA = firstFailure(deltaA as readonly Op[], b0);
  if (failA !== undefined)
    return { ok: false, error: { fault: 'DeltaDoesNotApply', side: 'A', ...failA } };
  const failB = firstFailure(deltaB as readonly Op[], b0);
  if (failB !== undefined)
    return { ok: false, error: { fault: 'DeltaDoesNotApply', side: 'B', ...failB } };

  // The yield rule runs first (Phase 2724): everything below judges and folds the
  // deltas without the yielded reorders.
  const { a, b, yielded } = yieldUnchangedReorders(
    b0,
    deltaA as readonly Op[],
    deltaB as readonly Op[],
  );

  const verdicts = conflictsIn(b0, a, b).map((c) => [c, judge(c)] as const);
  const refusals = verdicts.flatMap(([c, v]) =>
    v.v === 'Refuse' ? [{ conflict: c as OpConflict<TMsg>, class: v.class }] : [],
  );
  if (refusals.length > 0)
    return { ok: false, error: { fault: 'Refused', refusals: sortFoldRefusals(refusals) } };

  const rebase = new Set(verdicts.flatMap(([, v]) => (v.v === 'Rebase' ? [v.parent] : [])));
  const parents = [
    ...new Set(
      verdicts.flatMap(([, v]) => (v.v === 'Interleave' || v.v === 'Rebase' ? [v.parent] : [])),
    ),
  ].sort(ordinal);
  // A parent whose reorder yielded is recorded too: its order in the fold is the
  // surviving reorder's, which the script fixes for a merge node's replay.
  const scripted = [...new Set([...parents, ...yielded])].sort(ordinal);
  // A pair is reported once per address it collides on: count distinct agreeing ops.
  const agreements = new Set(
    verdicts.flatMap(([c, v]) => (v.v === 'Agreement' ? [encodeOp(c.left)] : [])),
  ).size;

  // A branch's run of appends into `parent`, in branch order. An append a later
  // reorder of the same parent on the branch lists is settled by that reorder:
  // the branch placed it, so it leaves the run.
  const appendsOf = (parent: string, delta: readonly Op[]): string[] =>
    delta.reduce<string[]>((run, op) => {
      if (op.kind === 'ReorderChildren' && (op.parentId as string) === parent) {
        const listed = op.newOrder.map(String);
        return run.filter((id) => !listed.includes(id));
      }
      const id = appendInto(parent, op);
      return id === undefined || run.includes(id) ? run : [...run, id];
    }, []);

  const derive = (
    first: readonly Op[],
    second: readonly Op[],
  ): { ok: true; tree: N; script: Op[] } | { ok: false; error: ApplyError } => {
    const folded = foldHeld([...first, ...second], b0, rebase);
    if (!folded.ok) return folded;
    const script = scripted.flatMap((p) =>
      reorderFor(folded.tree, p, appendsOf(p, a), appendsOf(p, b)),
    );
    const t = foldHeld(script, folded.tree);
    return t.ok ? { ok: true, tree: t.tree, script } : t;
  };

  const ab = derive(a, b);
  if (!ab.ok) return { ok: false, error: { fault: 'FoldFaulted', error: ab.error } };
  const ba = derive(b, a);
  if (!ba.ok) return { ok: false, error: { fault: 'FoldFaulted', error: ba.error } };
  const abText = encodeNode(ab.tree);
  const baText = encodeNode(ba.tree);
  if (abText !== baText)
    return { ok: false, error: { fault: 'OrderSensitive', aThenB: abText, bThenA: baText } };
  return {
    ok: true,
    value: {
      tree: ab.tree as Node<TMsg>,
      script: ab.script as TreeOp<TMsg>[],
      agreements,
      interleaves: parents.length,
    },
  };
};

/**
 * `reconcileFold`, then the validator gate: `introduced` is handed the two
 * branch heads and the derived tree and answers the defects the derived tree
 * carries that neither head does (§27.8.2's introduced-defect diff under the
 * domain's validator). Any refuses the merge.
 */
export const reconcileFoldGated = <TMsg, D>(
  introduced: (headA: Node<TMsg>, headB: Node<TMsg>, derived: Node<TMsg>) => readonly D[],
  base: Node<TMsg>,
  deltaA: readonly TreeOp<TMsg>[],
  deltaB: readonly TreeOp<TMsg>[],
): FoldResult<TMsg, D> => {
  const r = reconcileFold(base, deltaA, deltaB);
  if (!r.ok) return r;
  // Both deltas applied from the base inside `reconcileFold`, so the heads exist.
  const head = (delta: readonly TreeOp<TMsg>[]): Node<TMsg> => {
    const h = foldHeld(delta as readonly Op[], base as N);
    return (h.ok ? h.tree : base) as Node<TMsg>;
  };
  const defects = introduced(head(deltaA), head(deltaB), r.value.tree);
  return defects.length === 0 ? r : { ok: false, error: { fault: 'IntroducedDefects', defects } };
};

/**
 * The refusal envelope (§34.5): a JSON array of the refused pairs in canonical
 * order, each `{"address","class","left","right","shape"[,"slot"]}` with the
 * ops as their canonical encodings and `slot` present only for a `SlotClash`.
 * `sha256` over it is the cross-host refusal hash.
 */
export const encodeFoldEnvelope = <TMsg>(refusals: readonly FoldRefusal<TMsg>[]): string =>
  '[' +
  sortFoldRefusals(refusals)
    .map((r) => {
      const c = r.conflict;
      const slot = c.shape.shape === 'SlotClash' ? `,"slot":${str(c.shape.slot)}` : '';
      return (
        `{"address":${str(c.address)},"class":${str(r.class)},"left":${encodeOp(c.left)},` +
        `"right":${encodeOp(c.right)},"shape":${str(c.shape.shape)}${slot}}`
      );
    })
    .join(',') +
  ']';
