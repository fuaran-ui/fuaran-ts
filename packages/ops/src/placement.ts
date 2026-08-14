// ============================================================================
//  @fuaran-ui/ops — placement algebra: placed insert / move / nudge, and the
//  clone verbs (duplicate / paste) built on top of them.
//
//  Port of the F# `Fuaran.UI.Ops.Placement` module — behavioural parity, same
//  verdicts, same emitted op shapes.
//
//  The op vocabulary is deliberately positionless: `InsertChild` and `MoveNode`
//  append, and an explicit order is stated only by `ReorderChildren` naming
//  every sibling id (an id is checkable; an ordinal is not). Placing a node
//  anywhere but last is therefore `Batch [InsertChild|MoveNode,
//  ReorderChildren]` — correct, but it leaves every consumer deriving the full
//  sibling permutation itself. This module ships that derivation once, purely
//  additively: every helper emits ops built from the EXISTING vocabulary
//  (`InsertChild` / `MoveNode` / `ReorderChildren` / `Batch`), so the wire
//  format, the apply engine, and the node contract are untouched — and the
//  reorder leg is dropped whenever appending already yields the wanted order,
//  keeping the common case a single bare op.
//
//  Pre-checks mirror the apply engine's own rejections (childless kind,
//  move-into-self, move-into-descendant, duplicate id) so an editor can grey
//  out an illegal drop without a dry-run apply — with one deliberate
//  tightening: an anchor that is not among the destination's post-op children
//  is REFUSED (`UnknownAnchor`) rather than silently appended. The only op
//  that could honour such an anchor would be a `ReorderChildren` naming it,
//  which the apply engine refuses as `OrderingMismatch`; saying so before
//  emission is friendlier than a rejection after it.
//
//  The clone verbs rewrite a copied subtree's ids to a fresh, collision-free
//  set before `InsertChild`. The remap runs over the WHOLE traversal surface —
//  the apply engine's own `childSlots` walker, not just the structural child
//  lists — because the id-uniqueness contract is tree-wide, and a clone that
//  kept an old id inside a Switch case or an ErrorBoundary slot would smuggle
//  a duplicate past it.
// ============================================================================

import type { Node, NodeId, Result } from '@fuaran-ui/schema';

import {
  allNodeIds,
  childSlots,
  findLayoutParent,
  findNode,
  isAncestor,
  layoutChildren,
} from './apply.js';
import type { TreeOp } from './treeOp.js';

// ─── Placement vocabulary ────────────────────────────────────────────────────

/**
 * Where a node should sit among its destination siblings, stated the only way
 * the op vocabulary allows: by naming an existing sibling, or an end.
 */
export type Placement =
  /** Append — what `InsertChild` / `MoveNode` do on their own. */
  | { readonly kind: 'Last' }
  /** Prepend — before every current sibling. */
  | { readonly kind: 'First' }
  /** Immediately before the named sibling. */
  | { readonly kind: 'Before'; readonly anchor: NodeId }
  /** Immediately after the named sibling. */
  | { readonly kind: 'After'; readonly anchor: NodeId };

/** A structural destination: which parent, and where among its children. */
export interface PlaceTarget {
  readonly parentId: NodeId;
  readonly placement: Placement;
}

/**
 * Why a placement could not become an op. Each case is a pre-statement of the
 * apply-time refusal the emitted op would have met, so a helper rejection and
 * an apply rejection agree — no false permit, no false refuse.
 */
export type PlaceError =
  /** The destination parent is not in the tree (apply: `ParentNotFound`). */
  | { readonly kind: 'ParentNotFound'; readonly parentId: NodeId }
  /** The destination parent's kind has no children field (apply: `ChildlessKind`). */
  | { readonly kind: 'ChildlessKind'; readonly parentId: NodeId }
  /**
   * The node to move / nudge / duplicate is not structurally addressable
   * (absent, or held in a non-structural position the structural ops cannot
   * reach) — apply: `NodeNotFound`.
   */
  | { readonly kind: 'NodeNotFound'; readonly nodeId: NodeId }
  /**
   * The placement anchor is not among the destination's post-op children. The
   * only op that could honour it — a `ReorderChildren` naming it — is refused
   * by the apply engine as `OrderingMismatch`.
   */
  | { readonly kind: 'UnknownAnchor'; readonly anchor: NodeId }
  /**
   * The subtree being inserted carries an id already present in the tree
   * (apply: `DuplicateNodeId`).
   */
  | { readonly kind: 'DuplicateId'; readonly nodeId: NodeId }
  /** The node would become its own parent (apply: `KindMismatch`). */
  | { readonly kind: 'MoveIntoSelf'; readonly nodeId: NodeId }
  /**
   * The destination sits inside the node's own subtree — a cycle (apply:
   * `KindMismatch`).
   */
  | { readonly kind: 'MoveIntoDescendant'; readonly nodeId: NodeId; readonly parentId: NodeId }
  /** The root has no siblings to nudge among. */
  | { readonly kind: 'CannotNudgeRoot'; readonly nodeId: NodeId }
  /** The nudge would leave the sibling range (already first / already last). */
  | { readonly kind: 'NudgeOutOfRange'; readonly nodeId: NodeId; readonly delta: number };

