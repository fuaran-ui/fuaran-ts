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

const shapeSvg = (sources: BindingSources, sh: Shape): string => {
  switch (sh.kind) {
    case 'Group': {
      const inner = sh.children.map((c) => shapeSvg(sources, c)).join('');
      return `<g class="fuaran-drawing-group"${styleAttrs(sources, false, sh.style)}>${inner}</g>`;
    }
    case 'Rectangle': {
      const rx = sh.cornerRadius !== undefined ? ` rx="${formatNum(sh.cornerRadius)}"` : '';
      return `<rect class="fuaran-drawing-rect" x="${formatNum(sh.x)}" y="${formatNum(sh.y)}" width="${formatNum(sh.width)}" height="${formatNum(sh.height)}"${rx}${styleAttrs(sources, false, sh.style)}/>`;
    }
    case 'Line':
      return `<line class="fuaran-drawing-line" x1="${formatNum(sh.x1)}" y1="${formatNum(sh.y1)}" x2="${formatNum(sh.x2)}" y2="${formatNum(sh.y2)}"${styleAttrs(sources, false, sh.style)}/>`;
    case 'Polyline':
      return `<polyline class="fuaran-drawing-polyline" points="${pointsAttr(sh.points)}"${styleAttrs(sources, true, sh.style)}${strokeJoinAttrs(sources, sh.style)}/>`;
    case 'Polygon':
      return `<polygon class="fuaran-drawing-polygon" points="${pointsAttr(sh.points)}"${styleAttrs(sources, false, sh.style)}${strokeJoinAttrs(sources, sh.style)}/>`;
    case 'Curve':
      return `<path class="fuaran-drawing-curve" d="${pathD(sh.commands)}"${styleAttrs(sources, true, sh.style)}${strokeJoinAttrs(sources, sh.style)}/>`;
    case 'Circle':
      return `<circle class="fuaran-drawing-circle" cx="${formatNum(sh.cx)}" cy="${formatNum(sh.cy)}" r="${formatNum(sh.r)}"${styleAttrs(sources, false, sh.style)}/>`;
    case 'Ellipse':
      return `<ellipse class="fuaran-drawing-ellipse" cx="${formatNum(sh.cx)}" cy="${formatNum(sh.cy)}" rx="${formatNum(sh.rx)}" ry="${formatNum(sh.ry)}"${styleAttrs(sources, false, sh.style)}/>`;
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
      return `<text class="fuaran-drawing-label" x="${formatNum(sh.x)}" y="${formatNum(sh.y)}"${rot}${styleAttrs(sources, false, sh.style)}>${escape(renderText(sources, sh.text))}</text>`;
    }
  }
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
  return `<svg class="fuaran-drawing" role="img" viewBox="${viewBox}"${styleAttrs(sources, false, spec.style)}>${title}${desc}${body}</svg>`;
};
