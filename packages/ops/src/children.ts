// ============================================================================
//  @fuaran-ui/ops — what a node's children are.
//
//  The ONE enumeration of the parent/child relation in this host, with the
//  reach a caller wants stated rather than re-derived. The relation used to be
//  written by hand in every walker that needed it, and the copies disagreed:
//  the apply engine's walk reached `state.onLoading` / `state.onEmpty` and the
//  introspection walk did not, so a node under `onEmpty` was found by one
//  `findNode` and not the other; the renderers' fragment collectors stopped at
//  the kind, so a `FragmentDecl` inside `onLoading` was never registered and
//  its references rendered the unresolved placeholder; and fragment
//  namespacing did not descend into the state alternatives, so two references
//  to one fragment emitted duplicate ids there.
//
//  So this module names the questions. Every position a node holds another
//  node in has a CLASS (`Position`), and a caller asks for the classes it means
//  (`Reach`). The switch in `held` below is the only place a `NodeKind` is
//  taken apart to find its children.
// ============================================================================

import type { FragmentArg, LayoutKind, Node, NodeKind } from '@fuaran-ui/schema';

/**
 * The kind of place one node holds another in.
 *
 * - `Ordered` — a layout's ordered `children` list. The surface the structural
 *   ops (InsertChild / RemoveChild / MoveNode / ReorderChildren) edit.
 * - `Arm` — a node the KIND holds in a named arm: `ErrorBoundary.child` /
 *   `.fallback`, every `Switch` case child and its default, a `FragmentDecl`
 *   body.
 * - `StateArm` — the envelope's `state.onLoading` / `state.onEmpty`, which
 *   render INSTEAD of the node.
 * - `Fallback` — the envelope's author-declared `fallback`, which a reader that
 *   cannot render the node renders instead.
 * - `Argument` — a subtree passed as an argument: a `FragmentRef`'s slot
 *   arguments and a `Mount`'s slot inputs.
 */
export type Position = 'Ordered' | 'Arm' | 'StateArm' | 'Fallback' | 'Argument';

/** The position classes a walk descends through. */
export type Reach = ReadonlySet<Position>;

const reachOf = (...positions: Position[]): Reach => new Set(positions);

/** The named reaches. A walk passes one explicitly; there is no default. */
export const Reach = {
  /** The ordered child lists alone — what the structural ops edit. */
  structural: reachOf('Ordered'),
  /**
   * Every node the node's own KIND holds: the ordered lists plus the arms. The
   * tree as the vocabulary shapes it; it leaves out the envelope alternatives
   * (which render instead of the node) and slot arguments (which belong to the
   * scope they are passed into).
   */
  kindHeld: reachOf('Ordered', 'Arm'),
  /**
   * The kind-held positions plus the two `state` alternatives: the surface node
   * lookup, the apply engine's id checks, the clone remap and the renderers'
   * fragment collection and namespacing descend through. The envelope
   * `fallback` and slot arguments are outside it; that boundary is stated here
   * once rather than in each walker.
   */
  lookup: reachOf('Ordered', 'Arm', 'StateArm'),
  /** Every position a node holds another node in. */
  all: reachOf('Ordered', 'Arm', 'StateArm', 'Fallback', 'Argument'),
} as const;

interface Held<TMsg> {
  readonly positions: readonly Position[];
  readonly nodes: readonly Node<TMsg>[];
  /** Rebuild the node from a same-length replacement for `nodes`. */
  readonly rebuild: (nodes: readonly Node<TMsg>[]) => Node<TMsg>;
}

// A hand-built tree may omit an empty argument bag; it holds no slot then.
const slotArgs = <TMsg>(
  bag: Readonly<Record<string, FragmentArg<TMsg>>> | undefined,
): readonly (readonly [string, Node<TMsg>])[] =>
  Object.entries(bag ?? {}).flatMap(([k, a]) => (a.kind === 'slot' ? [[k, a.tree] as const] : []));

const putSlotArgs = <TMsg>(
  bag: Readonly<Record<string, FragmentArg<TMsg>>>,
  replaced: ReadonlyMap<string, Node<TMsg>>,
): Readonly<Record<string, FragmentArg<TMsg>>> =>
  Object.fromEntries(
    Object.entries(bag).map(([k, a]) => {
      const tree = replaced.get(k);
      return [k, a.kind === 'slot' && tree !== undefined ? { ...a, tree } : a];
    }),
  );

