// ============================================================================
//  @fuaran-ui/ai-tools — runtime tree-introspection surface.
//
//  The read-only subset of Fuaran.UI.AiTools: walk a typed Node<TMsg> tree and
//  report each node's kind, its bound binding slots (with the canonical
//  wire-form expression), and its children. Useful for TS-host AI tooling (an
//  orchestrator analogue that needs to inspect the current tree to feed the
//  model) and for dev tooling (a React-DevTools-style panel over the typed
//  Fuaran shape rather than the raw React tree).
//
//  The F# AiTools tier additionally resolves binding *values* against live
//  BindingSources and probes renderer geometry / current-state via host seams.
//  Those need the renderer's live resolution context, so this package ships the
//  source-side static surface — kind, binding-slot expressions, structure —
//  which is self-contained and matches the F# tier's shapes (kindName, the
//  per-kind binding-slot table, and the `$state.<key>` / `$queries.<name>` /
//  … expression forms) for the same fixture tree.
// ============================================================================

import type { Binding, Node, NodeKind } from '@fuaran-ui/schema';

/**
 * Which `Binding` case a slot came from — port of F# `BindingSource`. `Local`
 * and `Format` resolve to `Computed` (matching the F# tier), distinguished by
 * their distinct `expression`.
 */
export type BindingSource =
  | 'Static'
  | 'Query'
  | 'Filter'
  | 'Selection'
  | 'State'
  | 'Computed'
  | 'I18n';

/** One bound binding slot on a node — the slot name + its wire-form expression. */
export interface BindingSlotInfo {
  /** The slot name (e.g. `Source`, `ActiveIndex`, `Disabled`) — matches the F# table. */
  readonly slot: string;
  /** Canonical wire-form expression (`$state.<key>`, `$queries.<name>`, …). */
  readonly expression: string;
  /** Which `Binding` case produced the slot. */
  readonly source: BindingSource;
}

/** The per-node introspection envelope — port of the self-contained subset of F# `NodeState`. */
export interface NodeIntrospection {
  readonly id: string;
  /** The wire discriminator string — matches F# `Introspect.kindName`. */
  readonly kind: string;
  /** The node's bound binding slots, in the F# `extractBindings` order. */
  readonly bindings: readonly BindingSlotInfo[];
  /** Ids of the node's structural children (layout children / boundary arms / fragment body). */
  readonly childIds: readonly string[];
}

/** A recursive structural snapshot of a whole tree. */
export interface TreeIntrospection extends NodeIntrospection {
  readonly children: readonly TreeIntrospection[];
}

// ─── kindName — the wire discriminator (port of F# Introspect.kindName) ───────

/**
 * The kind discriminator string for a node, matching F# `Introspect.kindName`
 * (`Kind.name`): the in-memory case name verbatim. The unified layout container
 * (Phase 390) tags as `"Box"` regardless of role/layout; the Visualisation grid
 * tags as `"Grid"` (the F# `kindName` returns `"Grid"` for the data grid even
 * though its wire discriminator is `DataGrid`).
 */
export const kindName = (kind: NodeKind<unknown>): string => {
  switch (kind.kind) {
    case 'Layout':
      return kind.layout.kind;
    case 'Display':
      return kind.display.kind;
    case 'Input':
      return kind.input.kind;
    case 'Visualisation':
      return kind.visualisation.kind; // 'Grid' | 'Chart' | 'Table' | 'Map'
    case 'Custom':
      return 'Custom';
    case 'ErrorBoundary':
      return 'ErrorBoundary';
    case 'Switch':
      return 'Switch';
    case 'FragmentDecl':
      return 'FragmentDecl';
    case 'FragmentRef':
      return 'FragmentRef';
    case 'Mount':
      return 'Mount';
  }
};

// ─── Binding-expression mapping (port of F# BindingProbe.identify) ────────────

/** Classify a binding into its `(source, expression)` — port of F# `identify`. */
export const bindingExpression = <T>(
  binding: Binding<T>,
): { source: BindingSource; expression: string } => {
  switch (binding.kind) {
    case 'Static':
      return { source: 'Static', expression: '$static' };
    case 'Query':
      return { source: 'Query', expression: `$queries.${binding.name}` };
    case 'Filter':
      return { source: 'Filter', expression: `$filters.${binding.name}` };
    case 'Selection':
      return { source: 'Selection', expression: `$selection.${binding.nodeId}` };
    case 'State':
      return { source: 'State', expression: `$state.${binding.key}` };
    case 'Computed':
      return { source: 'Computed', expression: '$computed' };
    case 'I18n':
      return { source: 'I18n', expression: `$i18n.${binding.key}` };
    case 'Local':
      // F# maps Local → BindingSource.Computed with a distinct "$local" expression.
      return { source: 'Computed', expression: '$local' };
    case 'Format':
      return { source: 'Computed', expression: '$format' };
    case 'Transform':
      // Phase 282 — a declarative dataframe pipeline evaluated as data; labelled
      // distinctly ($transform) so the orchestrator knows the field is computed.
      return { source: 'Computed', expression: '$transform' };
    case 'Invoke':
      // Phase 283 — a host-registered capability dispatched for a value.
      return { source: 'Computed', expression: '$invoke' };
  }
};

