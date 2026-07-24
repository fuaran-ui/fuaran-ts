// ============================================================================
//  @fuaran-ui/renderer/render/Display — every DisplayKind variant.
//  Mirrors the F# renderDisplay: Heading / Markdown / KPI / Badge /
//  Skeleton / Callout / Progress / Sparkline / LabelValueRow. Markdown routes
//  through the sanitising parser (NOT raw dangerouslySetInnerHTML) per Phase 56.
// ============================================================================

import type { ReactElement, ReactNode } from 'react';

import type {
  CalloutSpec,
  DisplayKind,
  ErrorPayload,
  HeadingSpec,
  MetricSpec,
  LabelValueRowSpec,
  ProgressSpec,
  SparklineSpec,
  StateBehaviour,
} from '@fuaran-ui/schema';

import {
  asArray,
  formatNumber,
  renderText,
  resolve,
  resolveScalarFloat,
  type Resolution,
  tryResolve,
  tryResolveScalarFloat,
} from '../bindings.js';
import { toneVar } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { drawingSvg } from '../drawingSvg.js';
import { mathMl } from '../mathMl.js';
import { toHtml } from '../markdown.js';
import { sanitizeUrlOrBlank } from '../sanitize.js';
import { renderNode } from './core.js';
import { iconHook } from './iconHook.js';

let counter = 0;
const correlationId = (): string => {
  counter += 1;
  return `d${counter.toString(36)}`;
};

const bindingResolutionError = (message: string): ErrorPayload => ({
  kind: 'BindingResolution',
  message,
  correlationId: correlationId(),
});

/** Resolved-value text for Metric / LabelValueRow value slots (mirrors F#). */
const resolvedValueText = (
  resolution: Resolution<number>,
  format: MetricSpec['format'],
): string => {
  switch (resolution.kind) {
    case 'Resolved':
      return formatNumber(format, resolution.value);
    case 'NotResolved':
      return '—';
    case 'Errored':
      return `(error: ${resolution.message})`;
    case 'I18nUnresolved':
      return `[i18n:${resolution.key}]`;
  }
};

