// ============================================================================
//  @fuaran-ui/renderer-server/render — the pure-string server renderer.
//
//  Walks a typed Fuaran `Node` tree and emits a body-fragment HTML string,
//  mirroring the structure + class vocabulary the React client renderer
//  (@fuaran-ui/renderer's render/*.tsx) produces, so a server-rendered page
//  hydrates cleanly and is styled by the same packaged reference CSS. The
//  TypeScript twin of the F# `Fuaran.UI.Renderer.Server` and the Python host's
//  `render.py`.
//
//  Server semantics (no client runtime, no dispatch):
//    - interactivity renders INERT — a `Button` is a real `<button>`, dead until
//      hydration; no event handlers are emitted.
//    - a `Link` renders a real, sanitised `<a href>` — the crawlable,
//      no-JavaScript navigation path.
//    - bindings resolve server-side: `Static` to its value, `Query`/`Filter`/…
//      from host-supplied `sources` or the em-dash placeholder.
//    - client-library visualisations (`Chart` / `Map`) render a deterministic
//      labelled placeholder, never a blank.
//    - `Custom` renders the same inert labelled placeholder the client emits when
//      no renderer is registered (the server ships no registry seam).
//
//  The host owns the document shell (`<html>` / `<head>` / the `<link>` to the
//  packaged `@fuaran-ui/renderer/css`); this renderer emits the body fragment.
// ============================================================================

import {
  denyNonLocalEgress,
  type EgressPolicy,
  sanitizeEmbedSrcForEgress,
  sanitizeUrlForEgress,
} from '@fuaran-ui/renderer/egress';
import { sanitizeExtraAttributes } from '@fuaran-ui/renderer/sanitize';
import type {
  Action,
  Binding,
  CardStore,
  ContentHash,
  CellFormat,
  CellKindErased,
  CellValue,
  ColumnErased,
  DefaultSort,
  DisplayKind,
  EmbedPermission,
  ErrorPayload,
  FilterSpec,
  FormField,
  FieldRule,
  InputKind,
  JsonValue,
  LayoutKind,
  MapMarker,
  Node,
  Orientation,
  SelectOption,
  SortDirection,
  StateBehaviour,
  TabHeader,
  ToneVariant,
  VisKind,
} from '@fuaran-ui/schema';

import { cardVerdictMarker, describeFromCard } from '@fuaran-ui/schema';

import {
  accessibilityAttributes,
  forwardsToSemanticElement,
  partitionExtraAttributes,
  tooltipHintId,
  tooltipRidesSemanticElement,
  withTooltipDescribedBy,
} from './accessibility.js';
import {
  asArray,
  type BindingSources,
  emptySources,
  formatNumber,
  renderCellValue,
  renderText,
  resolve,
  resolveScalarFloat,
  type Resolution,
  tryResolve,
  tryResolveScalarFloat,
} from './bindings.js';
import { chartLowerSpecOf, drawingSvg, mathMl } from '@fuaran-ui/renderer';
// Phase 1075 — the `Binding.State` seeding pass. One definition, shared with
// the client renderer, so the two tiers cannot drift on the charter's §4/§5.
import { withStateSeeds } from '@fuaran-ui/ops';
import { isLowered, lower, type ChartRow } from '@fuaran-ui/charts';

import {
  imageAspectClass,
  motionVar,
  nodeClassName,
  toneVar,
  trendSentiment,
} from './classNames.js';
import { type Attr, el, escapeText, textEl, voidEl } from './html.js';
import { toHtmlWithEgress } from './markdown.js';

const EM_DASH = '—';

/**
 * The uniform icon hook (mirrors the F# renderers + the React client): every
 * icon-bearing spec renders its icon as ONE empty placement element —
 * `<span class="fuaran-icon fuaran-{kind}-icon" data-icon="{name}" aria-hidden="true"></span>`.
 * The icon name rides `data-icon`, never the text content; hosts map it to
 * glyphs via their own icon system, and with no mapping the hook renders as
 * nothing (not the raw name).
 */
const iconHook = (kindClass: string, name: string): string =>
  el('span', [
    ['class', `fuaran-icon ${kindClass}`],
    ['data-icon', name],
    ['aria-hidden', 'true'],
  ]);

/**
 * Phase 812 — protected-link emission: every UTF-16 code unit as a decimal
 * HTML entity (`&#78;`). Code-unit iteration (not code points) matches the F#
 * server renderer's per-`char` encode exactly, keeping the two emissions
 * byte-identical.
 */
const entityEncode = (value: string): string => {
  let out = '';
  for (let i = 0; i < value.length; i++) out += `&#${value.charCodeAt(i)};`;
  return out;
};

/** Per-render context: the host binding sources + the fragment registry + cycle guard. */
interface ServerContext {
  readonly sources: BindingSources;
  readonly fragments: ReadonlyMap<string, Node<unknown>>;
  readonly expandingFragments: ReadonlySet<string>;
  /**
   * Phase 1037 — the ambient destination policy (WIRE_FORMAT §14.1), the server
   * twin of the client's `RenderContext.egressPolicy`. Same default
   * (`denyNonLocalEgress`), same reason: an emission cannot declare its own
   * egress, and the server tier renders a decoded tree into a document a
   * browser fetches before any script runs.
   */
  readonly egressPolicy: EgressPolicy;
  /**
   * WIRE_FORMAT.md §25 — host-supplied contract cards. Undefined by default, and
   * an absent store leaves every emitted byte exactly as it was: the
   * identity-only placeholder is unchanged for a host that holds no card, which
   * is what makes the §25.4 obligation free for every existing consumer.
   *
   * This tier ships no custom-renderer registry seam at all, so EVERY `Custom`
   * node here takes the unregistered path — which makes the server renderer the
   * clearest place the card earns its keep, not an edge case in it.
   */
  readonly cards?: CardStore;
}

// ─── Fragment collection + namespacing (port of @fuaran-ui/renderer/context) ──

const collectFragments = (
  acc: Map<string, Node<unknown>>,
  node: Node<unknown>,
): Map<string, Node<unknown>> => {
  const kind = node.kind;
  switch (kind.kind) {
    case 'FragmentDecl':
      acc.set(kind.spec.name, kind.spec.body);
      return collectFragments(acc, kind.spec.body);
    case 'Layout':
      for (const child of kind.layout.spec.children) collectFragments(acc, child);
      return acc;
    case 'ErrorBoundary':
      collectFragments(acc, kind.spec.child);
      collectFragments(acc, kind.spec.fallback);
      return acc;
    case 'Switch':
      for (const c of kind.spec.cases) collectFragments(acc, c.child);
      collectFragments(acc, kind.spec.default);
      return acc;
    default:
      return acc;
  }
};

const namespaceNode = (prefix: string, node: Node<unknown>): Node<unknown> => ({
  ...node,
  id: (prefix + node.id) as Node<unknown>['id'],
  kind: namespaceKind(prefix, node.kind),
});

const namespaceKind = (prefix: string, kind: Node<unknown>['kind']): Node<unknown>['kind'] => {
  switch (kind.kind) {
    case 'Layout': {
      const layout = kind.layout;
      const newSpec = {
        ...layout.spec,
        children: layout.spec.children.map((c) => namespaceNode(prefix, c)),
      };
      return { kind: 'Layout', layout: { ...layout, spec: newSpec } as LayoutKind<unknown> };
    }
    case 'ErrorBoundary':
      return {
        kind: 'ErrorBoundary',
        spec: {
          child: namespaceNode(prefix, kind.spec.child),
          fallback: namespaceNode(prefix, kind.spec.fallback),
        },
      };
    case 'Switch':
      return {
        kind: 'Switch',
        spec: {
          ...kind.spec,
          cases: kind.spec.cases.map((c) => ({
            match: c.match,
            child: namespaceNode(prefix, c.child),
          })),
          default: namespaceNode(prefix, kind.spec.default),
        },
      };
    case 'FragmentDecl':
      return {
        kind: 'FragmentDecl',
        spec: { ...kind.spec, body: namespaceNode(prefix, kind.spec.body) },
      };
    default:
      return kind;
  }
};

// ─── Unwired-action detection (UX hint only — port of context.ts) ─────────────

const containsUnwiredAction = (action: Action<unknown>): boolean => {
  switch (action.kind) {
    case 'Dispatch':
    case 'CommitLocal':
    case 'WriteToClipboard':
    case 'ReadFileBody':
      return false;
    case 'Chain':
      return action.actions.some(containsUnwiredAction);
    case 'Call':
    case 'Notify':
    case 'Navigate':
    case 'SetState':
    case 'AiTool':
    case 'Invoke':
      return true;
  }
};

const UNWIRED_TOOLTIP =
  'This action routes through the runtime substrate (Call/Notify/Navigate/SetState/AiTool).';

// ─── Error payload (server correlation id) ────────────────────────────────────

let counter = 0;
const correlationId = (): string => {
  counter += 1;
  return `s${counter.toString(36)}`;
};
const bindingResolutionError = (message: string): ErrorPayload => ({
  kind: 'BindingResolution',
  message,
  correlationId: correlationId(),
});

/** Resolved-value text for Metric / LabelValueRow value slots (mirrors the client). */
const resolvedValueText = (resolution: Resolution<number>, format: CellFormat): string => {
  switch (resolution.kind) {
    case 'Resolved':
      return formatNumber(format, resolution.value);
    case 'NotResolved':
      return EM_DASH;
    case 'Errored':
      return `(error: ${resolution.message})`;
    case 'I18nUnresolved':
      return `[i18n:${resolution.key}]`;
  }
};

// ─── The node wrapper + kind dispatch ─────────────────────────────────────────

const renderChildren = (ctx: ServerContext, nodes: readonly Node<unknown>[]): string =>
  nodes.map((n) => renderNode(ctx, n)).join('');

const renderNode = (ctx: ServerContext, node: Node<unknown>): string => {
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

  // Accessibility first, then sanitized extra-attributes (extra overrides a11y,
  // mirroring the client's `Object.assign` order).
  //
  // Phase 951 — but routed: a kind whose body IS the node's semantic element
  // takes the a11y attributes (plus the `aria-*` half of extraAttributes) onto
  // that element, leaving the wrapper only the `data-*` addressing half beside
  // data-fuaran-node-id. Every other kind is unchanged. The predicate is shared
  // with the client tier and with both F# renderers, so the placement cannot
  // fork by host.
  const dyn: Record<string, string> = {};
  const semantic: Record<string, string> = {};
  const forwards = forwardsToSemanticElement(node.kind);
  const target = forwards ? semantic : dyn;
  for (const [k, v] of accessibilityAttributes(ctx.sources, node.accessibility)) target[k] = v;
  if (node.extraAttributes !== undefined) {
    const extras = sanitizeExtraAttributes(node.extraAttributes);
    if (forwards) {
      const [dataHalf, ariaHalf] = partitionExtraAttributes(extras);
      Object.assign(dyn, dataHalf);
      Object.assign(semantic, ariaHalf);
    } else {
      Object.assign(dyn, extras);
    }
  }

  // Phase 1112 -- route the hint's description and, where the wrapper is the
  // described element, its focus stop. The two travel together by construction:
  // see `tooltipRidesSemanticElement`.
  if (tooltipText !== undefined) {
    const hintId = tooltipHintId(node.id);
    if (tooltipRidesSemanticElement(node.kind)) {
      withTooltipDescribedBy(hintId, semantic);
    } else {
      withTooltipDescribedBy(hintId, dyn);
      dyn['tabindex'] = '0';
    }
  }

  const attrs: Attr[] = [
    ['id', node.id],
    ['data-fuaran-node-id', node.id],
    ['class', className],
    ...Object.entries(dyn),
  ];

  // The hint element itself -- a sibling of the body inside the wrapper, which is
  // what makes it HOVERABLE: the pointer moving from the node onto the hint never
  // leaves the wrapper, so the `:hover` that revealed it still holds (WCAG
  // 1.4.13). Placed after the body so the reading order is thing-then-description.
  const body = renderKind(ctx, node, Object.entries(semantic));
  const hintEl =
    tooltipText === undefined
      ? ''
      : textEl(
          'span',
          [
            ['id', tooltipHintId(node.id)],
            ['class', 'fuaran-tooltip'],
            ['role', 'tooltip'],
          ],
          tooltipText,
        );
  return el('div', attrs, body + hintEl);
};

