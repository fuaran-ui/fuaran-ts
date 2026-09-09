// ============================================================================
//  @fuaran-ui/renderer-server/csp — the strict-CSP render mode (Phase 1545).
//
//  This renderer sets a `style` attribute for the handful of slots whose value
//  is CONTINUOUS — a grid track list, a masonry column count, a flex gap, a
//  split-pane weight, a scroll-area ceiling, a progress width, a grid cell's
//  progress fill. Under a Content-Security-Policy that otherwise forbids
//  everything, that forces every deploying host to ship
//  `style-src 'unsafe-inline'`, which is the remaining CSS exfiltration
//  channel: an injected style attribute reads the document with attribute
//  selectors and leaks what it finds through a background URL.
//
//  So a render carries a MODE. `permissive` is what every existing caller gets
//  and is byte-for-byte the emission this renderer has always produced —
//  nothing on that path consults this module. A strict mode is reached BY NAME
//  (`renderToHtml(tree, { csp: { mode: 'strict', nonce } })`), and under it no
//  `style` attribute is emitted anywhere: each continuous value becomes a
//  generated class plus a declaration collected into one nonce-bearing
//  `<style>` element per render root.
//
//  The TypeScript twin of the F# `Fuaran.UI.Renderer.Csp`. The two hosts derive
//  the SAME class name for the same tree, which is the property that matters:
//  a document is supposed to render the same on every conformant host, and a
//  class name is part of the document. That is why the declaration builders
//  below reproduce the F# spelling exactly — including `toFixed(6)`, which is
//  what `sprintf "%f"` produces — even where this renderer's own permissive
//  emission has always formatted the same number differently.
// ============================================================================

import { isSafeCssValue } from '@fuaran-ui/renderer/sanitize';

/** The Content-Security-Policy posture a render runs under. */
export type CspMode =
  /** Today's emission: continuous values ride an inline `style` attribute. */
  | { readonly mode: 'permissive' }
  /**
   * No `style` attribute is emitted anywhere; continuous values become
   * generated classes whose declarations are collected into one `<style>`
   * element carrying this nonce.
   *
   * Nothing here generates a nonce: the host mints it per response and puts the
   * same value in its `Content-Security-Policy` header. A nonce the document
   * could derive is a nonce an attacker can derive.
   */
  | { readonly mode: 'strict'; readonly nonce: string };

export const permissiveCsp: CspMode = { mode: 'permissive' };

/** A strict-mode posture carrying the host's per-response nonce. */
export const strictCsp = (nonce: string): CspMode => ({ mode: 'strict', nonce });

/** One CSS declaration in its canonical spelling: a kebab-case property, a value. */
export type Declaration = readonly [property: string, value: string];

// ─── The raw-`<style>`-content floor ─────────────────────────────────────────

/**
 * Is this value safe to write into raw `<style>` element CONTENT?
 *
 * Two gates, and the second is the one this sink adds. `isSafeCssValue` is the
 * shared emission grammar every host agrees on: it denies `;`, `{`, `}`, `\`
 * and the C0 range, which stops a value closing its own declaration or its
 * rule. It does NOT deny `<`, and deliberately so — in an ATTRIBUTE value `<`
 * is escaped by `escapeAttr`, so it can neither open a tag nor end one.
 *
 * A `<style>` element's content is not escaped, and the HTML parser looks for
 * `</style` inside it BEFORE any CSS parser sees the text. So a value carrying
 * that sequence would end the element and put the remainder of the stylesheet
 * into the document as markup. `<` and `>` are therefore refused here on top of
 * the shared grammar.
 *
 * In practice this never fires: every value reaching the collector has already
 * passed its own emission-site gate or is a renderer-formatted number. It is
 * the floor that makes that true by construction rather than by audit.
 */
export const isCollectableValue = (value: string): boolean =>
  isSafeCssValue(value) && !value.includes('<') && !value.includes('>');

/**
 * The canonical declaration text for a rule body — `prop:value;prop:value`, in
 * the order the emission site listed them. Both the hash input and what the
 * collected stylesheet writes, so the two cannot disagree about what a class
 * means.
 */
export const declarationText = (declarations: readonly Declaration[]): string =>
  declarations.map(([property, value]) => `${property}:${value}`).join(';');

// ─── The generated class name ────────────────────────────────────────────────

/**
 * A CONCATENATION ROOT, never a complete class name — the completions are
 * derived per render, so no fixed vocabulary member exists to name.
 */
export const CLASS_ROOT = 'fuaran-csp-';

/**
 * FNV-1a over a string, byte-identical to the F# `Ids.deterministicCorrelationId`
 * (32-bit, offset basis `2166136261`, prime `16777619`, XOR by UTF-16 code
 * unit, 8-hex-digit output). `Math.imul` performs the 32-bit-wrapping multiply;
 * `>>> 0` keeps every intermediate unsigned so the result matches .NET `uint32`
 * arithmetic.
 *
 * Written here rather than imported: this package is dependency-light by design
 * (the `html.ts` posture for `isSafeAttributeName`), and the eight lines cost
 * less than a runtime dependency on a package this one does not otherwise need.
 */
