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
//   3. A REFUSAL — anything else. `DeleteModify` when exactly one of the two ops
//      removes (a `RemoveNode`, or a `Batch` holding one), `Conflict` otherwise.
//
//  THE CHILD-ORDER RULE (§34.4). Under an interleaved parent the children
//  neither branch appended keep the fold's order and the appended ones follow:
//  each branch's appends in its own order, the two runs merged by comparing
//  heads ordinally by NodeId, the smaller first. Where that differs from the
//  fold's order the merge records `ReorderChildren(p, order)`.
//
//  CHECKED, not assumed: the admitted classes lie outside Core's independence
//  theorem, so the fold runs in both orders, each followed by the script, and
//  two trees that differ refuse the merge as `OrderSensitive`.
//
//  The reference is fuaran-dotnet's `DagReconcile`; the `foldFixtures` family
//  of the merge-conformance corpus certifies every host against the same bytes.
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

/** A derived merge: the tree, the script the merge records, how many distinct
 * agreeing ops the fold applied as no change, and how many parents it interleaved. */
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

const foldHeld = (ops: readonly Op[], start: N): Applied =>
  foldOps(ops, start, (o, t) => {
    const r = applyHeld(o, t);
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

type Verdict =
  | { readonly v: 'Agreement' }
  | { readonly v: 'Interleave'; readonly parent: string }
  | { readonly v: 'Refuse'; readonly class: FoldRefusalClass };

const judge = (c: OpConflict<unknown>): Verdict => {
  if (encodeOp(c.left) === encodeOp(c.right)) return { v: 'Agreement' };
  const l = appendInto(c.address, c.left);
  const r = appendInto(c.address, c.right);
  if (c.shape.shape === 'InsertPositionClash' && l !== undefined && r !== undefined && l !== r)
    return { v: 'Interleave', parent: c.address };
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

/** The child-order rule's run-merge: each run in its own order, heads compared ordinally. */
const interleave = (a: readonly string[], b: readonly string[]): string[] => {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(ordinal(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  return [...out, ...a.slice(i), ...b.slice(j)];
};

/** The `ReorderChildren` the rule asks of `parent`, or none when the fold's order is the rule's. */
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
  const order = [...kids.filter((k) => !appended.has(k)), ...interleave(keep(runA), keep(runB))];
  return order.every((x, i) => x === kids[i])
    ? []
    : [{ kind: 'ReorderChildren', parentId: parent as NodeId, newOrder: order as NodeId[] }];
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
  const a = deltaA as readonly Op[];
  const b = deltaB as readonly Op[];
  const failA = firstFailure(a, b0);
  if (failA !== undefined)
    return { ok: false, error: { fault: 'DeltaDoesNotApply', side: 'A', ...failA } };
  const failB = firstFailure(b, b0);
  if (failB !== undefined)
    return { ok: false, error: { fault: 'DeltaDoesNotApply', side: 'B', ...failB } };

  const verdicts = conflictsIn(b0, a, b).map((c) => [c, judge(c)] as const);
  const refusals = verdicts.flatMap(([c, v]) =>
    v.v === 'Refuse' ? [{ conflict: c as OpConflict<TMsg>, class: v.class }] : [],
  );
  if (refusals.length > 0)
    return { ok: false, error: { fault: 'Refused', refusals: sortFoldRefusals(refusals) } };

  const parents = [
    ...new Set(verdicts.flatMap(([, v]) => (v.v === 'Interleave' ? [v.parent] : []))),
  ].sort(ordinal);
  // A pair is reported once per address it collides on: count distinct agreeing ops.
  const agreements = new Set(
    verdicts.flatMap(([c, v]) => (v.v === 'Agreement' ? [encodeOp(c.left)] : [])),
  ).size;

  const appendsOf = (parent: string, delta: readonly Op[]): string[] =>
    delta.flatMap((op) => {
      const id = appendInto(parent, op);
      return id === undefined ? [] : [id];
    });

  const derive = (
    first: readonly Op[],
    second: readonly Op[],
  ): { ok: true; tree: N; script: Op[] } | { ok: false; error: ApplyError } => {
    const folded = foldHeld([...first, ...second], b0);
    if (!folded.ok) return folded;
    const script = parents.flatMap((p) =>
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