const slot = <T>(name: string, binding: Binding<T>): BindingSlotInfo => {
  const { source, expression } = bindingExpression(binding);
  return { slot: name, expression, source };
};

// ─── Per-NodeKind binding-slot extraction (port of F# extractBindings) ────────

/**
 * The bound binding slots a node carries, in the F# `extractBindings` order.
 * Optional slots (Metric.Trend, Tabs.ActiveTag, Button/Select/Form/FileUpload
 * Disabled) appear only when present, matching the F# table the Phase 118
 * consistency test pins.
 */
export const extractBindingSlots = (kind: NodeKind<unknown>): BindingSlotInfo[] => {
  if (kind.kind === 'Display') {
    const d = kind.display;
    switch (d.kind) {
      case 'Metric': {
        const slots = [slot('Value', d.spec.value)];
        if (d.spec.trend !== undefined) slots.push(slot('Trend', d.spec.trend));
        return slots;
      }
      case 'Sparkline':
        return [slot('Source', d.spec.source)];
      case 'Progress':
        return [slot('Fraction', d.spec.fraction)];
      case 'LabelValueRow':
        return [slot('Value', d.spec.value)];
      default:
        return [];
    }
  }
  if (kind.kind === 'Layout') {
    const l = kind.layout;
    switch (l.kind) {
      case 'Stepper':
        return [slot('ActiveStep', l.spec.activeStep)];
      case 'Tabs': {
        const slots = [slot('ActiveIndex', l.spec.activeIndex)];
        if (l.spec.activeTag !== undefined) slots.push(slot('ActiveTag', l.spec.activeTag));
        return slots;
      }
      case 'Disclosure':
        return [slot('Open', l.spec.open)];
      default:
        return [];
    }
  }
  if (kind.kind === 'Input') {
    const i = kind.input;
    switch (i.kind) {
      case 'Button':
        return i.spec.disabled !== undefined ? [slot('Disabled', i.spec.disabled)] : [];
      case 'Select': {
        const slots = [slot('Source', i.spec.source), slot('Value', i.spec.value)];
        if (i.spec.disabled !== undefined) slots.push(slot('Disabled', i.spec.disabled));
        return slots;
      }
      case 'Form':
        return i.spec.disabled !== undefined ? [slot('Disabled', i.spec.disabled)] : [];
      case 'FileUpload':
        return i.spec.disabled !== undefined ? [slot('Disabled', i.spec.disabled)] : [];
      default:
        return [];
    }
  }
  if (kind.kind === 'Visualisation') {
    const v = kind.visualisation;
    switch (v.kind) {
      case 'Grid':
        return [slot('Source', v.spec.source)];
      case 'Chart':
        return [slot('Source', v.spec.source)];
      case 'Map':
        return [slot('Source', v.spec.source)];
      default:
        return [];
    }
  }
  return [];
};

// ─── Per-slot binding lookup (port of F# Tools.extractSlot) ───────────────────

/**
 * The `Binding` object backing a named binding slot on a node kind, or
 * `undefined` when the slot is not a declared binding slot for that kind. This
 * is the value-bearing counterpart to {@link extractBindingSlots} (which
 * returns only the slot name + its wire-form expression): a live host resolves
 * the returned binding against its `BindingSources` to read the slot's *current
 * value*. Slot coverage matches `extractBindingSlots` exactly (optional slots —
 * Metric.Trend, Tabs.ActiveTag, Button/Select/Form/FileUpload Disabled — return
 * the binding only when present, `undefined` when absent), so a slot advertised
 * by `extractBindingSlots` always resolves here. Port of F# `Tools.extractSlot`.
 */