export const renderDisplay = <TMsg,>(
  ctx: RenderContext<TMsg>,
  state: StateBehaviour<TMsg>,
  display: DisplayKind,
): ReactNode => {
  switch (display.kind) {
    case 'Heading':
      return renderHeading(ctx, display.spec);

    case 'Markdown':
      return (
        <div
          className="fuaran-markdown"
          dangerouslySetInnerHTML={{ __html: toHtml(renderText(ctx.sources, display.spec.text)) }}
        />
      );

    case 'Metric':
      return renderMetric(ctx, state, display.spec);

    case 'Badge':
      return (
        <span className={`fuaran-badge fuaran-badge-${display.spec.variant.toLowerCase()}`}>
          {renderText(ctx.sources, display.spec.label)}
        </span>
      );

    case 'Skeleton':
      return (
        <div className="fuaran-skeleton">
          {Array.from({ length: display.spec.rows }, (_, i) => (
            <div key={i} className="fuaran-skeleton-row" />
          ))}
        </div>
      );

    case 'Callout':
      return renderCallout(ctx, display.spec);

    case 'Progress':
      return renderProgress(ctx, state, display.spec);

    case 'Sparkline':
      return renderSparkline(ctx, display.spec);

    case 'Drawing':
      // Phase 525 — first-party inline SVG from the canonical builder (the ONE
      // serialisation the string server renderer also emits, so the class sets
      // are parity by construction). Rides dangerouslySetInnerHTML like Markdown.
      return <div dangerouslySetInnerHTML={{ __html: drawingSvg(ctx.sources, display.spec) }} />;

    case 'LabelValueRow':
      return renderLabelValueRow(ctx, state, display.spec);

    case 'Fact': {
      // A labeled TEXT fact tile — Metric's chrome for a TextSource value;
      // renderText resolves Literal/Bound/I18n as for every label.
      const spec = display.spec;
      const emphasisSuffix = spec.emphasis ? ' fuaran-fact-emphasis' : '';
      return (
        <div className={`fuaran-fact fuaran-fact-${toneVar(spec.tone)}${emphasisSuffix}`}>
          <div className="fuaran-fact-label">{renderText(ctx.sources, spec.label)}</div>
          <div className="fuaran-fact-value">
            {spec.icon !== undefined ? iconHook('fuaran-fact-icon', spec.icon) : null}
            <span>{renderText(ctx.sources, spec.value)}</span>
          </div>
          {spec.help !== undefined ? (
            <div className="fuaran-fact-help">{renderText(ctx.sources, spec.help)}</div>
          ) : null}
        </div>
      );
    }

    case 'Link': {
      // A real <a href> — crawlable + works with JS disabled. href resolves the
      // binding then passes through sanitizeUrlOrBlank (rejected URLs collapse
      // to about:blank). rel/target emit when set; download emits a bare attr.
      const href = sanitizeUrlOrBlank(tryResolve(ctx.sources, display.spec.href) ?? '');
      return (
        <a
          className="fuaran-link"
          href={href}
          {...(display.spec.rel !== undefined ? { rel: display.spec.rel } : {})}
          {...(display.spec.target !== undefined ? { target: display.spec.target } : {})}
          {...(display.spec.download ? { download: '' } : {})}
        >
          {renderText(ctx.sources, display.spec.label)}
        </a>
      );
    }

    case 'Image': {
      // A real <img> (Phase 287). src resolves the binding then passes through
      // sanitizeUrlOrBlank (blocks javascript:/vbscript:/file:); alt is
      // mandatory; variant appends an Avatar / Rounded class.
      const src = sanitizeUrlOrBlank(tryResolve(ctx.sources, display.spec.src) ?? '');
      const variantClass =
        display.spec.variant === 'Avatar'
          ? 'fuaran-image fuaran-image-avatar'
          : display.spec.variant === 'Rounded'
            ? 'fuaran-image fuaran-image-rounded'
            : 'fuaran-image';
      return (
        <img className={variantClass} src={src} alt={renderText(ctx.sources, display.spec.alt)} />
      );
    }

    case 'List': {
      // <ol> (ordered) / <ul> (unordered) of <li> items (Phase 287).
      const items = display.spec.items.map((item, i) => (
        <li key={i} className="fuaran-list-item">
          {renderText(ctx.sources, item)}
        </li>
      ));
      return display.spec.ordered ? (
        <ol className="fuaran-list fuaran-list-ordered">{items}</ol>
      ) : (
        <ul className="fuaran-list fuaran-list-unordered">{items}</ul>
      );
    }

    case 'Toast': {
      // Phase 289 overlay render-fidelity contract: ALWAYS in the DOM (no
      // portal); closed = the `hidden` attribute. role="status" +
      // aria-live="polite" announce the message without interrupting.
      const isOpen = tryResolve(ctx.sources, display.spec.open) === true;
      const toneClass = toneVar(display.spec.tone);
      return (
        <div
          className={`fuaran-toast fuaran-toast-${toneClass}`}
          role="status"
          aria-live="polite"
          {...(!isOpen ? { hidden: true } : {})}
        >
          <span className="fuaran-toast-message">
            {renderText(ctx.sources, display.spec.message)}
          </span>
          {display.spec.dismissable ? (
            <button className="fuaran-toast-dismiss" type="button" aria-label="Dismiss">
              ×
            </button>
          ) : null}
        </div>
      );
    }

    case 'CodeBlock': {
      // Phase 290 — DETERMINISTIC <pre><code> (HTML-escaped by React, NO markdown
      // library), byte-identical across hosts + SSR. Syntax highlighting is a
      // client-only post-hydration enhancement that targets the `language-{x}`
      // class — explicitly NOT emitted here (outside the parity output). Line
      // numbers + highlight ranges are deterministic class / data hooks.
      const spec = display.spec;
      const containerClass = spec.lineNumbers
        ? 'fuaran-codeblock fuaran-codeblock-numbered'
        : 'fuaran-codeblock';
      const highlightAttr =
        spec.highlightLines.length > 0
          ? { 'data-highlight-lines': spec.highlightLines.join(',') }
          : {};
      return (
        <div className={containerClass} data-language={spec.language} {...highlightAttr}>
          {spec.copyable ? (
            <button className="fuaran-codeblock-copy" type="button" aria-label="Copy">
              Copy
            </button>
          ) : null}
          <pre className="fuaran-codeblock-pre">
            <code className={`fuaran-codeblock-code language-${spec.language}`}>{spec.code}</code>
          </pre>
        </div>
      );
    }

    case 'Math': {
      // Phase 658 — DETERMINISTIC native MathML for the closed subset (real
      // superscripts with NO JavaScript), or the raw escaped-source span for
      // out-of-subset input. `mathMl` is byte-identical to the F# renderer (and
      // the server renderer imports the same builder). KaTeX upgrades either
      // shape client-only post-hydration (targets the `.fuaran-math` container,
      // reads `data-fuaran-math-src`), OUTSIDE the parity output. See
      // fuaran/docs/MATH-DEGRADATION.md.
      const spec = display.spec;
      const markup = mathMl(spec.source, spec.display);
      const isBlock = spec.display === 'Block';
      const className = isBlock
        ? 'fuaran-math fuaran-math-block'
        : 'fuaran-math fuaran-math-inline';
      const dataDisplay = isBlock ? 'block' : 'inline';
      if (markup !== null) {
        return isBlock ? (
          <div
            className={className}
            data-math-display={dataDisplay}
            data-fuaran-math-src={spec.source}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        ) : (
          <span
            className={className}
            data-math-display={dataDisplay}
            data-fuaran-math-src={spec.source}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        );
      }
      const sourceSpan = <span className="fuaran-math-source">{spec.source}</span>;
      return isBlock ? (
        <div
          className={className}
          data-math-display={dataDisplay}
          data-fuaran-math-src={spec.source}
        >
          {sourceSpan}
        </div>
      ) : (
        <span
          className={className}
          data-math-display={dataDisplay}
          data-fuaran-math-src={spec.source}
        >
          {sourceSpan}
        </span>
      );
    }
  }
};