// ─── Fresh-id strategy (the clone verbs' id-minting seam) ────────────────────

/**
 * How the clone verbs mint replacement ids: given the id being replaced and a
 * predicate over every id already claimed (the whole target tree, the whole
 * incoming subtree, and ids minted earlier in the same remap), return an id
 * the predicate refuses. Injectable so a host with its own id discipline can
 * supply it; `derivedFreshIds` is the default.
 */
export type FreshIds = (oldId: string, taken: (candidate: string) => boolean) => string;

/**
 * The default strategy: `<oldId>-copy`, then `<oldId>-copy-2`, `-copy-3`, … —
 * the first candidate not already taken. Deterministic (derived from the id it
 * replaces, no ambient state) and collision-free by probing.
 */
export const derivedFreshIds: FreshIds = (oldId, taken) => {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? `${oldId}-copy` : `${oldId}-copy-${n}`;
    if (!taken(candidate)) return candidate;
  }
};

/**
 * Sequential ids under a fixed prefix (`<prefix>-1`, `-2`, …) — the
 * deterministic-replay option: the minted sequence depends only on the prefix
 * and the order of requests, never on the ids being replaced. Each call to
 * `sequentialFreshIds` starts its own counter.
 */
export const sequentialFreshIds = (prefix: string): FreshIds => {
  let counter = 0;
  return (_oldId, taken) => {
    for (;;) {
      counter += 1;
      const candidate = `${prefix}-${counter}`;
      if (!taken(candidate)) return candidate;
    }
  };
};

// ─── Internals ───────────────────────────────────────────────────────────────

type N = Node<unknown>;

const ok = <T>(value: T): Result<T, PlaceError> => ({ ok: true, value });
const err = <T>(error: PlaceError): Result<T, PlaceError> => ({ ok: false, error });

const idOf = (n: N): NodeId => n.id;