const renderKind = (
  ctx: ServerContext,
  node: Node<unknown>,
  // Phase 951 — the node's a11y projection, for the kinds that carry it on
  // their own semantic element. `[]` for every other kind.
  semanticAttrs: readonly Attr[] = [],
): string => {
  const kind = node.kind;
  switch (kind.kind) {
    case 'Layout':
      return renderLayout(ctx, node.id, kind.layout);
    case 'Display':
      return renderDisplay(ctx, node.state, kind.display, semanticAttrs);
    case 'Input':
      return renderInput(ctx, node.id, kind.input, semanticAttrs);
    case 'Visualisation':
      return renderVis(ctx, node.state, kind.visualisation);
    case 'ErrorBoundary':
      // No error server-side — render the child inert (mirrors the client
      // boundary's no-error path).
      return renderNode(ctx, kind.spec.child);
    case 'Switch': {
      // State-bound conditional child (Phase 392). SSR resolves the initial
      // state value from `ctx.sources.state` and renders the matching case —
      // else the default. The client's first render reads the same initial
      // state, so server + client first render match (hydration parity,
      // docs/SSR.md); a post-hydration SetState re-selects a case.
      // Phase 768 — the selector is any Binding. State keeps the direct
      // state-bag read (hydration parity) with the 768-form defaultValue
      // seeding; other bindings resolve through the resolver, so an SSR switch
      // on a pre-seeded Selection renders the branch the client will.
      const on = kind.spec.on;
      let raw: unknown;
      if (on.kind === 'State') {
        raw = ctx.sources.state?.[on.key];
        if (raw === undefined) raw = on.defaultValue;
      } else {
        raw = tryResolve(ctx.sources, on);
      }
      const valueStr = raw === undefined || raw === null ? '' : String(raw);
      const matched = kind.spec.cases.find((c) => c.match === valueStr);
      return renderNode(ctx, matched ? matched.child : kind.spec.default);
    }
    case 'Custom':
      return renderCustom(ctx, kind.moduleId, kind.componentId, kind.props, kind.contentHash);
    case 'FragmentDecl':
      return ''; // zero-paint — the decl is a template, not visible output.
    case 'FragmentRef':
      return renderFragmentRef(ctx, node.id, kind.spec.name);
    case 'Mount':
      // Isolation/embedding boundary (§4o). Declared empty state until the
      // guest loader attaches client-side (Phase 266); the guest scope id is
      // carried as a data attribute so the boundary stays addressable. Mirrors
      // the F# server renderer's Mount arm (never a throw). Full SSR byte-parity
      // corpus coverage is a Phase 142 follow-up.
      return textEl(
        'div',
        [
          ['class', 'fuaran-mount-placeholder'],
          ['data-fuaran-mount-scope', kind.spec.scopeId],
        ],
        `[fuaran:mount '${kind.spec.scopeId}' — guest loader not attached]`,
      );
  }
};

// ─── Layouts ──────────────────────────────────────────────────────────────────

const renderLayout = (
  ctx: ServerContext,
  parentNodeId: string,
  layout: LayoutKind<unknown>,
): string => {
  switch (layout.kind) {
    // Phase 390 — the unified container. Role + layout mode drive the emitted
    // element + classes so each retired kind's HTML/a11y is byte-identical
    // (parity-locked with the React renderer + F# reference).
    case 'Box': {
      const spec = layout.spec;
      if (spec.role === 'Card') {
        const header =
          spec.heading !== undefined
            ? textEl(
                'header',
                [['class', 'fuaran-card-heading']],
                renderText(ctx.sources, spec.heading),
              )
            : '';
        const body = el('div', [['class', 'fuaran-card-body']], renderChildren(ctx, spec.children));
        return el('section', [['class', 'fuaran-layout-card']], header + body);
      }
      if (spec.role === 'Dashboard' || spec.layout.kind === 'Auto') {
        return el(
          'div',
          [['class', 'fuaran-layout-dashboard']],
          renderChildren(ctx, spec.children),
        );
      }
      if (spec.role === 'Separator') {
        return voidEl('hr', [['class', 'fuaran-layout-separator']]);
      }
      if (spec.layout.kind === 'Grid') {
        const g = spec.layout;
        const templateColumns =
          g.templateColumns !== undefined ? g.templateColumns : `repeat(${g.cols}, 1fr)`;
        // `gap` (Phase 459) emits only when set — gap-free grids stay
        // byte-identical to the pre-459 emission (SSR parity with the client).
        const gridStyle =
          g.gap !== undefined
            ? `grid-template-columns:${templateColumns};gap:${g.gap}px`
            : `grid-template-columns:${templateColumns}`;
        return el(
          'div',
          [
            ['class', 'fuaran-layout-grid'],
            ['style', gridStyle],
          ],
          renderChildren(ctx, spec.children),
        );
      }
      if (spec.layout.kind === 'Masonry') {
        // WIRE_FORMAT §3.6.7 — column-fill, realised with the CSS multi-column
        // family. `grid-template-rows: masonry` is NOT the mechanism and must
        // not be substituted: it is not deterministically supported across
        // engines, so a document rendered through it would lay out differently
        // depending on which browser read it.
        const m = spec.layout;
        const masonryStyle =
          m.gap !== undefined ? `column-count:${m.cols};gap:${m.gap}px` : `column-count:${m.cols}`;
        return el(
          'div',
          [
            ['class', 'fuaran-layout-masonry'],
            ['style', masonryStyle],
          ],
          renderChildren(ctx, spec.children),
        );
      }
      const f = spec.layout;
      const dir =
        f.kind === 'Flex' && f.direction === 'Horizontal'
          ? 'fuaran-stack-horizontal'
          : 'fuaran-stack-vertical';
      const wrap = f.kind === 'Flex' && f.wrap ? ' fuaran-stack-wrap' : '';
      // `gap` emits only when set (Phase 459) — a gap-free stack carries no
      // `style` attribute, byte-identical to the pre-459 emission.
      const flexGap = f.kind === 'Flex' ? f.gap : undefined;
      const stackAttrs: Attr[] =
        flexGap !== undefined
          ? [
              ['class', `fuaran-layout-stack ${dir}${wrap}`],
              ['style', `gap:${flexGap}px`],
            ]
          : [['class', `fuaran-layout-stack ${dir}${wrap}`]];
      return el('div', stackAttrs, renderChildren(ctx, spec.children));
    }

    case 'SplitPanel': {
      const weightLeft = Math.max(0, Math.min(1, layout.spec.weight));
      const weightRight = 1 - weightLeft;
      const rendered = layout.spec.children.map((c) => renderNode(ctx, c));
      const left = el(
        'div',
        [
          ['class', 'fuaran-split-pane fuaran-split-pane-left'],
          ['style', `flex:${weightLeft.toFixed(6)} 1 0`],
        ],
        rendered.slice(0, 1).join(''),
      );
      const right = el(
        'div',
        [
          ['class', 'fuaran-split-pane fuaran-split-pane-right'],
          ['style', `flex:${weightRight.toFixed(6)} 1 0`],
        ],
        rendered.slice(1).join(''),
      );
      return el('div', [['class', 'fuaran-layout-split-panel']], left + right);
    }

    case 'Tabs':
      return renderTabs(ctx, parentNodeId, layout.spec);

    case 'SummaryList': {
      const header =
        layout.spec.heading !== undefined
          ? textEl(
              'header',
              [['class', 'fuaran-summary-list-heading']],
              renderText(ctx.sources, layout.spec.heading),
            )
          : '';
      const body = el(
        'div',
        [['class', 'fuaran-summary-list-body']],
        renderChildren(ctx, layout.spec.children),
      );
      return el('section', [['class', 'fuaran-layout-summary-list']], header + body);
    }

    case 'Disclosure': {
      const resolvedOpen = tryResolve(ctx.sources, layout.spec.open) ?? layout.spec.defaultOpen;
      const summary = textEl(
        'summary',
        [['class', 'fuaran-disclosure-summary']],
        renderText(ctx.sources, layout.spec.heading),
      );
      const body = el(
        'div',
        [['class', 'fuaran-disclosure-body']],
        renderChildren(ctx, layout.spec.children),
      );
      return el(
        'details',
        [
          ['class', 'fuaran-layout-disclosure'],
          ['open', resolvedOpen === true],
        ],
        summary + body,
      );
    }

    case 'Modal': {
      // Phase 289 overlay render-fidelity contract: ALWAYS in the DOM (no
      // portal); closed = the `hidden` attribute; positioned by CSS. Inert
      // server-side (handlers attach on hydration). Body order: heading, dismiss
      // button, then the children body — parity-locked with the client + F#.
      const isOpen = tryResolve(ctx.sources, layout.spec.open) === true;
      const heading =
        layout.spec.heading !== undefined
          ? textEl(
              'h2',
              [['class', 'fuaran-modal-heading']],
              renderText(ctx.sources, layout.spec.heading),
            )
          : '';
      const dismiss = layout.spec.dismissable
        ? textEl(
            'button',
            [
              ['class', 'fuaran-modal-dismiss'],
              ['type', 'button'],
              ['aria-label', 'Close'],
            ],
            '×',
          )
        : '';
      const body = el(
        'div',
        [['class', 'fuaran-modal-body']],
        renderChildren(ctx, layout.spec.children),
      );
      const dialog = el(
        'div',
        [
          ['class', 'fuaran-modal-dialog'],
          ['role', 'dialog'],
          ['aria-modal', 'true'],
        ],
        heading + dismiss + body,
      );
      const overlayAttrs: Attr[] = [['class', 'fuaran-modal-overlay']];
      if (!isOpen) overlayAttrs.push(['hidden', true]);
      return el('div', overlayAttrs, dialog);
    }

    case 'ScrollArea': {
      // Phase 289 — overflow/scroll container. The scroll axis is a class (CSS
      // owns `overflow`); optional pixel bounds are an inline max-height /
      // max-width style (identical SSR↔CSR).
      const axisClass =
        layout.spec.orientation === 'Horizontal'
          ? 'fuaran-scrollarea fuaran-scrollarea-horizontal'
          : layout.spec.orientation === 'Both'
            ? 'fuaran-scrollarea fuaran-scrollarea-both'
            : 'fuaran-scrollarea fuaran-scrollarea-vertical';
      const styleParts: string[] = [];
      if (layout.spec.maxHeight !== undefined)
        styleParts.push(`max-height:${layout.spec.maxHeight}px`);
      if (layout.spec.maxWidth !== undefined)
        styleParts.push(`max-width:${layout.spec.maxWidth}px`);
      const attrs: Attr[] = [
        ['class', axisClass],
        ['tabindex', 0],
      ];
      if (styleParts.length > 0) attrs.push(['style', styleParts.join(';')]);
      return el('div', attrs, renderChildren(ctx, layout.spec.children));
    }

    case 'Stepper': {
      const activeIndex = tryResolve(ctx.sources, layout.spec.activeStep) ?? 0;
      const children = layout.spec.children;
      const steps = children
        .map((_, i) =>
          textEl(
            'li',
            [
              [
                'class',
                i === activeIndex
                  ? 'fuaran-stepper-step fuaran-stepper-step-active'
                  : 'fuaran-stepper-step',
              ],
            ],
            String(i + 1),
          ),
        )
        .join('');
      const numbers = el('ol', [['class', 'fuaran-stepper-numbers']], steps);
      const activeChild = children[activeIndex];
      const body = el(
        'div',
        [['class', 'fuaran-stepper-body']],
        activeChild !== undefined ? renderNode(ctx, activeChild) : '',
      );
      return el('div', [['class', 'fuaran-layout-stepper']], numbers + body);
    }
  }
};

// ─── Tabs ───────────────────────────────────────────────────────────────────

interface PerTab {
  readonly label: string;
  readonly icon: string | undefined;
  readonly disabled: boolean;
}

