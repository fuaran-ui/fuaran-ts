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
  EmbedPermission,
  StateBehaviour,
  TreeItem,
} from '@fuaran-ui/schema';

import {
  asArray,
  electedDefaultTracks,
  focusableTreeItem,
  formatNumber,
  readExpandedItems,
  readSelectedItem,
  renderText,
  resolve,
  resolveScalarFloat,
  type Resolution,
  trackKindToken,
  treeItemExpanded,
  tryResolve,
  tryResolveScalarFloat,
} from '../bindings.js';
import { tryLowerSparkline } from '@fuaran-ui/charts';

import { imageAspectClass, toneVar, trendSentiment } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { drawingSvg } from '../drawingSvg.js';
import { mathMl } from '../mathMl.js';
import { sanitizeEmbedSrcForEgress, sanitizeUrlForEgress } from '../egress.js';
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

    case 'Media': {
      // Phase 1076 — the media transport. Four things here are contract rather
      // than choice, and each is stated normatively in WIRE_FORMAT §3.6.6
      // because a host that got any of them wrong would still round-trip the
      // bytes perfectly:
      //
      //   * `aria-label` ALWAYS. The label is mandatory on the wire and a
      //     transport has no decorative case, so unlike `Image`'s `alt` there
      //     is no branch — the attribute is emitted whatever it resolves to.
      //   * `autoplay` NEVER WITHOUT `muted`. The pairing is what the
      //     declaration MEANS, not a default a caller overrides, which is why
      //     the wire carries no separate muted slot to fall out of step with
      //     it. Every browser blocks unmuted autoplay, so an unmuted emission
      //     is a player that silently never starts.
      //   * NO AUTOPLAY PATHWAY ON AUDIO, at all. Not "off by default" — the
      //     `Audio` case carries no slot to read, so this arm has nothing to
      //     branch on and cannot acquire one by a later edit here.
      //   * BOTH URLS THROUGH THE `media` EGRESS SEAM. A refused `src`
      //     collapses (an element must have a source); a refused `poster` is
      //     DROPPED, because a <video> with no poster shows its first frame
      //     while a poster at the refusal URL is a broken image over the
      //     player. Same rule as a refused srcSet candidate.
      //
      // Nothing is attached at hydration: a `<video controls>` is already a
      // complete interactive control, so there is no enhancement tier here as
      // there is for `Image.expandable`.
      const [src, egressAttrs] = sanitizeUrlForEgress(
        ctx.egressPolicy,
        'media',
        tryResolve(ctx.sources, display.spec.src) ?? '',
      );
      const shared = {
        src,
        'aria-label': renderText(ctx.sources, display.spec.label),
        ...(display.spec.controls ? { controls: true } : {}),
        ...(display.spec.loop ? { loop: true } : {}),
        ...semanticAttrs,
        ...Object.fromEntries(egressAttrs),
      };
      // Phase 1110 — the timed-text tracks, in AUTHORED order (never re-sorted:
      // a reader picks from a menu the user agent builds in document order). A
      // track whose source the egress floor refuses is DROPPED — the POSTER's
      // disposition rather than the source's, because an element must have a
      // source but need not have this track, and a `<track>` pointing at the
      // refusal URL is a menu entry that opens onto nothing. At most one
      // `default` per KIND survives, first election wins; the later track is
      // still emitted, only its claim on the menu is dropped.
      const elected = electedDefaultTracks(display.spec.tracks);
      const trackEls = display.spec.tracks.map((t, i) => {
        const [trackSrc, trackRefusal] = sanitizeUrlForEgress(
          ctx.egressPolicy,
          'media',
          tryResolve(ctx.sources, t.src) ?? '',
        );
        if (trackSrc === '' || trackRefusal.length > 0) return null;
        return (
          <track
            key={i}
            kind={trackKindToken(t.kind)}
            src={trackSrc}
            // The lower-case HTML spelling, spread rather than written as the
            // camel-case prop: React 19 passes this attribute through UNMAPPED,
            // so `srcLang={…}` emits `srcLang=` — which an HTML parser still
            // reads (attribute names are ASCII case-insensitive) but which
            // differs byte-for-byte from the server tier's emission for no
            // reason at all. The typings only know the camel-case spelling, so
            // the spread is what carries the correct one.
            {...{ srclang: t.srcLang }}
            label={renderText(ctx.sources, t.label)}
            {...(elected[i] === true ? { default: true } : {})}
          />
        );
      });
      // The transcript renders as a disclosure BESIDE the transport, never
      // inside it: `<video>` / `<audio>` admit only source-ish children, so a
      // transcript placed there would be fallback content a browser never shows.
      // The disclosure carries the MEDIA's resolved label as its own accessible
      // name, so a reader meeting it out of context is told which recording it
      // transcribes.
      const withTranscript = (element: ReactNode): ReactNode => {
        if (display.spec.transcript === undefined) return element;
        return (
          <div className="fuaran-media-group">
            {element}
            <details
              className="fuaran-media-transcript"
              aria-label={renderText(ctx.sources, display.spec.label)}
            >
              <summary className="fuaran-media-transcript-summary">Transcript</summary>
              <div className="fuaran-media-transcript-body">
                {renderText(ctx.sources, display.spec.transcript)}
              </div>
            </details>
          </div>
        );
      };
      if (display.spec.kind.$type === 'Audio') {
        return withTranscript(
          <audio className="fuaran-media fuaran-media-audio" {...shared}>
            {trackEls}
          </audio>,
        );
      }
      const posterBinding = display.spec.kind.poster;
      let posterAttrs: { poster?: string } = {};
      if (posterBinding !== undefined) {
        const [safePoster, posterRefusal] = sanitizeUrlForEgress(
          ctx.egressPolicy,
          'media',
          tryResolve(ctx.sources, posterBinding) ?? '',
        );
        if (safePoster !== '' && posterRefusal.length === 0) posterAttrs = { poster: safePoster };
      }
      // The pairing, on the tier where it governs playback. Both flags together
      // or neither — a `muted` emitted without `autoplay` would silence a video
      // the reader pressed play on, which is the same defect in the other
      // direction.
      const autoplayAttrs = display.spec.kind.autoplay ? { autoPlay: true, muted: true } : {};
      return withTranscript(
        <video
          className="fuaran-media fuaran-media-video"
          {...shared}
          {...posterAttrs}
          {...autoplayAttrs}
        >
          {trackEls}
        </video>,
      );
    }

    // Phase 1111 — the sandboxed third-party embed, structural parity with the
    // server renderer and with both F# renderers. Four contract points, in the
    // order they appear below: the `sandbox` attribute emitted ALWAYS and EMPTY
    // when nothing is granted (omitting it on a permissionless embed would be
    // the same markup as an unsandboxed frame); the tokens in the vocabulary's
    // DECLARATION order and de-duplicated, so two documents naming the same set
    // produce identical markup whatever order they authored; fullscreen riding
    // `allow` rather than `sandbox`, because it is a permissions-policy
    // directive and not a sandbox token; and a refused `src` OMITTED ENTIRELY
    // rather than pointed at the refusal URL, because an iframe at that URL
    // renders that page.
    case 'Embed': {
      const [embedSrc, embedEgressAttrs] = sanitizeEmbedSrcForEgress(
        ctx.egressPolicy,
        tryResolve(ctx.sources, display.spec.src) ?? '',
      );
      const has = (perm: EmbedPermission): boolean => display.spec.permissions.includes(perm);
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
      return (
        <iframe
          className={'fuaran-embed' + aspectClass}
          title={renderText(ctx.sources, display.spec.title)}
          sandbox={sandboxTokens.join(' ')}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          {...(embedSrc === undefined ? {} : { src: embedSrc })}
          {...(has('AllowFullscreen') ? { allow: 'fullscreen' } : {})}
          {...semanticAttrs}
          {...Object.fromEntries(embedEgressAttrs)}
        />
      );
    }

    // Phase 1120 — the tree. Structurally identical to the server floor, and
    // deliberately so: this arm renders the SAME elements, the SAME ARIA and the
    // SAME roving tabindex, computed from the SAME shared state readers, so a
    // hydrating client cannot replace the server's rows. Movement is this tier's
    // addition over that identical DOM, never a precondition for the document
    // being readable.
    case 'Tree': {
      const spec = display.spec;
      const expandedKeyNamed = spec.expandedStateKey !== undefined;
      const expanded = readExpandedItems(ctx.sources, spec.expandedStateKey);
      const selected = readSelectedItem(ctx.sources, spec.selectionStateKey);
      const focusable = focusableTreeItem(expandedKeyNamed, expanded, selected, spec.items);
      const renderItems = (level: number, items: readonly TreeItem[]): ReactNode[] => {
        const setSize = items.length;
        return items.map((item, i) => {
          const isOpen = treeItemExpanded(expandedKeyNamed, expanded, item);
          const hasChildren = item.children.length > 0;
          const label = renderText(ctx.sources, item.label);
          return (
            <li
              key={item.id}
              className="fuaran-tree-item"
              role="treeitem"
              // STATED rather than computed from contents: a treeitem OWNS its
              // child group, so a name derived from its subtree would read the
              // whole branch out as the row's own name.
              aria-label={label}
              aria-level={level}
              aria-setsize={setSize}
              aria-posinset={i + 1}
              data-fuaran-tree-item={item.id}
              tabIndex={item.id === focusable ? 0 : -1}
              // Emitted ONLY on a row that HAS children. On a leaf the attribute
              // asserts a collapsed subtree that does not exist, and assistive
              // technology announces such a row as closed.
              {...(hasChildren ? { 'aria-expanded': isOpen } : {})}
              // Likewise only where a selection key is named: a tree that never
              // selects must not declare a selectable widget with nothing
              // selected.
              {...(spec.selectionStateKey !== undefined
                ? { 'aria-selected': item.id === selected }
                : {})}
            >
              <span className="fuaran-tree-label">{label}</span>
              {isOpen ? (
                <ul className="fuaran-tree-group" role="group">
                  {renderItems(level + 1, item.children)}
                </ul>
              ) : null}
            </li>
          );
        });
      };
      return (
        <ul className="fuaran-tree" role="tree">
          {renderItems(1, spec.items)}
        </ul>
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

// Phase 1099 — the bespoke polyline builder is retired for the shared
// `Sparkline -> Drawing` lowering (Phase 644's D7), emitted through the SAME
// `drawingSvg` builder the `Drawing` and `Chart` arms already use. This arm and
// the string server renderer's arm were two hand-written copies of one
// algorithm producing byte-identical pictures; they are now the same bytes by
// construction, which is what moved `Sparkline` to `"class": "none"` in the
// render-fidelity contract.
//
// The `fuaran-sparkline` class moves to the CONTAINER. That is where the 100x30
// sizing and the inherited `color` the lowering's `currentColor` stroke reads
// have always lived, so the hook `render-fidelity.json` names survives and the
// picture does not move; the inner SVG is the shared builder's `fuaran-drawing`
// root.
//
// An unresolved or empty series keeps the em-dash element, unchanged: it is a
// host element rather than a `Shape`, so `tryLowerSparkline` reports it in the
// return type rather than lowering an empty canvas nobody can read.
const renderSparkline = <TMsg,>(ctx: RenderContext<TMsg>, spec: SparklineSpec): ReactElement => {
  const drawing = tryLowerSparkline(asArray<number>(tryResolve(ctx.sources, spec.source)));
  if (drawing === null) {
    return <div className="fuaran-sparkline fuaran-sparkline-empty">—</div>;
  }
  return (
    <div
      className="fuaran-sparkline"
      dangerouslySetInnerHTML={{ __html: drawingSvg(ctx.sources, drawing) }}
    />
  );
};
