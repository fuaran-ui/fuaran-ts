// ============================================================================
//  @fuaran-ui/ops — tree-op apply engine.
//
//  Port of Fuaran.UI.Ops.Apply. Applies a `TreeOp` against a `Node` tree,
//  returning either the new tree (+ telemetry) or a structured `ApplyError`.
//  The engine never partially mutates: on any error path the input tree is
//  returned untouched (the caller's reference is unchanged, so "revert" is
//  implicit). Wrap an op list in `TreeOp.Batch` for all-or-nothing atomicity.
//
//  Per the F# original (§4g), apply is sequential within a turn; callers fold
//  across an op list themselves or use `Batch`. Structural child ops
//  (Insert / Remove / Move / Reorder) address `Layout` nodes only — every
//  layout spec carries an ordered `children` list; non-layout kinds surface a
//  `ChildlessKind` error with a hint enumerating what is addressable.
//
//  `ApplyResult` additionally carries `emittedTelemetry` (one record per
//  applied leaf op) per the Phase 76 contract; the apply-engine shape stays
//  alpha until Phase 78 validates it against a real sample app.
// ============================================================================

import type {
  Binding,
  LayoutKind,
  Node,
  NodeId,
  NodeKind,
  Result,
  SemanticStyle,
  StateBehaviour,
} from '@fuaran-ui/schema';

import { coerce } from './decode.js';
import type { TreeOp } from './treeOp.js';

// ─── Error + result surface ──────────────────────────────────────────────────

export type ApplyErrorCode =
  | 'NodeNotFound'
  | 'ParentNotFound'
  | 'ChildlessKind'
  | 'PositionOutOfRange'
  | 'DuplicateNodeId'
  | 'FieldNotFound'
  | 'SlotNotFound'
  | 'KindMismatch'
  | 'PathInvalid'
  | 'PathNotSupportedYet'
  | 'OrderingMismatch'
  | 'BatchAborted';

export interface ApplyError {
  readonly code: ApplyErrorCode;
  readonly message: string;
  /** Inner-op index when `code === 'BatchAborted'`. */
  readonly batchIndex?: number;
}

/** One record per applied leaf op (Phase 76 telemetry contract). */
export interface OpApplyTelemetryRecord {
  readonly op: TreeOp<unknown>['kind'];
  readonly targetId: string;
}

export type ApplyResult<TMsg> = Result<
  { readonly newTree: Node<TMsg>; readonly emittedTelemetry: readonly OpApplyTelemetryRecord[] },
  ApplyError
>;

type N = Node<unknown>;
type R = Result<N, ApplyError>;

const ok = (value: N): R => ({ ok: true, value });
const fail = (code: ApplyErrorCode, message: string, batchIndex?: number): R => ({
  ok: false,
  error: batchIndex === undefined ? { code, message } : { code, message, batchIndex },
});

const idOf = (n: N): string => n.id as string;

// ─── Tree walkers ────────────────────────────────────────────────────────────

interface ChildSlot {
  readonly child: N;
  readonly rebuild: (c: N) => N;
}

const withLayoutChildren = (n: N, children: readonly N[]): N => {
  const k = n.kind;
  if (k.kind !== 'Layout') return n;
  const layout = { ...k.layout, spec: { ...k.layout.spec, children } } as LayoutKind<unknown>;
  return { ...n, kind: { kind: 'Layout', layout } };
};

const layoutChildren = (n: N): readonly N[] | undefined =>
  n.kind.kind === 'Layout' ? n.kind.layout.spec.children : undefined;

/** Every immediate sub-node position, each with a rebuild that swaps it. */
const childSlots = (n: N): ChildSlot[] => {
  const slots: ChildSlot[] = [];
  const k = n.kind;
  if (k.kind === 'Layout') {
    const children = k.layout.spec.children;
    children.forEach((child, i) => {
      slots.push({
        child,
        rebuild: (c) =>
          withLayoutChildren(
            n,
            children.map((cc, j) => (j === i ? c : cc)),
          ),
      });
    });
  } else if (k.kind === 'ErrorBoundary') {
    slots.push({
      child: k.spec.child,
      rebuild: (c) => ({ ...n, kind: { kind: 'ErrorBoundary', spec: { ...k.spec, child: c } } }),
    });
    slots.push({
      child: k.spec.fallback,
      rebuild: (c) => ({ ...n, kind: { kind: 'ErrorBoundary', spec: { ...k.spec, fallback: c } } }),
    });
  } else if (k.kind === 'Switch') {
    // Phase 392: each case child + the default are editable slots (mirrors the
    // ErrorBoundary handling above); the match values are preserved on rebuild.
    k.spec.cases.forEach((cse, i) => {
      slots.push({
        child: cse.child,
        rebuild: (c) => ({
          ...n,
          kind: {
            kind: 'Switch',
            spec: {
              ...k.spec,
              cases: k.spec.cases.map((cc, j) => (j === i ? { ...cc, child: c } : cc)),
            },
          },
        }),
      });
    });
    slots.push({
      child: k.spec.default,
      rebuild: (c) => ({ ...n, kind: { kind: 'Switch', spec: { ...k.spec, default: c } } }),
    });
  } else if (k.kind === 'FragmentDecl') {
    slots.push({
      child: k.spec.body,
      rebuild: (c) => ({ ...n, kind: { kind: 'FragmentDecl', spec: { ...k.spec, body: c } } }),
    });
  }
  if (n.state.onLoading !== undefined) {
    const onLoading = n.state.onLoading;
    slots.push({
      child: onLoading,
      rebuild: (c) => ({ ...n, state: { ...n.state, onLoading: c } }),
    });
  }
  if (n.state.onEmpty !== undefined) {
    const onEmpty = n.state.onEmpty;
    slots.push({ child: onEmpty, rebuild: (c) => ({ ...n, state: { ...n.state, onEmpty: c } }) });
  }
  return slots;
};