const renderTabs = (
  ctx: ServerContext,
  parentNodeId: string,
  spec: Extract<LayoutKind<unknown>, { kind: 'Tabs' }>['spec'],
): string => {
  const labelFromChild = (child: Node<unknown>): string => {
    if (
      child.kind.kind === 'Layout' &&
      child.kind.layout.kind === 'Box' &&
      child.kind.layout.spec.role === 'Card'
    ) {
      const heading = child.kind.layout.spec.heading;
      if (heading !== undefined) return renderText(ctx.sources, heading);
    }
    return child.id;
  };

  const perTab: PerTab[] =
    spec.tabHeaders !== undefined
      ? spec.tabHeaders.map((h: TabHeader) => ({
          label: renderText(ctx.sources, h.label),
          icon: h.icon,
          disabled:
            (h.disabled !== undefined ? tryResolve(ctx.sources, h.disabled) : undefined) ?? false,
        }))
      : spec.children.map((child) => ({
          label: labelFromChild(child),
          icon: undefined,
          disabled: false,
        }));

  const orientationClass =
    spec.orientation === 'Vertical' ? 'fuaran-tabs-vertical' : 'fuaran-tabs-horizontal';
  const isVertical = spec.orientation === 'Vertical';

  const resolvedFromTag = ((): number | undefined => {
    if (spec.tabTags !== undefined && spec.activeTag !== undefined) {
      const tag = tryResolve(ctx.sources, spec.activeTag);
      if (tag !== undefined) {
        const idx = spec.tabTags.indexOf(tag);
        return idx >= 0 ? idx : undefined;
      }
    }
    return undefined;
  })();

  const rawIndex = resolvedFromTag ?? tryResolve(ctx.sources, spec.activeIndex) ?? 0;
  const activeIndex = Math.min(Math.max(0, rawIndex), Math.max(0, spec.children.length - 1));
  const activeChild = spec.children[activeIndex] ?? spec.children[0];

  const tabId = (i: number): string => `${parentNodeId}-tab-${i}`;
  const panelId = (i: number): string => `${parentNodeId}-panel-${i}`;

  const tabs = perTab
    .map((t, i) => {
      const isActive = i === activeIndex;
      const cls = [
        'fuaran-tab',
        isActive ? 'fuaran-tab-active' : '',
        t.disabled ? 'fuaran-tab-disabled' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const inner =
        (t.icon !== undefined ? iconHook('fuaran-tab-icon', t.icon) : '') +
        textEl('span', [['class', 'fuaran-tab-label']], t.label);
      const attrs: Attr[] = [
        ['id', tabId(i)],
        ['class', cls],
        ['role', 'tab'],
        ['aria-selected', isActive ? 'true' : 'false'],
        ['aria-controls', panelId(i)],
        ['tabindex', isActive ? 0 : -1],
        ['data-tab-index', i],
      ];
      if (t.disabled) {
        attrs.push(['aria-disabled', 'true'], ['disabled', true]);
      }
      return el('button', attrs, inner);
    })
    .join('');

  const bar = el(
    'div',
    [
      ['class', 'fuaran-tabs-bar'],
      ['role', 'tablist'],
      ['aria-orientation', isVertical ? 'vertical' : 'horizontal'],
    ],
    tabs,
  );

  const panel =
    activeChild !== undefined
      ? el(
          'div',
          [
            ['id', panelId(activeIndex)],
            ['role', 'tabpanel'],
            ['aria-labelledby', tabId(activeIndex)],
            ['tabindex', 0],
            ['class', 'fuaran-tabs-panel'],
          ],
          renderNode(ctx, activeChild),
        )
      : '';
  const panels = el('div', [['class', 'fuaran-tabs-panels']], panel);
  return el('div', [['class', `fuaran-layout-tabs ${orientationClass}`]], bar + panels);
};

// ─── Displays ─────────────────────────────────────────────────────────────────

const renderDisplay = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  display: DisplayKind,
  // Phase 951 — the node's a11y projection, for the kinds whose body IS the
  // node's semantic element (here: Link and Image). `[]` everywhere else.
  semanticAttrs: readonly Attr[] = [],
): string => {
  switch (display.kind) {
    case 'Heading': {
      const variantSuffix =
        display.spec.variant === 'Eyebrow'
          ? ' fuaran-heading-eyebrow'
          : display.spec.variant === 'Caption'
            ? ' fuaran-heading-caption'
            : display.spec.variant === 'Lead'
              ? ' fuaran-heading-lead'
              : '';
      const level = display.spec.level;
      const tag = level >= 1 && level <= 6 ? `h${level}` : 'h6';
      return textEl(
        tag,
        [['class', `fuaran-heading${variantSuffix}`]],
        renderText(ctx.sources, display.spec.text),
      );
    }

    case 'Markdown':
      // Returns already-sanitised HTML — inserted raw (the innerHTML seam).
      // Phase 1037 — rendered under the SAME ambient policy the `Link` / `Image`
      // arms consult, so a markdown body's own links and images are policed
      // exactly as the tree's own destinations are. Byte-parity with the client
      // arm holds because both tiers call the one deterministic renderer with
      // the same policy.
      return el(
        'div',
        [['class', 'fuaran-markdown']],
        toHtmlWithEgress(ctx.egressPolicy, renderText(ctx.sources, display.spec.text)),
      );

    case 'Metric':
      return renderMetric(ctx, state, display.spec);

    case 'Badge':
      return textEl(
        'span',
        [['class', `fuaran-badge fuaran-badge-${display.spec.variant.toLowerCase()}`]],
        renderText(ctx.sources, display.spec.label),
      );

    case 'Skeleton':
      return el(
        'div',
        [['class', 'fuaran-skeleton']],
        Array.from({ length: display.spec.rows }, () =>
          el('div', [['class', 'fuaran-skeleton-row']]),
        ).join(''),
      );

    case 'Icon': {
      // Phase 821 — the standalone icon-only display kind. The glyph NAME
      // rides `data-icon` (the uniform icon-hook contract — no text content,
      // hosts map it to glyphs); size + tone are modifier classes. A11y:
      // decorative (no label) emits `aria-hidden="true"`; labelled emits
      // `role="img"` + `aria-label`. Mirrors the F# SSR renderer byte-for-byte.
      const spec = display.spec;
      const attrs: [string, string][] = [
        [
          'class',
          `fuaran-icon fuaran-icon--${spec.size.toLowerCase()} fuaran-icon-${toneVar(spec.tone)}`,
        ],
        ['data-icon', spec.icon],
      ];
      if (spec.label !== undefined) {
        attrs.push(['role', 'img'], ['aria-label', spec.label]);
      } else {
        attrs.push(['aria-hidden', 'true']);
      }
      return el('span', attrs);
    }

    case 'Callout':
      return renderCallout(ctx, display.spec);

    case 'Progress':
      return renderProgress(ctx, state, display.spec);

    case 'Sparkline':
      return renderSparkline(ctx, display.spec);

    case 'Drawing':
      // Phase 525 — the SAME canonical SVG string the client emits (so the
      // class sets are parity by construction), inserted raw like Markdown.
      return el('div', [], drawingSvg(ctx.sources, display.spec));

    case 'LabelValueRow':
      return renderLabelValueRow(ctx, state, display.spec);

    case 'Fact': {
      // A labeled TEXT fact tile — Metric's chrome for a TextSource value.
      // renderText resolves Literal/Bound/I18n exactly as it does for labels.
      const spec = display.spec;
      const emphasisSuffix = spec.emphasis ? ' fuaran-fact-emphasis' : '';
      const valueInner =
        (spec.icon !== undefined ? iconHook('fuaran-fact-icon', spec.icon) : '') +
        textEl('span', [], renderText(ctx.sources, spec.value));
      const inner =
        textEl('div', [['class', 'fuaran-fact-label']], renderText(ctx.sources, spec.label)) +
        el('div', [['class', 'fuaran-fact-value']], valueInner) +
        (spec.help !== undefined
          ? textEl('div', [['class', 'fuaran-fact-help']], renderText(ctx.sources, spec.help))
          : '');
      return el(
        'div',
        [['class', `fuaran-fact fuaran-fact-${toneVar(spec.tone)}${emphasisSuffix}`]],
        inner,
      );
    }

    case 'Link': {
      // Phase 1037 — the ambient destination policy; the client tier's `Link`
      // arm makes the identical call with the identical class, which is what
      // keeps the two emitted hrefs parity-locked. `download` is deliberately
      // NOT the class even when set: the class names the SINK the browser
      // reaches, and flipping a tree boolean must not change which rule applies.
      const [href, egressAttrs] = sanitizeUrlForEgress(
        ctx.egressPolicy,
        'hyperlink',
        tryResolve(ctx.sources, display.spec.href) ?? '',
      );
      if (display.spec.protection === 'email' && href.startsWith('mailto:')) {
        // Phase 812 — protected email link. Every character of the sanitised
        // href AND the label is emitted as a decimal HTML entity: the browser
        // decodes entities in both positions, so the anchor is a working
        // `mailto:` with no JavaScript while the raw source carries no
        // scrapeable address. Encoding every character (not just specials)
        // makes the fragment injection-proof by construction, which is why the
        // anchor is built as a raw string below `el`'s escaping floor —
        // `escapeAttr` would re-escape the entities. Byte-identical to the F#
        // server renderer's emission; the client renderer emits the same
        // structure with the decoded href (DOMs identical post entity-decode).
        const anchor =
          '<a class="fuaran-link fuaran-link-protected" href="' +
          entityEncode(href) +
          '">' +
          entityEncode(renderText(ctx.sources, display.spec.label)) +
          '</a>';
        // Phase 951 — the anchor here is an entity-encoded opaque string, so
        // the projection lands on the wrap <span>: the only element this arm
        // owns in every tier, and parity outranks reaching one tier's anchor.
        return el('span', [['class', 'fuaran-link-protected-wrap'], ...semanticAttrs], anchor);
      }
      const attrs: Attr[] = [
        ['class', 'fuaran-link'],
        ['href', href],
      ];
      if (display.spec.rel !== undefined) attrs.push(['rel', display.spec.rel]);
      if (display.spec.target !== undefined) attrs.push(['target', display.spec.target]);
      if (display.spec.download) attrs.push(['download', true]);
      // Phase 951 — the node's a11y projection lands on the anchor.
      attrs.push(...semanticAttrs);
      // Phase 1037 — the refusal marker rides the element carrying the refused
      // href. Empty on an allow.
      attrs.push(...egressAttrs);
      return textEl('a', attrs, renderText(ctx.sources, display.spec.label));
    }

    case 'Image': {
      // Phase 1037 — `media`: the class the browser fetches with no user act.
      const [src, egressAttrs] = sanitizeUrlForEgress(
        ctx.egressPolicy,
        'media',
        tryResolve(ctx.sources, display.spec.src) ?? '',
      );
      const variantClass =
        display.spec.variant === 'Avatar'
          ? 'fuaran-image fuaran-image-avatar'
          : display.spec.variant === 'Rounded'
            ? 'fuaran-image fuaran-image-rounded'
            : 'fuaran-image';
      // Phase 1077 — the presentation tokens map to classes and nothing else:
      // no value from the tree ever reaches a style attribute. `Natural` emits
      // NO class on either axis, so a pre-phase tree's class attribute is
      // byte-identical to what it was.
      const fitClass =
        display.spec.fit === 'Cover'
          ? ' fuaran-image-fit-cover'
          : display.spec.fit === 'Contain'
            ? ' fuaran-image-fit-contain'
            : '';
      const aspectClass = imageAspectClass(display.spec.aspectRatio);
      // Phase 1077 — `Eager` emits no attribute at all (the browser default);
      // only `Lazy` is a declaration.
      const loadingAttrs: (readonly [string, string])[] =
        display.spec.loading === 'Lazy' ? [['loading', 'lazy']] : [];
      // Phase 1080 — the responsive candidate list. Every candidate goes through
      // the SAME `media`-class egress seam the primary `src` does; a refused one
      // is DROPPED rather than neutered into the list, leaving the primary `src`
      // as the fallback the whole mechanism rests on. Ascending by width is the
      // RENDERER's canonicalisation — the wire keeps authored order — and the
      // sort is stable, so equal widths keep theirs.
      const srcSetCandidates = [...display.spec.srcSet]
        .sort((a, b) => a.width - b.width)
        .flatMap((entry) => {
          const [safe, refusal] = sanitizeUrlForEgress(
            ctx.egressPolicy,
            'media',
            tryResolve(ctx.sources, entry.src) ?? '',
          );
          return safe === '' || refusal.length > 0 ? [] : [`${safe} ${entry.width}w`];
        });
      // `sizes` is bounded to the one value the tree can justify — nothing in
      // the document says how wide the element will be laid out.
      const srcSetAttrs: (readonly [string, string])[] =
        srcSetCandidates.length > 0
          ? [
              ['srcset', srcSetCandidates.join(', ')],
              ['sizes', '100vw'],
            ]
          : [];
      // Phase 951 — the a11y projection lands on the <img> itself.
      const img = voidEl('img', [
        ['class', variantClass + fitClass + aspectClass],
        ['src', src],
        ['alt', renderText(ctx.sources, display.spec.alt)],
        ...srcSetAttrs,
        ...loadingAttrs,
        ...semanticAttrs,
        ...egressAttrs,
      ]);
      // Phase 1078 — the caption. Absent returns the <img> UNTOUCHED: there is
      // no wrapper to be byte-identical to, because there is no wrapper.
      // Present wraps it in the semantic pair, which is the binding an ad-hoc
      // sibling text node never had. Nothing moves onto the <figure> — the a11y
      // projection, the egress marker and the sanitised src stay on the
      // element they describe.
      // Phase 1079 — the expansion affordance. The BASELINE is a real link:
      // `<a href="{the sanitised src}">` around the `<img>` means a reader with
      // no JavaScript clicks the picture and gets the full-size asset in the
      // browser's own viewer. `data-fuaran-expandable` is a marker ON a working
      // link, never the mechanism — it is what the enhancement tier reads.
      //
      // A refused `src` emits NO anchor: the `<img>`'s `src` must exist so it
      // collapses to the refusal URL, but an anchor has no such obligation, and
      // a link to `about:blank` is the dead control this design avoids. The
      // image still renders, carrying its refusal marker.
      //
      // Nothing crosses the dispatch gate: no action, no handler, no onclick.
      const expandable =
        display.spec.expandable && src !== '' && egressAttrs.length === 0
          ? el(
              'a',
              [
                ['class', 'fuaran-image-expand'],
                ['href', src],
                ['data-fuaran-expandable', ''],
              ],
              img,
            )
          : img;
      // Phase 1079 — `<figure>` wraps `<a>` wraps `<img>`; the `<figcaption>` is
      // the anchor's SIBLING, so the caption is outside the link target.
      if (display.spec.caption === undefined) return expandable;
      return el(
        'figure',
        [['class', 'fuaran-image-figure']],
        expandable +
          textEl(
            'figcaption',
            [['class', 'fuaran-image-figure-caption']],
            renderText(ctx.sources, display.spec.caption),
          ),
      );
    }

    case 'Media': {
      // Phase 1076 — the media transport, structural parity with the React arm
      // and with both F# renderers. The four contract points are stated at
      // length in WIRE_FORMAT §3.6.6; in brief, and in the order they appear
      // below: `aria-label` unconditionally (the label is mandatory and has no
      // decorative case); both URLs through the same `media` egress seam, with
      // a refused poster DROPPED where a refused `src` collapses; `autoplay`
      // never emitted without `muted`; and no autoplay pathway on `Audio` at
      // all, because the case declares no slot to read.
      const [src, egressAttrs] = sanitizeUrlForEgress(
        ctx.egressPolicy,
        'media',
        tryResolve(ctx.sources, display.spec.src) ?? '',
      );
      const shared: Attr[] = [
        ['src', src],
        ['aria-label', renderText(ctx.sources, display.spec.label)],
        ...(display.spec.controls ? ([['controls', true]] as Attr[]) : []),
        ...(display.spec.loop ? ([['loop', true]] as Attr[]) : []),
        ...semanticAttrs,
        ...egressAttrs,
      ];
      if (display.spec.kind.$type === 'Audio') {
        // `el`, not `voidEl`: `<video>` / `<audio>` are NOT void elements. A
        // self-closed `<video …/>` leaves the parser inside the element and
        // swallows the rest of the document as its fallback content — the one
        // mistake here that produces a page that looks broken everywhere
        // EXCEPT the node that caused it.
        return el('audio', [['class', 'fuaran-media fuaran-media-audio'], ...shared]);
      }
      const posterBinding = display.spec.kind.poster;
      const posterAttrs: Attr[] = [];
      if (posterBinding !== undefined) {
        const [safePoster, posterRefusal] = sanitizeUrlForEgress(
          ctx.egressPolicy,
          'media',
          tryResolve(ctx.sources, posterBinding) ?? '',
        );
        if (safePoster !== '' && posterRefusal.length === 0)
          posterAttrs.push(['poster', safePoster]);
      }
      const autoplayAttrs: Attr[] = display.spec.kind.autoplay
        ? [
            ['autoplay', true],
            ['muted', true],
          ]
        : [];
      return el('video', [
        ['class', 'fuaran-media fuaran-media-video'],
        ...shared,
        ...posterAttrs,
        ...autoplayAttrs,
      ]);
    }

    case 'Embed': {
      // Phase 1111 — the sandboxed third-party embed, structural parity with
      // both F# renderers. Four contract points, stated at length in
      // WIRE_FORMAT §3.6.8 and in the order they appear below: the `sandbox`
      // attribute emitted ALWAYS and EMPTY when nothing is granted (omitting it
      // on a permissionless embed would be the same markup as an unsandboxed
      // frame); the tokens in the vocabulary's DECLARATION order and
      // de-duplicated, so two documents naming the same set produce identical
      // markup whatever order they authored; fullscreen riding `allow` rather
      // than `sandbox`, because it is a permissions-policy directive and not a
      // sandbox token; and a refused `src` DROPPED entirely rather than pointed
      // at the refusal URL, because an iframe at that URL renders that page.
      const [embedSrc, embedEgressAttrs] = sanitizeEmbedSrcForEgress(
        ctx.egressPolicy,
        tryResolve(ctx.sources, display.spec.src) ?? '',
      );
      const has = (p: EmbedPermission): boolean => display.spec.permissions.includes(p);
      const sandboxTokens: string[] = [];
      if (has('AllowScripts')) sandboxTokens.push('allow-scripts');
      if (has('AllowSameOrigin')) sandboxTokens.push('allow-same-origin');
      if (has('AllowForms')) sandboxTokens.push('allow-forms');
      const aspectClass =
        display.spec.aspectRatio === 'Natural'
          ? ''
          : display.spec.aspectRatio === 'Square'
            ? ' fuaran-embed-aspect-square'
            : display.spec.aspectRatio === 'FourThree'
              ? ' fuaran-embed-aspect-four-three'
              : display.spec.aspectRatio === 'ThreeTwo'
                ? ' fuaran-embed-aspect-three-two'
                : ' fuaran-embed-aspect-sixteen-nine';
      // `el`, not `voidEl`: `<iframe>` is NOT a void element, and a self-closed
      // one leaves the parser inside it — the `<video>` trap one kind over.
      return el('iframe', [
        ['class', 'fuaran-embed' + aspectClass],
        ['title', renderText(ctx.sources, display.spec.title)],
        ['sandbox', sandboxTokens.join(' ')],
        ['loading', 'lazy'],
        ['referrerpolicy', 'strict-origin-when-cross-origin'],
        ...(embedSrc === undefined ? [] : ([['src', embedSrc]] as Attr[])),
        ...(has('AllowFullscreen') ? ([['allow', 'fullscreen']] as Attr[]) : []),
        ...semanticAttrs,
        ...embedEgressAttrs,
      ]);
    }

    case 'List': {
      const items = display.spec.items
        .map((item) => textEl('li', [['class', 'fuaran-list-item']], renderText(ctx.sources, item)))
        .join('');
      return display.spec.ordered
        ? el('ol', [['class', 'fuaran-list fuaran-list-ordered']], items)
        : el('ul', [['class', 'fuaran-list fuaran-list-unordered']], items);
    }

    case 'Toast': {
      const isOpen = tryResolve(ctx.sources, display.spec.open) === true;
      const toneClass = toneVar(display.spec.tone);
      const message = textEl(
        'span',
        [['class', 'fuaran-toast-message']],
        renderText(ctx.sources, display.spec.message),
      );
      const dismiss = display.spec.dismissable
        ? textEl(
            'button',
            [
              ['class', 'fuaran-toast-dismiss'],
              ['type', 'button'],
              ['aria-label', 'Dismiss'],
            ],
            '×',
          )
        : '';
      const attrs: Attr[] = [
        ['class', `fuaran-toast fuaran-toast-${toneClass}`],
        ['role', 'status'],
        ['aria-live', 'polite'],
      ];
      if (!isOpen) attrs.push(['hidden', true]);
      return el('div', attrs, message + dismiss);
    }

    case 'CodeBlock': {
      // Phase 290 — DETERMINISTIC <pre><code> (HTML-escaped, NO markdown
      // library), byte-identical SSR↔CSR. Syntax highlighting is a client-only
      // post-hydration enhancement keyed on `language-{x}` — not emitted here.
      const spec = display.spec;
      const containerClass = spec.lineNumbers
        ? 'fuaran-codeblock fuaran-codeblock-numbered'
        : 'fuaran-codeblock';
      const copy = spec.copyable
        ? textEl(
            'button',
            [
              ['class', 'fuaran-codeblock-copy'],
              ['type', 'button'],
              ['aria-label', 'Copy'],
            ],
            'Copy',
          )
        : '';
      const code = el(
        'pre',
        [['class', 'fuaran-codeblock-pre']],
        textEl('code', [['class', `fuaran-codeblock-code language-${spec.language}`]], spec.code),
      );
      const attrs: Attr[] = [
        ['class', containerClass],
        ['data-language', spec.language],
      ];
      if (spec.highlightLines.length > 0) {
        attrs.push(['data-highlight-lines', spec.highlightLines.join(',')]);
      }
      return el('div', attrs, copy + code);
    }

    case 'Math': {
      // Phase 658 — DETERMINISTIC native MathML for the closed subset (real
      // superscripts, no JS), else the raw escaped-source span. Byte-identical
      // to the client renderer via the shared `mathMl` builder. KaTeX upgrades
      // either shape client-only (targets the `.fuaran-math` container), outside
      // parity. See fuaran-dotnet/docs/MATH-DEGRADATION.md.
      const spec = display.spec;
      const markup = mathMl(spec.source, spec.display);
      const isBlock = spec.display === 'Block';
      const attrs: Attr[] = [
        ['class', isBlock ? 'fuaran-math fuaran-math-block' : 'fuaran-math fuaran-math-inline'],
        ['data-math-display', isBlock ? 'block' : 'inline'],
        ['data-fuaran-math-src', spec.source],
      ];
      const inner =
        markup !== null ? markup : textEl('span', [['class', 'fuaran-math-source']], spec.source);
      return el(isBlock ? 'div' : 'span', attrs, inner);
    }
  }
};

