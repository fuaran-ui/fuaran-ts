// ============================================================================
//  @fuaran-ui/renderer/render/Layout — every LayoutKind variant.
//  Mirrors the F# renderer's renderLayout: Dashboard / Stack / Card / Grid /
//  SplitPanel / Tabs / StatList / Disclosure / Stepper. DOM structure + class
//  names + ARIA are byte-for-byte parity with the F# renderer (the packaged
//  reference CSS keys off them).
// ============================================================================

import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

import type { LayoutKind, Node, TabHeader } from '@fuaran-ui/schema';

import { renderText, tryResolve } from '../bindings.js';
import { printBreakClasses } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { runAction, writeBackTo } from '../context.js';
import { renderChildren, renderNode } from './core.js';
import { iconHook } from './iconHook.js';

// ─── Popover (Phase 1119) ────────────────────────────────────────────────────
//
// `ModalSpec.modality = 'Popover'` selects the NON-BLOCKING overlay. Everything
// in this component is renderer-owned: where the surface is placed, which way it
// flips at a viewport edge, how far off its anchor it sits, and which gestures
// close it. Nothing on the wire names a pixel or an event — WIRE_FORMAT.md
// §3.6.11 — which is why this lives here rather than in four more wire members.
//
// The RENDERED markup is byte-identical to the SSR floor: same wrapper, same
// classes, same `role`, same `[hidden]`. Placement is applied IMPERATIVELY to
// the element after mount, never as a `style` prop, so hydration finds the DOM
// the server emitted — the same posture the modal's focus management takes.
//
// When no anchor resolves, this positions NOTHING and the surface stays in the
// document flow where the node sits. It does not guess and it does not centre
// itself: a surface floating mid-screen with no scrim is the one outcome a
// reader cannot interpret, and the validator reports both unanchored shapes
// (FUARAN122) so the fallback is described rather than silent.

const POPOVER_GAP = 8;

const findAnchor = (anchorId: string | undefined): Element | null => {
  if (anchorId === undefined || anchorId === '' || typeof document === 'undefined') return null;
  return document.querySelector(`[data-fuaran-node-id="${anchorId.replace(/"/g, '\\"')}"]`);
};

