// @fuaran-ui/charts — the deterministic text metrics (Phase 879).
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import { r2 } from './layout.js';

// ─── Deterministic text metrics (Phase 879) ───────────────────
//
// A byte-for-byte MIRROR of the F# reference table
// (`Fuaran.UI.Charts.TextMetrics`) — mirrored, never re-derived, because the
// margins, the legend pitch and the label rotations it decides are all pinned
// by the shared `chart-lowering/*` corpus.
//
// THE APPROXIMATION IS THE SPEC. No host measures text: a headless emitter has
// no font engine, and a browser's measurement depends on which member of the
// font stack actually resolved — either would make the lowering's output a
// function of the host, destroying the byte-identical cross-host property the
// corpus rests on. So the widths come from a FIXED table of per-character
// advance widths as a fraction of the font size (em), approximating a typical
// sans-serif. A real font differs by a few percent; `AXIS_LABEL_PADDING`
// absorbs it.
//
//   1. Five width classes; an unlisted character (including every non-ASCII
//      one) takes the DEFAULT, which is what makes the table total.
//   2. Width = fontSize × Σ advanceEm(ch), summed LEFT TO RIGHT (float addition
//      is not associative — the order is part of the spec), rounded once.
//   3. Line height = fontSize × TEXT_LINE_HEIGHT_FACTOR.
//   4. Truncation keeps the longest prefix that still fits with the ellipsis;
//      when nothing fits the result is a bare `…`, never the empty string.

const THIN_EM = 0.28;
const NARROW_EM = 0.33;
const DEFAULT_EM = 0.55;
const WIDE_EM = 0.7;
const EXTRA_WIDE_EM = 0.9;
export const ELLIPSIS = '…';

const THIN_CHARS = " !',.:;Iijl|";
const NARROW_CHARS = '"()*-/\\[]{}frt';
const EXTRA_WIDE_CHARS = '%@MWm';

/** One character's advance width as a fraction of the font size. Total: an
 * unlisted character takes `DEFAULT_EM`, so no host enumerates Unicode. */
const advanceEm = (ch: string): number => {
  if (THIN_CHARS.includes(ch)) return THIN_EM;
  if (NARROW_CHARS.includes(ch)) return NARROW_EM;
  if (EXTRA_WIDE_CHARS.includes(ch)) return EXTRA_WIDE_EM;
  if (ch === 'J' || ch === 'L') return DEFAULT_EM;
  if (ch >= 'A' && ch <= 'Z') return WIDE_EM;
  if (ch === 'w') return WIDE_EM;
  return DEFAULT_EM;
};

/** A string's advance width in em — summed LEFT TO RIGHT (rule 2). */
const advanceEmOf = (text: string): number => {
  let acc = 0.0;
  for (let i = 0; i < text.length; i++) acc += advanceEm(text[i]!);
  return acc;
};

/** The estimated rendered width of `text` at `fontSize`, rounded once. */
export const textWidth = (fontSize: number, text: string): number =>
  r2(fontSize * advanceEmOf(text));

/** The estimated line height at `fontSize` (rule 3). */
export const textLineHeight = (fontSize: number, lineHeightFactor: number): number =>
  r2(fontSize * lineHeightFactor);

/** Does `text` fit a box `maxWidth` × `maxHeight` at `fontSize`? The single
 * predicate a data-label gate answers inside/outside/suppress with, so a label
 * can never disagree with the margin that made room for it. */
export const textFitsBox = (
  fontSize: number,
  lineHeightFactor: number,
  maxWidth: number,
  maxHeight: number,
  text: string,
): boolean =>
  textWidth(fontSize, text) <= maxWidth && textLineHeight(fontSize, lineHeightFactor) <= maxHeight;

/** Deterministic ellipsis truncation to `maxWidth` (rule 4). A string that
 * already fits comes back unchanged. */
export const truncateToWidth = (fontSize: number, maxWidth: number, text: string): string => {
  if (textWidth(fontSize, text) <= maxWidth) return text;
  const budget = maxWidth - textWidth(fontSize, ELLIPSIS);
  if (budget < 0.0) return ELLIPSIS;
  let acc = 0.0;
  let take = 0;
  for (let i = 0; i < text.length; i++) {
    const next = acc + advanceEm(text[i]!);
    if (r2(fontSize * next) > budget) break;
    acc = next;
    take = i + 1;
  }
  return text.slice(0, take) + ELLIPSIS;
};

export const DEG_TO_RAD = Math.PI / 180.0;
