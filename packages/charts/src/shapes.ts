// @fuaran-ui/charts — DrawStyle and the shape builders.
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import type {
  Binding,
  DrawPoint,
  DrawStyle,
  Emphasis,
  Shape,
  TextAnchor,
  TextSource,
} from '@fuaran-ui/schema';

import { AXIS_OPACITY, CHART_FONT, INK } from './layout.js';
import { WITHHELD_WORD } from './spec.js';

// ─── DrawStyle + shape builders ──────────────────────────────────────────────

const staticBinding = <T>(value: T): Binding<T> => ({ kind: 'Static', value });

/** Phase 642 — stamp a derivation-based mark identity onto a data-bearing
 * shape's style: `series-field|category-key`, stable under row reorder and
 * data refresh (object constancy). Chrome deliberately stays unstamped. */
export const withMark = (
  seriesField: string,
  categoryKey: string,
  style: DrawStyle,
): DrawStyle => ({
  ...style,
  markId: `${seriesField}|${categoryKey}`,
});

/** A series-level mark (one shape carries the whole series — Line/Area): the
 * identity is the series field alone. */
export const withSeriesMark = (seriesField: string, style: DrawStyle): DrawStyle => ({
  ...style,
  markId: seriesField,
});

/** Phase 883 — the separator between the three parts of a hover readout. A
 * middle dot with spaces of its own: not a character a series or category name
 * is likely to contain (a hyphen, a slash and a comma all are), and it reads as
 * a separator rather than as punctuation belonging to either side. */
export const TIP_SEPARATOR = ' · ';

/** Phase 883 — stamp the hover readout onto a data-bearing shape's style. An
 * EMPTY readout is dropped rather than encoded: an empty SVG `<title>`
 * suppresses the native tooltip AND overrides the element's accessible name
 * with nothing, which is worse than no title at all. */
export const withTip = (text: string, style: DrawStyle): DrawStyle =>
  text === '' ? style : { ...style, tip: { kind: 'Literal', value: text } };

export const styleFill = (fill: string): DrawStyle => ({ fill: staticBinding(fill) });

export const styleStroke = (stroke: string, width: number): DrawStyle => ({
  stroke: staticBinding(stroke),
  strokeWidth: staticBinding(width),
});

export const styleFillOpacity = (fill: string, opacity: number): DrawStyle => ({
  fill: staticBinding(fill),
  opacity: staticBinding(opacity),
});

/** Surface-relative structural stroke (`currentColor` at a per-role opacity). */
export const styleStrokeInk = (opacity: number, width: number): DrawStyle => ({
  stroke: staticBinding(INK),
  strokeWidth: staticBinding(width),
  opacity: staticBinding(opacity),
});

/** Phase 2809 (D38) — the readout of a WITHHELD datum: "Series · Category ·
 * withheld", with no number, because the number is what the gate suppressed.
 * Phase 2810 — shared by the series arms and the Heatmap arm ("Row · X · withheld"). */
export const withheldTip = (
  seriesField: string,
  categoryKey: string,
  style: DrawStyle,
): DrawStyle =>
  withTip(`${seriesField}${TIP_SEPARATOR}${categoryKey}${TIP_SEPARATOR}${WITHHELD_WORD}`, style);

/** Phase 2809 — the WITHHELD placeholder's paint: no fill, outlined in the
 * axis's own ink at the axis's opacity — surface-relative, so it reads on every
 * theme, and never a series colour, so it never reads as data. */
export const withheldStyle = (): DrawStyle => ({
  ...styleFill('none'),
  ...styleStrokeInk(AXIS_OPACITY, 1.0),
});

/** Surface-relative text-label style: `currentColor` + optional per-role opacity. */
export const textStyle = (
  opacity: number | undefined,
  anchor: TextAnchor,
  size: number,
  emphasis: Emphasis,
): DrawStyle => ({
  fill: staticBinding(INK),
  ...(opacity !== undefined ? { opacity: staticBinding(opacity) } : {}),
  textAnchor: anchor,
  fontSize: size,
  emphasis,
  fontFamily: CHART_FONT,
});

export const literal = (text: string): TextSource => ({ kind: 'Literal', value: text });

export const line = (x1: number, y1: number, x2: number, y2: number, style: DrawStyle): Shape => ({
  kind: 'Line',
  x1,
  y1,
  x2,
  y2,
  style,
});

export const rectangle = (
  x: number,
  y: number,
  width: number,
  height: number,
  cornerRadius: number | undefined,
  style: DrawStyle,
): Shape => ({
  kind: 'Rectangle',
  x,
  y,
  width,
  height,
  ...(cornerRadius !== undefined ? { cornerRadius } : {}),
  style,
});

export const label = (x: number, y: number, text: TextSource, style: DrawStyle): Shape => ({
  kind: 'Label',
  x,
  y,
  text,
  style,
});

export const polyline = (points: readonly DrawPoint[], style: DrawStyle): Shape => ({
  kind: 'Polyline',
  points,
  style,
});

export const polygon = (points: readonly DrawPoint[], style: DrawStyle): Shape => ({
  kind: 'Polygon',
  points,
  style,
});

export const circle = (cx: number, cy: number, r: number, style: DrawStyle): Shape => ({
  kind: 'Circle',
  cx,
  cy,
  r,
  style,
});
