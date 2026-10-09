// ============================================================================
//  @fuaran-ui/renderer/render/core — the recursive node renderer.
//
//  Mirrors the F# reference renderer's `render` + `renderKind` functions: every
//  node renders to an outer wrapper `<div>` carrying `id`, `data-fuaran-node-id`,
//  the kind+style className, projected aria-* attributes, and sanitised
//  extra-attributes; the per-kind body renders as its single child. The
//  per-node render guard catches a throwing body so sibling nodes stay live
//  (suspended under an active ErrorBoundary, which wants the fallback subtree).
//
//  Class-name + ARIA parity with the F# renderer is the load-bearing property —
//  see classNames.ts.
// ============================================================================

import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { Node, NodeKind, StateBehaviour } from '@fuaran-ui/schema';

import {
  isNodeVisible,
  renderText,
  resolve,
  selectSwitchCase,
  tryResolveScalarText,
} from '../bindings.js';
import { collectFragments } from '../context.js';
import { deriveGuestPrivilege } from '../guestPrivilege.js';
import {
  accessibilityAttributes,
  forwardsToSemanticElement,
  tooltipHintId,
  tooltipRidesSemanticElement,
  withTooltipDescribedBy,
  partitionExtraAttributes,
} from '../accessibility.js';
import { motionVar, nodeClassName, textDirectionAttr } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { sanitizeExtraAttributes } from '../sanitize.js';
import { renderCustom } from './Custom.js';
import { renderDisplay } from './Display.js';
import { ErrorBoundaryRenderer } from './ErrorBoundary.js';
import { renderFragmentRef } from './Fragment.js';
import { renderInput } from './Input.js';
import { renderLayout } from './Layout.js';
import { renderVis } from './Visualisation.js';

/** Project a NodeKind to "Layout.Stack" / "Display.KPI" / … for failure telemetry. */
export const nodeKindName = (kind: NodeKind<unknown>): string => {
  switch (kind.kind) {
    case 'Layout':
      return `Layout.${kind.layout.kind}`;
    case 'Display':
      return `Display.${kind.display.kind}`;
    case 'Input':
      return `Input.${kind.input.kind}`;
    case 'Visualisation':
      return `Visualisation.${kind.visualisation.kind}`;
    case 'Custom':
      return `Custom.${kind.moduleId}.${kind.componentId}`;
    case 'ErrorBoundary':
      return 'ErrorBoundary';
    case 'Switch':
      return 'Switch';
    case 'FragmentDecl':
      return 'FragmentDecl';
    case 'FragmentRef':
      return 'FragmentRef';
    case 'Mount':
      return `Mount.${kind.spec.scopeId}`;
  }
};

/** Render a list of child nodes with stable React keys. */
export const renderChildren = <TMsg,>(
  ctx: RenderContext<TMsg>,
  nodes: readonly Node<TMsg>[],
): ReactElement[] => nodes.map((child, i) => renderNode(ctx, child, `${child.id}:${i}`));