const renderMetric = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  spec: Extract<DisplayKind, { kind: 'Metric' }>['spec'],
): string => {
  // Phase 632 — the Metric value is a scalar slot: a `Binding.Transform`
  // resolves to its 1×1 result cell (a global aggregate / row-field lookup).
  const resolution = resolveScalarFloat(ctx.sources, spec.value);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const parts = [
    ...(spec.icon !== undefined ? [iconHook('fuaran-metric-icon', spec.icon)] : []),
    textEl('div', [['class', 'fuaran-metric-label']], renderText(ctx.sources, spec.label)),
    textEl('div', [['class', 'fuaran-metric-value']], resolvedValueText(resolution, spec.format)),
  ];
  if (spec.trend !== undefined) {
    // Phase 867 — mirrors the client renderer byte-for-byte: the trend element
    // carries a SENTIMENT (sign, and from Part B the declared polarity), not an
    // unconditional success class. `tone` still colours the tile alone.
    const t = tryResolveScalarFloat(ctx.sources, spec.trend);
    if (t === undefined) {
      parts.push(textEl('div', [['class', 'fuaran-metric-trend']], ''));
    } else {
      const [sentiment, glyph] = trendSentiment(spec.trendPolarity, t);
      parts.push(
        el(
          'div',
          [['class', `fuaran-metric-trend fuaran-metric-trend-${sentiment}`]],
          textEl(
            'span',
            [
              ['class', 'fuaran-metric-trend-glyph'],
              ['role', 'img'],
              ['aria-label', sentiment],
            ],
            glyph,
          ) + escapeText(formatNumber(spec.trendFormat ?? { kind: 'None' }, t)),
        ),
      );
    }
  }
  if (spec.subtext !== undefined) {
    parts.push(
      textEl('div', [['class', 'fuaran-metric-subtext']], renderText(ctx.sources, spec.subtext)),
    );
  }
  return el(
    'div',
    [['class', `fuaran-metric fuaran-metric-${toneVar(spec.tone)}`]],
    parts.join(''),
  );
};

const renderCallout = (
  ctx: ServerContext,
  spec: Extract<DisplayKind, { kind: 'Callout' }>['spec'],
): string => {
  const icon = spec.icon !== undefined ? iconHook('fuaran-callout-icon', spec.icon) : '';
  const heading =
    spec.heading !== undefined
      ? textEl('div', [['class', 'fuaran-callout-heading']], renderText(ctx.sources, spec.heading))
      : '';
  const body = textEl(
    'div',
    [['class', 'fuaran-callout-body']],
    renderText(ctx.sources, spec.body),
  );
  const dismiss = spec.dismissable
    ? textEl(
        'button',
        [
          ['class', 'fuaran-callout-dismiss'],
          ['aria-label', 'Dismiss'],
        ],
        '×',
      )
    : '';
  return el(
    'div',
    [['class', `fuaran-callout fuaran-callout-${toneVar(spec.tone)}`]],
    icon + heading + body + dismiss,
  );
};

const renderProgress = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  spec: Extract<DisplayKind, { kind: 'Progress' }>['spec'],
): string => {
  const resolution = resolve(ctx.sources, spec.fraction);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const fraction = resolution.kind === 'Resolved' ? resolution.value : 0;
  const indeterminate = spec.indeterminate ? ' fuaran-progress-indeterminate' : '';
  const label =
    spec.label !== undefined
      ? textEl('div', [['class', 'fuaran-progress-label']], renderText(ctx.sources, spec.label))
      : '';
  const fill = el('div', [
    ['class', 'fuaran-progress-fill'],
    ['style', `width:${fraction * 100}%`],
  ]);
  const bar = el('div', [['class', 'fuaran-progress-bar']], fill);
  const caveat =
    spec.caveat !== undefined
      ? textEl('div', [['class', 'fuaran-progress-caveat']], renderText(ctx.sources, spec.caveat))
      : '';
  return el(
    'div',
    [['class', `fuaran-progress fuaran-progress-${toneVar(spec.tone)}${indeterminate}`]],
    label + bar + caveat,
  );
};

const renderLabelValueRow = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  spec: Extract<DisplayKind, { kind: 'LabelValueRow' }>['spec'],
): string => {
  // Phase 632 — a scalar slot: Transform resolves to its 1×1 result cell.
  const resolution = resolveScalarFloat(ctx.sources, spec.value);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const emphasisSuffix = spec.emphasis ? ' fuaran-label-value-row-emphasis' : '';
  const help =
    spec.help !== undefined
      ? textEl(
          'span',
          [['class', 'fuaran-label-value-row-help']],
          renderText(ctx.sources, spec.help),
        )
      : '';
  const labelBlock = el(
    'div',
    [['class', 'fuaran-label-value-row-label-block']],
    textEl(
      'span',
      [['class', 'fuaran-label-value-row-label']],
      renderText(ctx.sources, spec.label),
    ) + help,
  );
  const value = textEl(
    'span',
    [['class', 'fuaran-label-value-row-value']],
    resolvedValueText(resolution, spec.format),
  );
  return el('div', [['class', `fuaran-label-value-row${emphasisSuffix}`]], labelBlock + value);
};

