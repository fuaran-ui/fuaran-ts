// ============================================================================
//  @fuaran-ui/ops — the footprint of a tree op, and Core's conflict report
//  over two deltas (WIRE_FORMAT.md §34.2, Phase 2641).
//
//  A footprint says what an op reads and writes, as Fuaran Core's `Footprint`
//  record: the ids it depends on (`reads`), the named parents whose child list
//  it changes (`structureWrites`), the nodes it authors, destroys, relocates or
//  rewrites (`contentWrites`), the nodes it removes or rewrites under a parent
//  it cannot name (`unknownParentWrites`), and the `(node, slot)` pairs it
//  reads or writes without touching the whole node. Two scripts whose
//  footprints fail no clause of Core's `Ops.independent` commute.
//
//  §34.2 makes the projection itself part of the contract: the pairs a merge
//  by fold judges are exactly the pairs Core's `Dag.conflictsIn` reports over
//  the reference's base-aware footprint (`TreeOpFootprint.ofOpIn`). A coarser
//  projection refuses pairs the reference admits, a finer one admits pairs it
//  refuses, and the `foldFixtures` family catches both. So this module ports
//  the reference's rules arm for arm, and nothing else:
//
//  - The PURE form (`footprintOf`) is computed from the op alone. The
//    structural ops are Core's skeleton clauses; an in-place edit is Core's
//    `UpdateNode` footprint — the node read and content-written with every id
//    of a subtree the op puts in, and an unknown-parent write of the node.
//  - The BASE-AWARE form (`footprintIn`) is computed at the tree the op applies
//    to (Core's `Ops.footprintIn`, fuaran-core Phase 500). A removal whose
//    target the STRUCTURAL walk locates under a structural parent names that
//    parent (a read and a structure write) and content-writes the whole subtree
//    it destroys; a move located the same way, whose destination is located
//    too, also reads the destination's proper ancestors (the cycle check reads
//    them). A located in-place edit that applies is declared at the SLOT it
//    changes — `kind`, `state`, `style`, `style.<field>` beside a read of
//    `style`, `accessibility`, `tooltip` — with every id it puts in or takes
//    out. Anything the walk does not locate takes the pure arm. A `Batch` is
//    threaded member by member, and from an op that does not apply onwards
//    every op takes the pure arm.
//
//  Ids are counted over EVERY position a node holds another in (`Reach.all`,
//  the reference's keyed walk); the base-aware arms LOCATE through the ordered
//  child lists alone (`Reach.structural`), as Core's resolution does, so a node
//  held only in a keyed position takes the pure arm.
//
//  Sets enumerate in ordinal order wherever order is observable (the conflict
//  report), which is the order F#'s `Set<string>` gives the reference. Pure,
//  total, no IO.
// ============================================================================

import type { Node } from '@fuaran-ui/schema';

import { apply, insertedNodes } from './apply.js';
import { children, Reach } from './children.js';
import type { TreeOp } from './treeOp.js';

type N = Node<unknown>;

/** Ordinal comparison over UTF-16 code units — F#'s `String.CompareOrdinal`. */
export const ordinal = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

/** A `(node id, slot)` pair. */
export type Slot = readonly [node: string, slot: string];

/**
 * The read/write footprint of a tree op — Fuaran Core's `Footprint` record,
 * every address an id key. See the module header for each set's role.
 */
export interface Footprint {
  readonly reads: ReadonlySet<string>;
  readonly structureWrites: ReadonlySet<string>;
  readonly contentWrites: ReadonlySet<string>;
  readonly unknownParentWrites: ReadonlySet<string>;
  /** Keyed by `slotKey`, so one pair is held once. */
  readonly slotReads: ReadonlyMap<string, Slot>;
  /** Keyed by `slotKey`, so one pair is held once. */
  readonly slotWrites: ReadonlyMap<string, Slot>;
}

const slotKey = (s: Slot): string => JSON.stringify(s);

const none: ReadonlySet<string> = new Set();
const noSlots: ReadonlyMap<string, Slot> = new Map();

/** No reads, no writes — independent of everything. */
export const emptyFootprint: Footprint = {
  reads: none,
  structureWrites: none,
  contentWrites: none,
  unknownParentWrites: none,
  slotReads: noSlots,
  slotWrites: noSlots,
};

