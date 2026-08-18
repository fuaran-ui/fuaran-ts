// ============================================================================
//  Phase 525 — the canonical inline-SVG string for a `DisplayKind.Drawing`.
//
//  The TypeScript port of the F# `Fuaran.UI.Renderer.DrawingSvg` builder — the
//  ONE serialisation both the React client (via `dangerouslySetInnerHTML`) and
//  the string server renderer emit, so their `fuaran-*` class sets are parity by
//  construction (Lock A). A `Drawing` is resolved static geometry (Phase 524),
//  so it renders identically client + server. First-party, zero third-party dep.
//
//  Class vocabulary parity-locked to the F# reference (Lock B):
//  `fuaran-drawing` + `fuaran-drawing-{group,rect,line,polyline,polygon,curve,
//  circle,ellipse,label}`. a11y: `role="img"` + optional `<title>`/`<desc>`.
//  The bytes match the F# builder's `DrawingSvgTests` golden.
// ============================================================================

import type { CurveCommand, DrawPoint, DrawStyle, DrawingSpec, Shape } from '@fuaran-ui/schema';

import { type BindingSources, renderText, tryResolve } from './bindings.js';

/** Canonical SVG number form — matches the F# `DrawingSvg.formatNum` (whole →
 * no decimal; else the shortest round-trip). JS `String` already drops `.0`. */
const formatNum = (n: number): string => (Number.isFinite(n) ? String(n) : '0');

/** XML-escape text / attribute content (raw markup rides innerHTML). `&` first. */
const escape = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const point = (p: DrawPoint): string => `${formatNum(p.x)},${formatNum(p.y)}`;

const pointsAttr = (pts: readonly DrawPoint[]): string => pts.map(point).join(' ');

/** The typed `CurveCommand` list → an SVG path `d` string (no raw authored `d`). */
const pathD = (commands: readonly CurveCommand[]): string =>
  commands
    .map((c): string => {
      switch (c.kind) {
        case 'MoveTo':
          return `M${formatNum(c.to.x)} ${formatNum(c.to.y)}`;
        case 'LineTo':
          return `L${formatNum(c.to.x)} ${formatNum(c.to.y)}`;
        case 'CubicTo':
          return `C${formatNum(c.control1.x)} ${formatNum(c.control1.y)} ${formatNum(c.control2.x)} ${formatNum(c.control2.y)} ${formatNum(c.to.x)} ${formatNum(c.to.y)}`;
        case 'QuadraticTo':
          return `Q${formatNum(c.control.x)} ${formatNum(c.control.y)} ${formatNum(c.to.x)} ${formatNum(c.to.y)}`;
        case 'Close':
          return 'Z';
      }
    })
    .join(' ');

/** `DrawStyle` bindings → SVG presentation attributes (canonical order: fill,
 * opacity, stroke, stroke-width, then the text-only attrs text-anchor,
 * font-family, font-size, font-weight — Phase 528.1). Open shapes default
 * `fill="none"`; the text attrs are emitted only when set (no-op on non-text
 * shapes, which never carry them). */
const styleAttrs = (
  sources: BindingSources,
  defaultFillNone: boolean,
  style: DrawStyle,
): string => {
  let out = '';
  const fill =
    style.fill !== undefined
      ? tryResolve(sources, style.fill)
      : defaultFillNone
        ? 'none'
        : undefined;
  if (fill !== undefined) out += ` fill="${escape(fill)}"`;
  const opacity = style.opacity !== undefined ? tryResolve(sources, style.opacity) : undefined;
  if (opacity !== undefined) out += ` opacity="${formatNum(opacity)}"`;
  const stroke = style.stroke !== undefined ? tryResolve(sources, style.stroke) : undefined;
  if (stroke !== undefined) out += ` stroke="${escape(stroke)}"`;
  const strokeWidth =
    style.strokeWidth !== undefined ? tryResolve(sources, style.strokeWidth) : undefined;
  if (strokeWidth !== undefined) out += ` stroke-width="${formatNum(strokeWidth)}"`;
  if (style.textAnchor !== undefined) {
    const a =
      style.textAnchor === 'Start' ? 'start' : style.textAnchor === 'Middle' ? 'middle' : 'end';
    out += ` text-anchor="${a}"`;
  }
  if (style.fontFamily !== undefined) out += ` font-family="${escape(style.fontFamily)}"`;
  if (style.fontSize !== undefined) out += ` font-size="${formatNum(style.fontSize)}px"`;
  if (style.emphasis !== undefined) {
    const w = style.emphasis === 'Quiet' ? '300' : style.emphasis === 'Normal' ? '400' : '700';
    out += ` font-weight="${w}"`;
  }
  // Phase 642 — keyed mark identity: a data-bearing shape's derivation-based
  // id rides into the emitted SVG so marks are addressable (object constancy)
  // — last in the fixed attribute order.
  if (style.markId !== undefined) out += ` data-fuaran-mark="${escape(style.markId)}"`;
  return out;
};