const findNode = (target: string, n: N): N | undefined => {
  if (idOf(n) === target) return n;
  for (const s of childSlots(n)) {
    const r = findNode(target, s.child);
    if (r !== undefined) return r;
  }
  return undefined;
};

const mapNode = (target: string, f: (n: N) => N, n: N): N | undefined => {
  if (idOf(n) === target) return f(n);
  for (const s of childSlots(n)) {
    const r = mapNode(target, f, s.child);
    if (r !== undefined) return s.rebuild(r);
  }
  return undefined;
};

/**
 * Every NodeId in `n`'s subtree, DFS order. Exported for the elicitation
 * envelope's contract-vs-tree membership probe (WIRE_FORMAT.md §18,
 * `CONTRACT_UNKNOWN_NODE`) — the same traversal the structural-op duplicate
 * checks run, so "is a node in the tree" cannot drift between the two.
 */
export const allNodeIds = (n: N): string[] => [
  idOf(n),
  ...childSlots(n).flatMap((s) => allNodeIds(s.child)),
];

const findLayoutParent = (target: string, n: N): N | undefined => {
  const children = layoutChildren(n);
  if (children !== undefined && children.some((c) => idOf(c) === target)) return n;
  for (const s of childSlots(n)) {
    const r = findLayoutParent(target, s.child);
    if (r !== undefined) return r;
  }
  return undefined;
};

const isAncestor = (ancestorId: string, descendantId: string, root: N): boolean => {
  const a = findNode(ancestorId, root);
  if (a === undefined) return false;
  return childSlots(a).some((s) => allNodeIds(s.child).includes(descendantId));
};

// ─── UpdateProp field dispatch ───────────────────────────────────────────────

type UpdateOutcome =
  | { readonly tag: 'updated'; readonly kind: NodeKind<unknown> }
  | { readonly tag: 'unknownField' }
  | { readonly tag: 'notSupported' }
  | { readonly tag: 'typeMismatch'; readonly detail: string };

const updated = (kind: NodeKind<unknown>): UpdateOutcome => ({ tag: 'updated', kind });
const typeMismatch = (detail: string): UpdateOutcome => ({ tag: 'typeMismatch', detail });

/** Apply a coercer + spec patch, threading coercion failures into typeMismatch. */
const patch = <T>(r: Result<T, string>, build: (value: T) => NodeKind<unknown>): UpdateOutcome =>
  r.ok ? updated(build(r.value)) : typeMismatch(r.error);

