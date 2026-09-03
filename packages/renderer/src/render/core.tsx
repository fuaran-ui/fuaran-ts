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

import type { ReactElement, ReactNode } from 'react';

import type { Node, NodeKind, StateBehaviour } from '@fuaran-ui/schema';

import { renderText, resolve } from '../bindings.js';
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
import { motionVar, nodeClassName } from '../classNames.js';
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
        const r = resolve(ctx.sources, on);
        raw = r.kind === 'Resolved' ? r.value : undefined;
      }
      const valueStr = raw === undefined || raw === null ? '' : String(raw);
      const matched = kind.spec.cases.find((c) => c.match === valueStr);
      return renderNode(ctx, matched ? matched.child : kind.spec.default);
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
      };

      return (
        <div className="fuaran-mount-boundary" data-fuaran-mount-scope={spec.scopeId}>
          {renderNode(guestCtx, guestTree)}
        </div>
      );
    }
  }
};

/** Render a Fuaran `Node<TMsg>` to a React element against an explicit context. */
export const renderNode = <TMsg,>(
  ctx: RenderContext<TMsg>,
  node: Node<TMsg>,
  key?: string,
): ReactElement => {
  const id = node.id;

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
    <div key={key} id={id} data-fuaran-node-id={id} className={className} {...attrs}>
      {kindBody}
      {tooltipText !== undefined && (
        <span id={tooltipHintId(id)} className="fuaran-tooltip" role="tooltip">
          {tooltipText}
        </span>
      )}
    </div>
  );
};

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