/** Per-`NodeKind` dispatch to the family sub-renderers. */
export const renderKind = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  state: StateBehaviour<TMsg>,
  kind: NodeKind<TMsg>,
  // Phase 951 — the node's a11y projection, for the kinds that carry it on
  // their own semantic element. `{}` for every other kind.
  semanticAttrs: Record<string, string> = {},
): ReactNode => {
  switch (kind.kind) {
    case 'Layout':
      return renderLayout(ctx, parentNodeId, kind.layout);
    case 'Display':
      return renderDisplay(ctx, state, kind.display, semanticAttrs);
    case 'Input':
      return renderInput(ctx, kind.input, semanticAttrs);
    case 'Visualisation':
      return renderVis(ctx, parentNodeId, state, kind.visualisation);
    case 'ErrorBoundary':
      return <ErrorBoundaryRenderer ctx={ctx} parentNodeId={parentNodeId} spec={kind.spec} />;
    case 'Switch': {
      // State-bound conditional child (Phase 392). Resolve the state value at
      // `stateKey` from the (snapshot) sources, match its string form against
      // each case in order (first-match-wins), and render that case's child —
      // else the default. State transitions arrive as ordinary Action.SetState
      // (via runtime.setState); the host re-renders with an updated sources.state
      // and the switch re-selects — no bespoke dispatch path (FGP 3). SSR reads
      // the same initial state, so server + client first render match (hydration
      // parity, docs/SSR.md).
      // Phase 768 — the selector is any Binding. The State form keeps the
      // direct state-bag read (hydration-parity path, unchanged) with the
      // 768-form defaultValue seeding the un-written key; other bindings
      // resolve through the standard resolver (decoded Selection accessors
      // already project their field, the Phase 427/632 fix).
      const on = kind.spec.on;
      let raw: unknown;
      if (on.kind === 'State') {
        raw = ctx.sources.state?.[on.key];
        if (raw === undefined) raw = on.defaultValue;
      } else {
        // Phase 1535 — the SCALAR resolver. `resolve`'s `Transform` arm is
        // row-shaped and cannot serve a string slot, so a computed selector fell
        // through to `default` on every host with nothing saying why. Every
        // other binding case resolves exactly as before.
        raw = tryResolveScalarText(ctx.sources, on);
      }
      const valueStr = raw === undefined || raw === null ? '' : String(raw);
      // Phase 1535 — first-match-wins over both kinds of case, through the one
      // shared definition, so this renderer and the server cannot drift on the
      // order or on what a predicate that fails to resolve means.
      const matched = selectSwitchCase(ctx.sources, valueStr, kind.spec.cases);
      return renderNode(ctx, matched ?? kind.spec.default);
    }
    case 'Custom':
      return renderCustom(ctx, parentNodeId, state, kind);
    case 'FragmentDecl':
      // The decl renders nothing visible — its body is the template the refs expand.
      return null;
    case 'FragmentRef':
      return renderFragmentRef(ctx, parentNodeId, kind.spec);
    case 'Mount': {
      // Isolation/embedding boundary (§4o), mirroring the reference renderer's
      // Mount arm (never a throw). The scope id is carried as a data attribute
      // so the boundary stays addressable across the isolation seam.
      //
      // Phase 1021 — THIS IS THE ONLY CALL TO `loadGuest` IN THE RENDERER, and
      // it derives the guest's privilege in the same expression that resolves
      // the guest. A host supplies a loader; it never constructs the guest's
      // context, so it cannot construct a privileged one. With no `guestSeam`
      // wired the guest is UNPRIVILEGED and its channel is clamped to `OutOnly`
      // — see `guestPrivilege.ts` for the whole contract and why the clamp
      // precedes every read.
      const spec = kind.spec;
      const guestTree = ctx.runtime.loadGuest?.(spec.scopeId);
      if (guestTree === undefined) {
        // No loader wired (the default / standalone / server case): a Mount is
        // inert. Byte-identical to the pre-1021 placeholder — the string
        // renderer emits the same one and the fixture snapshots pin both.
        return (
          <div className="fuaran-mount-placeholder" data-fuaran-mount-scope={spec.scopeId}>
            {`[fuaran:mount '${spec.scopeId}' — guest loader not attached]`}
          </div>
        );
      }

      const privilege = deriveGuestPrivilege(
        spec,
        ctx.runtime,
        // The raw bubble: a guest dispatch reaches the host ONLY here, tagged
        // with its scope, so the host's own TMsg stays behind the boundary. An
        // unwired port swallows it — inert, exactly like an unwired `onBubble`.
        (action) => ctx.runtime.bubbleGuestAction?.(spec.scopeId, action),
        ctx.runtime.guestSeam,
      );

      const guestCtx: RenderContext<unknown> = {
        sources: ctx.sources,
        runtime: privilege.runtime,
        dispatch: privilege.dispatch,
        fragments: collectFragments(new Map<string, Node<unknown>>(), guestTree),
        expandingFragments: new Set<string>(),
        inErrorBoundary: false,
        // The guest INHERITS the host's egress policy and hash floor. A guest
        // tree is composed by a host-side loader but is not thereby more trusted
        // than the tree that mounted it, and a guest able to WIDEN either would
        // make the ambient default reachable around. Narrowing for a guest is a
        // host act, available through `GuestSeam.wrapRuntime`.
        egressPolicy: ctx.egressPolicy,
        ...(ctx.customHashFloor !== undefined ? { customHashFloor: ctx.customHashFloor } : {}),
        // Phase 2074 — the guest is inside this renderer, so it shares its drag cell.
        ...(ctx.gridDrag !== undefined ? { gridDrag: ctx.gridDrag } : {}),
      };

      return (
        <div className="fuaran-mount-boundary" data-fuaran-mount-scope={spec.scopeId}>
          {renderNode(guestCtx, guestTree)}
        </div>
      );
    }
  }
};