const renderSparkline = (
  ctx: ServerContext,
  spec: Extract<DisplayKind, { kind: 'Sparkline' }>['spec'],
): string => {
  const series = asArray<number>(tryResolve(ctx.sources, spec.source));
  if (series.length === 0) {
    return textEl('div', [['class', 'fuaran-sparkline fuaran-sparkline-empty']], EM_DASH);
  }
  const values = [...series];
  const n = values.length;
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV < 1e-9 ? 1 : maxV - minV;
  const points = values
    .map((v, i) => {
      const x = n <= 1 ? 50 : (i / (n - 1)) * 100;
      const y = 30 - ((v - minV) / range) * 28 - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const polyline = el('polyline', [
    ['class', 'fuaran-sparkline-line'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '1.5'],
    ['points', points],
  ]);
  return el(
    'svg',
    [
      ['class', 'fuaran-sparkline'],
      ['viewBox', '0 0 100 30'],
      ['preserveAspectRatio', 'none'],
    ],
    polyline,
  );
};

// ─── Inputs (inert — no dispatch server-side) ─────────────────────────────────

const renderInput = (
  ctx: ServerContext,
  parentNodeId: string,
  input: InputKind<unknown>,
  // Phase 951 — the node's a11y projection, for the kinds whose body IS the
  // node's semantic element (here: Button alone — a field's control sits inside
  // its <label>, which already names it). `[]` everywhere else.
  semanticAttrs: readonly Attr[] = [],
): string => {
  switch (input.kind) {
    case 'Button':
      return renderButton(ctx, input.spec, semanticAttrs);
    case 'Select':
      return renderSelect(ctx, input.spec);
    case 'Form':
      return renderForm(ctx, input.spec);
    case 'Filters':
      return renderFilters(ctx, input.specs);
    case 'FileUpload':
      return renderFileUpload(ctx, input.spec);
  }
};

const renderButton = (
  ctx: ServerContext,
  spec: Extract<InputKind<unknown>, { kind: 'Button' }>['spec'],
  // Phase 951 — the node's a11y projection, emitted on the <button> itself.
  semanticAttrs: readonly Attr[] = [],
): string => {
  const unwired = containsUnwiredAction(spec.onClick);
  const variantClass = spec.variant.toLowerCase();
  const className = unwired
    ? `fuaran-button fuaran-button-${variantClass} fuaran-button-unwired`
    : `fuaran-button fuaran-button-${variantClass}`;
  const tooltip =
    spec.tooltip !== undefined
      ? renderText(ctx.sources, spec.tooltip)
      : unwired
        ? UNWIRED_TOOLTIP
        : undefined;
  const isDisabled =
    spec.disabled !== undefined ? tryResolve(ctx.sources, spec.disabled) === true : false;
  const attrs: Attr[] = [['class', className]];
  if (tooltip !== undefined) attrs.push(['title', tooltip]);
  // Phase 951 — before `disabled`, matching the F# server renderer's order.
  attrs.push(...semanticAttrs);
  if (isDisabled) attrs.push(['disabled', true]);
  const label = renderText(ctx.sources, spec.label);
  // Icon-bearing buttons lead with the uniform icon hook; icon-less buttons
  // keep the plain text shape (markup unchanged for existing trees).
  return spec.icon !== undefined
    ? el('button', attrs, iconHook('fuaran-button-icon', spec.icon) + escapeText(label))
    : textEl('button', attrs, label);
};

const renderSelect = (
  ctx: ServerContext,
  spec: Extract<InputKind<unknown>, { kind: 'Select' }>['spec'],
): string => {
  const options = asArray<SelectOption>(tryResolve(ctx.sources, spec.source));
  const isDisabled =
    spec.disabled !== undefined ? tryResolve(ctx.sources, spec.disabled) === true : false;
  const label = textEl(
    'span',
    [['class', 'fuaran-select-label']],
    renderText(ctx.sources, spec.label),
  );
  const placeholder =
    spec.placeholder !== undefined
      ? textEl('option', [['value', '']], renderText(ctx.sources, spec.placeholder))
      : '';
  const opts = options
    .map((o) => textEl('option', [['value', o.value]], renderText(ctx.sources, o.label)))
    .join('');
  // Phase 291 — multi-select. Emit the `multiple` attribute + the options with NO
  // placeholder and NO scalar value (a controlled multi-select rejects a string
  // value). Inert server-side (the multi onChange attaches on hydration).
  const control = spec.multiple
    ? el(
        'select',
        [
          ['class', 'fuaran-select-control'],
          ['multiple', true],
          ['disabled', isDisabled],
        ],
        opts,
      )
    : el(
        'select',
        [
          ['class', 'fuaran-select-control'],
          ['disabled', isDisabled],
        ],
        placeholder + opts,
      );
  return el('label', [['class', 'fuaran-select']], label + control);
};

const renderForm = (
  ctx: ServerContext,
  spec: Extract<InputKind<unknown>, { kind: 'Form' }>['spec'],
): string => {
  const fields = spec.fields.map((f) => renderFormField(ctx, f)).join('');
  const submit = textEl(
    'button',
    [
      ['class', 'fuaran-form-submit'],
      ['type', 'submit'],
    ],
    renderText(ctx.sources, spec.submitLabel),
  );
  const body = fields + submit;
  const children =
    spec.disabled !== undefined
      ? el(
          'fieldset',
          [
            ['class', 'fuaran-form-fieldset'],
            ['disabled', tryResolve(ctx.sources, spec.disabled) === true],
          ],
          body,
        )
      : body;
  return el('form', [['class', 'fuaran-form']], children);
};

const renderFormField = (ctx: ServerContext, field: FormField<unknown>): string => {
  const labelText = renderText(ctx.sources, field.label);
  const labelWithRequired = field.required ? `${labelText} *` : labelText;
  const label = textEl(
    'label',
    [
      ['class', 'fuaran-form-label'],
      ['for', field.id],
    ],
    labelWithRequired,
  );
  const control = renderFormControl(ctx, field);
  const help =
    field.help !== undefined
      ? textEl('div', [['class', 'fuaran-form-help']], renderText(ctx.sources, field.help))
      : '';
  return el('div', [['class', 'fuaran-form-field']], label + control + help);
};

// Phase 864 — the static/SSR obligation from WIRE_FORMAT's rule table: project
// the declared rule into the platform's OWN constraint attributes so the browser
// enforces it. This tier emits no script and drives no document, so the browser
// is the only enforcer it has, which makes the projection the whole obligation
// rather than a convenience.
//
// RECORDED KNOWN LIMIT — `rule.compare` has NO HTML equivalent. There is no
// attribute that says "this field must be >= that field", so a static page
// cannot enforce a cross-field predicate at all. It is emitted as a
// `data-fuaran-field-compare` DECLARATION, matching the F# reference host's
// spelling exactly, so a reader can see the constraint was not silently
// dropped — and it is explicitly NOT claimed as coverage: no platform machinery
// reads that attribute. `compare` is enforced by a rendering host's submit gate
// and, non-bypassably, by the server-side re-check on submit.
const ruleAttrs = (rule: FieldRule | undefined, includePattern: boolean): Attr[] => {
  if (rule === undefined) return [];
  const attrs: Attr[] = [];
  if (includePattern && rule.pattern !== undefined) attrs.push(['pattern', rule.pattern]);
  if (rule.minLength !== undefined) attrs.push(['minlength', rule.minLength]);
  if (rule.maxLength !== undefined) attrs.push(['maxlength', rule.maxLength]);
  if (rule.compare !== undefined)
    attrs.push([
      'data-fuaran-field-compare',
      `${rule.compare.op}:${rule.compare.against.kind === 'State' ? rule.compare.against.key : ''}`,
    ]);
  return attrs;
};

const renderFormControl = (ctx: ServerContext, field: FormField<unknown>): string => {
  const k = field.kind;
  switch (k.kind) {
    case 'Text': {
      const current = String(tryResolve(ctx.sources, k.value) ?? '');
      return voidEl('input', [
        ['class', 'fuaran-form-input'],
        // `rule.format` chooses the input TYPE — the accepted set's HTML
        // projection, not a second declaration of the same thing.
        ['type', field.rule?.format ?? 'text'],
        ['id', field.id],
        ['required', field.required],
        ...ruleAttrs(field.rule, true),
        ['value', current],
      ]);
    }
    case 'Number': {
      const current = tryResolve(ctx.sources, k.value) ?? 0;
      return voidEl('input', [
        ['class', 'fuaran-form-input'],
        ['type', 'number'],
        ['id', field.id],
        ['required', field.required],
        ['value', String(current)],
      ]);
    }
    case 'RangedNumber': {
      const current = tryResolve(ctx.sources, k.value) ?? 0;
      const attrs: Attr[] = [
        ['class', 'fuaran-form-input'],
        ['type', 'number'],
        ['id', field.id],
        ['required', field.required],
        ['value', String(current)],
      ];
      if (k.constraints.min !== undefined) attrs.push(['min', k.constraints.min]);
      if (k.constraints.max !== undefined) attrs.push(['max', k.constraints.max]);
      if (k.constraints.step !== undefined) attrs.push(['step', k.constraints.step]);
      return voidEl('input', attrs);
    }
    case 'Range': {
      // 0.2.0 — dual-thumb numeric range (absorbed FilterKind.RangeFilter).
      const resolved = tryResolve(ctx.sources, k.value);
      const [minV, maxV]: readonly [number, number] =
        Array.isArray(resolved) && resolved.length === 2 ? (resolved as [number, number]) : [0, 0];
      const boundAttrs: Attr[] = [];
      if (k.constraints?.min !== undefined) boundAttrs.push(['min', k.constraints.min]);
      if (k.constraints?.max !== undefined) boundAttrs.push(['max', k.constraints.max]);
      if (k.constraints?.step !== undefined) boundAttrs.push(['step', k.constraints.step]);
      return el(
        'span',
        [
          ['class', 'fuaran-form-range'],
          ['id', field.id],
        ],
        voidEl('input', [
          ['type', 'number'],
          ['class', 'fuaran-form-input fuaran-form-range-min'],
          ['value', String(minV)],
          ...boundAttrs,
        ]) +
          textEl('span', [['class', 'fuaran-form-range-sep']], '–') +
          voidEl('input', [
            ['type', 'number'],
            ['class', 'fuaran-form-input fuaran-form-range-max'],
            ['value', String(maxV)],
            ...boundAttrs,
          ]),
      );
    }
    case 'Checkbox': {
      const current = tryResolve(ctx.sources, k.value) ?? false;
      return voidEl('input', [
        ['class', 'fuaran-form-checkbox'],
        ['type', 'checkbox'],
        ['id', field.id],
        ['checked', current === true],
      ]);
    }
    // Phase 766 — the switch affordance. role/aria-checked must be in the
    // SERVER HTML: a switch that only becomes one after hydration is announced
    // wrongly on first paint, and never at all in a static render.
    case 'Toggle': {
      const current = tryResolve(ctx.sources, k.value) ?? false;
      return voidEl('input', [
        ['class', 'fuaran-form-toggle'],
        ['type', 'checkbox'],
        ['role', 'switch'],
        ['aria-checked', current === true ? 'true' : 'false'],
        ['id', field.id],
        ['checked', current === true],
      ]);
    }
    case 'Choice': {
      const opts = asArray<SelectOption>(tryResolve(ctx.sources, k.options));
      const optionsHtml =
        textEl('option', [['value', '']], EM_DASH) +
        opts
          .map((o) => textEl('option', [['value', o.value]], renderText(ctx.sources, o.label)))
          .join('');
      return el(
        'select',
        [
          ['class', 'fuaran-form-select'],
          ['id', field.id],
          ['required', field.required],
        ],
        optionsHtml,
      );
    }
    case 'TextArea': {
      const current = String(tryResolve(ctx.sources, k.value) ?? '');
      return textEl(
        'textarea',
        [
          ['class', 'fuaran-form-textarea'],
          ['id', field.id],
          ['required', field.required],
          ['rows', k.rows],
          // A textarea has a length and no input type, and HTML gives it no
          // `pattern` either — so the length pair only. FUARAN100 warns an
          // author who declares the others on this control.
          ...ruleAttrs(field.rule, false),
        ],
        current,
      );
    }
    case 'SegmentedChoice':
      return renderSegmentedChoiceCore(ctx, field.id, k.options, k.value, k.orientation);
    // Phase 1113 — THE SSR FLOOR FOR A COMBOBOX, and it is not an approximation
    // of the client widget: a native `<input list>` bound to a `<datalist>` IS a
    // combobox to the user agent, which supplies the popup, the filtering, the
    // keyboard interaction and the accessibility semantics itself, with no
    // script. NO HAND-WRITTEN ARIA is emitted — a static `aria-expanded="false"`
    // that can never become `true` would replace the user agent's own correct
    // semantics with a claim inert markup cannot keep.
    //
    // RECORDED KNOWN LIMIT — `allowFreeText: false` is NOT enforced here and
    // cannot be: a `<datalist>` is a suggestion list, not a constraint. The
    // declaration rides `data-fuaran-combobox-constrained` so a reader can see
    // it was not silently dropped, and it is NOT claimed as coverage; the
    // enforcement is the host's server-side re-check on submit.
    case 'Combobox': {
      const listId = `${field.id}-options`;
      const opts = asArray<SelectOption>(tryResolve(ctx.sources, k.options));
      const current = String(tryResolve(ctx.sources, k.value) ?? '');
      const optionsHtml = opts
        .map((o) => textEl('option', [['value', o.value]], renderText(ctx.sources, o.label)))
        .join('');
      const input = voidEl('input', [
        ['class', 'fuaran-form-field-control fuaran-combobox-input'],
        ['data-fuaran-field', field.id],
        ['type', 'text'],
        ['list', listId],
        // The browser's own history dropdown would otherwise compete with the
        // datalist popup for the same gesture.
        ['autocomplete', 'off'],
        ['data-fuaran-combobox-constrained', k.allowFreeText ? 'false' : 'true'],
        ['required', field.required],
        ['value', current],
      ]);
      return el(
        'span',
        [['class', 'fuaran-combobox']],
        input + el('datalist', [['id', listId]], optionsHtml),
      );
    }
    case 'Date': {
      const inputType =
        k.variant === 'Time' ? 'time' : k.variant === 'DateTime' ? 'datetime-local' : 'date';
      const current = String(tryResolve(ctx.sources, k.value) ?? '');
      const attrs: Attr[] = [
        ['class', 'fuaran-form-input fuaran-form-date'],
        ['type', inputType],
        ['id', field.id],
        ['required', field.required],
        ['value', current],
      ];
      if (k.constraints.min !== undefined) attrs.push(['min', k.constraints.min]);
      if (k.constraints.max !== undefined) attrs.push(['max', k.constraints.max]);
      if (k.constraints.step !== undefined) attrs.push(['step', k.constraints.step]);
      // Phase 864 — the control's own bounds are above; the rule slot mints
      // none of its own for a date, so only the `compare` DECLARATION reaches
      // the markup here. A date field is where cross-field comparison actually
      // arrives, so the marker matches the reference host rather than being
      // silently absent on the one control that most needs it. It claims
      // nothing: a static page cannot enforce a cross-field predicate at all,
      // and the server-side re-check on submit is what does.
      attrs.push(
        ...ruleAttrs(
          field.rule?.compare === undefined ? undefined : { compare: field.rule.compare },
          false,
        ),
      );
      return voidEl('input', attrs);
    }
    case 'DateRange': {
      // Phase 725 — single-control date range: `Range`'s two-input shape with
      // `Date`'s native control per variant. Both ends share the min/max/step
      // attributes; the class vocabulary is the F# renderer's (parity lock).
      const inputType =
        k.variant === 'Time' ? 'time' : k.variant === 'DateTime' ? 'datetime-local' : 'date';
      const resolved = tryResolve(ctx.sources, k.value);
      const [fromV, toV]: readonly [string, string] =
        Array.isArray(resolved) && resolved.length === 2
          ? (resolved as [string, string])
          : ['', ''];
      const boundAttrs: Attr[] = [];
      if (k.constraints.min !== undefined) boundAttrs.push(['min', k.constraints.min]);
      if (k.constraints.max !== undefined) boundAttrs.push(['max', k.constraints.max]);
      if (k.constraints.step !== undefined) boundAttrs.push(['step', k.constraints.step]);
      return el(
        'span',
        [['class', 'fuaran-field-range']],
        voidEl('input', [
          ['class', 'fuaran-form-input fuaran-form-date fuaran-field-range-min'],
          ['type', inputType],
          ['id', field.id],
          ['required', field.required],
          ['value', fromV],
          ...boundAttrs,
        ]) +
          textEl('span', [['class', 'fuaran-field-range-sep']], '–') +
          voidEl('input', [
            ['class', 'fuaran-form-input fuaran-form-date fuaran-field-range-max'],
            ['type', inputType],
            ['required', field.required],
            ['value', toV],
            ...boundAttrs,
          ]),
      );
    }
  }
};

const renderSegmentedChoiceCore = (
  ctx: ServerContext,
  idNamespace: string,
  options: Binding<readonly SelectOption[]>,
  value: Binding<string | undefined>,
  orientation: Orientation,
): string => {
  const opts = asArray<SelectOption>(tryResolve(ctx.sources, options));
  const current = tryResolve(ctx.sources, value);
  const optionId = (index: number): string => `${idNamespace}-opt-${index}`;

  if (orientation === 'Horizontal') {
    const activeIndex = current !== undefined ? opts.findIndex((o) => o.value === current) : -1;
    const buttons = opts
      .map((o, index) => {
        const isActive = index === activeIndex;
        const tabIndex = isActive ? 0 : activeIndex < 0 && index === 0 ? 0 : -1;
        return textEl(
          'button',
          [
            ['class', 'fuaran-segmented-option'],
            ['type', 'button'],
            ['id', optionId(index)],
            ['aria-checked', isActive ? 'true' : 'false'],
            ['role', 'radio'],
            ['tabindex', tabIndex],
          ],
          renderText(ctx.sources, o.label),
        );
      })
      .join('');
    return el(
      'div',
      [
        ['class', 'fuaran-segmented-horizontal'],
        ['id', idNamespace],
        ['role', 'radiogroup'],
        ['aria-orientation', 'horizontal'],
      ],
      buttons,
    );
  }

  const legend = textEl('legend', [['class', 'fuaran-segmented-legend']], idNamespace);
  const rows = opts
    .map((o, index) => {
      const inputId = optionId(index);
      const radio = voidEl('input', [
        ['type', 'radio'],
        ['id', inputId],
        ['name', idNamespace],
        ['value', o.value],
        ['checked', current === o.value],
      ]);
      const label = textEl('label', [['for', inputId]], renderText(ctx.sources, o.label));
      return el('div', [['class', 'fuaran-segmented-row']], radio + label);
    })
    .join('');
  return el(
    'fieldset',
    [
      ['class', 'fuaran-segmented-vertical'],
      ['aria-orientation', 'vertical'],
    ],
    legend + rows,
  );
};

const renderFilters = (ctx: ServerContext, specs: readonly FilterSpec<unknown>[]): string =>
  el('div', [['class', 'fuaran-filters']], specs.map((s) => renderFilter(ctx, s)).join(''));

const renderFilter = (ctx: ServerContext, spec: FilterSpec<unknown>): string => {
  // 0.2.0 filters-unification: the chip's control is an ordinary
  // `FormFieldKind` rendered by the shared form-control renderer (the server
  // projection is static, so no write path is involved).
  const labelText = renderText(ctx.sources, spec.label);
  const field: FormField<unknown> = {
    id: `filter-${spec.name}`,
    label: spec.label,
    kind: spec.field,
    required: false,
  };
  return el(
    'label',
    [['class', 'fuaran-filter']],
    textEl('span', [['class', 'fuaran-filter-label']], labelText) + renderFormControl(ctx, field),
  );
};

const renderFileUpload = (
  ctx: ServerContext,
  spec: Extract<InputKind<unknown>, { kind: 'FileUpload' }>['spec'],
): string => {
  const acceptStr = spec.accept.length === 0 ? undefined : spec.accept.join(',');
  const isDisabled =
    spec.disabled !== undefined ? tryResolve(ctx.sources, spec.disabled) === true : false;
  const label = textEl(
    'span',
    [['class', 'fuaran-file-upload-label']],
    renderText(ctx.sources, spec.label),
  );
  const attrs: Attr[] = [
    ['class', 'fuaran-file-upload-input'],
    ['type', 'file'],
    ['multiple', spec.multiple],
  ];
  if (isDisabled) attrs.push(['disabled', true]);
  if (acceptStr !== undefined) attrs.push(['accept', acceptStr]);
  return el('label', [['class', 'fuaran-file-upload']], label + voidEl('input', attrs));
};

// ─── Visualisations ───────────────────────────────────────────────────────────

const renderVis = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  vis: VisKind<unknown>,
): string => {
  switch (vis.kind) {
    case 'Grid':
      // Phase 393 — a static read-only grid renders the semantic <table> leg (byte-identical
      // to the retired Table); a data-bound grid takes the ordinary grid path.
      return vis.spec.staticRows !== undefined
        ? renderTable(ctx, vis.spec.staticRows)
        : renderGrid(ctx, state, vis.spec);
    case 'Chart':
      return renderChart(ctx, state, vis.spec);
    case 'Map':
      return renderMap(ctx, state, vis.spec);
  }
};

// ─── The grid's whole-rows write destination (Phase 663 / 863 / 934) ─────────
//
// Parity-locked with the client renderer's `gridWriteDestination` /
// `editDestination` / `reorderDestination` and F# `BindingResolver`'s three of
// the same names. A declared `editStateKey` wins; else the Phase-663 floor, the
// grid's own `source` when that source is a direct `State` binding; else there
// is NO destination, and neither affordance is drawn — a Transform pipeline is
// not invertible and Static/Query rows are host data, so a handle or an input
// over them would be a gesture with nowhere to land.
//
// The server collapses the three to a predicate: it never writes, so WHICH
// destination is reachable does not change a byte of its output, only whether
// one is.
const hasGridWriteDestination = (
  declared: boolean,
  editStateKey: string | undefined,
  source: Binding<readonly unknown[]>,
): boolean => declared && (editStateKey !== undefined || source.kind === 'State');

// Phase 863 — the per-cell predicate behind the client's `cellCommit`, which
// returns a committer exactly where this returns `true`: editable write-back
// applies only on the declarative path — a `field`-projected Text/Numeric cell
// with no `value` closure, since a closure's projection need not correspond to
// any row field and there would be nothing sound to write. The column flag
// NARROWS the grid-level capability: an explicit `false` is read-only.
const cellEditable = (gridEditable: boolean, col: ColumnErased<unknown>): boolean =>
  gridEditable &&
  col.editable !== false &&
  col.value === undefined &&
  col.field !== undefined &&
  (col.kind.kind === 'Text' || col.kind.kind === 'Numeric');

const renderGrid = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  spec: Extract<VisKind<unknown>, { kind: 'Grid' }>['spec'],
): string => {
  const resolution = resolve(ctx.sources, spec.source);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const resolvedRows = resolution.kind === 'Resolved' ? asArray<unknown>(resolution.value) : [];
  if (resolvedRows.length === 0 && state.onEmpty !== undefined) {
    return renderNode(ctx, state.onEmpty);
  }
  // Phase 818 — `sortStateKey`: a host that seeds the named State key with a
  // `{column, direction}` descriptor gets its resolved rows sorted by the
  // addressed column's `field` before rendering (runtime-side sort). No seeded
  // descriptor (the SSR default) ⇒ natural source order. The interactive
  // affordance (`data-sortable` / live `aria-sort`) is a client-runtime
  // surface this inert renderer deliberately does not emit — a table never
  // advertises an interaction it cannot perform.
  // Phase 861 — the effective order. A static host applies a DECLARED initial
  // order for the same reason it applies a seeded sort: both are data
  // operations the document itself determines, and neither needs a click.
  const sortDescriptor = effectiveSortDescriptor(spec.sortStateKey, spec.defaultSort, ctx.sources);
  const sorted = sortRowsByDescriptor(spec.columns, sortDescriptor, resolvedRows);
  // Phase 862 — `pageStateKey` + `pageSize`, under the SAME rule the sort above
  // follows: the SLICE is a data operation the seeded State determines, so a
  // static host performs it (page 1 absent a seeded descriptor); the PAGER is
  // an interactive affordance this inert renderer cannot honour, so it is
  // omitted rather than emitted dead. A page a reader cannot leave is still an
  // honest first page; a pager that does nothing is not.
  //
  // The wire declaration is this phase's; what a static host renders for a
  // bound grid more broadly is Phase 668's, and this follows 818's shipped
  // precedent rather than pre-empting it.
  const paging =
    spec.pageStateKey !== undefined && spec.pageSize !== undefined && spec.pageSize > 0
      ? (() => {
          const key = spec.pageStateKey;
          const size = spec.pageSize;
          const hostPages = sourceHostPagesOn(spec.source, key);
          const requested = readPageDescriptor(ctx.sources, key);
          return {
            size,
            hostPages,
            page: hostPages
              ? Math.max(1, requested)
              : Math.min(Math.max(1, requested), pageCountOf(size, sorted.length)),
            lastPage: hostPages ? undefined : pageCountOf(size, sorted.length),
          };
        })()
      : undefined;
  const rows =
    paging !== undefined && !paging.hostPages
      ? sliceRowsToPage(paging.size, paging.page, sorted)
      : sorted;
  // Phase 663 / 863 / 934 — the two whole-rows affordances, under exactly the
  // conditions the client renderer draws them (`editDestination` /
  // `reorderDestination`, parity-locked with F# `BindingResolver`). The server
  // needs only whether a destination EXISTS, never which one: it performs no
  // write, and the client's `writeBackTo` is what resolves the target.
  //
  // Both are emitted INERT, on Phase 818's rule as the pager below applies it:
  // the STRUCTURE is emitted (the extra leading column, the input in place of
  // the span) because the class set and the column count are what a clean
  // hydration handoff and Lock A both key on, while the INTERACTION SURFACE is
  // omitted — no `draggable`, no `data-reorder-handle`, no `aria-keyshortcuts`,
  // exactly as the sortable header's `data-sortable` / `aria-sort` are omitted
  // above. A surface never advertises an interaction it cannot perform; it also
  // never lays out a table one column narrower than the one it hands over to.
  const reorderable =
    sortDescriptor === undefined &&
    hasGridWriteDestination(spec.reorderable, spec.editStateKey, spec.source);
  const editable = hasGridWriteDestination(spec.editable, spec.editStateKey, spec.source);
  const rowOffset = paging !== undefined && !paging.hostPages ? (paging.page - 1) * paging.size : 0;
  const reorderHeaderCell = reorderable
    ? el('th', [
        ['class', 'fuaran-grid-reorder-header'],
        ['scope', 'col'],
        ['aria-label', 'Reorder'],
      ])
    : '';
  // The handle is a real `<button>` carrying the reference CSS's own class, so
  // the slim leading column lands styled and identically sized either side of
  // hydration. It is NOT `disabled`: the pager's steps are, because the
  // stylesheet ships a `:disabled` rule sizing that state deliberately, and
  // this class ships none — a dimmed handle that un-dims on hydration would be
  // a flash the reader has no way to read. Inert by absence of a handler, the
  // posture every other server-rendered button takes.
  const reorderCell = (rowIndex: number): string =>
    !reorderable
      ? ''
      : el(
          'td',
          [['class', 'fuaran-grid-reorder-cell']],
          textEl(
            'button',
            [
              ['class', 'fuaran-grid-reorder-handle'],
              ['type', 'button'],
              // The client's label promises drag and arrow keys; this one names
              // the row and stops there, because that is all a static document
              // can honour.
              ['aria-label', `Reorder row ${rowOffset + rowIndex + 1} of ${rows.length}`],
            ],
            '⣿',
          ),
        );
  const headerCells =
    reorderHeaderCell +
    spec.columns.map((col) => textEl('th', [['class', 'fuaran-grid-header']], col.label)).join('');
  const head = el('thead', [], el('tr', [], headerCells));
  const bodyRows = rows
    .map((row, rowIndex) => {
      const cells = spec.columns
        .map((col) =>
          el(
            'td',
            [['class', 'fuaran-grid-cell']],
            renderGridCell(ctx, col, row, cellEditable(editable, col)),
          ),
        )
        .join('');
      return el('tr', [['class', 'fuaran-grid-row']], reorderCell(rowIndex) + cells);
    })
    .join('');
  const body = el('tbody', [], bodyRows);
  const table = el('table', [['class', 'fuaran-grid']], head + body);
  if (paging === undefined) return table;
  // Phase 862 — the pager is emitted with BOTH steps `disabled`. Three
  // constraints meet here and this is the only shape that satisfies all of
  // them:
  //
  //  - A static host cannot honour a click, and 818's rule is that a surface
  //    never advertises an interaction it cannot perform. A disabled control
  //    does not advertise one; it states plainly that it is unavailable.
  //  - Omitting the pager entirely would silently drop every row past page 1
  //    with nothing to say so. The STATUS is the honest part — the reader is
  //    told which page they are on, and of how many.
  //  - Lock A holds the two renderers to the same `fuaran-*` class set. An
  //    omitted pager breaks that parity; an inert one keeps it.
  const stepAttrs = (label: string): string =>
    textEl(
      'button',
      [
        ['type', 'button'],
        ['class', 'fuaran-grid-pager-step'],
        ['disabled', ''],
      ],
      label,
    );
  const status = textEl(
    'span',
    [
      ['class', 'fuaran-grid-pager-status'],
      ['aria-live', 'polite'],
    ],
    paging.lastPage !== undefined
      ? `Page ${paging.page} of ${paging.lastPage}`
      : `Page ${paging.page}`,
  );
  const pager = el(
    'nav',
    [
      ['class', 'fuaran-grid-pager'],
      ['aria-label', 'Pagination'],
    ],
    stepAttrs('Previous') + status + stepAttrs('Next'),
  );
  return el('div', [['class', 'fuaran-grid-paged']], table + pager);
};