const union = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> =>
  b.size === 0 ? a : a.size === 0 ? b : new Set([...a, ...b]);

const unionSlots = (
  a: ReadonlyMap<string, Slot>,
  b: ReadonlyMap<string, Slot>,
): ReadonlyMap<string, Slot> => (b.size === 0 ? a : a.size === 0 ? b : new Map([...a, ...b]));

/** Both footprints' addresses, kind by kind. */
export const unionFootprint = (a: Footprint, b: Footprint): Footprint => ({
  reads: union(a.reads, b.reads),
  structureWrites: union(a.structureWrites, b.structureWrites),
  contentWrites: union(a.contentWrites, b.contentWrites),
  unknownParentWrites: union(a.unknownParentWrites, b.unknownParentWrites),
  slotReads: unionSlots(a.slotReads, b.slotReads),
  slotWrites: unionSlots(a.slotWrites, b.slotWrites),
});

const footprint = (parts: Partial<Footprint>): Footprint => ({ ...emptyFootprint, ...parts });

const slots = (pairs: readonly Slot[]): ReadonlyMap<string, Slot> =>
  new Map(pairs.map((p) => [slotKey(p), p]));

// ─── walks ──────────────────────────────────────────────────────────────────

const idOf = (n: N): string => n.id as string;

/** Every id in `node`'s subtree, `node` included, through every position. */
const keyedIds = (node: N, into: Set<string> = new Set()): Set<string> => {
  into.add(idOf(node));
  for (const c of children(node, Reach.all)) keyedIds(c, into);
  return into;
};

/** The ids a list of subtree roots carries. */
const idsOf = (nodes: readonly N[]): Set<string> => {
  const acc = new Set<string>();
  for (const n of nodes) keyedIds(n, acc);
  return acc;
};

/** Every id `node` holds below itself, through every position. */
const heldIds = (node: N): Set<string> => {
  const ids = keyedIds(node);
  ids.delete(idOf(node));
  return ids;
};

/** The path from `root` to `id` over the ordered child lists, both ends included. */
const structuralPath = (root: N, id: string): readonly N[] | undefined => {
  if (idOf(root) === id) return [root];
  for (const c of children(root, Reach.structural)) {
    const p = structuralPath(c, id);
    if (p !== undefined) return [root, ...p];
  }
  return undefined;
};

const findStructural = (root: N, id: string): N | undefined => structuralPath(root, id)?.at(-1);

/** The node whose ordered child list holds `id`, preorder first. */
const structuralParentOf = (root: N, id: string): N | undefined => {
  const kids = children(root, Reach.structural);
  if (kids.some((c) => idOf(c) === id)) return root;
  for (const c of kids) {
    const p = structuralParentOf(c, id);
    if (p !== undefined) return p;
  }
  return undefined;
};

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

// ─── the pure form ──────────────────────────────────────────────────────────

/** Core's `UpdateNode` footprint: an in-place rewrite of `id` putting `incoming` in. */
const vertical = (id: string, incoming: readonly N[]): Footprint => {
  const touched = idsOf(incoming);
  touched.add(id);
  return footprint({ reads: touched, contentWrites: touched, unknownParentWrites: new Set([id]) });
};

/** The footprint of one op, computed from the op alone. Total over the union. */
export const footprintOf = (op: TreeOp<unknown>): Footprint => {
  switch (op.kind) {
    case 'InsertChild': {
      const parent = op.parentId as string;
      const inserted = keyedIds(op.child);
      return footprint({
        reads: new Set([parent, ...inserted]),
        structureWrites: new Set([parent]),
        contentWrites: inserted,
      });
    }
    case 'RemoveNode': {
      const t = op.target as string;
      return footprint({
        reads: new Set([t]),
        contentWrites: new Set([t]),
        unknownParentWrites: new Set([t]),
      });
    }
    case 'MoveNode': {
      const t = op.target as string;
      const np = op.newParentId as string;
      return footprint({
        reads: new Set([t, np]),
        structureWrites: new Set([np]),
        contentWrites: new Set([t]),
        unknownParentWrites: new Set([t]),
      });
    }
    case 'ReorderChildren': {
      const parent = op.parentId as string;
      return footprint({
        reads: new Set([parent, ...op.newOrder.map((i) => i as string)]),
        structureWrites: new Set([parent]),
      });
    }
    case 'EditNode':
    case 'UpdateState':
      return vertical(op.target as string, insertedNodes(op));
    case 'UpdateProp':
    case 'ReplaceBinding':
    case 'UpdateStyle':
    case 'PatchStyle':
    case 'UpdateAccessibility':
    case 'UpdateTooltip':
      return vertical(op.target as string, []);
    case 'ReplaceRoot': {
      const ids = keyedIds(op.node);
      const root = new Set([idOf(op.node)]);
      return footprint({
        reads: ids,
        contentWrites: ids,
        structureWrites: root,
        unknownParentWrites: root,
      });
    }
    case 'Batch':
      return op.ops.map(footprintOf).reduce(unionFootprint, emptyFootprint);
  }
};