const renderHeading = <TMsg,>(ctx: RenderContext<TMsg>, spec: HeadingSpec): ReactElement => {
  const variantSuffix =
    spec.variant === 'Eyebrow'
      ? ' fuaran-heading-eyebrow'
      : spec.variant === 'Caption'
        ? ' fuaran-heading-caption'
        : spec.variant === 'Lead'
          ? ' fuaran-heading-lead'
          : '';
  const className = `fuaran-heading${variantSuffix}`;
  const text = renderText(ctx.sources, spec.text);
  const level = spec.level;
  switch (level) {
    case 1:
      return <h1 className={className}>{text}</h1>;
    case 2:
      return <h2 className={className}>{text}</h2>;
    case 3:
      return <h3 className={className}>{text}</h3>;
    case 4:
      return <h4 className={className}>{text}</h4>;
    case 5:
      return <h5 className={className}>{text}</h5>;
    default:
      return <h6 className={className}>{text}</h6>;
  }
};

const renderMetric = <TMsg,>(
  ctx: RenderContext<TMsg>,
  state: StateBehaviour<TMsg>,
  spec: MetricSpec,
): ReactNode => {
  // Phase 632 — the Metric value is a scalar slot: a `Binding.Transform`
  // resolves to its 1×1 result cell (a global aggregate / row-field lookup).
  const resolution = resolveScalarFloat(ctx.sources, spec.value);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  return (
    <div className={`fuaran-metric fuaran-metric-${toneVar(spec.tone)}`}>
      {spec.icon !== undefined ? iconHook('fuaran-metric-icon', spec.icon) : null}
      <div className="fuaran-metric-label">{renderText(ctx.sources, spec.label)}</div>
      <div className="fuaran-metric-value">{resolvedValueText(resolution, spec.format)}</div>
      {spec.trend !== undefined && (
        <div className="fuaran-metric-trend">
          {(() => {
            const t = tryResolveScalarFloat(ctx.sources, spec.trend);
            return t !== undefined ? formatNumber(spec.trendFormat ?? { kind: 'None' }, t) : '';
          })()}
        </div>
      )}
      {spec.subtext !== undefined && (
        <div className="fuaran-metric-subtext">{renderText(ctx.sources, spec.subtext)}</div>
      )}
    </div>
  );
};