/** Phase 875 — round line joins + caps on a STROKED path shape (`Polyline` /
 * `Polygon` / `Curve`). A RENDERER default, not a wire field: `DrawStyle`
 * gains nothing, no fixture changes shape, and every host emits the same two
 * attributes from its own builder. SVG's initial `stroke-linejoin` is
 * `miter`, which spikes at the acute vertices a data polyline routinely has —
 * a visible artefact that carries no data.
 *
 * Emitted only when the shape actually strokes, so a fill-only polygon (an
 * area band) keeps its minimal attribute set. `Line` is deliberately
 * excluded: a round cap on the axis and gridline rules would overhang each
 * end by half the stroke width, lengthening chrome that is positioned
 * exactly. */
const strokeJoinAttrs = (sources: BindingSources, style: DrawStyle): string => {
  const stroke = style.stroke !== undefined ? tryResolve(sources, style.stroke) : undefined;
  return stroke !== undefined ? ' stroke-linejoin="round" stroke-linecap="round"' : '';
};

/** Phase 883 — the mark's hover readout as an SVG `<title>` CHILD of its own
 * element: the native browser tooltip and the element's accessible name, with
 * no script, so a statically-served page carries it. `<title>` must be the
 * FIRST child to be the accessible name, which is why every arm below emits it
 * ahead of any other content.
 *
 * A tip is the one `DrawStyle` field honoured on EVERY shape rather than only
 * on `Label` — the marks a reader hovers are bars, wedges and points, and a
 * `<title>` is inert geometry-wise on all of them (unlike `rotation`, whose
 * off-`Label` emission would move geometry).
 *
 * The text is XML-escaped through the same `escape` the label text and the
 * drawing `<title>` / `<desc>` use: this builder emits raw markup, so escaping
 * here is the whole defence, and the chart lowering feeds it UNTRUSTED
 * series/category strings straight off the data feed. */
const tipChild = (sources: BindingSources, style: DrawStyle): string =>
  style.tip !== undefined ? `<title>${escape(renderText(sources, style.tip))}</title>` : '';

/** The tail of a shape element carrying no child content of its own:
 * self-closing when untipped (byte-unchanged from pre-883), an open/close pair
 * wrapping the `<title>` when tipped. */
const closeTag = (sources: BindingSources, style: DrawStyle, element: string): string =>
  style.tip !== undefined ? `>${tipChild(sources, style)}</${element}>` : '/>';