/**
 * Render a Fuaran `Node<TMsg>` to a React element against an explicit context.
 *
 * Phase 2074 — every node renders through `NodeView`, a component that is
 * skipped outright when its node, its context and every state key its subtree
 * READ are unchanged (see "The memo boundary" below). The element returned here
 * is cheap: no binding resolves until React renders it.
 */
export const renderNode = <TMsg,>(
  ctx: RenderContext<TMsg>,
  node: Node<TMsg>,
  key?: string,
): ReactElement => (
  <NodeView key={key} ctx={ctx as RenderContext<unknown>} node={node as Node<unknown>} />
);

/** The body of one node: its wrapper, its kind's body and its tooltip hint. */
const renderNodeBody = <TMsg,>(ctx: RenderContext<TMsg>, node: Node<TMsg>): ReactElement | null => {
  const id = node.id;

  // Phase 1535 — CONDITIONAL PRESENCE, before anything else is computed. A
  // resolved `false` on `node.visible` removes the node entirely: no element,
  // no placeholder, no `aria-hidden`, nothing in the layout and nothing in the
  // accessibility tree. Absence, an unresolved predicate and an errored one all
  // render — a missing source silently hiding content is the one failure a
  // reader cannot see, cannot report and cannot work around.
  //
  // The rule is `isNodeVisible`, shared with the server renderer, and the guard
  // sits on this one function rather than at every call site that produces a
  // child, so a kind added tomorrow inherits it without anyone remembering to.
  if (!isNodeVisible(ctx.sources, node)) return null;

  let className = nodeClassName(node.kind, node.style);
  if (node.motion !== undefined) className += ` fuaran-motion-${motionVar(node.motion)}`;

  // Phase 1112 -- the node-level tooltip trait. An EMPTY resolved hint emits
  // nothing at all: a declared hint that says nothing is markup that reveals an
  // empty box on hover, and the wrapper class / focus stop / describedby would
  // then advertise a description that is not there.
  const resolvedHint =
    node.tooltip === undefined ? undefined : renderText(ctx.sources, node.tooltip);
  const tooltipText =
    resolvedHint !== undefined && resolvedHint.trim() !== '' ? resolvedHint : undefined;
  if (tooltipText !== undefined) className += ' fuaran-has-tooltip';

  // Phase 951 — route the projection. A kind whose body IS the node's semantic
  // element takes the a11y attributes (plus the `aria-*` half of
  // extraAttributes) onto that element; the wrapper keeps only the `data-*`
  // addressing half, beside data-fuaran-node-id. Every other kind is unchanged:
  // a11y first, then extras (extras override), on the wrapper. Parity-locked
  // with the F# tiers via the same predicate — see forwardsToSemanticElement.
  const attrs: Record<string, string> = {};
  const semanticAttrs: Record<string, string> = {};
  // Phase 1472 / Phase 1696 — the DECLARED direction rides the wrapper, first
  // among the attributes that follow `class`, exactly as the server renderer
  // emits it: the served DOM and the hydrated one must carry the same attribute
  // or hydration finds markup it did not produce. The `fuaran-dir-*` class in
  // `className` isolates the run (§3.1 rule 2); this states which way it reads
  // (rule 1).
  const direction = textDirectionAttr(node.style.direction);
  if (direction !== undefined) attrs['dir'] = direction;
  const forwards = forwardsToSemanticElement(node.kind);
  const target = forwards ? semanticAttrs : attrs;
  for (const [k, v] of accessibilityAttributes(ctx.sources, node.accessibility)) target[k] = v;
  if (node.extraAttributes !== undefined) {
    const extras = sanitizeExtraAttributes(node.extraAttributes);
    if (forwards) {
      const [dataHalf, ariaHalf] = partitionExtraAttributes(extras);
      Object.assign(attrs, dataHalf);
      Object.assign(semanticAttrs, ariaHalf);
    } else {
      Object.assign(attrs, extras);
    }
  }

  // Phase 1112 -- route the hint's description and, where the wrapper is the
  // described element, its focus stop. The two travel together by construction:
  // see `tooltipRidesSemanticElement`. Emitted attribute-for-attribute as the
  // server renderer emits them, so the hydrated DOM matches the served one.
  if (tooltipText !== undefined) {
    const hintId = tooltipHintId(id);
    if (tooltipRidesSemanticElement(node.kind)) {
      withTooltipDescribedBy(hintId, semanticAttrs);
    } else {
      withTooltipDescribedBy(hintId, attrs);
      attrs['tabIndex'] = '0';
    }
    ensureTooltipDismissal();
  }

  let kindBody: ReactNode;
  try {
    kindBody = renderKind(ctx, id, node.state, node.kind, semanticAttrs);
  } catch (ex) {
    if (ctx.inErrorBoundary) throw ex;
    const message = ex instanceof Error ? ex.message : String(ex);
    kindBody = (
      <div
        className="fuaran-node-fallback"
        data-fuaran-render-failed="true"
        data-fuaran-render-correlation={correlationId()}
      >
        {`[fuaran: render failed for '${id}' (${nodeKindName(node.kind)}) — ${message}]`}
      </div>
    );
  }

  // The hint element itself -- a sibling of the body inside the wrapper, which is
  // what makes it HOVERABLE: the pointer moving from the node onto the hint never
  // leaves the wrapper, so the `:hover` that revealed it still holds (WCAG
  // 1.4.13). Placed after the body so the reading order is thing-then-description.
  return (
    <div id={id} data-fuaran-node-id={id} className={className} {...attrs}>
      {kindBody}
      {tooltipText !== undefined && (
        <span id={tooltipHintId(id)} className="fuaran-tooltip" role="tooltip">
          {tooltipText}
        </span>
      )}
    </div>
  );
};