export const bindingForSlot = (
  kind: NodeKind<unknown>,
  slotName: string,
): Binding<unknown> | undefined => {
  // `Binding<T>` is invariant (its `Local.initialFrom` + accessor closures pin
  // `T`), so a concrete `Binding<number>` is not directly assignable to
  // `Binding<unknown>`. Launder through `unknown` — the slot value is read-only
  // and the host re-resolves it; the type parameter is irrelevant here.
  const u = (binding: unknown): Binding<unknown> | undefined =>
    binding as Binding<unknown> | undefined;
  if (kind.kind === 'Display') {
    const d = kind.display;
    if (d.kind === 'Metric' && slotName === 'Value') return u(d.spec.value);
    if (d.kind === 'Metric' && slotName === 'Trend') return u(d.spec.trend);
    if (d.kind === 'Sparkline' && slotName === 'Source') return u(d.spec.source);
    if (d.kind === 'Progress' && slotName === 'Fraction') return u(d.spec.fraction);
    if (d.kind === 'LabelValueRow' && slotName === 'Value') return u(d.spec.value);
    return undefined;
  }
  if (kind.kind === 'Layout') {
    const l = kind.layout;
    if (l.kind === 'Stepper' && slotName === 'ActiveStep') return u(l.spec.activeStep);
    if (l.kind === 'Tabs' && slotName === 'ActiveIndex') return u(l.spec.activeIndex);
    if (l.kind === 'Tabs' && slotName === 'ActiveTag') return u(l.spec.activeTag);
    if (l.kind === 'Disclosure' && slotName === 'Open') return u(l.spec.open);
    return undefined;
  }
  if (kind.kind === 'Input') {
    const i = kind.input;
    if (i.kind === 'Button' && slotName === 'Disabled') return u(i.spec.disabled);
    if (i.kind === 'Select' && slotName === 'Source') return u(i.spec.source);
    if (i.kind === 'Select' && slotName === 'Value') return u(i.spec.value);
    if (i.kind === 'Select' && slotName === 'Disabled') return u(i.spec.disabled);
    if (i.kind === 'Form' && slotName === 'Disabled') return u(i.spec.disabled);
    if (i.kind === 'FileUpload' && slotName === 'Disabled') return u(i.spec.disabled);
    return undefined;
  }
  if (kind.kind === 'Visualisation') {
    const v = kind.visualisation;
    if (v.kind === 'Grid' && slotName === 'Source') return u(v.spec.source);
    if (v.kind === 'Chart' && slotName === 'Source') return u(v.spec.source);
    if (v.kind === 'Map' && slotName === 'Source') return u(v.spec.source);
    return undefined;
  }
  return undefined;
};

// ─── Structural traversal ─────────────────────────────────────────────────────

/** The structural children of a node — layout children, boundary arms, fragment body. */
export const childNodes = <TMsg>(node: Node<TMsg>): readonly Node<TMsg>[] => {
  const kind = node.kind;
  switch (kind.kind) {
    case 'Layout':
      return kind.layout.spec.children;
    case 'ErrorBoundary':
      return [kind.spec.child, kind.spec.fallback];
    case 'Switch':
      return [...kind.spec.cases.map((c) => c.child), kind.spec.default];
    case 'FragmentDecl':
      return [kind.spec.body];
    default:
      return [];
  }
};

/** Depth-first walk of every node in the tree, root first. */
export const walkNodes = <TMsg>(tree: Node<TMsg>): Node<TMsg>[] => {
  const acc: Node<TMsg>[] = [];
  const visit = (node: Node<TMsg>): void => {
    acc.push(node);
    for (const child of childNodes(node)) visit(child);
  };
  visit(tree);
  return acc;
};

/** Find the first node with `id` (depth-first), or `undefined`. */
export const findNode = <TMsg>(tree: Node<TMsg>, id: string): Node<TMsg> | undefined =>
  walkNodes(tree).find((n) => (n.id as string) === id);

/** Every node matching `predicate`, depth-first. Port of F# `findNodes`. */
export const findNodes = <TMsg>(
  tree: Node<TMsg>,
  predicate: (node: Node<TMsg>) => boolean,
): Node<TMsg>[] => walkNodes(tree).filter(predicate);

const introspectNode = <TMsg>(node: Node<TMsg>): NodeIntrospection => ({
  id: node.id as string,
  kind: kindName(node.kind as NodeKind<unknown>),
  bindings: extractBindingSlots(node.kind as NodeKind<unknown>),
  childIds: childNodes(node).map((c) => c.id as string),
});

/** The introspection envelope for a single node by id, or `undefined`. Port of F# `getNodeState`. */
export const getNodeState = <TMsg>(
  tree: Node<TMsg>,
  nodeId: string,
): NodeIntrospection | undefined => {
  const node = findNode(tree, nodeId);
  return node === undefined ? undefined : introspectNode(node);
};

/** A recursive structural snapshot of the whole tree. Port of F# `inspectTree`. */
export const inspectTree = <TMsg>(tree: Node<TMsg>): TreeIntrospection => ({
  ...introspectNode(tree),
  children: childNodes(tree).map(inspectTree),
});