// ─── Data-bound grid sort (Phase 818 — `sortStateKey`; parity-locked with the
// client renderer's `readSortDescriptor` / `sortRowsByDescriptor`) ───────────

const readSortDescriptor = (
  sources: BindingSources,
  key: string,
): readonly [number, SortDirection] | undefined => {
  const raw = sources.state?.[key];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const col = rec['column'];
  const dir = rec['direction'];
  if (typeof col !== 'number' || !Number.isInteger(col) || col < 0) return undefined;
  if (dir !== 'asc' && dir !== 'desc') return undefined;
  return [col, dir];
};

// ─── Phase 861 — the three-way sort slot (parity-locked with the client
// renderer and F# `BindingResolver`) ────────────────────────────────────────

const effectiveSortDescriptor = (
  sortStateKey: string | undefined,
  defaultSort: DefaultSort | undefined,
  sources: BindingSources,
): readonly [number, SortDirection] | undefined => {
  const declared: readonly [number, SortDirection] | undefined =
    defaultSort !== undefined ? [defaultSort.column, defaultSort.direction] : undefined;
  if (sortStateKey === undefined) return declared;
  // An absent key is "not yet sorted" (the declared order applies); a key
  // holding anything that is not a usable descriptor is the cycle's authored
  // state (no sort at all).
  if (sources.state?.[sortStateKey] === undefined) return declared;
  return readSortDescriptor(sources, sortStateKey);
};