// --- The memo boundary (Phase 2074) -------------------------------------------
//
// A node re-renders when, and only when, one of three things moved:
//
//   1. the node itself — `apply` rebuilds only the spine above an edit, so an
//      unchanged subtree keeps its identity and identity is a sound test;
//   2. the context, compared field by field (a derived context such as
//      `{ ...ctx, inErrorBoundary: true }` is a new object each render but the
//      same context), with every BindingSources member except `state` compared
//      by identity;
//   3. a `state` key the node's SUBTREE read on an earlier render.
//
// What a subtree reads is not declared anywhere, so it is RECORDED: the node
// renders against a `state` view that notes every key looked up through it,
// and the note propagates to every ancestor node, because an ancestor that
// skips also skips its descendants. Enumerating the bag (`Object.keys`, a
// spread, `JSON.stringify`) marks the reader as depending on ALL of it, so a
// reader nobody anticipated degrades to "re-render on any state change" —
// the pre-2074 behaviour — never to a stale render. The record only grows: a
// key read once keeps re-rendering its readers, which can cost a render and
// can never lose one.
//
// Handlers and effects outlive the render that created them, and a skipped
// node keeps its old ones. They read state through the same view, which is
// RETARGETED to the newest bag whenever the node is skipped (and passes that
// to every descendant that shares the bag), so a handler acting at dispatch
// time sees the state of the latest render, exactly as before memoisation.

type StateBag = Readonly<Record<string, unknown>>;