// ─── the base-aware form ────────────────────────────────────────────────────

/** A slot-precise in-place rewrite of `target`, with every id it moves in or out. */
const slotted = (
  writes: readonly string[],
  readSlots: readonly string[],
  target: string,
  touched: ReadonlySet<string>,
): Footprint =>
  footprint({
    reads: touched,
    contentWrites: touched,
    slotReads: slots([...writes, ...readSlots].map((s) => [target, s] as const)),
    slotWrites: slots(writes.map((s) => [target, s] as const)),
  });

/** The wire member names a `PatchStyle` delta sets. */
const styleFields = (op: Extract<TreeOp<unknown>, { kind: 'PatchStyle' }>): string[] =>
  Object.entries(op.style)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);

/** The base-aware arm of one non-batch op at `state`, given the tree it reaches. */
const resolvedAt = (state: N, after: N | undefined, op: TreeOp<unknown>): Footprint => {
  // The ids an op that puts no node in moved anyway: a guard, empty for every
  // such op the engine has.
  const heldChange = (id: string, node: N): ReadonlySet<string> => {
    const before = heldIds(node);
    const later = after === undefined ? undefined : findStructural(after, id);
    if (later === undefined) return before;
    const a = heldIds(later);
    return sameSet(a, before) ? none : union(before, a);
  };

  // A vertical op is slot-precise only where the structural walk locates its
  // node and the op applies; otherwise it is the pure arm.
  const verticalAt = (id: string, arm: (node: N) => Footprint): Footprint => {
    const node = findStructural(state, id);
    return node !== undefined && after !== undefined ? arm(node) : footprintOf(op);
  };

  switch (op.kind) {
    case 'InsertChild':
    case 'ReorderChildren':
      return footprintOf(op);
    case 'RemoveNode': {
      const t = op.target as string;
      const sub = findStructural(state, t);
      const parent = sub === undefined ? undefined : structuralParentOf(state, t);
      if (sub === undefined || parent === undefined) return footprintOf(op);
      const p = idOf(parent);
      return footprint({
        reads: new Set([t, p]),
        structureWrites: new Set([p]),
        contentWrites: keyedIds(sub),
      });
    }
    case 'MoveNode': {
      const t = op.target as string;
      const np = op.newParentId as string;
      const located = findStructural(state, t) !== undefined;
      const parent = located ? structuralParentOf(state, t) : undefined;
      const destination = structuralPath(state, np);
      if (!located || parent === undefined || destination === undefined) return footprintOf(op);
      const p = idOf(parent);
      return footprint({
        reads: new Set([t, np, p, ...destination.slice(0, -1).map(idOf)]),
        structureWrites: new Set([p, np]),
        contentWrites: new Set([t]),
      });
    }
    case 'EditNode': {
      const id = op.target as string;
      return verticalAt(id, (node) => {
        const old = insertedNodes({ kind: 'EditNode', target: op.target, newKind: node.kind });
        return slotted(['kind'], [], id, union(idsOf(old), idsOf(insertedNodes(op))));
      });
    }
    case 'UpdateProp':
    case 'ReplaceBinding': {
      const id = op.target as string;
      return verticalAt(id, (node) => slotted(['kind'], [], id, heldChange(id, node)));
    }
    case 'UpdateState': {
      const id = op.target as string;
      return verticalAt(id, (node) => {
        const old = [node.state?.onLoading, node.state?.onEmpty].filter(
          (n): n is N => n !== undefined,
        );
        return slotted(['state'], [], id, union(idsOf(old), idsOf(insertedNodes(op))));
      });
    }
    case 'UpdateStyle': {
      const id = op.target as string;
      return verticalAt(id, (node) => slotted(['style'], [], id, heldChange(id, node)));
    }
    case 'UpdateAccessibility': {
      const id = op.target as string;
      return verticalAt(id, (node) => slotted(['accessibility'], [], id, heldChange(id, node)));
    }
    case 'UpdateTooltip': {
      const id = op.target as string;
      return verticalAt(id, (node) => slotted(['tooltip'], [], id, heldChange(id, node)));
    }
    case 'PatchStyle': {
      const id = op.target as string;
      return verticalAt(id, (node) =>
        slotted(
          styleFields(op).map((f) => `style.${f}`),
          ['style'],
          id,
          heldChange(id, node),
        ),
      );
    }
    case 'ReplaceRoot': {
      const plain = footprintOf(op);
      const replaced = keyedIds(state);
      return {
        ...plain,
        reads: union(plain.reads, replaced),
        contentWrites: union(plain.contentWrites, replaced),
        structureWrites: union(plain.structureWrites, new Set([idOf(state)])),
      };
    }
    case 'Batch':
      return footprintOf(op);
  }
};