const PopoverSurface = ({
  hidden,
  anchor,
  dismissable,
  onDismiss,
  children,
}: {
  readonly hidden: boolean;
  readonly anchor?: string;
  readonly dismissable: boolean;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}): ReactElement => {
  const ref = useRef<HTMLDivElement | null>(null);
  const isOpen = !hidden;

  // Placement, and the re-placement on scroll / resize while open. `scroll` is
  // captured because a scroll event does not bubble, so the capture phase is the
  // only way to see one from a nested scroller and move with the anchor.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const place = (): void => {
      const anchorEl = isOpen ? findAnchor(anchor) : null;
      if (anchorEl === null) {
        el.style.position = '';
        el.style.top = '';
        el.style.left = '';
        el.removeAttribute('data-fuaran-popover-placement');
        return;
      }
      // Coordinates are viewport-relative from getBoundingClientRect, so fixed
      // positioning needs no scroll arithmetic and no offset-parent archaeology
      // — the two things that make hand-rolled anchoring wrong under any
      // transformed ancestor.
      const a = anchorEl.getBoundingClientRect();
      el.style.position = 'fixed';
      el.style.top = '0px';
      el.style.left = '0px';
      const s = el.getBoundingClientRect();
      const roomBelow = window.innerHeight - a.bottom - POPOVER_GAP;
      const roomAbove = a.top - POPOVER_GAP;
      // A single either/or, preferring below on a tie. There is no left/right
      // axis and no "auto" strategy: a second axis needs a preference to choose
      // between them, and a preference is a wire member the charter declines.
      const above = s.height > roomBelow && roomAbove > roomBelow;
      const top = above ? a.top - POPOVER_GAP - s.height : a.bottom + POPOVER_GAP;
      const maxLeft = window.innerWidth - s.width - POPOVER_GAP;
      const left = Math.max(POPOVER_GAP, Math.min(a.left, maxLeft));
      el.style.top = `${String(Math.round(top))}px`;
      el.style.left = `${String(Math.round(left))}px`;
      el.setAttribute('data-fuaran-popover-placement', above ? 'above' : 'below');
    };
    place();
    if (!isOpen || anchor === undefined) return;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [isOpen, anchor]);

  // Light dismiss. The ANCHOR is excluded from the outside test deliberately: it
  // is normally the control that opened the surface, so a dismiss on its own
  // pointerdown would race the open it is about to perform. `pointerdown` rather
  // than `click`, and `Escape` on the document rather than on the surface —
  // nothing here holds focus, so a keydown on the surface would mostly not fire.
  useEffect(() => {
    if (!isOpen || !dismissable || typeof document === 'undefined') return;
    const el = ref.current;
    const anchorEl = findAnchor(anchor);
    const onPointerDown = (e: Event): void => {
      const target = e.target as globalThis.Node | null;
      if (el !== null && target !== null && el.contains(target)) return;
      if (anchorEl !== null && target !== null && anchorEl.contains(target)) return;
      onDismiss();
    };
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Esc') onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, anchor, dismissable, onDismiss]);

  return (
    <div
      className="fuaran-popover"
      ref={ref}
      {...(hidden ? { hidden: true } : {})}
      {...(anchor !== undefined ? { 'data-fuaran-popover-anchor': anchor } : {})}
    >
      {children}
    </div>
  );
};

export const renderLayout = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  layout: LayoutKind<TMsg>,
): ReactElement => {
  switch (layout.kind) {
    // Phase 390 — the unified container. Role + layout mode drive the emitted
    // element + classes so each retired kind's HTML/a11y is byte-identical:
    // Card role → <section class="fuaran-layout-card">; Dashboard role (or
    // Group+Auto) → <div class="fuaran-layout-dashboard">; Separator →
    // <hr class="fuaran-layout-separator">; Group+Grid → grid div; Group+Flex →
    // stack div.
    case 'Box': {
      const spec = layout.spec;
      // Phase 1473 — the paged-medium declarations, appended to every one of
      // this kind's six emission arms. The realising rules live in the reference
      // stylesheet's `@media print` block, so a SCREEN rendering is unchanged
      // and no script participates — which is why the class string is the whole
      // of this tier's contribution and it matches the server's byte for byte.
      const brk = printBreakClasses(spec.keepTogether, spec.breakBefore);
      if (spec.role === 'Card') {
        return (
          <section className={`fuaran-layout-card${brk}`}>
            {spec.heading !== undefined && (
              <header className="fuaran-card-heading">
                {renderText(ctx.sources, spec.heading)}
              </header>
            )}
            <div className="fuaran-card-body">{renderChildren(ctx, spec.children)}</div>
          </section>
        );
      }
      if (spec.role === 'Dashboard' || spec.layout.kind === 'Auto') {
        return (
          <div className={`fuaran-layout-dashboard${brk}`}>
            {renderChildren(ctx, spec.children)}
          </div>
        );
      }
      if (spec.role === 'Separator') {
        return <hr className={`fuaran-layout-separator${brk}`} />;
      }
      // role === 'Group' with a Flex or Grid layout.
      if (spec.layout.kind === 'Grid') {
        const g = spec.layout;
        const templateColumns =
          g.templateColumns !== undefined ? g.templateColumns : `repeat(${g.cols}, 1fr)`;
        // `gap` (Phase 459 — the Spacer replacement) emits only when set, so
        // gap-free grids stay byte-identical to the pre-459 emission.
        const gridStyle: CSSProperties = { gridTemplateColumns: templateColumns };
        if (g.gap !== undefined) gridStyle.gap = `${g.gap}px`;
        return (
          <div className={`fuaran-layout-grid${brk}`} style={gridStyle}>
            {renderChildren(ctx, spec.children)}
          </div>
        );
      }
      // WIRE_FORMAT §3.6.7 — column-fill, realised with the CSS multi-column
      // family (`grid-template-rows: masonry` is explicitly NOT the mechanism —
      // it is not deterministically supported across engines). The reference
      // stylesheet supplies the `break-inside: avoid` on the children that
      // stops a card being cut in half down a column boundary.
      if (spec.layout.kind === 'Masonry') {
        const m = spec.layout;
        const masonryStyle: CSSProperties = { columnCount: m.cols };
        if (m.gap !== undefined) masonryStyle.gap = `${m.gap}px`;
        return (
          <div className={`fuaran-layout-masonry${brk}`} style={masonryStyle}>
            {renderChildren(ctx, spec.children)}
          </div>
        );
      }
      // Flex (the fall-through for Group; Auto handled above).
      const f = spec.layout;
      const dir =
        f.kind === 'Flex' && f.direction === 'Horizontal'
          ? 'fuaran-stack-horizontal'
          : 'fuaran-stack-vertical';
      const wrap = f.kind === 'Flex' && f.wrap ? ' fuaran-stack-wrap' : '';
      // `gap` emits only when set (Phase 459) — a gap-free stack carries no
      // `style` attribute, byte-identical to the pre-459 emission.
      const flexGap = f.kind === 'Flex' ? f.gap : undefined;
      const stackStyle: CSSProperties | undefined =
        flexGap !== undefined ? { gap: `${flexGap}px` } : undefined;
      return (
        <div className={`fuaran-layout-stack ${dir}${wrap}${brk}`} style={stackStyle}>
          {renderChildren(ctx, spec.children)}
        </div>
      );
    }

    case 'SplitPanel': {
      const weightLeft = Math.max(0, Math.min(1, layout.spec.weight));
      const weightRight = 1 - weightLeft;
      const rendered = renderChildren(ctx, layout.spec.children);
      const left = rendered.length > 0 ? rendered.slice(0, 1) : [];
      const right = rendered.length > 1 ? rendered.slice(1) : [];
      return (
        <div className="fuaran-layout-split-panel">
          <div
            className="fuaran-split-pane fuaran-split-pane-left"
            style={{ flex: `${weightLeft.toFixed(6)} 1 0` }}
          >
            {left}
          </div>
          <div
            className="fuaran-split-pane fuaran-split-pane-right"
            style={{ flex: `${weightRight.toFixed(6)} 1 0` }}
          >
            {right}
          </div>
        </div>
      );
    }

    case 'Tabs':
      return renderTabs(ctx, parentNodeId, layout.spec);

    case 'SummaryList':
      return (
        <section className="fuaran-layout-summary-list">
          {layout.spec.heading !== undefined && (
            <header className="fuaran-summary-list-heading">
              {renderText(ctx.sources, layout.spec.heading)}
            </header>
          )}
          <div className="fuaran-summary-list-body">
            {renderChildren(ctx, layout.spec.children)}
          </div>
        </section>
      );

    case 'Disclosure': {
      const resolvedOpen = tryResolve(ctx.sources, layout.spec.open) ?? layout.spec.defaultOpen;
      const onToggle = layout.spec.onToggle;
      const openBinding = layout.spec.open;
      return (
        <details
          className="fuaran-layout-disclosure"
          open={resolvedOpen}
          onToggle={(e) => {
            const target = e.currentTarget as HTMLDetailsElement;
            // Phase 426: the closure wins; an omitted handler writes the new
            // open value back to a writable `open` binding.
            if (onToggle !== undefined) runAction(ctx, onToggle(target.open));
            else writeBackTo(ctx, openBinding, target.open);
          }}
        >
          <summary className="fuaran-disclosure-summary">
            {renderText(ctx.sources, layout.spec.heading)}
          </summary>
          <div className="fuaran-disclosure-body">{renderChildren(ctx, layout.spec.children)}</div>
        </details>
      );
    }

    case 'Modal': {
      // Phase 289 overlay render-fidelity contract: the overlay is ALWAYS in
      // the DOM (no React portal), positioned + z-indexed by CSS; closed = the
      // `hidden` attribute. role="dialog" + aria-modal mark the dialog. Backdrop
      // / close-button click fire onDismiss (client only). Body order: heading,
      // dismiss button, then the children body — parity-locked with F#.
      const isOpen = tryResolve(ctx.sources, layout.spec.open) === true;
      const onDismiss = layout.spec.onDismiss;
      const modalOpenBinding = layout.spec.open;
      // Phase 426: the wire-survivable action wins; an omitted `onDismiss`
      // writes `false` back to a writable `open` binding — a decoded
      // dismissable modal closes itself with zero host code.
      const dismiss = (): void => {
        if (onDismiss !== undefined) runAction(ctx, onDismiss);
        else writeBackTo(ctx, modalOpenBinding, false);
      };
      // Phase 1119 — the modality selects WHICH overlay this is. A Popover
      // takes the whole `fuaran-popover` class family rather than a modifier on
      // the modal's: the class vocabulary is parity-locked across every host
      // tier, and a modifier that changed what `fuaran-modal-*` MEANS would
      // silently re-style every existing modal on a host that adopted it.
      // Every emitted class name is a LITERAL at its call site, never composed
      // from a family prefix: the class vocabulary is parity-locked across the
      // host tiers and read out of the source, so a composed name is invisible
      // to the machinery that keeps the lock.
      const surfaceChildren = (
        headingClass: string,
        dismissClass: string,
        bodyClass: string,
      ): ReactElement => (
        <>
          {layout.spec.heading !== undefined && (
            <h2 className={headingClass}>{renderText(ctx.sources, layout.spec.heading)}</h2>
          )}
          {layout.spec.dismissable && (
            <button
              className={dismissClass}
              type="button"
              aria-label="Close"
              onClick={() => dismiss()}
            >
              ×
            </button>
          )}
          <div className={bodyClass}>{renderChildren(ctx, layout.spec.children)}</div>
        </>
      );
      if (layout.spec.modality === 'Popover') {
        // No scrim wrapper, no backdrop click and NO `aria-modal` — that
        // attribute asserts the rest of the page is inert, which here is false,
        // and it is omitted entirely rather than emitted as "false" (already the
        // ARIA default, so writing it would claim a denial nobody made). The
        // dialog role is kept: a dialog that does not block is exactly what
        // ARIA's non-modal dialog is. Placement and light dismiss are attached
        // to the mounted element by `PopoverSurface`, so the rendered markup is
        // byte-identical to the server's and hydration finds the DOM it expects.
        return (
          <PopoverSurface
            hidden={!isOpen}
            {...(layout.spec.anchor !== undefined ? { anchor: layout.spec.anchor } : {})}
            dismissable={layout.spec.dismissable}
            onDismiss={dismiss}
          >
            <div className="fuaran-popover-surface" role="dialog">
              {surfaceChildren(
                'fuaran-popover-heading',
                'fuaran-popover-dismiss',
                'fuaran-popover-body',
              )}
            </div>
          </PopoverSurface>
        );
      }
      return (
        <div
          className="fuaran-modal-overlay"
          {...(!isOpen ? { hidden: true } : {})}
          onClick={() => {
            if (layout.spec.dismissable) dismiss();
          }}
        >
          <div className="fuaran-modal-dialog" role="dialog" aria-modal="true">
            {surfaceChildren('fuaran-modal-heading', 'fuaran-modal-dismiss', 'fuaran-modal-body')}
          </div>
        </div>
      );
    }

    case 'ScrollArea': {
      // Phase 289 — overflow/scroll container. The scroll axis is a class (CSS
      // owns `overflow`); optional pixel bounds are inline max-height /
      // max-width (identical SSR↔CSR). tabindex makes it keyboard-scrollable.
      const axisClass =
        layout.spec.orientation === 'Horizontal'
          ? 'fuaran-scrollarea fuaran-scrollarea-horizontal'
          : layout.spec.orientation === 'Both'
            ? 'fuaran-scrollarea fuaran-scrollarea-both'
            : 'fuaran-scrollarea fuaran-scrollarea-vertical';
      const style: Record<string, string> = {};
      if (layout.spec.maxHeight !== undefined) style['maxHeight'] = `${layout.spec.maxHeight}px`;
      if (layout.spec.maxWidth !== undefined) style['maxWidth'] = `${layout.spec.maxWidth}px`;
      return (
        <div
          className={axisClass}
          tabIndex={0}
          {...(Object.keys(style).length > 0 ? { style } : {})}
        >
          {renderChildren(ctx, layout.spec.children)}
        </div>
      );
    }

    case 'Stepper': {
      const activeIndex = tryResolve(ctx.sources, layout.spec.activeStep) ?? 0;
      const children = layout.spec.children;
      const activeChild = children[activeIndex];
      // A step-header click fires `onSelect(i)` (default no-op `Chain []`),
      // mirroring tabs.
      return (
        <div className="fuaran-layout-stepper">
          <ol className="fuaran-stepper-numbers">
            {children.map((_, i) => (
              <li
                key={i}
                className={
                  i === activeIndex
                    ? 'fuaran-stepper-step fuaran-stepper-step-active'
                    : 'fuaran-stepper-step'
                }
                onClick={() => runAction(ctx, layout.spec.onSelect(i))}
              >
                {i + 1}
              </li>
            ))}
          </ol>
          <div className="fuaran-stepper-body">
            {activeChild !== undefined ? renderNode(ctx, activeChild) : null}
          </div>
        </div>
      );
    }
  }
};

