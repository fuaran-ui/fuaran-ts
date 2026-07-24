// ============================================================================
//  @fuaran-ui/renderer/render/Layout — every LayoutKind variant.
//  Mirrors the F# renderer's renderLayout: Dashboard / Stack / Card / Grid /
//  SplitPanel / Tabs / StatList / Disclosure / Stepper. DOM structure + class
//  names + ARIA are byte-for-byte parity with the F# renderer (the packaged
//  reference CSS keys off them).
// ============================================================================

import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';

import type { LayoutKind, Node, TabHeader } from '@fuaran-ui/schema';

import { renderText, tryResolve } from '../bindings.js';
import type { RenderContext } from '../context.js';
import { runAction, writeBackTo } from '../context.js';
import { renderChildren, renderNode } from './core.js';
import { iconHook } from './iconHook.js';

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
      if (spec.role === 'Card') {
        return (
          <section className="fuaran-layout-card">
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
        return <div className="fuaran-layout-dashboard">{renderChildren(ctx, spec.children)}</div>;
      }
      if (spec.role === 'Separator') {
        return <hr className="fuaran-layout-separator" />;
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
          <div className="fuaran-layout-grid" style={gridStyle}>
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
        <div className={`fuaran-layout-stack ${dir}${wrap}`} style={stackStyle}>
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
      return (
        <div
          className="fuaran-modal-overlay"
          {...(!isOpen ? { hidden: true } : {})}
          onClick={() => {
            if (layout.spec.dismissable) dismiss();
          }}
        >
          <div className="fuaran-modal-dialog" role="dialog" aria-modal="true">
            {layout.spec.heading !== undefined && (
              <h2 className="fuaran-modal-heading">
                {renderText(ctx.sources, layout.spec.heading)}
              </h2>
            )}
            {layout.spec.dismissable && (
              <button
                className="fuaran-modal-dismiss"
                type="button"
                aria-label="Close"
                onClick={() => dismiss()}
              >
                ×
              </button>
            )}
            <div className="fuaran-modal-body">{renderChildren(ctx, layout.spec.children)}</div>
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