// ─── Data-bound grid pagination (Phase 862 — `pageStateKey` / `pageSize`;
// parity-locked with the client renderer and with F# `BindingResolver`) ──────

const readPageDescriptor = (sources: BindingSources, key: string): number => {
  const raw = sources.state?.[key];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 1;
  const page = (raw as Record<string, unknown>)['page'];
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return 1;
  return page;
};

const sourceHostPagesOn = (source: Binding<readonly unknown[]>, pageKey: string): boolean =>
  source.kind === 'Query' && (source.dependsOn ?? []).includes(pageKey);

const pageCountOf = (pageSize: number, rowCount: number): number =>
  pageSize <= 0 ? 1 : Math.max(1, Math.ceil(rowCount / pageSize));

const sliceRowsToPage = (
  pageSize: number,
  page: number,
  rows: readonly unknown[],
): readonly unknown[] => {
  if (pageSize <= 0) return rows;
  const clamped = Math.min(Math.max(1, page), pageCountOf(pageSize, rows.length));
  const start = (clamped - 1) * pageSize;
  return rows.slice(start, start + pageSize);
};

const cellSortRank = (v: CellValue): number => {
  switch (v.kind) {
    case 'Numeric':
      return 0;
    case 'Bool':
      return 1;
    case 'Date':
      return 2;
    case 'Text':
      return 3;
    case 'Empty':
      return 4;
  }
};

const compareCells = (a: CellValue, b: CellValue): number => {
  if (a.kind === 'Numeric' && b.kind === 'Numeric')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (a.kind === 'Bool' && b.kind === 'Bool') return Number(a.value) - Number(b.value);
  if (a.kind === 'Date' && b.kind === 'Date') return a.value.getTime() - b.value.getTime();
  if (a.kind === 'Text' && b.kind === 'Text') {
    const x = a.value.toLowerCase();
    const y = b.value.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return cellSortRank(a) - cellSortRank(b);
};

const sortRowsByDescriptor = (
  columns: readonly ColumnErased<unknown>[],
  descriptor: readonly [number, SortDirection] | undefined,
  rows: readonly unknown[],
): readonly unknown[] => {
  if (descriptor === undefined) return rows;
  const [colIndex, direction] = descriptor;
  const field = columns[colIndex]?.field;
  if (field === undefined) return rows;
  const keyed = rows.map((r) => [projectRowFieldValue(r, field), r] as const);
  keyed.sort(([ka], [kb]) => {
    if (ka.kind === 'Empty' && kb.kind === 'Empty') return 0;
    if (ka.kind === 'Empty') return 1;
    if (kb.kind === 'Empty') return -1;
    const c = compareCells(ka, kb);
    return direction === 'asc' ? c : -c;
  });
  return keyed.map(([, r]) => r);
};

// Phase 425 — the row-field projection contract (parity-locked with the client
// renderers): read a named property off a row object and coerce to CellValue.
const projectRowFieldValue = (row: unknown, field: string): CellValue => {
  if (row === null || typeof row !== 'object') return { kind: 'Empty' };
  const v = (row as Record<string, unknown>)[field];
  if (v === null || v === undefined) return { kind: 'Empty' };
  if (typeof v === 'string') return { kind: 'Text', value: v };
  if (typeof v === 'boolean') return { kind: 'Bool', value: v };
  if (typeof v === 'number') return { kind: 'Numeric', value: v };
  return { kind: 'Empty' };
};

// Phase 427 — the row-key floor (parity-locked with the client renderers).
const projectRowFieldString = (row: unknown, field: string): string => {
  const v = projectRowFieldValue(row, field);
  switch (v.kind) {
    case 'Text':
      return v.value;
    case 'Numeric':
      return String(v.value);
    case 'Bool':
      return v.value ? 'true' : 'false';
    case 'Date':
      return v.value.toISOString();
    case 'Empty':
      return '';
  }
};

// Phase 750 — lower a `TonedPill` for one row (parity-locked with the client renderer's
// `tonedPillOf` and F# `BindingResolver.tonedPillOf`): the named field's text IS the
// label, and its tone is the map's entry for that text, or `defaultTone` otherwise.
const tonedPillOf = (
  row: unknown,
  field: string,
  map: Readonly<Record<string, ToneVariant>>,
  defaultTone: ToneVariant,
): readonly [string, ToneVariant] => {
  const label = projectRowFieldString(row, field);
  return [label, map[label] ?? defaultTone];
};

const renderGridCell = (
  ctx: ServerContext,
  col: ColumnErased<unknown>,
  row: unknown,
  editable = false,
): string => {
  // Phase 425 — the closure wins; else the declarative `field` projects the
  // row property; else the cell is empty (a decoded grid renders from `field`).
  const value: CellValue =
    col.value !== undefined
      ? col.value(row)
      : col.field !== undefined
        ? projectRowFieldValue(row, col.field)
        : { kind: 'Empty' };
  const kind: CellKindErased<unknown> = col.kind;
  switch (kind.kind) {
    case 'Text':
    case 'Numeric':
    case 'Date':
      // Phase 663 — an editable grid turns its field-projected Text/Numeric
      // display cells into the same input shapes the `Editable` cell kind
      // below emits, holding the RAW value rather than the formatted
      // rendering (the client commits the raw value, so the two must agree
      // about what is in the box at the handover). `editable` is false for a
      // `Date` column, so this branch reaches only the two kinds the client's
      // `cellCommit` admits.
      if (editable) {
        if (kind.kind === 'Numeric' && value.kind === 'Numeric') {
          return voidEl('input', [
            ['class', 'fuaran-grid-cell-editable'],
            ['type', 'number'],
            ['value', String(value.value)],
          ]);
        }
        if (kind.kind === 'Numeric') {
          // An Empty (or non-numeric) cell in a Numeric column: a text input,
          // which the client commits only when the entry parses numerically.
          return voidEl('input', [
            ['class', 'fuaran-grid-cell-editable'],
            ['type', 'text'],
            ['value', renderCellValue({ kind: 'None' }, value)],
          ]);
        }
        return voidEl('input', [
          ['class', 'fuaran-grid-cell-editable'],
          ['type', 'text'],
          ['value', value.kind === 'Text' ? value.value : renderCellValue({ kind: 'None' }, value)],
        ]);
      }
      return textEl('span', [], renderCellValue(col.format, value));
    case 'Editable':
      if (value.kind === 'Numeric') {
        return voidEl('input', [
          ['class', 'fuaran-grid-cell-editable'],
          ['type', 'number'],
          ['value', String(value.value)],
        ]);
      }
      if (value.kind === 'Text') {
        return voidEl('input', [
          ['class', 'fuaran-grid-cell-editable'],
          ['type', 'text'],
          ['value', value.value],
        ]);
      }
      return textEl('span', [], renderCellValue(col.format, value));
    case 'Checkbox':
      return voidEl('input', [
        ['type', 'checkbox'],
        ['checked', kind.get(row) === true],
      ]);
    case 'Button':
      return textEl(
        'button',
        [['class', 'fuaran-grid-cell-button']],
        renderText(ctx.sources, kind.label),
      );
    case 'ButtonGroup':
      return el(
        'span',
        [['class', 'fuaran-grid-cell-button-group']],
        kind.buttons
          .map(([label]) =>
            textEl(
              'button',
              [['class', 'fuaran-grid-cell-button']],
              renderText(ctx.sources, label),
            ),
          )
          .join(''),
      );
    case 'Link': {
      // Phase 1037 — the ambient policy, per row. The highest-volume egress
      // surface the renderer has: one href per row, all from a row accessor
      // over bound data.
      const [href, egressAttrs] = sanitizeUrlForEgress(
        ctx.egressPolicy,
        'hyperlink',
        kind.href(row),
      );
      return textEl(
        'a',
        [['class', 'fuaran-grid-cell-link'], ['href', href], ...egressAttrs],
        renderText(ctx.sources, kind.label(row)),
      );
    }
    case 'Pill':
      return textEl(
        'span',
        [['class', `fuaran-grid-cell-pill fuaran-pill-${toneVar(kind.tone(row))}`]],
        renderText(ctx.sources, kind.label(row)),
      );
    // Phase 750 — the declarative twin: same element, class vocabulary and text as the
    // hosted `Pill` arm above.
    case 'TonedPill': {
      const [label, tone] = tonedPillOf(row, kind.field, kind.map, kind.defaultTone);
      return textEl(
        'span',
        [['class', `fuaran-grid-cell-pill fuaran-pill-${toneVar(tone)}`]],
        label,
      );
    }
    case 'Progress': {
      const f = kind.fraction(row);
      const labelHtml =
        kind.label !== undefined
          ? textEl('span', [], renderText(ctx.sources, kind.label(row)))
          : '';
      const fill = el('div', [
        ['class', 'fuaran-grid-cell-progress-fill'],
        ['style', `width:${f * 100}%`],
      ]);
      return el('div', [['class', 'fuaran-grid-cell-progress']], fill + labelHtml);
    }
    case 'Custom':
      return renderNode(
        ctx,
        kind.render((r: unknown) => r as JsonValue),
      );
  }
};

const renderChart = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  spec: Extract<VisKind<unknown>, { kind: 'Chart' }>['spec'],
): string => {
  const resolution = resolve(ctx.sources, spec.source);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const rows = resolution.kind === 'Resolved' ? asArray<unknown>(resolution.value) : [];

  // Phase 534 tail / 636–638 — first-party lowering, parity-locked with the
  // client renderer: a lowerable chart with resolved row objects lowers to a
  // canonical `Drawing` subtree via `@fuaran-ui/charts` and renders as the
  // SAME inline SVG string the client emits. Anything unresolved /
  // not-yet-lowered falls through to the placeholder below.
  if (isLowered(spec.kind) && rows.length > 0 && rows.every(isChartRow)) {
    // Parity by construction rather than by copying: the SAME bridge the client
    // renderer uses decides which declared fields cross into the lowering, and
    // carries the Literal-only `TextSource` rule. This arm threaded `title` +
    // `valueFormat` and dropped the other five semantic fields; the client arm
    // dropped six. Two copies, two different answers — hence one helper.
    const drawing = lower(chartLowerSpecOf(spec), rows as readonly ChartRow[]);
    return el('div', [], drawingSvg(ctx.sources, drawing));
  }

  const rowCount = rows.length;
  const title =
    spec.title !== undefined
      ? textEl('div', [['class', 'fuaran-chart-title']], renderText(ctx.sources, spec.title))
      : '';
  const placeholder = textEl(
    'div',
    [
      ['class', 'fuaran-chart-placeholder'],
      ['data-stacked', spec.stacked],
    ],
    `[Chart placeholder: ${spec.kind}${spec.stacked ? ' (stacked)' : ''} — ${rowCount} rows × {${spec.xField}} → {${spec.yFields.join(', ')}}. Wire a chart adapter for live rendering.]`,
  );
  return el('div', [['class', 'fuaran-chart']], title + placeholder);
};