const sameOrder = (a: readonly NodeId[], b: readonly NodeId[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The destination's current child ids, or the mirrored apply-side refusal
 * (absent parent / childless kind).
 */
const containerChildren = (root: N, parentId: NodeId): Result<readonly NodeId[], PlaceError> => {
  const parent = findNode(parentId as string, root);
  if (parent === undefined) return err({ kind: 'ParentNotFound', parentId });
  const children = layoutChildren(parent);
  if (children === undefined) return err({ kind: 'ChildlessKind', parentId });
  return ok(children.map(idOf));
};

/**
 * Place `moved` within `order` (which already contains it) per `placement`.
 * An anchor that is not in the list is refused — the honest alternative
 * (silently appending) would emit an op that does not honour the caller's
 * stated intent.
 */
const reposition = (
  order: readonly NodeId[],
  moved: NodeId,
  placement: Placement,
): Result<readonly NodeId[], PlaceError> => {
  const rest = order.filter((id) => id !== moved);
  const anchored = (anchor: NodeId, offset: number): Result<readonly NodeId[], PlaceError> => {
    const i = rest.findIndex((id) => id === anchor);
    if (i < 0) return err({ kind: 'UnknownAnchor', anchor });
    const at = i + offset;
    return ok([...rest.slice(0, at), moved, ...rest.slice(at)]);
  };
  switch (placement.kind) {
    case 'Last':
      return ok([...rest, moved]);
    case 'First':
      return ok([moved, ...rest]);
    case 'Before':
      return anchored(placement.anchor, 0);
    case 'After':
      return anchored(placement.anchor, 1);
  }
};

/**
 * Whether `nodeId` is addressable by the structural ops: the root, or a node
 * reachable through a layout children list. A node held in a non-structural
 * position (a Switch case, an ErrorBoundary slot, a State placeholder) is
 * visible to traversal but not movable, and the apply engine refuses ops
 * against it as `NodeNotFound`.
 */
const structurallyPresent = (nodeId: NodeId, root: N): boolean =>
  idOf(root) === nodeId || findLayoutParent(nodeId as string, root) !== undefined;

/** The first id present in both trees, if any — the pre-insert duplicate check. */
const firstSharedId = (root: N, incoming: N): NodeId | undefined => {
  const existing = new Set(allNodeIds(root));
  return allNodeIds(incoming).find((id) => existing.has(id)) as NodeId | undefined;
};

// ─── The verbs ───────────────────────────────────────────────────────────────

/**
 * Whether `moved` may legally take up residence at `target` — the pre-check an
 * editor uses to grey out an illegal drop without a dry-run apply. Mirrors the
 * apply engine's rejections: absent node, move into itself, move into its own
 * descendant (a cycle), absent or childless destination, unknown anchor.
 */
export const canPlace = <TMsg>(
  root: Node<TMsg>,
  moved: NodeId,
  target: PlaceTarget,
): Result<void, PlaceError> => {
  const r = root as N;
  if (!structurallyPresent(moved, r)) return err({ kind: 'NodeNotFound', nodeId: moved });
  if (target.parentId === moved) return err({ kind: 'MoveIntoSelf', nodeId: moved });
  if (isAncestor(moved as string, target.parentId as string, r))
    return err({ kind: 'MoveIntoDescendant', nodeId: moved, parentId: target.parentId });
  const siblings = containerChildren(r, target.parentId);
  if (!siblings.ok) return siblings;
  const membership = [...siblings.value.filter((id) => id !== moved), moved];
  const placed = reposition(membership, moved, target.placement);
  return placed.ok ? ok(undefined) : placed;
};

/**
 * The op an insertion becomes. `InsertChild` appends, so the wanted order is
 * computed over the post-insert membership and stated by `ReorderChildren`
 * naming every sibling id; the reorder leg is dropped when appending already
 * produces that order.
 */
export const placeOp = <TMsg>(
  root: Node<TMsg>,
  child: Node<TMsg>,
  target: PlaceTarget,
): Result<TreeOp<TMsg>, PlaceError> => {
  const r = root as N;
  const siblings = containerChildren(r, target.parentId);
  if (!siblings.ok) return siblings;
  const dup = firstSharedId(r, child as N);
  if (dup !== undefined) return err({ kind: 'DuplicateId', nodeId: dup });
  const childId = idOf(child as N);
  const appended = [...siblings.value, childId];
  const wanted = reposition(appended, childId, target.placement);
  if (!wanted.ok) return wanted;
  const insert: TreeOp<TMsg> = { kind: 'InsertChild', parentId: target.parentId, child };
  return ok(
    sameOrder(wanted.value, appended)
      ? insert
      : {
          kind: 'Batch',
          ops: [
            insert,
            { kind: 'ReorderChildren', parentId: target.parentId, newOrder: wanted.value },
          ],
        },
  );
};

/**
 * The op a move becomes. `MoveNode` appends under the new parent, and the node
 * may already be one of that parent's children (a re-placement within one
 * parent), so the post-move membership is the siblings WITHOUT it plus it.
 */
export const moveOp = <TMsg>(
  root: Node<TMsg>,
  moved: NodeId,
  target: PlaceTarget,
): Result<TreeOp<TMsg>, PlaceError> => {
  const legal = canPlace(root, moved, target);
  if (!legal.ok) return legal;
  const siblings = containerChildren(root as N, target.parentId);
  if (!siblings.ok) return siblings;
  const appended = [...siblings.value.filter((id) => id !== moved), moved];
  const wanted = reposition(appended, moved, target.placement);
  if (!wanted.ok) return wanted;
  const move: TreeOp<TMsg> = { kind: 'MoveNode', target: moved, newParentId: target.parentId };
  return ok(
    sameOrder(wanted.value, appended)
      ? move
      : {
          kind: 'Batch',
          ops: [
            move,
            { kind: 'ReorderChildren', parentId: target.parentId, newOrder: wanted.value },
          ],
        },
  );
};

/**
 * The op a keyboard move-up (`-1`) / move-down (`+1`) becomes: the node
 * swapped with the sibling `delta` positions away, stated as the FULL sibling
 * id order (which is what `ReorderChildren` requires — a partial list is
 * refused by the apply engine, and rightly, since a partial order is not one).
 */
export const nudgeOp = <TMsg>(
  root: Node<TMsg>,
  nodeId: NodeId,
  delta: number,
): Result<TreeOp<TMsg>, PlaceError> => {
  const r = root as N;
  if (idOf(r) === nodeId) return err({ kind: 'CannotNudgeRoot', nodeId });
  const parent = findLayoutParent(nodeId as string, r);
  if (parent === undefined) return err({ kind: 'NodeNotFound', nodeId });
  const ids = (layoutChildren(parent) ?? []).map(idOf);
  const index = ids.findIndex((id) => id === nodeId);
  const swapWith = index + delta;
  if (swapWith < 0 || swapWith >= ids.length)
    return err({ kind: 'NudgeOutOfRange', nodeId, delta });
  const reordered = ids.map((id, i) =>
    i === index ? ids[swapWith]! : i === swapWith ? ids[index]! : id,
  );
  return ok({ kind: 'ReorderChildren', parentId: idOf(parent), newOrder: reordered });
};

// ─── Clone verbs ─────────────────────────────────────────────────────────────

/**
 * Rebuild every immediate sub-node position of `n` (the whole traversal
 * surface — layout children AND the non-structural slots) through `f`. Slots
 * are re-read after each rebuild so successive replacements compose.
 */
const mapImmediate = (n: N, f: (c: N) => N): N => {
  let cur = n;
  const count = childSlots(n).length;
  for (let i = 0; i < count; i += 1) {
    const slot = childSlots(cur)[i]!;
    const mapped = f(slot.child);
    if (mapped !== slot.child) cur = slot.rebuild(mapped);
  }
  return cur;
};

/**
 * Rewrite every id in `incoming` that collides with an id in `targetRoot` to a
 * fresh, collision-free one. Ids with no collision are preserved — a pasted
 * subtree keeps its identity where it can; a subtree duplicated within its own
 * tree remaps every id, since every one collides.
 */
const remapForInsert = (freshIds: FreshIds, targetRoot: N, incoming: N): N => {
  const existing = new Set(allNodeIds(targetRoot));
  // Fresh ids must also dodge the incoming subtree's own ids (a minted id
  // colliding with a not-yet-visited incoming node would re-introduce the
  // duplicate the remap exists to remove) and each other.
  const taken = new Set([...existing, ...allNodeIds(incoming)]);
  const rename = new Map<string, string>();
  for (const oldId of allNodeIds(incoming)) {
    if (existing.has(oldId)) {
      const fresh = freshIds(oldId, (candidate) => taken.has(candidate));
      taken.add(fresh);
      rename.set(oldId, fresh);
    }
  }
  if (rename.size === 0) return incoming;
  const rewrite = (node: N): N => {
    const withChildren = mapImmediate(node, rewrite);
    const fresh = rename.get(withChildren.id as string);
    return fresh === undefined ? withChildren : { ...withChildren, id: fresh as NodeId };
  };
  return rewrite(incoming);
};

/**
 * Duplicate the subtree rooted at `source` and place the clone at `target`,
 * minting replacement ids with `freshIds`. The emitted op is an ordinary
 * placed insert — the clone is a fresh subtree, so the standard apply gate
 * (including the tree-wide duplicate-id check) accepts it unchanged.
 */
export const duplicateOpWith = <TMsg>(
  freshIds: FreshIds,
  root: Node<TMsg>,
  source: NodeId,
  target: PlaceTarget,
): Result<TreeOp<TMsg>, PlaceError> => {
  const r = root as N;
  const sub = findNode(source as string, r);
  if (sub === undefined) return err({ kind: 'NodeNotFound', nodeId: source });
  return placeOp(root, remapForInsert(freshIds, r, sub) as Node<TMsg>, target);
};

/** `duplicateOpWith` under the default derived-suffix id strategy. */
export const duplicateOp = <TMsg>(
  root: Node<TMsg>,
  source: NodeId,
  target: PlaceTarget,
): Result<TreeOp<TMsg>, PlaceError> => duplicateOpWith(derivedFreshIds, root, source, target);

/**
 * Place a subtree lifted from a DIFFERENT tree into `targetRoot`, remapping
 * any id that collides with one already present (ids with no collision are
 * preserved). The incoming subtree's ids must be unique within itself — a
 * subtree extracted from any well-formed tree is.
 */
export const pasteOpWith = <TMsg>(
  freshIds: FreshIds,
  targetRoot: Node<TMsg>,
  incoming: Node<TMsg>,
  target: PlaceTarget,
): Result<TreeOp<TMsg>, PlaceError> =>
  placeOp(
    targetRoot,
    remapForInsert(freshIds, targetRoot as N, incoming as N) as Node<TMsg>,
    target,
  );

/** `pasteOpWith` under the default derived-suffix id strategy. */
export const pasteOp = <TMsg>(
  targetRoot: Node<TMsg>,
  incoming: Node<TMsg>,
  target: PlaceTarget,
): Result<TreeOp<TMsg>, PlaceError> => pasteOpWith(derivedFreshIds, targetRoot, incoming, target);