const updateField = (
  field: string,
  value: import('@fuaran-ui/schema').JsonValue,
  kind: NodeKind<unknown>,
): UpdateOutcome => {
  if (kind.kind === 'Display') {
    const d = kind.display;
    const disp = (display: import('@fuaran-ui/schema').DisplayKind): NodeKind<unknown> => ({
      kind: 'Display',
      display,
    });
    switch (d.kind) {
      case 'Metric': {
        const s = d.spec;
        switch (field) {
          case 'Label':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, label: x } }),
            );
          case 'Value':
            return patch(coerce.bindingNumber(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, value: x } }),
            );
          case 'Format':
            return patch(coerce.cellFormat(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, format: x } }),
            );
          case 'Tone':
            return patch(coerce.tone(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, tone: x } }),
            );
          case 'Weight':
            return patch(coerce.weight(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, weight: x } }),
            );
          case 'Emphasis':
            return patch(coerce.emphasis(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, emphasis: x } }),
            );
          case 'Trend':
            return patch(coerce.bindingNumber(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, trend: x } }),
            );
          case 'TrendFormat':
            return patch(coerce.cellFormat(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, trendFormat: x } }),
            );
          case 'Icon':
            return patch(coerce.iconSource(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, icon: x } }),
            );
          case 'Subtext':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Metric', spec: { ...s, subtext: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Heading': {
        const s = d.spec;
        switch (field) {
          case 'Level':
            return patch(coerce.int(value), (x) =>
              disp({ kind: 'Heading', spec: { ...s, level: x } }),
            );
          case 'Text':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Heading', spec: { ...s, text: x } }),
            );
          case 'Variant':
            return patch(coerce.headingVariant(value), (x) =>
              disp({ kind: 'Heading', spec: { ...s, variant: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Markdown':
        return field === 'Text'
          ? patch(coerce.textSource(value), (x) => disp({ kind: 'Markdown', spec: { text: x } }))
          : { tag: 'unknownField' };
      case 'Badge': {
        const s = d.spec;
        switch (field) {
          case 'Label':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Badge', spec: { ...s, label: x } }),
            );
          case 'Variant':
            return patch(coerce.badgeVariant(value), (x) =>
              disp({ kind: 'Badge', spec: { ...s, variant: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Skeleton':
        return field === 'Rows'
          ? patch(coerce.int(value), (x) => disp({ kind: 'Skeleton', spec: { rows: x } }))
          : { tag: 'unknownField' };
      case 'Callout': {
        const s = d.spec;
        switch (field) {
          case 'Tone':
            return patch(coerce.tone(value), (x) =>
              disp({ kind: 'Callout', spec: { ...s, tone: x } }),
            );
          case 'Body':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Callout', spec: { ...s, body: x } }),
            );
          case 'Dismissable':
            return patch(coerce.bool(value), (x) =>
              disp({ kind: 'Callout', spec: { ...s, dismissable: x } }),
            );
          case 'Heading':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Callout', spec: { ...s, heading: x } }),
            );
          case 'Icon':
            return patch(coerce.iconSource(value), (x) =>
              disp({ kind: 'Callout', spec: { ...s, icon: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Progress': {
        const s = d.spec;
        switch (field) {
          case 'Fraction':
            return patch(coerce.bindingNumber(value), (x) =>
              disp({ kind: 'Progress', spec: { ...s, fraction: x } }),
            );
          case 'Indeterminate':
            return patch(coerce.bool(value), (x) =>
              disp({ kind: 'Progress', spec: { ...s, indeterminate: x } }),
            );
          case 'Tone':
            return patch(coerce.tone(value), (x) =>
              disp({ kind: 'Progress', spec: { ...s, tone: x } }),
            );
          case 'Label':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Progress', spec: { ...s, label: x } }),
            );
          case 'Caveat':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Progress', spec: { ...s, caveat: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Fact': {
        const s = d.spec;
        switch (field) {
          case 'Label':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Fact', spec: { ...s, label: x } }),
            );
          case 'Value':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Fact', spec: { ...s, value: x } }),
            );
          case 'Tone':
            return patch(coerce.tone(value), (x) =>
              disp({ kind: 'Fact', spec: { ...s, tone: x } }),
            );
          case 'Emphasis':
            // 0.2.8 — routed through the shared cross-vocabulary flag reader,
            // so a TreeOp edit gets the same admission as a fresh decode.
            return patch(coerce.emphasisFlag(value), (x) =>
              disp({ kind: 'Fact', spec: { ...s, emphasis: x } }),
            );
          case 'Help':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Fact', spec: { ...s, help: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'LabelValueRow': {
        const s = d.spec;
        switch (field) {
          case 'Label':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'LabelValueRow', spec: { ...s, label: x } }),
            );
          case 'Value':
            return patch(coerce.bindingNumber(value), (x) =>
              disp({ kind: 'LabelValueRow', spec: { ...s, value: x } }),
            );
          case 'Format':
            return patch(coerce.cellFormat(value), (x) =>
              disp({ kind: 'LabelValueRow', spec: { ...s, format: x } }),
            );
          case 'Emphasis':
            // 0.2.8 — the same shared flag reader as Fact (cross-vocab admission).
            return patch(coerce.emphasisFlag(value), (x) =>
              disp({ kind: 'LabelValueRow', spec: { ...s, emphasis: x } }),
            );
          case 'Help':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'LabelValueRow', spec: { ...s, help: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Link': {
        const s = d.spec;
        switch (field) {
          case 'Href':
            return patch(coerce.bindingString(value), (x) =>
              disp({ kind: 'Link', spec: { ...s, href: x } }),
            );
          case 'Label':
            return patch(coerce.textSource(value), (x) =>
              disp({ kind: 'Link', spec: { ...s, label: x } }),
            );
          case 'Rel':
            return patch(coerce.string(value), (x) =>
              disp({ kind: 'Link', spec: { ...s, rel: x } }),
            );
          case 'Target':
            return patch(coerce.string(value), (x) =>
              disp({ kind: 'Link', spec: { ...s, target: x } }),
            );
          case 'Download':
            return patch(coerce.bool(value), (x) =>
              disp({ kind: 'Link', spec: { ...s, download: x } }),
            );
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Sparkline':
        return { tag: 'notSupported' };
      default:
        return { tag: 'unknownField' };
    }
  }

  if (kind.kind === 'Layout') {
    const l = kind.layout;
    const lay = (layout: LayoutKind<unknown>): NodeKind<unknown> => ({ kind: 'Layout', layout });
    switch (l.kind) {
      // Phase 390 — the unified container. Field surface is layout-mode-
      // dependent, preserving the retired kinds' updatable fields: Flex →
      // Orientation/Wrap (Stack); Grid → Cols/TemplateColumns (GridLayout);
      // Heading applies to any layout (Card). Mirrors the F# `updateBox`.
      case 'Box': {
        const s = l.spec;
        const mode = s.layout;
        if (field === 'Orientation' && mode.kind === 'Flex') {
          return patch(coerce.orientation(value), (x) =>
            lay({ kind: 'Box', spec: { ...s, layout: { ...mode, direction: x } } }),
          );
        }
        if (field === 'Wrap' && mode.kind === 'Flex') {
          return patch(coerce.bool(value), (x) =>
            lay({ kind: 'Box', spec: { ...s, layout: { ...mode, wrap: x } } }),
          );
        }
        if (field === 'Cols' && mode.kind === 'Grid') {
          return patch(coerce.int(value), (x) =>
            lay({ kind: 'Box', spec: { ...s, layout: { ...mode, cols: x } } }),
          );
        }
        if (field === 'TemplateColumns' && mode.kind === 'Grid') {
          return patch(coerce.string(value), (x) =>
            lay({ kind: 'Box', spec: { ...s, layout: { ...mode, templateColumns: x } } }),
          );
        }
        if (field === 'Heading') {
          return patch(coerce.textSource(value), (x) =>
            lay({ kind: 'Box', spec: { ...s, heading: x } }),
          );
        }
        if (field === 'Children') return { tag: 'notSupported' };
        return { tag: 'unknownField' };
      }
      case 'SplitPanel': {
        const s = l.spec;
        switch (field) {
          case 'Weight':
            return patch(coerce.float(value), (x) =>
              lay({ kind: 'SplitPanel', spec: { ...s, weight: x } }),
            );
          case 'Children':
            return { tag: 'notSupported' };
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Tabs': {
        const s = l.spec;
        switch (field) {
          case 'Orientation':
            return patch(coerce.orientation(value), (x) =>
              lay({ kind: 'Tabs', spec: { ...s, orientation: x } }),
            );
          case 'Children':
            return { tag: 'notSupported' };
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Stepper': {
        const s = l.spec;
        switch (field) {
          case 'ActiveStep':
            return patch(coerce.bindingInt(value), (x) =>
              lay({ kind: 'Stepper', spec: { ...s, activeStep: x } }),
            );
          case 'Children':
            return { tag: 'notSupported' };
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'SummaryList': {
        const s = l.spec;
        switch (field) {
          case 'Heading':
            return patch(coerce.textSource(value), (x) =>
              lay({ kind: 'SummaryList', spec: { ...s, heading: x } }),
            );
          case 'Children':
            return { tag: 'notSupported' };
          default:
            return { tag: 'unknownField' };
        }
      }
      case 'Disclosure': {
        const s = l.spec;
        switch (field) {
          case 'Heading':
            return patch(coerce.textSource(value), (x) =>
              lay({ kind: 'Disclosure', spec: { ...s, heading: x } }),
            );
          case 'Open':
            return patch(coerce.bindingBool(value), (x) =>
              lay({ kind: 'Disclosure', spec: { ...s, open: x } }),
            );
          case 'DefaultOpen':
            return patch(coerce.bool(value), (x) =>
              lay({ kind: 'Disclosure', spec: { ...s, defaultOpen: x } }),
            );
          case 'Children':
            return { tag: 'notSupported' };
          default:
            return { tag: 'unknownField' };
        }
      }
      default:
        return { tag: 'unknownField' };
    }
  }

  if (kind.kind === 'FragmentDecl') {
    return field === 'Name'
      ? patch(coerce.string(value), (x) => ({
          kind: 'FragmentDecl',
          spec: { ...kind.spec, name: x as import('@fuaran-ui/schema').FragmentId },
        }))
      : { tag: 'unknownField' };
  }
  if (kind.kind === 'FragmentRef') {
    return field === 'Name'
      ? patch(coerce.string(value), (x) => ({
          kind: 'FragmentRef',
          spec: { ...kind.spec, name: x as import('@fuaran-ui/schema').FragmentId },
        }))
      : { tag: 'unknownField' };
  }

  // Input / Visualisation / Custom / ErrorBoundary have no field-level surface.
  return { tag: 'notSupported' };
};

// ─── UpdateProp path parser (WIRE_FORMAT.md §3.4 grammar — Phase 364) ────────
//
//   path     := segment ( "." segment )*
//   segment  := field ( "[" index "]" )?
//   field    := [A-Za-z_][A-Za-z0-9_]*
//   index    := "0" | [1-9][0-9]*
//
// Hand-rolled (no regex) to mirror the F# reference parser byte-for-byte in
// behaviour. Character classes are strict ASCII per the grammar.

interface PathSeg {
  readonly field: string;
  readonly index?: number;
}

const isFieldStart = (c: string): boolean =>
  (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
const isFieldChar = (c: string): boolean => isFieldStart(c) || (c >= '0' && c <= '9');
const isAsciiDigit = (c: string): boolean => c >= '0' && c <= '9';

const parseSegment = (raw: string): Result<PathSeg, string> => {
  if (raw.length === 0) return { ok: false, error: 'empty segment' };
  const bracket = raw.indexOf('[');
  const fieldPart = bracket < 0 ? raw : raw.slice(0, bracket);
  if (fieldPart.length === 0 || !isFieldStart(fieldPart[0]!) || ![...fieldPart].every(isFieldChar))
    return { ok: false, error: `segment '${raw}' is not a field name` };
  if (bracket < 0) return { ok: true, value: { field: fieldPart } };
  const indexPart = raw.slice(bracket);
  if (indexPart.length < 3 || indexPart[indexPart.length - 1] !== ']')
    return { ok: false, error: `malformed index in segment '${raw}'` };
  const digits = indexPart.slice(1, -1);
  if (digits.length === 0 || ![...digits].every(isAsciiDigit))
    return {
      ok: false,
      error: `index in segment '${raw}' must be a non-negative decimal integer`,
    };
  if (digits.length > 1 && digits[0] === '0')
    return { ok: false, error: `index in segment '${raw}' has a leading zero` };
  const n = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(n))
    return { ok: false, error: `index in segment '${raw}' is out of range` };
  return { ok: true, value: { field: fieldPart, index: n } };
};

const parsePath = (path: string): Result<readonly PathSeg[], string> => {
  if (path.trim() === '') return { ok: false, error: 'empty path' };
  const segs: PathSeg[] = [];
  for (const raw of path.split('.')) {
    const r = parseSegment(raw);
    if (!r.ok) return r;
    segs.push(r.value);
  }
  return { ok: true, value: segs };
};

// ─── UpdateProp nested dispatch — per-kind typed traversal (Phase 364) ───────
//
// Mirrors the F# `dispatchNestedUpdate` legs: DataGrid Columns[i].{Label,
// Format,Width}, Chart YFields[i], Tabs TabHeaders[i].{Label,Icon,Disabled},
// Form Fields[i].{Label,Required,Help}. Closure-bearing sub-fields are never
// addressable.

type NestedOutcome =
  | { readonly tag: 'updated'; readonly kind: NodeKind<unknown> }
  | {
      readonly tag: 'fieldNotFound';
      readonly segment: string;
      readonly available: readonly string[];
    }
  | { readonly tag: 'missingIndex'; readonly listField: string; readonly count: number }
  | {
      readonly tag: 'indexOutOfRange';
      readonly listField: string;
      readonly count: number;
      readonly requested: number;
    }
  | { readonly tag: 'notSupported' }
  | { readonly tag: 'typeMismatch'; readonly detail: string };

const nestedPatch = <T>(
  r: Result<T, string>,
  build: (value: T) => NodeKind<unknown>,
): NestedOutcome =>
  r.ok ? { tag: 'updated', kind: build(r.value) } : { tag: 'typeMismatch', detail: r.error };

const replaceAt = <T>(xs: readonly T[], i: number, item: T): T[] =>
  xs.map((x, j) => (j === i ? item : x));

const updateNested = (
  segs: readonly PathSeg[],
  value: import('@fuaran-ui/schema').JsonValue,
  kind: NodeKind<unknown>,
): NestedOutcome => {
  const [head, ...rest] = segs;
  if (head === undefined) return { tag: 'notSupported' };

  if (kind.kind === 'Visualisation') {
    const v = kind.visualisation;
    if (v.kind === 'Grid') {
      const s = v.spec;
      if (head.field === 'Columns') {
        if (head.index === undefined)
          return { tag: 'missingIndex', listField: 'Columns', count: s.columns.length };
        if (head.index >= s.columns.length)
          return {
            tag: 'indexOutOfRange',
            listField: 'Columns',
            count: s.columns.length,
            requested: head.index,
          };
        const i = head.index;
        const col = s.columns[i]!;
        const rebuild = (c: (typeof s.columns)[number]): NodeKind<unknown> => ({
          kind: 'Visualisation',
          visualisation: { kind: 'Grid', spec: { ...s, columns: replaceAt(s.columns, i, c) } },
        });
        const leaf = rest.length === 1 && rest[0]!.index === undefined ? rest[0]!.field : undefined;
        if (leaf === undefined) return { tag: 'notSupported' };
        switch (leaf) {
          case 'Label':
            return nestedPatch(coerce.string(value), (x) => rebuild({ ...col, label: x }));
          case 'Format':
            return nestedPatch(coerce.cellFormat(value), (x) => rebuild({ ...col, format: x }));
          case 'Width':
            return nestedPatch(coerce.columnWidth(value), (x) => rebuild({ ...col, width: x }));
          case 'Value':
          case 'Kind':
            // Closure-bearing — never addressable.
            return { tag: 'notSupported' };
          default:
            return { tag: 'fieldNotFound', segment: leaf, available: ['Label', 'Format', 'Width'] };
        }
      }
      return { tag: 'fieldNotFound', segment: head.field, available: ['Columns'] };
    }
    if (v.kind === 'Chart') {
      const s = v.spec;
      if (head.field === 'YFields') {
        if (head.index === undefined)
          return { tag: 'missingIndex', listField: 'YFields', count: s.yFields.length };
        if (head.index >= s.yFields.length)
          return {
            tag: 'indexOutOfRange',
            listField: 'YFields',
            count: s.yFields.length,
            requested: head.index,
          };
        if (rest.length > 0) return { tag: 'notSupported' };
        const i = head.index;
        return nestedPatch(coerce.string(value), (x) => ({
          kind: 'Visualisation',
          visualisation: { kind: 'Chart', spec: { ...s, yFields: replaceAt(s.yFields, i, x) } },
        }));
      }
      return { tag: 'fieldNotFound', segment: head.field, available: ['YFields'] };
    }
    return { tag: 'notSupported' };
  }

  if (kind.kind === 'Layout' && kind.layout.kind === 'Tabs') {
    const s = kind.layout.spec;
    // An absent header list addresses like an empty one.
    const headers = s.tabHeaders ?? [];
    if (head.field === 'TabHeaders') {
      if (head.index === undefined)
        return { tag: 'missingIndex', listField: 'TabHeaders', count: headers.length };
      if (head.index >= headers.length)
        return {
          tag: 'indexOutOfRange',
          listField: 'TabHeaders',
          count: headers.length,
          requested: head.index,
        };
      const i = head.index;
      const hdr = headers[i]!;
      const rebuild = (h: (typeof headers)[number]): NodeKind<unknown> => ({
        kind: 'Layout',
        layout: { kind: 'Tabs', spec: { ...s, tabHeaders: replaceAt(headers, i, h) } },
      });
      const leaf = rest.length === 1 && rest[0]!.index === undefined ? rest[0]!.field : undefined;
      if (leaf === undefined) return { tag: 'notSupported' };
      switch (leaf) {
        case 'Label':
          return nestedPatch(coerce.textSource(value), (x) => rebuild({ ...hdr, label: x }));
        case 'Icon':
          return nestedPatch(coerce.iconSource(value), (x) => rebuild({ ...hdr, icon: x }));
        case 'Disabled':
          // Optional typed binding; replacing it installs the value.
          return nestedPatch(coerce.bindingBool(value), (x) => rebuild({ ...hdr, disabled: x }));
        default:
          return { tag: 'fieldNotFound', segment: leaf, available: ['Label', 'Icon', 'Disabled'] };
      }
    }
    return { tag: 'fieldNotFound', segment: head.field, available: ['TabHeaders'] };
  }

  if (kind.kind === 'Input' && kind.input.kind === 'Form') {
    const s = kind.input.spec;
    if (head.field === 'Fields') {
      if (head.index === undefined)
        return { tag: 'missingIndex', listField: 'Fields', count: s.fields.length };
      if (head.index >= s.fields.length)
        return {
          tag: 'indexOutOfRange',
          listField: 'Fields',
          count: s.fields.length,
          requested: head.index,
        };
      const i = head.index;
      const fld = s.fields[i]!;
      const rebuild = (f: (typeof s.fields)[number]): NodeKind<unknown> => ({
        kind: 'Input',
        input: { kind: 'Form', spec: { ...s, fields: replaceAt(s.fields, i, f) } },
      });
      const leaf = rest.length === 1 && rest[0]!.index === undefined ? rest[0]!.field : undefined;
      if (leaf === undefined) return { tag: 'notSupported' };
      switch (leaf) {
        case 'Label':
          return nestedPatch(coerce.textSource(value), (x) => rebuild({ ...fld, label: x }));
        case 'Required':
          return nestedPatch(coerce.bool(value), (x) => rebuild({ ...fld, required: x }));
        case 'Help':
          return nestedPatch(coerce.textSource(value), (x) => rebuild({ ...fld, help: x }));
        case 'Id':
        case 'Kind':
          // Id is the form-store key; Kind is closure-bearing. Not addressable.
          return { tag: 'notSupported' };
        default:
          return { tag: 'fieldNotFound', segment: leaf, available: ['Label', 'Required', 'Help'] };
      }
    }
    return { tag: 'fieldNotFound', segment: head.field, available: ['Fields'] };
  }

  return { tag: 'notSupported' };
};

// ─── ReplaceBinding slot dispatch ────────────────────────────────────────────

const replaceBinding = (
  slot: string,
  b: Binding<unknown>,
  kind: NodeKind<unknown>,
): NodeKind<unknown> | undefined => {
  if (kind.kind === 'Display') {
    const d = kind.display;
    if (d.kind === 'Metric' && slot === 'Value')
      return {
        kind: 'Display',
        display: { kind: 'Metric', spec: { ...d.spec, value: b as Binding<number> } },
      };
    if (d.kind === 'Metric' && slot === 'Trend')
      return {
        kind: 'Display',
        display: { kind: 'Metric', spec: { ...d.spec, trend: b as Binding<number> } },
      };
    if (d.kind === 'Sparkline' && slot === 'Source')
      return {
        kind: 'Display',
        display: { kind: 'Sparkline', spec: { source: b as Binding<readonly number[]> } },
      };
    if (d.kind === 'Progress' && slot === 'Fraction')
      return {
        kind: 'Display',
        display: { kind: 'Progress', spec: { ...d.spec, fraction: b as Binding<number> } },
      };
    if (d.kind === 'LabelValueRow' && slot === 'Value')
      return {
        kind: 'Display',
        display: { kind: 'LabelValueRow', spec: { ...d.spec, value: b as Binding<number> } },
      };
  } else if (kind.kind === 'Layout') {
    const l = kind.layout;
    if (l.kind === 'Stepper' && slot === 'ActiveStep')
      return {
        kind: 'Layout',
        layout: { kind: 'Stepper', spec: { ...l.spec, activeStep: b as Binding<number> } },
      };
  } else if (kind.kind === 'Input') {
    const i = kind.input;
    // Phase 129: Button's optional bound disabled-state slot.
    if (i.kind === 'Button' && slot === 'Disabled')
      return {
        kind: 'Input',
        input: { kind: 'Button', spec: { ...i.spec, disabled: b as Binding<boolean> } },
      };
    // Phase 130: Select / Form / FileUpload optional bound disabled-state slot.
    if (i.kind === 'Select' && slot === 'Disabled')
      return {
        kind: 'Input',
        input: { kind: 'Select', spec: { ...i.spec, disabled: b as Binding<boolean> } },
      };
    if (i.kind === 'Form' && slot === 'Disabled')
      return {
        kind: 'Input',
        input: { kind: 'Form', spec: { ...i.spec, disabled: b as Binding<boolean> } },
      };
    if (i.kind === 'FileUpload' && slot === 'Disabled')
      return {
        kind: 'Input',
        input: { kind: 'FileUpload', spec: { ...i.spec, disabled: b as Binding<boolean> } },
      };
  } else if (kind.kind === 'Visualisation') {
    const v = kind.visualisation;
    if (v.kind === 'Grid' && slot === 'Source')
      return {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Grid',
          spec: { ...v.spec, source: b as Binding<readonly unknown[]> },
        },
      };
    if (v.kind === 'Chart' && slot === 'Source')
      return {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Chart',
          spec: { ...v.spec, source: b as Binding<readonly unknown[]> },
        },
      };
    if (v.kind === 'Map' && slot === 'Source')
      return {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Map',
          spec: {
            ...v.spec,
            source: b as Binding<readonly import('@fuaran-ui/schema').MapMarker[]>,
          },
        },
      };
  }
  return undefined;
};

// ─── Single-op apply ─────────────────────────────────────────────────────────

const applyOne = (op: TreeOp<unknown>, root: N, telem: OpApplyTelemetryRecord[]): R => {
  switch (op.kind) {
    case 'EditNode': {
      const updatedTree = mapNode(op.target, (n) => ({ ...n, kind: op.newKind }), root);
      if (updatedTree === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      telem.push({ op: 'EditNode', targetId: op.target });
      return ok(updatedTree);
    }
    case 'UpdateProp': {
      const parsed = parsePath(op.path);
      if (!parsed.ok)
        return fail('PathInvalid', `Path '${op.path}' is structurally invalid: ${parsed.error}.`);
      const targetNode = findNode(op.target, root);
      if (targetNode === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      const segs = parsed.value;
      const finish = (kind: NodeKind<unknown>): R => {
        const newTree = mapNode(op.target, (n) => ({ ...n, kind }), root);
        if (newTree === undefined)
          return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
        telem.push({ op: 'UpdateProp', targetId: op.target });
        return ok(newTree);
      };
      if (segs.length === 1 && segs[0]!.index === undefined) {
        // Top-level path — the original per-kind field dispatch.
        const outcome = updateField(op.path, op.value, targetNode.kind);
        switch (outcome.tag) {
          case 'updated':
            return finish(outcome.kind);
          case 'unknownField':
            return fail('FieldNotFound', `Field '${op.path}' not found on node '${op.target}'.`);
          case 'notSupported':
            return fail(
              'PathNotSupportedYet',
              `Path '${op.path}' on node '${op.target}' is not yet supported by the apply engine.`,
            );
          case 'typeMismatch':
            return fail(
              'KindMismatch',
              `UpdateProp value for '${op.path}' on node '${op.target}' does not match the field's expected type: ${outcome.detail}`,
            );
        }
        break;
      }
      // Nested path (Phase 364) — the per-kind typed traversal.
      const outcome = updateNested(segs, op.value, targetNode.kind);
      switch (outcome.tag) {
        case 'updated':
          return finish(outcome.kind);
        case 'missingIndex':
          return fail(
            'PathInvalid',
            `Field '${outcome.listField}' on node '${op.target}' is a list — address an element with a 0-based index (the list has ${outcome.count} element(s)).`,
          );
        case 'indexOutOfRange':
          return fail(
            'PositionOutOfRange',
            `Index ${outcome.requested} is out of range for '${outcome.listField}' on node '${op.target}' (${
              outcome.count === 0 ? 'the list is empty' : `valid: 0..${outcome.count - 1}`
            }).`,
          );
        case 'fieldNotFound':
          return fail(
            'FieldNotFound',
            `Field '${outcome.segment}' (in path '${op.path}') not found on node '${op.target}'. Available at this segment: ${outcome.available.join(', ')}.`,
          );
        case 'notSupported':
          return fail(
            'PathNotSupportedYet',
            `Path '${op.path}' on node '${op.target}' is not yet supported by the apply engine.`,
          );
        case 'typeMismatch':
          return fail(
            'KindMismatch',
            `UpdateProp value for '${op.path}' on node '${op.target}' does not match the field's expected type: ${outcome.detail}`,
          );
      }
      break;
    }
    case 'ReplaceBinding': {
      const targetNode = findNode(op.target, root);
      if (targetNode === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      const newKind = replaceBinding(op.slot, op.binding, targetNode.kind);
      if (newKind === undefined)
        return fail('SlotNotFound', `Binding slot '${op.slot}' not found on node '${op.target}'.`);
      const newTree = mapNode(op.target, (n) => ({ ...n, kind: newKind }), root);
      if (newTree === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      telem.push({ op: 'ReplaceBinding', targetId: op.target });
      return ok(newTree);
    }
    case 'UpdateStyle': {
      const newTree = mapNode(op.target, (n) => ({ ...n, style: op.style as SemanticStyle }), root);
      if (newTree === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      telem.push({ op: 'UpdateStyle', targetId: op.target });
      return ok(newTree);
    }
    case 'UpdateState': {
      const newTree = mapNode(
        op.target,
        (n) => ({ ...n, state: op.state as StateBehaviour<unknown> }),
        root,
      );
      if (newTree === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      telem.push({ op: 'UpdateState', targetId: op.target });
      return ok(newTree);
    }
    case 'InsertChild': {
      const parent = findNode(op.parentId, root);
      if (parent === undefined)
        return fail('ParentNotFound', `Parent node '${op.parentId}' not found in tree.`);
      const children = layoutChildren(parent);
      if (children === undefined)
        return fail(
          'ChildlessKind',
          `Node '${op.parentId}' (kind=${parent.kind.kind}) has no children field — only Layout kinds accept structural child ops.`,
        );
      const existing = new Set(allNodeIds(root));
      const duplicate = allNodeIds(op.child).find((id) => existing.has(id));
      if (duplicate !== undefined)
        return fail(
          'DuplicateNodeId',
          `NodeId '${duplicate}' is already present in the tree; ids must be unique.`,
        );
      // 0.4.0: InsertChild APPENDS. Placing a node anywhere else is
      // Batch [InsertChild, ReorderChildren] — order is stated by naming ids.
      const newChildren = [...children, op.child];
      const newTree = mapNode(op.parentId, (n) => withLayoutChildren(n, newChildren), root);
      if (newTree === undefined)
        return fail('ParentNotFound', `Parent node '${op.parentId}' not found in tree.`);
      telem.push({ op: 'InsertChild', targetId: op.parentId });
      return ok(newTree);
    }
    case 'RemoveNode': {
      if (idOf(root) === op.target) return fail('KindMismatch', 'Cannot RemoveNode the root.');
      const parent = findLayoutParent(op.target, root);
      if (parent === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      const children = layoutChildren(parent)!;
      const newTree = mapNode(
        idOf(parent),
        (n) =>
          withLayoutChildren(
            n,
            children.filter((c) => idOf(c) !== op.target),
          ),
        root,
      );
      if (newTree === undefined)
        return fail('ParentNotFound', `Parent node '${idOf(parent)}' not found in tree.`);
      telem.push({ op: 'RemoveNode', targetId: op.target });
      return ok(newTree);
    }
    case 'MoveNode': {
      if (op.target === op.newParentId)
        return fail('KindMismatch', 'Cannot move a node into itself.');
      if (isAncestor(op.target, op.newParentId, root))
        return fail(
          'KindMismatch',
          'Cannot move a node into its own descendant (would create a cycle).',
        );
      const moving = findNode(op.target, root);
      if (moving === undefined)
        return fail('NodeNotFound', `Node '${op.target}' not found in tree.`);
      const newParent = findNode(op.newParentId, root);
      if (newParent === undefined)
        return fail('ParentNotFound', `Parent node '${op.newParentId}' not found in tree.`);
      if (layoutChildren(newParent) === undefined)
        return fail(
          'ChildlessKind',
          `Node '${op.newParentId}' (kind=${newParent.kind.kind}) has no children field.`,
        );
      const afterRemove = applyOne({ kind: 'RemoveNode', target: op.target }, root, []);
      if (!afterRemove.ok) return afterRemove;
      const inserted = applyOne(
        { kind: 'InsertChild', parentId: op.newParentId, child: moving },
        afterRemove.value,
        [],
      );
      if (!inserted.ok) return inserted;
      telem.push({ op: 'MoveNode', targetId: op.target });
      return ok(inserted.value);
    }
    case 'ReorderChildren': {
      const parent = findNode(op.parentId, root);
      if (parent === undefined)
        return fail('ParentNotFound', `Parent node '${op.parentId}' not found in tree.`);
      const children = layoutChildren(parent);
      if (children === undefined)
        return fail(
          'ChildlessKind',
          `Node '${op.parentId}' (kind=${parent.kind.kind}) has no children field.`,
        );
      const currentIds = children.map(idOf);
      const sortedCurrent = [...currentIds].sort();
      const sortedNew = [...op.newOrder].map((x) => x as string).sort();
      if (
        sortedCurrent.length !== sortedNew.length ||
        sortedCurrent.some((id, i) => id !== sortedNew[i])
      )
        return fail(
          'OrderingMismatch',
          `ReorderChildren for '${op.parentId}' did not list exactly the current child ids.`,
        );
      const byId = new Map(children.map((c) => [idOf(c), c]));
      const reordered = op.newOrder
        .map((id) => byId.get(id as string)!)
        .filter((c): c is N => c !== undefined);
      const newTree = mapNode(op.parentId, (n) => withLayoutChildren(n, reordered), root);
      if (newTree === undefined)
        return fail('ParentNotFound', `Parent node '${op.parentId}' not found in tree.`);
      telem.push({ op: 'ReorderChildren', targetId: op.parentId });
      return ok(newTree);
    }
    case 'ReplaceRoot':
      // The whole-tree swap: the only op that legally changes the root node id.
      return ok(op.node);
    case 'Batch': {
      let state = root;
      for (let i = 0; i < op.ops.length; i += 1) {
        const r = applyOne(op.ops[i]!, state, telem);
        if (!r.ok) {
          // All-or-nothing: discard partial state + telemetry, surface the failure.
          return {
            ok: false,
            error: {
              code: 'BatchAborted',
              message: `Batch aborted at inner op #${i}: ${r.error.message}`,
              batchIndex: i,
            },
          };
        }
        state = r.value;
      }
      return ok(state);
    }
  }
  // Unreachable — every TreeOp case returns above.
  return fail('KindMismatch', 'unreachable apply branch');
};

// ─── Public entry ────────────────────────────────────────────────────────────

/**
 * Apply a single tree-op against `tree`, returning either the updated tree plus
 * emitted telemetry, or a structured `ApplyError`. Fold this across an op list
 * to apply many; wrap in `TreeOp.Batch` for atomic all-or-nothing application.
 */
export const apply = <TMsg>(tree: Node<TMsg>, op: TreeOp<TMsg>): ApplyResult<TMsg> => {
  const telem: OpApplyTelemetryRecord[] = [];
  const r = applyOne(op as TreeOp<unknown>, tree as N, telem);
  if (!r.ok) return r;
  return { ok: true, value: { newTree: r.value as Node<TMsg>, emittedTelemetry: telem } };
};