const applied = (tree: N, op: TreeOp<unknown>): N | undefined => {
  const r = apply(tree, op);
  return r.ok ? r.value.newTree : undefined;
};

/** One op at the state the ops before it reached, and the state it reaches. */
const threaded = (state: N | undefined, op: TreeOp<unknown>): [Footprint, N | undefined] => {
  if (state === undefined) return [footprintOf(op), undefined];
  if (op.kind === 'Batch') {
    let acc = emptyFootprint;
    let st: N | undefined = state;
    for (const o of op.ops) {
      const [f, next] = threaded(st, o);
      acc = unionFootprint(acc, f);
      st = next;
    }
    return [acc, st];
  }
  const after = applied(state, op);
  return [resolvedAt(state, after, op), after];
};

/**
 * The footprint of one op at the tree it applies to: `footprintOf`'s address
 * kinds with every parent the pure form cannot name resolved against `state`,
 * and a located in-place edit declared at its slot. A `Batch` is threaded
 * member by member. Total; sound where `footprintOf` is and never less precise.
 */
export const footprintIn = <TMsg>(state: Node<TMsg>, op: TreeOp<TMsg>): Footprint =>
  threaded(state as N, op as TreeOp<unknown>)[0];

/** Each op of a script at the tree the ops before it reach, in order. */
export const footprintEachIn = <TMsg>(
  base: Node<TMsg>,
  ops: readonly TreeOp<TMsg>[],
): Footprint[] => {
  const out: Footprint[] = [];
  let st: N | undefined = base as N;
  for (const op of ops) {
    const [f, next] = threaded(st, op as TreeOp<unknown>);
    out.push(f);
    st = next;
  }
  return out;
};

// ─── Core's conflict report (`Dag.conflicts` / `Dag.conflictsIn`) ───────────

/**
 * How two ops collide at an address — Core's `MergeConflictShape`. A
 * `SlotClash` names the slot; its address is the node.
 */
export type OpConflictShape =
  | { readonly shape: 'ConcurrentUpdate' }
  | { readonly shape: 'InsertPositionClash' }
  | { readonly shape: 'MoveVsRemove' }
  | { readonly shape: 'SlotClash'; readonly slot: string };

/** One entry of Core's conflict report: the two ops, the address, the shape. */
export interface OpConflict<TMsg> {
  /** The op from the first delta. */
  readonly left: TreeOp<TMsg>;
  /** The op from the second delta. */
  readonly right: TreeOp<TMsg>;
  /** A node id, or a parent id for `InsertPositionClash`. */
  readonly address: string;
  readonly shape: OpConflictShape;
}

const sorted = (s: Iterable<string>): string[] => [...s].sort(ordinal);

const intersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> =>
  new Set([...a].filter((x) => b.has(x)));

const slotNodes = (s: ReadonlyMap<string, Slot>): Set<string> =>
  new Set([...s.values()].map(([node]) => node));