const fnv1a = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/**
 * The class a node's continuous declarations are emitted under in strict mode.
 *
 * Deterministic: the same node, slot and declarations always produce the same
 * name — and the same name the F# renderers produce, which is what keeps a
 * document's classes a property of the document rather than of the host that
 * rendered it. `slot` discriminates two declarations minted under one node id;
 * a split panel's two panes are the worked case.
 */
export const generatedClass = (
  nodeId: string,
  slot: string,
  declarations: readonly Declaration[],
): string => `${CLASS_ROOT}${fnv1a(`${nodeId}|${slot}|${declarationText(declarations)}`)}`;

// ─── The canonical declarations, per slot ────────────────────────────────────

/**
 * The declaration set each continuous-value site contributes, in the CANONICAL
 * spelling — which is the F# server renderer's, exactly.
 *
 * Where this renderer's own permissive emission differs (its progress fill
 * writes `width:50%` where F# writes `width:50.000000%`), the canonical form
 * still follows F#: the canonical pairs are the HASH INPUT and nothing this
 * module emits, so following one spelling costs no byte anywhere and buys a
 * class name two hosts agree on.
 */
export const declarations = {
  grid: (templateColumns: string, gap: number | undefined): Declaration[] =>
    gap !== undefined
      ? [
          ['grid-template-columns', templateColumns],
          ['gap', `${gap}px`],
        ]
      : [['grid-template-columns', templateColumns]],

  masonry: (columns: number, gap: number | undefined): Declaration[] =>
    gap !== undefined
      ? [
          ['column-count', String(columns)],
          ['gap', `${gap}px`],
        ]
      : [['column-count', String(columns)]],

  flex: (gap: number | undefined): Declaration[] =>
    gap !== undefined ? [['gap', `${gap}px`]] : [],

  splitPane: (weight: number): Declaration[] => [['flex', `${weight.toFixed(6)} 1 0`]],

  scrollArea: (maxHeight: number | undefined, maxWidth: number | undefined): Declaration[] => {
    const out: Declaration[] = [];
    if (maxHeight !== undefined) out.push(['max-height', `${maxHeight}px`]);
    if (maxWidth !== undefined) out.push(['max-width', `${maxWidth}px`]);
    return out;
  },

  progressFill: (fraction: number): Declaration[] => [['width', `${(fraction * 100).toFixed(6)}%`]],
} as const;

// ─── The per-render collector ────────────────────────────────────────────────

/**
 * The rules one render generated, in the order the walk produced them.
 *
 * MUTABLE, and threaded on the render context rather than returned. Making
 * every arm return its declarations alongside its HTML would have rewritten
 * hundreds of call sites to carry a value that is empty for all but seven of
 * them, and the emission is a single-threaded walk over one tree per context —
 * so a per-render accumulator is the smaller and the safer change. One
 * collector belongs to one context and never outlives the render that built it.
 *
 * Determinism comes from the walk, not from sorting: a class is registered the
 * first time it is seen and ignored afterwards, so two renders of one tree emit
 * one byte sequence, in the document order a reader debugging the emitted
 * stylesheet expects.
 */
export class StyleCollector {
  private readonly order: Array<readonly [string, string]> = [];
  private readonly seen = new Set<string>();

  /**
   * Register `declarations` under `className`. First write wins; a repeat is a
   * no-op, which is the common case — a class is derived from its own
   * declarations, so two registrations of one name carry the same body by
   * construction.
   *
   * A declaration whose value is not collectable is dropped. When that leaves
   * nothing, the class registers no rule at all: the element keeps a class that
   * styles nothing, which is what a refused value should look like, and the
   * emission site has already marked the refusal in the document.
   */
  register(className: string, declarations: readonly Declaration[]): void {
    if (this.seen.has(className)) return;
    this.seen.add(className);
    const safe = declarations.filter(([, value]) => isCollectableValue(value));
    if (safe.length > 0) this.order.push([className, declarationText(safe)]);
  }

  get rules(): ReadonlyArray<readonly [string, string]> {
    return this.order;
  }

  get isEmpty(): boolean {
    return this.order.length === 0;
  }
}

/**
 * The CSS text for a collected rule set — `.cls{decls}` concatenated in walk
 * order, with no whitespace between rules so the bytes are a function of the
 * tree alone.
 */
export const stylesheetText = (rules: ReadonlyArray<readonly [string, string]>): string =>
  rules.map(([className, decls]) => `.${className}{${decls}}`).join('');

// ─── The host's side of the contract ─────────────────────────────────────────

/**
 * The `style-src` directive a host sends for a document rendered under a strict
 * posture — its own origin for the packaged reference stylesheet, and this
 * render's nonce for the collected element. No `'unsafe-inline'`, which is the
 * whole point of the mode.
 */
export const styleSrcDirective = (nonce: string): string => `style-src 'self' 'nonce-${nonce}'`;