// ─── Tabs (Phase 69 — explicit headers + ARIA tablist + keyboard nav + tags) ──

interface PerTab {
  readonly label: string;
  readonly icon: string | undefined;
  readonly disabled: boolean;
}

const renderTabs = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  spec: Extract<LayoutKind<TMsg>, { kind: 'Tabs' }>['spec'],
): ReactElement => {
  const labelFromChild = (child: Node<TMsg>): string => {
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

  // Phase 426: an omitted `onSelect` writes the clicked index back to a
  // writable `activeIndex` binding (the write-back default), and an omitted
  // `onSelectTag` with a populated tag overlay writes the clicked tag back to
  // a writable `activeTag` binding — so decoded tabs switch panes with zero
  // host code. Present closures dispatch exactly as before.
  const dispatchTabIndex = (i: number): void => {
    if (spec.onSelect !== undefined) runAction(ctx, spec.onSelect(i));
    else writeBackTo(ctx, spec.activeIndex, i);
    if (spec.tabTags !== undefined) {
      const tag = spec.tabTags[i];
      if (tag !== undefined) {
        if (spec.onSelectTag !== undefined) runAction(ctx, spec.onSelectTag(tag));
        else if (spec.activeTag !== undefined) writeBackTo(ctx, spec.activeTag, tag);
      }
    }
  };

  const nextEnabledIndex = (start: number, dir: number): number => {
    const n = perTab.length;
    if (n === 0) return 0;
    let visited = 0;
    let idx = start;
    while (visited < n) {
      const candidate = (((idx + dir) % n) + n) % n;
      if (!perTab[candidate]?.disabled) return candidate;
      idx = candidate;
      visited += 1;
    }
    return start;
  };
  const firstEnabledIndex = (): number => {
    const i = perTab.findIndex((t) => !t.disabled);
    return i >= 0 ? i : 0;
  };
  const lastEnabledIndex = (): number => {
    for (let i = perTab.length - 1; i >= 0; i--) if (!perTab[i]?.disabled) return i;
    return Math.max(0, perTab.length - 1);
  };

  const focusTab = (i: number): void => {
    if (typeof document !== 'undefined') {
      const el = document.getElementById(tabId(i));
      if (el) el.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const prevKey = isVertical ? 'ArrowUp' : 'ArrowLeft';
    const nextKey = isVertical ? 'ArrowDown' : 'ArrowRight';
    let target: number | undefined;
    if (e.key === prevKey) target = nextEnabledIndex(activeIndex, -1);
    else if (e.key === nextKey) target = nextEnabledIndex(activeIndex, 1);
    else if (e.key === 'Home') target = firstEnabledIndex();
    else if (e.key === 'End') target = lastEnabledIndex();
    else if (e.key === 'Enter' || e.key === ' ') target = activeIndex;
    if (target !== undefined) {
      e.preventDefault();
      dispatchTabIndex(target);
      focusTab(target);
    }
  };

  return (
    <div className={`fuaran-layout-tabs ${orientationClass}`}>
      <div
        className="fuaran-tabs-bar"
        role="tablist"
        aria-orientation={isVertical ? 'vertical' : 'horizontal'}
        onKeyDown={handleKeyDown}
      >
        {perTab.map((t, i) => {
          const isActive = i === activeIndex;
          const cls = [
            'fuaran-tab',
            isActive ? 'fuaran-tab-active' : '',
            t.disabled ? 'fuaran-tab-disabled' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const buttonProps: Record<string, unknown> = {
            id: tabId(i),
            className: cls,
            role: 'tab',
            'aria-selected': isActive ? 'true' : 'false',
            'aria-controls': panelId(i),
            tabIndex: isActive ? 0 : -1,
            'data-tab-index': i,
            onClick: () => {
              if (!t.disabled) dispatchTabIndex(i);
            },
          };
          if (t.disabled) {
            buttonProps['aria-disabled'] = 'true';
            buttonProps['disabled'] = true;
          }
          return (
            <button key={i} {...buttonProps}>
              {t.icon !== undefined && iconHook('fuaran-tab-icon', t.icon)}
              <span className="fuaran-tab-label">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div className="fuaran-tabs-panels">
        {activeChild !== undefined ? (
          <div
            id={panelId(activeIndex)}
            role="tabpanel"
            aria-labelledby={tabId(activeIndex)}
            tabIndex={0}
            className="fuaran-tabs-panel"
          >
            {renderNode(ctx, activeChild)}
          </div>
        ) : null}
      </div>
    </div>
  );
};