/** The slots one side writes and the other reads or writes — Core's `Footprint.slotClash`. */
const slotClash = (a: Footprint, b: Footprint): Slot[] => {
  const hits = new Map<string, Slot>();
  const meet = (x: ReadonlyMap<string, Slot>, y: ReadonlyMap<string, Slot>): void => {
    for (const [k, s] of x) if (y.has(k)) hits.set(k, s);
  };
  meet(a.slotWrites, b.slotWrites);
  meet(a.slotWrites, b.slotReads);
  meet(a.slotReads, b.slotWrites);
  return [...hits.values()].sort((x, y) => ordinal(x[0], y[0]) || ordinal(x[1], y[1]));
};

/** The nodes `a` accesses through a slot that `b` touches whole — Core's `slotsAgainstNode`. */
const slotsAgainstNode = (a: Footprint, b: Footprint): Set<string> => {
  const whole = union(union(b.contentWrites, b.reads), b.structureWrites);
  return new Set([
    ...intersect(slotNodes(a.slotWrites), whole),
    ...intersect(slotNodes(a.slotReads), b.contentWrites),
  ]);
};

const writesStructure = (f: Footprint): boolean =>
  f.structureWrites.size > 0 || f.unknownParentWrites.size > 0;

/**
 * Core's `Dag.conflicts`: every op pair `(a ∈ left, b ∈ right)` whose footprints
 * are not independent, one entry per address by shape priority (content, then
 * position, then move/remove), plus one per clashing slot. Left order × right
 * order × ordinal addresses. Detection only.
 */
const conflictsOver = <Op>(
  left: readonly (readonly [Op, Footprint])[],
  right: readonly (readonly [Op, Footprint])[],
): { left: Op; right: Op; address: string; shape: OpConflictShape }[] => {
  const out: { left: Op; right: Op; address: string; shape: OpConflictShape }[] = [];
  for (const [a, fa] of left) {
    for (const [b, fb] of right) {
      const c1 = new Set([
        ...intersect(fa.contentWrites, fb.contentWrites),
        ...intersect(fa.contentWrites, fb.reads),
        ...intersect(fb.contentWrites, fa.reads),
        ...slotsAgainstNode(fa, fb),
        ...slotsAgainstNode(fb, fa),
      ]);
      const c2 = [...intersect(fa.structureWrites, fb.structureWrites)].filter((x) => !c1.has(x));
      const moveRemove = new Set([
        ...(fa.unknownParentWrites.size > 0 && writesStructure(fb) ? fa.unknownParentWrites : none),
        ...(fb.unknownParentWrites.size > 0 && writesStructure(fa) ? fb.unknownParentWrites : none),
      ]);
      const c2s = new Set(c2);
      const c3 = [...moveRemove].filter((x) => !c1.has(x) && !c2s.has(x));
      for (const address of sorted(c1))
        out.push({ left: a, right: b, address, shape: { shape: 'ConcurrentUpdate' } });
      for (const address of sorted(c2))
        out.push({ left: a, right: b, address, shape: { shape: 'InsertPositionClash' } });
      for (const address of sorted(c3))
        out.push({ left: a, right: b, address, shape: { shape: 'MoveVsRemove' } });
      for (const [address, slot] of slotClash(fa, fb))
        out.push({ left: a, right: b, address, shape: { shape: 'SlotClash', slot } });
    }
  }
  return out;
};

/** Each op of a delta with its footprint at the state the ops before it reach;
 * an op that does not apply leaves the state where it was, as Core's does. */
const threadDelta = <TMsg>(
  base: Node<TMsg>,
  delta: readonly TreeOp<TMsg>[],
): (readonly [TreeOp<TMsg>, Footprint])[] => {
  let st = base as N;
  return delta.map((op) => {
    const f = footprintIn(st, op as TreeOp<unknown>);
    st = applied(st, op as TreeOp<unknown>) ?? st;
    return [op, f] as const;
  });
};

/**
 * Core's `Dag.conflictsIn` over the base-aware footprint: each delta threaded
 * through `apply` from `base`, and the report `conflictsOver` the footprints so
 * computed. `[]` promises the two deltas commute from `base`.
 */
export const conflictsIn = <TMsg>(
  base: Node<TMsg>,
  deltaA: readonly TreeOp<TMsg>[],
  deltaB: readonly TreeOp<TMsg>[],
): OpConflict<TMsg>[] => conflictsOver(threadDelta(base, deltaA), threadDelta(base, deltaB));