const shapeSvg = (sources: BindingSources, sh: Shape): string => {
  switch (sh.kind) {
    case 'Group': {
      const inner = sh.children.map((c) => shapeSvg(sources, c)).join('');
      return `<g class="fuaran-drawing-group"${styleAttrs(sources, false, sh.style)}>${tipChild(sources, sh.style)}${inner}</g>`;
    }
    case 'Rectangle': {
      const rx = sh.cornerRadius !== undefined ? ` rx="${formatNum(sh.cornerRadius)}"` : '';
      return `<rect class="fuaran-drawing-rect" x="${formatNum(sh.x)}" y="${formatNum(sh.y)}" width="${formatNum(sh.width)}" height="${formatNum(sh.height)}"${rx}${styleAttrs(sources, false, sh.style)}${closeTag(sources, sh.style, 'rect')}`;
    }
    case 'Line':
      return `<line class="fuaran-drawing-line" x1="${formatNum(sh.x1)}" y1="${formatNum(sh.y1)}" x2="${formatNum(sh.x2)}" y2="${formatNum(sh.y2)}"${styleAttrs(sources, false, sh.style)}${closeTag(sources, sh.style, 'line')}`;
    case 'Polyline':
      return `<polyline class="fuaran-drawing-polyline" points="${pointsAttr(sh.points)}"${styleAttrs(sources, true, sh.style)}${strokeJoinAttrs(sources, sh.style)}${closeTag(sources, sh.style, 'polyline')}`;
    case 'Polygon':
      return `<polygon class="fuaran-drawing-polygon" points="${pointsAttr(sh.points)}"${styleAttrs(sources, false, sh.style)}${strokeJoinAttrs(sources, sh.style)}${closeTag(sources, sh.style, 'polygon')}`;
    case 'Curve':
      return `<path class="fuaran-drawing-curve" d="${pathD(sh.commands)}"${styleAttrs(sources, true, sh.style)}${strokeJoinAttrs(sources, sh.style)}${closeTag(sources, sh.style, 'path')}`;
    case 'Circle':
      return `<circle class="fuaran-drawing-circle" cx="${formatNum(sh.cx)}" cy="${formatNum(sh.cy)}" r="${formatNum(sh.r)}"${styleAttrs(sources, false, sh.style)}${closeTag(sources, sh.style, 'circle')}`;
    case 'Ellipse':
      return `<ellipse class="fuaran-drawing-ellipse" cx="${formatNum(sh.cx)}" cy="${formatNum(sh.cy)}" rx="${formatNum(sh.rx)}" ry="${formatNum(sh.ry)}"${styleAttrs(sources, false, sh.style)}${closeTag(sources, sh.style, 'ellipse')}`;
    case 'Label': {
      // Phase 877 — text rotation. Emitted here rather than in `styleAttrs`
      // because the pivot is the label's own anchor point, which the style
      // record does not know; `styleAttrs` is shared by every shape and stays
      // position-free. Anchoring at (x, y) is what makes rotation compose with
      // `textAnchor` — the text turns about the point it is aligned to.
      // Degrees, clockwise (SVG's own convention), so no sign conversion.
      const rot =
        sh.style.rotation !== undefined
          ? ` transform="rotate(${formatNum(sh.style.rotation)} ${formatNum(sh.x)} ${formatNum(sh.y)})"`
          : '';
      // The tip precedes the visible run — `<title>` is the accessible name
      // only as the FIRST child, and SVG renders it either way as nothing.
      return `<text class="fuaran-drawing-label" x="${formatNum(sh.x)}" y="${formatNum(sh.y)}"${rot}${styleAttrs(sources, false, sh.style)}>${tipChild(sources, sh.style)}${escape(renderText(sources, sh.text))}</text>`;
    }
  }
};

// ─── The root's announced accessible name (Phase 921) ────────────────────────
//
// `role="img"` presents the drawing as ONE graphic and does not traverse into
// it, and `<desc>` is not uniformly mapped to the accessible description
// (Chromium has never exposed it) — so the value the markup has carried since
// Phase 525 is one a reader cannot reach.
//
// The fix is `aria-label` on the root, composing the TITLE and the DESCRIPTION
// into one string. It is the accessible NAME, which every assistive technology
// announces unconditionally for a `role="img"` element.
//
// NOT `aria-labelledby` / `aria-describedby`: both reference elements BY ID, and
// this builder has no id to give — its whole input is a `DrawingSpec`, several
// drawings routinely share one document, and any minted id would have to be both
// unique per page and byte-identical across five hosts.
//
// Emitted ONLY when a description is present, so every pre-921 title-only or
// bare drawing is byte-identical. The `<title>` and `<desc>` children are
// unchanged — `<title>` stays the native hover tooltip.

/** Terminate a title with `.` unless it already ends in sentence punctuation, so
 * the composed label reads as two sentences rather than one run-on. */
const terminateTitle = (t: string): string =>
  t === '' || t.endsWith('.') || t.endsWith('!') || t.endsWith('?') ? t : `${t}.`;

/** The composed accessible name, or `''` when the root emits no `aria-label`. */
const rootAriaLabel = (sources: BindingSources, spec: DrawingSpec): string => {
  if (spec.description === undefined) return '';
  const descText = renderText(sources, spec.description);
  const titleText = spec.title !== undefined ? terminateTitle(renderText(sources, spec.title)) : '';
  const composed = titleText !== '' ? `${titleText} ${descText}` : descText;
  return ` aria-label="${escape(composed)}"`;
};

/** The full canonical inline-SVG string for a `Drawing` (a11y root + shapes). */
export const drawingSvg = (sources: BindingSources, spec: DrawingSpec): string => {
  const vb = spec.viewBox;
  const viewBox = `${formatNum(vb.minX)} ${formatNum(vb.minY)} ${formatNum(vb.width)} ${formatNum(vb.height)}`;
  const title =
    spec.title !== undefined ? `<title>${escape(renderText(sources, spec.title))}</title>` : '';
  const desc =
    spec.description !== undefined
      ? `<desc>${escape(renderText(sources, spec.description))}</desc>`
      : '';
  const body = spec.shapes.map((s) => shapeSvg(sources, s)).join('');
  return `<svg class="fuaran-drawing" role="img" viewBox="${viewBox}"${rootAriaLabel(sources, spec)}${styleAttrs(sources, false, spec.style)}>${title}${desc}${body}</svg>`;
};