const renderCallout = <TMsg,>(ctx: RenderContext<TMsg>, spec: CalloutSpec): ReactElement => (
  <div className={`fuaran-callout fuaran-callout-${toneVar(spec.tone)}`}>
    {spec.icon !== undefined ? iconHook('fuaran-callout-icon', spec.icon) : null}
    {spec.heading !== undefined && (
      <div className="fuaran-callout-heading">{renderText(ctx.sources, spec.heading)}</div>
    )}
    <div className="fuaran-callout-body">{renderText(ctx.sources, spec.body)}</div>
    {spec.dismissable ? (
      <button className="fuaran-callout-dismiss" aria-label="Dismiss">
        ×
      </button>
    ) : null}
  </div>
);

const renderProgress = <TMsg,>(
  ctx: RenderContext<TMsg>,
  state: StateBehaviour<TMsg>,
  spec: ProgressSpec,
): ReactNode => {
  const resolution = resolve(ctx.sources, spec.fraction);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const fraction = resolution.kind === 'Resolved' ? resolution.value : 0;
  const indeterminate = spec.indeterminate ? ' fuaran-progress-indeterminate' : '';
  return (
    <div className={`fuaran-progress fuaran-progress-${toneVar(spec.tone)}${indeterminate}`}>
      {spec.label !== undefined && (
        <div className="fuaran-progress-label">{renderText(ctx.sources, spec.label)}</div>
      )}
      <div className="fuaran-progress-bar">
        <div className="fuaran-progress-fill" style={{ width: `${fraction * 100}%` }} />
      </div>
      {spec.caveat !== undefined && (
        <div className="fuaran-progress-caveat">{renderText(ctx.sources, spec.caveat)}</div>
      )}
    </div>
  );
};

const renderLabelValueRow = <TMsg,>(
  ctx: RenderContext<TMsg>,
  state: StateBehaviour<TMsg>,
  spec: LabelValueRowSpec,
): ReactNode => {
  // Phase 632 — a scalar slot: Transform resolves to its 1×1 result cell.
  const resolution = resolveScalarFloat(ctx.sources, spec.value);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(ctx, state.onError(bindingResolutionError(resolution.message)));
  }
  const emphasisSuffix = spec.emphasis ? ' fuaran-label-value-row-emphasis' : '';
  return (
    <div className={`fuaran-label-value-row${emphasisSuffix}`}>
      <div className="fuaran-label-value-row-label-block">
        <span className="fuaran-label-value-row-label">{renderText(ctx.sources, spec.label)}</span>
        {spec.help !== undefined && (
          <span className="fuaran-label-value-row-help">{renderText(ctx.sources, spec.help)}</span>
        )}
      </div>
      <span className="fuaran-label-value-row-value">
        {resolvedValueText(resolution, spec.format)}
      </span>
    </div>
  );
};

const renderSparkline = <TMsg,>(ctx: RenderContext<TMsg>, spec: SparklineSpec): ReactElement => {
  const series = asArray<number>(tryResolve(ctx.sources, spec.source));
  if (series.length === 0) {
    return <div className="fuaran-sparkline fuaran-sparkline-empty">—</div>;
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
  return (
    <svg className="fuaran-sparkline" viewBox="0 0 100 30" preserveAspectRatio="none">
      <polyline
        className="fuaran-sparkline-line"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        points={points}
      />
    </svg>
  );
};
