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

import { sanitizeExtraAttributes, sanitizeUrlOrBlank } from '@fuaran-ui/renderer/sanitize';
import type {
  Action,
  Binding,
  CellFormat,
  CellKindErased,
  CellValue,
  ColumnErased,
  DisplayKind,
  ErrorPayload,
  FilterSpec,
  FormField,
  InputKind,
  JsonValue,
  LayoutKind,
  MapMarker,
  Node,
  Orientation,
  SelectOption,
  StateBehaviour,
  TabHeader,
  ToneVariant,
  VisKind,
} from '@fuaran-ui/schema';

import { accessibilityAttributes } from './accessibility.js';
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
import { drawingSvg, mathMl } from '@fuaran-ui/renderer';
import { isLowered, lower, type ChartRow } from '@fuaran-ui/charts';

import { motionVar, nodeClassName, toneVar } from './classNames.js';
import { type Attr, el, escapeText, textEl, voidEl } from './html.js';
import { toHtml } from './markdown.js';

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

  // Accessibility first, then sanitized extra-attributes (extra overrides a11y,
  // mirroring the client's `Object.assign` order).
  const dyn: Record<string, string> = {};
  for (const [k, v] of accessibilityAttributes(ctx.sources, node.accessibility)) dyn[k] = v;
  if (node.extraAttributes !== undefined) {
    Object.assign(dyn, sanitizeExtraAttributes(node.extraAttributes));
  }

  const attrs: Attr[] = [
    ['id', node.id],
    ['data-fuaran-node-id', node.id],
    ['class', className],
    ...Object.entries(dyn),
  ];
  return el('div', attrs, renderKind(ctx, node));
};

const renderKind = (ctx: ServerContext, node: Node<unknown>): string => {
  const kind = node.kind;
  switch (kind.kind) {
    case 'Layout':
      return renderLayout(ctx, node.id, kind.layout);
    case 'Display':
      return renderDisplay(ctx, node.state, kind.display);
    case 'Input':
      return renderInput(ctx, node.id, kind.input);
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
      return renderCustom(kind.moduleId, kind.componentId, kind.props);
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
      // toHtml returns already-sanitised HTML — inserted raw (the innerHTML seam).
      return el(
        'div',
        [['class', 'fuaran-markdown']],
        toHtml(renderText(ctx.sources, display.spec.text)),
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
      const href = sanitizeUrlOrBlank(tryResolve(ctx.sources, display.spec.href) ?? '');
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
        return el('span', [['class', 'fuaran-link-protected-wrap']], anchor);
      }
      const attrs: Attr[] = [
        ['class', 'fuaran-link'],
        ['href', href],
      ];
      if (display.spec.rel !== undefined) attrs.push(['rel', display.spec.rel]);
      if (display.spec.target !== undefined) attrs.push(['target', display.spec.target]);
      if (display.spec.download) attrs.push(['download', true]);
      return textEl('a', attrs, renderText(ctx.sources, display.spec.label));
    }

    case 'Image': {
      const src = sanitizeUrlOrBlank(tryResolve(ctx.sources, display.spec.src) ?? '');
      const variantClass =
        display.spec.variant === 'Avatar'
          ? 'fuaran-image fuaran-image-avatar'
          : display.spec.variant === 'Rounded'
            ? 'fuaran-image fuaran-image-rounded'
            : 'fuaran-image';
      return voidEl('img', [
        ['class', variantClass],
        ['src', src],
        ['alt', renderText(ctx.sources, display.spec.alt)],
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
    const t = tryResolveScalarFloat(ctx.sources, spec.trend);
    const trendText = t !== undefined ? formatNumber(spec.trendFormat ?? { kind: 'None' }, t) : '';
    parts.push(textEl('div', [['class', 'fuaran-metric-trend']], trendText));
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
): string => {
  switch (input.kind) {
    case 'Button':
      return renderButton(ctx, input.spec);
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

const renderFormControl = (ctx: ServerContext, field: FormField<unknown>): string => {
  const k = field.kind;
  switch (k.kind) {
    case 'Text': {
      const current = String(tryResolve(ctx.sources, k.value) ?? '');
      return voidEl('input', [
        ['class', 'fuaran-form-input'],
        ['type', 'text'],
        ['id', field.id],
        ['required', field.required],
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
        ],
        current,
      );
    }
    case 'SegmentedChoice':
      return renderSegmentedChoiceCore(ctx, field.id, k.options, k.value, k.orientation);
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
  const rows = resolution.kind === 'Resolved' ? asArray<unknown>(resolution.value) : [];
  if (rows.length === 0 && state.onEmpty !== undefined) {
    return renderNode(ctx, state.onEmpty);
  }
  const headerCells = spec.columns
    .map((col) => textEl('th', [['class', 'fuaran-grid-header']], col.label))
    .join('');
  const head = el('thead', [], el('tr', [], headerCells));
  const bodyRows = rows
    .map((row) => {
      const cells = spec.columns
        .map((col) => el('td', [['class', 'fuaran-grid-cell']], renderGridCell(ctx, col, row)))
        .join('');
      return el('tr', [['class', 'fuaran-grid-row']], cells);
    })
    .join('');
  const body = el('tbody', [], bodyRows);
  return el('table', [['class', 'fuaran-grid']], head + body);
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

const renderGridCell = (ctx: ServerContext, col: ColumnErased<unknown>, row: unknown): string => {
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
    case 'Link':
      return textEl(
        'a',
        [
          ['class', 'fuaran-grid-cell-link'],
          ['href', sanitizeUrlOrBlank(kind.href(row))],
        ],
        renderText(ctx.sources, kind.label(row)),
      );
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
    // Only a literal title carries into the lowered drawing (mirrors the client gate).
    const loweredTitle =
      spec.title !== undefined && spec.title.kind === 'Literal' ? spec.title.value : undefined;
    const drawing = lower(
      {
        kind: spec.kind,
        xField: spec.xField,
        yFields: spec.yFields,
        stacked: spec.stacked,
        ...(loweredTitle !== undefined ? { title: loweredTitle } : {}),
      },
      rows as readonly ChartRow[],
    );
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
  moduleId: string,
  componentId: string,
  props: Readonly<Record<string, JsonValue>>,
): string => {
  // The server ships no custom-renderer registry seam, so a Custom node always
  // renders the inert labelled placeholder the client emits when no renderer is
  // registered. The host owns + escapes its own Custom output on the client path.
  const propKeys = Object.keys(props).join(', ');
  const label = textEl(
    'div',
    [['class', 'fuaran-custom-label']],
    `Custom ${moduleId}.${componentId}`,
  );
  const propsDiv = textEl('div', [['class', 'fuaran-custom-props']], `props: ${propKeys}`);
  return el('div', [['class', 'fuaran-custom-placeholder']], label + propsDiv);
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
    sources: options.sources ?? emptySources,
    fragments: collectFragments(new Map<string, Node<unknown>>(), node),
    expandingFragments: new Set<string>(),
  };
  return renderNode(ctx, node);
};

/** Render a single node to HTML against an explicit binding-source set (no fragment scope). */
export const renderNodeToHtml = <TMsg>(
  node: Node<TMsg>,
  options: RenderToHtmlOptions = {},
): string => renderToHtml(node, options);