class StateReads {
  /** The bag this node last rendered with, or was carried forward to. */
  raw: StateBag | undefined;
  /** Every key this node's subtree has read. */
  readonly keys = new Set<string>();
  /** True once the subtree has enumerated the bag. */
  all = false;
  /** The descendants that render against this node's bag unchanged. */
  readonly sharers = new Set<StateReads>();

  constructor(readonly parent: StateReads | undefined) {}

  note(key: string): void {
    // Every ancestor already holds a key its descendant holds, so the walk can
    // stop at the first one that has it.
    for (let r: StateReads | undefined = this; r !== undefined && !r.keys.has(key); r = r.parent) {
      r.keys.add(key);
    }
  }

  noteAll(): void {
    for (let r: StateReads | undefined = this; r !== undefined && !r.all; r = r.parent) {
      r.all = true;
    }
  }

  retarget(raw: StateBag | undefined): void {
    if (this.raw === raw) return;
    this.raw = raw;
    for (const s of this.sharers) s.retarget(raw);
  }

  /** Would this subtree read the same values from `next` as from its current bag? */
  unchangedIn(next: StateBag | undefined): boolean {
    const prev = this.raw;
    if (prev === next) return true;
    if (prev === undefined || next === undefined || this.all) return false;
    for (const key of this.keys) {
      const had = Object.prototype.hasOwnProperty.call(prev, key);
      if (had !== Object.prototype.hasOwnProperty.call(next, key)) return false;
      if (had && !Object.is(prev[key], next[key])) return false;
    }
    return true;
  }
}

/** The recording views handed out, and whose reads each one notes. */
const viewOwners = new WeakMap<object, StateReads>();