/** What the KIND holds, in order, and how to rebuild the kind around replacements. */
const kindHeld = <TMsg>(
  k: NodeKind<TMsg>,
): {
  readonly positions: readonly Position[];
  readonly nodes: readonly Node<TMsg>[];
  readonly rebuild: (nodes: readonly Node<TMsg>[]) => NodeKind<TMsg>;
} => {
  switch (k.kind) {
    case 'Layout':
      return {
        positions: k.layout.spec.children.map(() => 'Ordered' as const),
        nodes: k.layout.spec.children,
        rebuild: (cs) => withOrderedChildren(k, cs),
      };
    case 'ErrorBoundary':
      return {
        positions: ['Arm', 'Arm'],
        nodes: [k.spec.child, k.spec.fallback],
        rebuild: ([child, fallback]) => ({
          kind: 'ErrorBoundary',
          spec: { ...k.spec, child: child!, fallback: fallback! },
        }),
      };
    case 'Switch': {
      const cases = k.spec.cases;
      return {
        positions: [...cases.map(() => 'Arm' as const), 'Arm'],
        nodes: [...cases.map((c) => c.child), k.spec.default],
        // The whole case is carried through and only the child is rewritten, so
        // `match` / `when` survive a rebuild.
        rebuild: (cs) => ({
          kind: 'Switch',
          spec: {
            ...k.spec,
            cases: cases.map((c, i) => ({ ...c, child: cs[i]! })),
            default: cs[cases.length]!,
          },
        }),
      };
    }
    case 'FragmentDecl':
      return {
        positions: ['Arm'],
        nodes: [k.spec.body],
        rebuild: ([body]) => ({ kind: 'FragmentDecl', spec: { ...k.spec, body: body! } }),
      };
    case 'FragmentRef': {
      const held = slotArgs(k.spec.args);
      return {
        positions: held.map(() => 'Argument' as const),
        nodes: held.map(([, n]) => n),
        rebuild: (cs) => ({
          kind: 'FragmentRef',
          spec: {
            ...k.spec,
            args: putSlotArgs(k.spec.args, new Map(held.map(([key], i) => [key, cs[i]!]))),
          },
        }),
      };
    }
    case 'Mount': {
      const held = slotArgs(k.spec.inputs);
      return {
        positions: held.map(() => 'Argument' as const),
        nodes: held.map(([, n]) => n),
        rebuild: (cs) => ({
          kind: 'Mount',
          spec: {
            ...k.spec,
            inputs: putSlotArgs(k.spec.inputs, new Map(held.map(([key], i) => [key, cs[i]!]))),
          },
        }),
      };
    }
    default:
      return { positions: [], nodes: [], rebuild: () => k };
  }
};

/** Every position `n` holds another node in — kind first, then the envelope. */
const held = <TMsg>(n: Node<TMsg>): Held<TMsg> => {
  const kind = kindHeld(n.kind);
  const positions: Position[] = [...kind.positions];
  const nodes: Node<TMsg>[] = [...kind.nodes];
  const { onLoading, onEmpty } = n.state;
  if (onLoading !== undefined) {
    positions.push('StateArm');
    nodes.push(onLoading);
  }
  if (onEmpty !== undefined) {
    positions.push('StateArm');
    nodes.push(onEmpty);
  }
  if (n.fallback !== undefined) {
    positions.push('Fallback');
    nodes.push(n.fallback);
  }
  const kindCount = kind.nodes.length;
  return {
    positions,
    nodes,
    rebuild: (cs) => {
      let i = kindCount;
      const nextLoading = onLoading === undefined ? undefined : cs[i++]!;
      const nextEmpty = onEmpty === undefined ? undefined : cs[i++]!;
      const nextFallback = n.fallback === undefined ? undefined : cs[i++]!;
      const sameState = nextLoading === onLoading && nextEmpty === onEmpty;
      return {
        ...n,
        kind: kind.rebuild(cs.slice(0, kindCount)),
        ...(sameState
          ? {}
          : {
              state: {
                ...n.state,
                ...(nextLoading === undefined ? {} : { onLoading: nextLoading }),
                ...(nextEmpty === undefined ? {} : { onEmpty: nextEmpty }),
              },
            }),
        ...(nextFallback === undefined ? {} : { fallback: nextFallback }),
      };
    },
  };
};

/**
 * The layout kind with its ordered `children` list replaced; any other kind is
 * returned unchanged (it has no ordered list). The per-layout spec is a
 * discriminated union whose children-bearing shape is uniform, so the cast is
 * sound.
 */
export const withOrderedChildren = <TMsg>(
  k: NodeKind<TMsg>,
  children: readonly Node<TMsg>[],
): NodeKind<TMsg> => {
  if (k.kind !== 'Layout') return k;
  const layout = { ...k.layout, spec: { ...k.layout.spec, children } } as LayoutKind<TMsg>;
  return { kind: 'Layout', layout };
};

/**
 * The ordered child list of `n`, or `undefined` when its kind has none — the
 * distinction the structural ops' `ChildlessKind` refusal rests on.
 */
export const orderedChildren = <TMsg>(n: Node<TMsg>): readonly Node<TMsg>[] | undefined =>
  n.kind.kind === 'Layout' ? n.kind.layout.spec.children : undefined;

/** The immediate children of `node` within `reach`, in enumeration order. */
export const children = <TMsg>(node: Node<TMsg>, reach: Reach): readonly Node<TMsg>[] => {
  const h = held(node);
  return h.nodes.filter((_, i) => reach.has(h.positions[i]!));
};

/**
 * Rebuild `node` with every immediate child within `reach` replaced by `f` of
 * it. The positions are enumerated once per call; when `f` returns every child
 * unchanged (by reference) the input node itself is returned.
 */
export const mapChildren = <TMsg>(
  node: Node<TMsg>,
  reach: Reach,
  f: (child: Node<TMsg>) => Node<TMsg>,
): Node<TMsg> => {
  const h = held(node);
  let changed = false;
  const next = h.nodes.map((c, i) => {
    if (!reach.has(h.positions[i]!)) return c;
    const m = f(c);
    if (m !== c) changed = true;
    return m;
  });
  return changed ? h.rebuild(next) : node;
};

/**
 * The first node with `id` in `tree` (depth-first, root first), searching the
 * `Reach.lookup` positions — the surface the apply engine's id checks run on —
 * or `undefined`.
 */
export const findNode = <TMsg>(tree: Node<TMsg>, id: string): Node<TMsg> | undefined => {
  if ((tree.id as string) === id) return tree;
  for (const c of children(tree, Reach.lookup)) {
    const r = findNode(c, id);
    if (r !== undefined) return r;
  }
  return undefined;
};