// A resolved chart data row is a plain field-map object — never an array or a
// scalar (the twin of the client renderer's `isChartRow`).
const isChartRow = (row: unknown): row is ChartRow =>
  typeof row === 'object' && row !== null && !Array.isArray(row);

// Phase 393 — the static read-only table leg, now driven by a grid's `staticRows`.
const renderTable = (
  ctx: ServerContext,
  spec: NonNullable<Extract<VisKind<unknown>, { kind: 'Grid' }>['spec']['staticRows']>,
): string => {
  const headerCells = spec.headers
    .map((h) => textEl('th', [['class', 'fuaran-table-header']], renderText(ctx.sources, h)))
    .join('');
  const head = el('thead', [], el('tr', [], headerCells));
  const bodyRows = spec.rows
    .map((row) => {
      const cells = row
        .map((cell) =>
          textEl('td', [['class', 'fuaran-table-cell']], renderText(ctx.sources, cell)),
        )
        .join('');
      return el('tr', [['class', 'fuaran-table-row']], cells);
    })
    .join('');
  const body = el('tbody', [], bodyRows);
  // Phase 801 — the declared sort intent as data attributes, so a progressive-enhancement
  // script honours it without re-parsing the wire. Emitted ONLY when declared (an
  // undeclared table's bytes are unchanged), and in the same order as the F# SSR twin so
  // the two hosts' markup stays parity-locked.
  const attrs: [string, string][] = [['class', 'fuaran-table']];
  if (spec.sortable !== undefined)
    attrs.push(['data-fuaran-sortable', spec.sortable ? 'true' : 'false']);
  if (spec.defaultSort !== undefined) {
    attrs.push(['data-fuaran-sort-column', String(spec.defaultSort.column)]);
    attrs.push(['data-fuaran-sort-direction', spec.defaultSort.direction]);
  }
  return el('table', attrs, head + body);
};

const renderMap = (
  ctx: ServerContext,
  state: StateBehaviour<unknown>,
  spec: Extract<VisKind<unknown>, { kind: 'Map' }>['spec'],
): string => {
  const resolution = resolve(ctx.sources, spec.source);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const markers = resolution.kind === 'Resolved' ? asArray<MapMarker>(resolution.value) : [];
  const placeholder = textEl(
    'div',
    [['class', 'fuaran-map-placeholder']],
    `[Map placeholder: ${markers.length} markers around (${spec.centreLatitude.toFixed(4)}, ${spec.centreLongitude.toFixed(4)}) zoom ${spec.zoom}. Wire a Leaflet adapter for live rendering.]`,
  );
  const list =
    markers.length > 0
      ? el(
          'ul',
          [['class', 'fuaran-map-marker-list']],
          markers
            .map((marker) =>
              textEl(
                'li',
                [['class', 'fuaran-map-marker']],
                `${renderText(ctx.sources, marker.label)} @ (${marker.latitude.toFixed(4)}, ${marker.longitude.toFixed(4)})`,
              ),
            )
            .join(''),
        )
      : '';
  return el('div', [['class', 'fuaran-map']], placeholder + list);
};

// ─── Custom + Fragment ────────────────────────────────────────────────────────

const renderCustom = (
  ctx: ServerContext,
  moduleId: string,
  componentId: string,
  props: Readonly<Record<string, JsonValue>>,
  contentHash: ContentHash | undefined,
): string => {
  // The server ships no custom-renderer registry seam, so a Custom node always
  // renders the inert labelled placeholder the client emits when no renderer is
  // registered. The host owns + escapes its own Custom output on the client path.
  //
  // WIRE_FORMAT.md §25.4 — TWO shapes, and the first is byte-for-byte what
  // shipped before. A host holding no card for this identity emits exactly the
  // placeholder it always emitted; a host holding one emits the card-derived
  // degradation. That the uncarded path is untouched is not a courtesy: it is
  // what makes the obligation safe to declare on a kind every host renders.
  const card = ctx.cards?.get(moduleId, componentId);

  if (card === undefined) {
    const propKeys = Object.keys(props).join(', ');
    const label = textEl(
      'div',
      [['class', 'fuaran-custom-label']],
      `Custom ${moduleId}.${componentId}`,
    );
    const propsDiv = textEl('div', [['class', 'fuaran-custom-props']], `props: ${propKeys}`);
    return el('div', [['class', 'fuaran-custom-placeholder']], label + propsDiv);
  }

  const described = describeFromCard(contentHash, props, card);

  const label = textEl('div', [['class', 'fuaran-custom-label']], described.label);

  const summary =
    described.summary === undefined
      ? ''
      : textEl('div', [['class', 'fuaran-custom-summary']], described.summary);

  // The declared prop rows — never a prop VALUE. The node's props are data this
  // host was not asked to interpret, and spilling them into a placeholder is an
  // information leak that buys no legibility at all.
  const propRows =
    described.propLines.length === 0
      ? ''
      : el(
          'ul',
          [['class', 'fuaran-custom-props']],
          described.propLines.map((line) => textEl('li', [], line)).join(''),
        );

  // The node's own prop bag, judged against the card. This is the half a
  // labelling pass alone would miss: a foreign host can now say the node is
  // MALFORMED, where before it could only fail to render it.
  const defects =
    described.validation.defects.length === 0
      ? ''
      : el(
          'ul',
          [['class', 'fuaran-custom-defects']],
          described.validation.defects.map((d) => textEl('li', [], d.message)).join(''),
        );

  return el(
    'div',
    [
      ['class', 'fuaran-custom-placeholder'],
      ['data-fuaran-custom-module', moduleId],
      ['data-fuaran-custom-component', componentId],
      ['data-fuaran-custom-card', cardVerdictMarker(described.verdict)],
    ],
    label + summary + propRows + defects,
  );
};

const renderFragmentRef = (ctx: ServerContext, parentNodeId: string, name: string): string => {
  if (ctx.expandingFragments.has(name)) {
    return textEl(
      'div',
      [
        ['class', 'fuaran-fragment-cycle-placeholder'],
        ['data-fuaran-fragment-cycle', name],
      ],
      `[fuaran:fragment cycle '${name}']`,
    );
  }
  const body = ctx.fragments.get(name);
  if (body === undefined) {
    return textEl(
      'div',
      [
        ['class', 'fuaran-fragment-unresolved-placeholder'],
        ['data-fuaran-fragment-unresolved', name],
      ],
      `[fuaran:fragment unresolved '${name}']`,
    );
  }
  const prefix = parentNodeId + '.';
  const namespaced = namespaceNode(prefix, body);
  const expandingFragments = new Set(ctx.expandingFragments);
  expandingFragments.add(name);
  return renderNode({ ...ctx, expandingFragments }, namespaced);
};

// ─── Public entry point ───────────────────────────────────────────────────────

/** Options for {@link renderToHtml}. */
export interface RenderToHtmlOptions {
  /** Host-supplied binding sources used to resolve non-`Static` bindings. Defaults to empty. */
  readonly sources?: BindingSources;
  /**
   * Phase 1037 — the ambient destination policy (WIRE_FORMAT §14.1) consulted
   * for every `Link` href, `Image` src, DataGrid link column and markdown body
   * in the tree.
   *
   * **Omitting it means `denyNonLocalEgress`.** An emission cannot declare its
   * own egress, so absent a host's declaration it gets none — and the server
   * tier is where that matters most, because a refused `<img src>` in a
   * server-rendered document is fetched by the browser before any script runs.
   * Pass `permissiveEgress` for a hand-authored tree, or an `allowOrigin`-built
   * policy to declare specific destinations; both are reached BY NAME.
   */
  readonly egressPolicy?: EgressPolicy;
  /**
   * WIRE_FORMAT.md §25 — host-supplied contract cards, so an unregistered
   * `Custom` node whose identity the store knows renders the card-derived
   * labelled placeholder (§25.4) instead of the identity-only one.
   *
   * Omitting it leaves the placeholder exactly as it was. Reached BY NAME, like
   * `egressPolicy`: a card store is a claim a host makes about what it can
   * describe, and a renderer must never assume one.
   */
  readonly cards?: CardStore;
}

/**
 * Render a typed Fuaran `Node` tree to a body-fragment HTML string. The host
 * owns the document shell + the `<link>` to the packaged
 * `@fuaran-ui/renderer/css`. With no `sources`, `Static` bindings resolve and the
 * rest fall back to their loading slot / em-dash placeholder.
 */
export const renderToHtml = <TMsg>(tree: Node<TMsg>, options: RenderToHtmlOptions = {}): string => {
  const node = tree as Node<unknown>;
  const ctx: ServerContext = {
    // Phase 1075 — a `Binding.State` carrying a `defaultValue` DECLARES the
    // value of its slot, so the tree's declarations are laid UNDER the host's
    // own sources before anything resolves. The host wins on every key it
    // names (charter §4); a seed is the value before anything else has said
    // anything, never an override. Seeding here — at the one place this tier
    // builds a context — is what keeps the SSR first frame identical to the
    // client's, and hydration mismatch-free.
    sources: withStateSeeds(node, options.sources ?? emptySources),
    fragments: collectFragments(new Map<string, Node<unknown>>(), node),
    expandingFragments: new Set<string>(),
    // Phase 1037 — default-deny. A host widens it BY NAME via `egressPolicy`.
    egressPolicy: options.egressPolicy ?? denyNonLocalEgress,
    ...(options.cards !== undefined ? { cards: options.cards } : {}),
  };
  return renderNode(ctx, node);
};

/** Render a single node to HTML against an explicit binding-source set (no fragment scope). */
export const renderNodeToHtml = <TMsg>(
  node: Node<TMsg>,
  options: RenderToHtmlOptions = {},
): string => renderToHtml(node, options);