const recordingView = (reads: StateReads): StateBag => {
  const view = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => {
      if (typeof key !== 'string') return undefined;
      reads.note(key);
      return reads.raw?.[key];
    },
    has: (_t, key) => {
      if (typeof key !== 'string') return false;
      reads.note(key);
      return reads.raw !== undefined && key in reads.raw;
    },
    getOwnPropertyDescriptor: (_t, key) => {
      if (typeof key !== 'string') return undefined;
      reads.note(key);
      const raw = reads.raw;
      if (raw === undefined || !Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
      return { value: raw[key], writable: false, enumerable: true, configurable: true };
    },
    ownKeys: () => {
      reads.noteAll();
      return reads.raw === undefined ? [] : Reflect.ownKeys(reads.raw);
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
  viewOwners.set(view, reads);
  return view;
};

/** The nearest enclosing node's record — where a node's reads propagate to. */
const ReadsContext = createContext<StateReads | undefined>(undefined);

const sameMembers = (a: object, b: object, skip: string): boolean => {
  if (a === b) return true;
  const ak = Object.keys(a).filter((k) => k !== skip);
  const bk = Object.keys(b).filter((k) => k !== skip);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
};

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

/** The context unchanged in everything but `sources.state`, which is judged per key. */
const sameContextBesideState = (a: RenderContext<unknown>, b: RenderContext<unknown>): boolean =>
  a === b ||
  (sameMembers(a, b, 'sources') &&
    // `expandingFragments` is a fresh Set per expansion; its CONTENT is the fact.
    sameSet(a.expandingFragments, b.expandingFragments) &&
    sameMembers(a.sources, b.sources, 'state'));

/** The raw bag behind a (possibly recording) `state`, and the record that owns it. */
const unwrapState = (
  state: StateBag | undefined,
): { readonly raw: StateBag | undefined; readonly owner: StateReads | undefined } => {
  if (state === undefined) return { raw: undefined, owner: undefined };
  const owner = viewOwners.get(state);
  return owner === undefined ? { raw: state, owner: undefined } : { raw: owner.raw, owner };
};

interface NodeViewMemo {
  readonly reads: StateReads;
  owner: StateReads | undefined;
  node: Node<unknown> | undefined;
  ctx: RenderContext<unknown> | undefined;
  element: ReactElement | null;
}

function NodeView({
  ctx,
  node,
}: {
  readonly ctx: RenderContext<unknown>;
  readonly node: Node<unknown>;
}): ReactElement | null {
  const parent = useContext(ReadsContext);
  const memoRef = useRef<NodeViewMemo | undefined>(undefined);
  if (memoRef.current === undefined) {
    memoRef.current = {
      reads: new StateReads(parent),
      owner: undefined,
      node: undefined,
      ctx: undefined,
      element: null,
    };
  }
  const memo = memoRef.current;
  const { reads } = memo;
  const { raw, owner } = unwrapState(ctx.sources.state);

  // A descendant rendering against this node's bag unchanged is retargeted
  // with it, so its handlers see the newest bag even while it is skipped.
  if (owner !== memo.owner) {
    memo.owner?.sharers.delete(reads);
    owner?.sharers.add(reads);
    memo.owner = owner;
  }
  useEffect(
    () => () => {
      memo.owner?.sharers.delete(reads);
    },
    [memo, reads],
  );

  if (
    memo.node === node &&
    memo.ctx !== undefined &&
    sameContextBesideState(memo.ctx, ctx) &&
    reads.unchangedIn(raw)
  ) {
    reads.retarget(raw);
    memo.ctx = ctx;
    // The same element: React skips this subtree without rendering it.
    return memo.element;
  }

  // Rendering: only THIS record moves to the new bag. Its sharers are compared
  // (and moved) as React reaches them; moving them here would make every
  // descendant look unchanged against the very bag it is about to be judged on.
  reads.raw = raw;
  const tracked: RenderContext<unknown> =
    raw === undefined ? ctx : { ...ctx, sources: { ...ctx.sources, state: recordingView(reads) } };
  const body = renderNodeBody(tracked, node);
  const element = <ReadsContext.Provider value={reads}>{body}</ReadsContext.Provider>;
  memo.node = node;
  memo.ctx = ctx;
  memo.element = element;
  return element;
}

// --- The tooltip dismissal listener (Phase 1112) ------------------------------
//
// WCAG 1.4.13 asks that content revealed on hover or focus be DISMISSIBLE without
// moving the pointer or the focus. The reveal itself is pure CSS -- the reference
// stylesheet shows `.fuaran-tooltip` on `:hover` / `:focus-within` of its
// `.fuaran-has-tooltip` wrapper -- so the only thing script has to add is Escape,
// and it adds it by writing `data-fuaran-tooltip-dismissed` on the wrapper, which
// the stylesheet's last rule reads.
//
// ONE DOCUMENT-LEVEL LISTENER, not a per-node handler, for two reasons that are
// not stylistic. A per-node handler only fires when focus is already inside that
// node, so a POINTER user hovering a hint -- the commonest case there is -- could
// never dismiss it; the key event goes to the document. And the node renderer is
// not a component, so it cannot hold an effect of its own.
//
// Installed lazily on the first hint rendered, and idempotent. It writes and
// clears one attribute and touches nothing React owns, so a re-render never
// fights it. Parity-locked with the F# client renderer's twin.
let tooltipDismissalInstalled = false;

const clearDismissedTooltips = (): void => {
  for (const el of Array.from(document.querySelectorAll('[data-fuaran-tooltip-dismissed]'))) {
    if (!el.matches(':hover') && !el.matches(':focus-within')) {
      el.removeAttribute('data-fuaran-tooltip-dismissed');
    }
  }
};

const ensureTooltipDismissal = (): void => {
  if (tooltipDismissalInstalled || typeof document === 'undefined') return;
  tooltipDismissalInstalled = true;

  document.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Escape') return;
    // The hints currently showing are exactly the wrappers under the pointer or
    // holding focus -- the same selector the stylesheet reveals on, so the two
    // can never disagree about which hint Escape is aimed at.
    const showing = document.querySelectorAll(
      '.fuaran-has-tooltip:hover, .fuaran-has-tooltip:focus-within',
    );
    for (const el of Array.from(showing)) {
      el.setAttribute('data-fuaran-tooltip-dismissed', '');
    }
  });

  document.addEventListener('pointerout', clearDismissedTooltips);
  document.addEventListener('focusout', clearDismissedTooltips);
};

let counter = 0;
const correlationId = (): string => {
  counter += 1;
  return `r${counter.toString(36)}`;
};
